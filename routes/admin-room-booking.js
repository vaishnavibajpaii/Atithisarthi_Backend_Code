const express = require("express");
const { ZodError } = require("zod");
const { requireAdminAuth } = require("../middleware/require-admin-auth");
const { validateBody, formatZodError } = require("../validators/common");
const {
  adminRoomBookingCreateSchema,
  adminRoomBookingPaymentSchema,
  adminRoomBookingStatusUpdateSchema,
  partialRoomSchema,
  partialRoomTypeSchema,
  roomAvailabilityQuerySchema,
  roomCombinedCheckoutSchema,
  roomBookingListQuerySchema,
  roomFeatureSettingsSchema,
  roomSchema,
  roomTypeSchema
} = require("../validators/rooms");
const { env } = require("../config/env");
const { supabase } = require("../utils/supabase");
const { invalidatePublicRoomsCache } = require("../utils/public-route-cache");
const {
  getRoomDefaultNightlyPrice,
  resolveRoomBookingPricing
} = require("../utils/room-pricing");
const {
  buildRoomBookingRequestFingerprint,
  classifyRoomBookingReplay,
  findRoomBookingByIdempotency,
  getRoomIdempotencyKey,
  isMissingTask6BookingAtomicRpc,
  isTask6BookingIdempotencyConflict,
  isTask6BookingMaintenanceConflict,
  normalizeTask6BookingAtomicResult
} = require("../utils/room-idempotency");
const {
  buildHotelFeatureSettingsRow,
  normalizeHotelFeatureConfig
} = require("../utils/hotel-feature-settings");
const {
  requireHotelFeature,
  resolveAdminHotelSlug
} = require("../middleware/require-hotel-feature");
const {
  createAdminCombinedCheckoutContextResolver,
  createRoomCombinedCheckoutFeatureGate,
  createRoomCombinedCheckoutHandler
} = require("../utils/room-combined-checkout-handler");
const {
  buildRoomCheckoutSummary,
  getNumberValue,
  roundMoney
} = require("../utils/room-checkout-summary");
const {
  buildAdvanceSummary,
  buildRoomAdvancePlan,
  buildRoomAdvanceReceipt,
  fetchRoomAdvancePolicy,
  isMissingAdvanceSchemaError,
  normalizeRoomAdvancePolicy
} = require("../utils/room-advance-payment");
const {
  ROOM_BOOKING_CONFLICT_CODE,
  ROOM_BOOKING_CONFLICT_MESSAGE,
  ROOM_STATUSES_BLOCKING_BOOKING,
  applyActiveBookingOverlapFilter,
  fetchMaintenanceBlockedRoomIds,
  isRoomBookingOverlapError
} = require("../utils/room-availability");

const router = express.Router();
const FINAL_BOOKING_STATUSES = ["checked_out", "cancelled", "no_show"];
const ORDER_ROOM_SERVICE_COLUMNS = [
  "room_id",
  "room_booking_id",
  "room_number",
  "room_service_guest_name",
  "room_service_charge_to_room"
];
const requireRoomCombinedCheckoutEnabled =
  createRoomCombinedCheckoutFeatureGate({
    isEnabled: () => env.roomCombinedCheckoutEnabled
  });
async function resolveAdminRoomOperationHotelSlug(req = {}) {
  const directHotelSlug = resolveAdminHotelSlug(req);
  if (directHotelSlug) return directHotelSlug;

  const recordId = normalizeText(req.params?.id, 80);
  const pathName = String(req.path || "").trim();
  if (!recordId) return "";

  const table = pathName.startsWith("/room-types/")
    ? "room_types"
    : pathName.startsWith("/rooms/")
      ? "rooms"
      : pathName.startsWith("/bookings/")
        ? "room_bookings"
        : "";
  if (!table) return "";

  const { data, error } = await supabase
    .from(table)
    .select("hotel_slug")
    .eq("id", recordId)
    .maybeSingle();
  if (error) throw error;
  return normalizeText(data?.hotel_slug, 120);
}

const requireAdminRoomModule = requireHotelFeature("rooms", {
  resolveHotelSlug: resolveAdminRoomOperationHotelSlug
});
const requireAdminCombinedBilling = requireHotelFeature("combined_billing", {
  resolveHotelSlug: resolveAdminRoomOperationHotelSlug
});
const adminRoomCombinedCheckoutHandler =
  createRoomCombinedCheckoutHandler({
    supabaseClient: supabase,
    useAtomicFinalizer: () => env.task6RoomCheckoutFinalizerEnabled,
    resolveRequestContext: createAdminCombinedCheckoutContextResolver({
      supabaseClient: supabase
    })
  });

router.use(requireAdminAuth);
router.use((req, res, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    res.on("finish", async () => {
      if (res.statusCode >= 400) return;
      try {
        const hotelSlug = await resolveAdminRoomOperationHotelSlug(req);
        if (hotelSlug) invalidatePublicRoomsCache(hotelSlug);
      } catch (error) {
        console.warn("Public Rooms cache invalidation skipped:", error?.message || error);
      }
    });
  }
  next();
});

function normalizeText(value = "", maxLength = 120) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength)
    : "";
}

function isMissingRoomBookingSchemaError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();
  const roomTables = [
    "hotel_feature_settings",
    "room_types",
    "rooms",
    "room_bookings",
    "room_booking_payments"
  ];

  return (
    code === "42P01" ||
    code === "42703" ||
    code === "PGRST205" ||
    code === "PGRST204" ||
    roomTables.some((tableName) => details.includes(tableName))
  );
}


function buildMissingSchemaResponse(res) {
  return res.status(400).json({
    success: false,
    schemaReady: false,
    message: "Room booking schema is not initialized yet"
  });
}

function isMissingRoomServiceOrderSchemaError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();

  return (
    code === "42P01" ||
    code === "42703" ||
    code === "PGRST205" ||
    code === "PGRST204" ||
    details.includes("orders") ||
    ORDER_ROOM_SERVICE_COLUMNS.some((columnName) => details.includes(columnName))
  );
}

function getDateOnlyMs(value = "") {
  return Date.parse(`${String(value || "").trim()}T00:00:00.000Z`);
}
function getTotalNights(checkInDate = "", checkOutDate = "") {
  const checkInMs = getDateOnlyMs(checkInDate);
  const checkOutMs = getDateOnlyMs(checkOutDate);
  const nightMs = 24 * 60 * 60 * 1000;

  if (!Number.isFinite(checkInMs) || !Number.isFinite(checkOutMs) || checkOutMs <= checkInMs) {
    return 0;
  }

  return Math.round((checkOutMs - checkInMs) / nightMs);
}

function getEffectiveRoomNightlyPrice(room = {}) {
  return getRoomDefaultNightlyPrice({ room }).amount;
}

function calculateRoomBookingTotals({ room, checkInDate, checkOutDate, advancePaid = 0 }) {
  const totalNights = getTotalNights(checkInDate, checkOutDate);
  const nightlyPrice = getEffectiveRoomNightlyPrice(room);
  const roomPrice = roundMoney(nightlyPrice * totalNights);
  const taxPercent = Math.min(Math.max(Number(room.tax_percent || 0), 0), 100);
  const taxAmount = roundMoney((roomPrice * taxPercent) / 100);
  const discountAmount = 0;
  const totalAmount = roundMoney(roomPrice + taxAmount - discountAmount);
  const safeAdvancePaid = Math.min(roundMoney(advancePaid), totalAmount);
  const balanceAmount = roundMoney(Math.max(0, totalAmount - safeAdvancePaid));
  const paymentStatus =
    safeAdvancePaid <= 0
      ? "unpaid"
      : balanceAmount <= 0
        ? "paid"
        : "partial";

  return {
    totalNights,
    roomPrice,
    taxAmount,
    discountAmount,
    totalAmount,
    advancePaid: safeAdvancePaid,
    balanceAmount,
    paymentStatus
  };
}

function getPaymentStatusFromAmounts({ advancePaid = 0, totalAmount = 0 }) {
  const safeAdvancePaid = roundMoney(Math.max(0, Number(advancePaid || 0)));
  const safeTotalAmount = roundMoney(Math.max(0, Number(totalAmount || 0)));

  if (safeAdvancePaid <= 0) {
    return "unpaid";
  }

  if (safeAdvancePaid >= safeTotalAmount) {
    return "paid";
  }

  return "partial";
}

function buildFeatureSettingsResponse(settingsRow, hotelSlug = "") {
  return normalizeHotelFeatureConfig(settingsRow || {}, hotelSlug);
}

function buildRoomTypePayload(body = {}) {
  const payload = {
    updated_at: new Date().toISOString()
  };

  if (body.hotelSlug !== undefined) payload.hotel_slug = body.hotelSlug;
  if (body.name !== undefined) payload.name = body.name;
  if (body.description !== undefined) payload.description = body.description || "";
  if (body.basePrice !== undefined) payload.base_price = Number(body.basePrice || 0);
  if (body.maxAdults !== undefined) payload.max_adults = Number(body.maxAdults || 0);
  if (body.maxChildren !== undefined) payload.max_children = Number(body.maxChildren || 0);
  if (body.amenities !== undefined) payload.amenities_json = body.amenities || [];
  if (body.images !== undefined) payload.images_json = body.images || [];
  if (body.cancellationPolicy !== undefined) {
    payload.cancellation_policy = body.cancellationPolicy || "";
  }
  if (body.isActive !== undefined) payload.is_active = !!body.isActive;

  return payload;
}

function buildRoomPayload(body = {}) {
  const payload = {
    updated_at: new Date().toISOString()
  };

  if (body.hotelSlug !== undefined) payload.hotel_slug = body.hotelSlug;
  if (body.roomTypeId !== undefined) payload.room_type_id = body.roomTypeId || null;
  if (body.roomNumber !== undefined) payload.room_number = body.roomNumber;
  if (body.floor !== undefined) payload.floor = body.floor || "";
  if (body.title !== undefined) payload.title = body.title || "";
  if (body.capacity !== undefined) payload.capacity = Number(body.capacity || 0);
  if (body.maxAdults !== undefined) payload.max_adults = Number(body.maxAdults || 0);
  if (body.maxChildren !== undefined) payload.max_children = Number(body.maxChildren || 0);
  if (body.bedType !== undefined) payload.bed_type = body.bedType || "";
  if (body.basePrice !== undefined) payload.base_price = Number(body.basePrice || 0);
  if (body.discountPrice !== undefined) {
    payload.discount_price = body.discountPrice === null ? null : Number(body.discountPrice || 0);
  }
  if (body.taxPercent !== undefined) payload.tax_percent = Number(body.taxPercent || 0);
  if (body.status !== undefined) payload.status = body.status;
  if (body.amenities !== undefined) payload.amenities_json = body.amenities || [];
  if (body.images !== undefined) payload.images_json = body.images || [];
  if (body.description !== undefined) payload.description = body.description || "";
  if (body.isActive !== undefined) payload.is_active = !!body.isActive;

  return payload;
}

function parseQuery(schema, query = {}) {
  try {
    return {
      values: schema.parse(query),
      errors: null
    };
  } catch (error) {
    return {
      values: null,
      errors: error instanceof ZodError ? formatZodError(error) : ["Invalid query"]
    };
  }
}

async function ensureRoomTypeBelongsToHotel(roomTypeId, hotelSlug) {
  if (!roomTypeId) {
    return {
      ok: true,
      roomType: null
    };
  }

  const { data, error } = await supabase
    .from("room_types")
    .select("id,hotel_slug,is_active")
    .eq("id", roomTypeId)
    .eq("hotel_slug", hotelSlug)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    return {
      ok: false,
      status: 400,
      message: "Room type was not found for this hotel"
    };
  }

  return {
    ok: true,
    roomType: data
  };
}

async function fetchBookableRoom({ hotelSlug, roomId }) {
  const { data, error } = await supabase
    .from("rooms")
    .select("*")
    .eq("id", roomId)
    .eq("hotel_slug", hotelSlug)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    return {
      ok: false,
      status: 404,
      message: "Room not found for this hotel"
    };
  }

  if (data.is_active === false || ROOM_STATUSES_BLOCKING_BOOKING.includes(data.status)) {
    return {
      ok: false,
      status: 409,
      message: "This room is not available for booking right now"
    };
  }

  return {
    ok: true,
    room: data
  };
}

async function hasBlockingBooking({ hotelSlug, roomId, checkInDate, checkOutDate }) {
  const { data, error } = await applyActiveBookingOverlapFilter(
    supabase
      .from("room_bookings")
      .select("id")
      .eq("hotel_slug", hotelSlug)
      .eq("room_id", roomId),
    { checkInDate, checkOutDate }
  ).limit(1);

  if (error) throw error;

  return Array.isArray(data) && data.length > 0;
}

async function fetchBookingForAdmin({ bookingId, hotelSlug = "" }) {
  let query = supabase
    .from("room_bookings")
    .select("*")
    .eq("id", bookingId);

  if (hotelSlug) {
    query = query.eq("hotel_slug", hotelSlug);
  }

  const { data, error } = await query.maybeSingle();

  if (error) throw error;

  if (!data) {
    return {
      ok: false,
      status: 404,
      message: "Room booking not found"
    };
  }

  return {
    ok: true,
    booking: data
  };
}

function buildBookingStatusUpdatePayload(nextStatus, notes = "", currentBooking = {}) {
  const now = new Date().toISOString();
  const payload = {
    booking_status: nextStatus,
    updated_at: now
  };

  if (notes !== undefined) {
    payload.notes = notes || currentBooking.notes || "";
  }

  if (nextStatus === "checked_in" && !currentBooking.checked_in_at) {
    payload.checked_in_at = now;
  }

  if (nextStatus === "checked_out" && !currentBooking.checked_out_at) {
    payload.checked_out_at = now;
  }

  if (nextStatus === "cancelled" && !currentBooking.cancelled_at) {
    payload.cancelled_at = now;
  }

  return payload;
}

router.get("/advance-policy/:slug", async (req, res) => {
  try {
    const hotelSlug = normalizeText(req.params.slug, 120);
    if (!hotelSlug) {
      return res.status(400).json({ success: false, message: "Hotel slug is required" });
    }
    const policy = await fetchRoomAdvancePolicy({ supabaseClient: supabase, hotelSlug });
    return res.json({ success: true, policy });
  } catch (error) {
    console.error("Admin Room advance policy fetch error:", error);
    return res.status(500).json({ success: false, message: "Failed to load Room advance policy" });
  }
});

router.get("/feature-settings/:slug", async (req, res) => {
  try {
    const slug = normalizeText(req.params.slug, 120);

    if (!slug) {
      return res.status(400).json({
        success: false,
        message: "Hotel slug is required"
      });
    }

    const { data, error } = await supabase
      .from("hotel_feature_settings")
      .select("*")
      .eq("hotel_slug", slug)
      .maybeSingle();

    if (error) {
      if (isMissingRoomBookingSchemaError(error)) {
        return buildMissingSchemaResponse(res);
      }

      throw error;
    }

    res.json({
      success: true,
      schemaReady: true,
      settings: buildFeatureSettingsResponse(data, slug)
    });
  } catch (error) {
    console.error("Room feature settings fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch room feature settings"
    });
  }
});

router.put("/feature-settings", validateBody(roomFeatureSettingsSchema), async (req, res) => {
  try {
    const hotelSlug = req.validatedBody.hotelSlug;

    if (
      req.validatedBody.enableFoodModule === false &&
      req.validatedBody.enableRoomModule === false
    ) {
      return res.status(400).json({
        success: false,
        code: "INVALID_FEATURE_CONFIGURATION",
        message: "At least one core module must remain enabled"
      });
    }

    const existingResult = await supabase
      .from("hotel_feature_settings")
      .select("*")
      .eq("hotel_slug", hotelSlug)
      .maybeSingle();

    if (existingResult.error && !isMissingRoomBookingSchemaError(existingResult.error)) {
      throw existingResult.error;
    }

    const previousConfig = buildFeatureSettingsResponse(existingResult.data, hotelSlug);
    const nextVersion = Math.max(1, Number(existingResult.data?.version || 0) + 1);
    const payload = buildHotelFeatureSettingsRow(
      {
        ...previousConfig,
        ...req.validatedBody,
        hotelSlug
      },
      {
        version: nextVersion,
        updatedBy: req.adminUser?.sub || req.adminUser?.email || "platform_admin"
      }
    );

    const { data, error } = await supabase
      .from("hotel_feature_settings")
      .upsert(payload, { onConflict: "hotel_slug" })
      .select()
      .single();

    if (error) {
      if (isMissingRoomBookingSchemaError(error)) {
        return buildMissingSchemaResponse(res);
      }

      throw error;
    }

    const nextConfig = buildFeatureSettingsResponse(data, hotelSlug);
    const auditResult = await supabase
      .from("hotel_feature_setting_audit")
      .insert([{
        hotel_slug: hotelSlug,
        actor_id: req.adminUser?.sub || req.adminUser?.email || null,
        actor_scope: "platform_admin",
        previous_config: previousConfig,
        next_config: nextConfig
      }]);

    if (auditResult.error && !isMissingRoomBookingSchemaError(auditResult.error)) {
      console.error("Hotel feature settings audit error:", auditResult.error);
    }

    res.json({
      success: true,
      message: "Hotel module settings saved",
      settings: nextConfig
    });
  } catch (error) {
    console.error("Room feature settings save error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to save room feature settings"
    });
  }
});

// Platform admins can always inspect current and historical Room data, including
// the cross-hotel lists used by the Admin dashboard. Mutations remain protected
// by the selected hotel's Room module so public and staff operational rules stay
// unchanged.
router.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") {
    return next();
  }

  return requireAdminRoomModule(req, res, next);
});

router.get("/room-types", async (req, res) => {
  try {
    const hotelSlug = normalizeText(req.query.hotelSlug, 120);
    let query = supabase
      .from("room_types")
      .select("*")
      .order("name", { ascending: true });

    if (hotelSlug) {
      query = query.eq("hotel_slug", hotelSlug);
    }

    const { data, error } = await query;

    if (error) {
      if (isMissingRoomBookingSchemaError(error)) {
        return buildMissingSchemaResponse(res);
      }

      throw error;
    }

    res.json({
      success: true,
      count: data.length,
      roomTypes: data
    });
  } catch (error) {
    console.error("Room types fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch room types"
    });
  }
});

router.post("/room-types", validateBody(roomTypeSchema), async (req, res) => {
  try {
    const payload = buildRoomTypePayload(req.validatedBody);

    const { data, error } = await supabase
      .from("room_types")
      .insert([payload])
      .select()
      .single();

    if (error) {
      if (isMissingRoomBookingSchemaError(error)) {
        return buildMissingSchemaResponse(res);
      }

      throw error;
    }

    res.status(201).json({
      success: true,
      message: "Room type created",
      roomType: data
    });
  } catch (error) {
    console.error("Room type create error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create room type"
    });
  }
});

router.patch("/room-types/:id", validateBody(partialRoomTypeSchema), async (req, res) => {
  try {
    const id = normalizeText(req.params.id, 80);
    const payload = buildRoomTypePayload(req.validatedBody);

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Room type id is required"
      });
    }

    if (Object.keys(payload).length === 1) {
      return res.status(400).json({
        success: false,
        message: "At least one field is required to update a room type"
      });
    }

    const { data, error } = await supabase
      .from("room_types")
      .update(payload)
      .eq("id", id)
      .select()
      .maybeSingle();

    if (error) {
      if (isMissingRoomBookingSchemaError(error)) {
        return buildMissingSchemaResponse(res);
      }

      throw error;
    }

    if (!data) {
      return res.status(404).json({
        success: false,
        message: "Room type not found"
      });
    }

    res.json({
      success: true,
      message: "Room type updated",
      roomType: data
    });
  } catch (error) {
    console.error("Room type update error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update room type"
    });
  }
});

router.get("/rooms", async (req, res) => {
  try {
    const hotelSlug = normalizeText(req.query.hotelSlug, 120);
    let query = supabase
      .from("rooms")
      .select("*")
      .order("room_number", { ascending: true });

    if (hotelSlug) {
      query = query.eq("hotel_slug", hotelSlug);
    }

    const { data, error } = await query;

    if (error) {
      if (isMissingRoomBookingSchemaError(error)) {
        return buildMissingSchemaResponse(res);
      }

      throw error;
    }

    res.json({
      success: true,
      count: data.length,
      rooms: data
    });
  } catch (error) {
    console.error("Rooms fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch rooms"
    });
  }
});

router.post("/rooms", validateBody(roomSchema), async (req, res) => {
  try {
    const roomTypeValidation = await ensureRoomTypeBelongsToHotel(
      req.validatedBody.roomTypeId,
      req.validatedBody.hotelSlug
    );

    if (!roomTypeValidation.ok) {
      return res.status(roomTypeValidation.status).json({
        success: false,
        message: roomTypeValidation.message
      });
    }

    const payload = buildRoomPayload(req.validatedBody);

    const { data, error } = await supabase
      .from("rooms")
      .insert([payload])
      .select()
      .single();

    if (error) {
      if (isMissingRoomBookingSchemaError(error)) {
        return buildMissingSchemaResponse(res);
      }

      throw error;
    }

    res.status(201).json({
      success: true,
      message: "Room created",
      room: data
    });
  } catch (error) {
    console.error("Room create error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create room"
    });
  }
});

router.patch("/rooms/:id", validateBody(partialRoomSchema), async (req, res) => {
  try {
    const id = normalizeText(req.params.id, 80);
    const payload = buildRoomPayload(req.validatedBody);

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Room id is required"
      });
    }

    if (Object.keys(payload).length === 1) {
      return res.status(400).json({
        success: false,
        message: "At least one field is required to update a room"
      });
    }

    const { data: existingRoom, error: existingRoomError } = await supabase
      .from("rooms")
      .select("id,hotel_slug")
      .eq("id", id)
      .maybeSingle();

    if (existingRoomError) {
      if (isMissingRoomBookingSchemaError(existingRoomError)) {
        return buildMissingSchemaResponse(res);
      }

      throw existingRoomError;
    }

    if (!existingRoom) {
      return res.status(404).json({
        success: false,
        message: "Room not found"
      });
    }

    if (req.validatedBody.roomTypeId !== undefined) {
      const roomTypeValidation = await ensureRoomTypeBelongsToHotel(
        req.validatedBody.roomTypeId,
        existingRoom.hotel_slug
      );

      if (!roomTypeValidation.ok) {
        return res.status(roomTypeValidation.status).json({
          success: false,
          message: roomTypeValidation.message
        });
      }
    }

    const { data, error } = await supabase
      .from("rooms")
      .update(payload)
      .eq("id", id)
      .select()
      .maybeSingle();

    if (error) {
      if (isMissingRoomBookingSchemaError(error)) {
        return buildMissingSchemaResponse(res);
      }

      throw error;
    }

    res.json({
      success: true,
      message: "Room updated",
      room: data
    });
  } catch (error) {
    console.error("Room update error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update room"
    });
  }
});

router.get("/availability", async (req, res) => {
  try {
    const parsedQuery = parseQuery(roomAvailabilityQuerySchema, req.query);

    if (parsedQuery.errors) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: parsedQuery.errors
      });
    }

    const {
      hotelSlug,
      checkInDate,
      checkOutDate,
      adults = 0,
      children = 0
    } = parsedQuery.values;
    let roomsQuery = supabase
      .from("rooms")
      .select("*")
      .eq("hotel_slug", hotelSlug)
      .eq("is_active", true)
      .eq("status", "available")
      .order("room_number", { ascending: true });

    if (adults > 0) {
      roomsQuery = roomsQuery.gte("max_adults", adults);
    }

    if (children > 0) {
      roomsQuery = roomsQuery.gte("max_children", children);
    }

    const { data: rooms, error: roomsError } = await roomsQuery;

    if (roomsError) {
      if (isMissingRoomBookingSchemaError(roomsError)) {
        return buildMissingSchemaResponse(res);
      }

      throw roomsError;
    }

    const roomIds = (rooms || []).map((room) => room.id);

    if (!roomIds.length) {
      return res.json({
        success: true,
        hotelSlug,
        checkInDate,
        checkOutDate,
        count: 0,
        rooms: []
      });
    }

    const { data: blockingBookings, error: bookingsError } = await applyActiveBookingOverlapFilter(
      supabase
        .from("room_bookings")
        .select("room_id")
        .eq("hotel_slug", hotelSlug)
        .in("room_id", roomIds),
      { checkInDate, checkOutDate }
    );

    if (bookingsError) {
      if (isMissingRoomBookingSchemaError(bookingsError)) {
        return buildMissingSchemaResponse(res);
      }

      throw bookingsError;
    }

    const blockedRoomIds = new Set(
      (blockingBookings || []).map((booking) => String(booking.room_id))
    );
    const maintenanceBlockedRoomIds = await fetchMaintenanceBlockedRoomIds({
      supabaseClient: supabase,
      hotelSlug,
      roomIds,
      checkInDate,
      checkOutDate
    });
    const availableRooms = (rooms || []).filter(
      (room) =>
        !blockedRoomIds.has(String(room.id)) &&
        !maintenanceBlockedRoomIds.has(String(room.id))
    );

    res.json({
      success: true,
      hotelSlug,
      checkInDate,
      checkOutDate,
      count: availableRooms.length,
      rooms: availableRooms
    });
  } catch (error) {
    console.error("Room availability fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch room availability"
    });
  }
});

router.get("/bookings", async (req, res) => {
  try {
    const parsedQuery = parseQuery(roomBookingListQuerySchema, req.query);

    if (parsedQuery.errors) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: parsedQuery.errors
      });
    }

    const {
      hotelSlug,
      status,
      fromDate,
      toDate,
      limit = 100
    } = parsedQuery.values;
    let query = supabase
      .from("room_bookings")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (hotelSlug) {
      query = query.eq("hotel_slug", hotelSlug);
    }

    if (status) {
      query = query.eq("booking_status", status);
    }

    if (fromDate) {
      query = query.gte("check_in_date", fromDate);
    }

    if (toDate) {
      query = query.lte("check_in_date", toDate);
    }

    const { data, error } = await query;

    if (error) {
      if (isMissingRoomBookingSchemaError(error)) {
        return buildMissingSchemaResponse(res);
      }

      throw error;
    }

    res.json({
      success: true,
      count: data.length,
      bookings: data
    });
  } catch (error) {
    console.error("Room bookings fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch room bookings"
    });
  }
});

router.post("/bookings", validateBody(adminRoomBookingCreateSchema), async (req, res) => {
  let createdBooking = null;

  try {
    const {
      hotelSlug,
      roomId,
      guestName,
      guestPhone,
      guestEmail,
      guestCompanyName,
      guestGstin,
      guestPlaceOfSupply,
      guestIdProof,
      checkInDate,
      checkOutDate,
      adults = 1,
      children = 0,
      advancePaid = 0,
      advanceOption,
      advanceAmount,
      advancePayments,
      bookingStatus = "confirmed",
      bookingSource = "admin",
      paymentMethod = "cash",
      notes
    } = req.validatedBody;
    const idempotency = getRoomIdempotencyKey(req);
    if (idempotency.error) {
      return res.status(400).json({ success: false, message: idempotency.error });
    }
    if (!idempotency.key) {
      return res.status(400).json({
        success: false,
        code: "ROOM_BOOKING_IDEMPOTENCY_REQUIRED",
        message: "An Idempotency-Key header is required for room booking requests."
      });
    }
    const requestFingerprint = buildRoomBookingRequestFingerprint({
      booking: {
        operation: "admin_room_booking_create",
        hotel_slug: hotelSlug,
        actor_id: req.adminUser?.sub || req.adminUser?.id || "",
        actor_role: "platform_admin",
        ...req.validatedBody
      }
    });
    const existingBooking = await findRoomBookingByIdempotency({
      supabaseClient: supabase,
      hotelSlug,
      key: idempotency.key
    });
    if (existingBooking) {
      const replay = classifyRoomBookingReplay(existingBooking, requestFingerprint);
      if (replay.replay) {
        return res.json({ success: true, idempotent: true, message: "Room booking already created", booking: existingBooking });
      }
      return res.status(409).json({
        success: false,
        code: "ROOM_BOOKING_IDEMPOTENCY_CONFLICT",
        message: "This booking retry key was already used for a different request."
      });
    }
    const roomResult = await fetchBookableRoom({ hotelSlug, roomId });

    if (!roomResult.ok) {
      return res.status(roomResult.status).json({
        success: false,
        message: roomResult.message
      });
    }

    const hasConflict = await hasBlockingBooking({
      hotelSlug,
      roomId,
      checkInDate,
      checkOutDate
    });

    if (hasConflict) {
      const concurrentReplay = await findRoomBookingByIdempotency({
        supabaseClient: supabase,
        hotelSlug,
        key: idempotency.key
      });
      const replay = classifyRoomBookingReplay(concurrentReplay, requestFingerprint);
      if (replay.replay) {
        return res.json({ success: true, idempotent: true, message: "Room booking already created", booking: concurrentReplay });
      }
      if (replay.conflict) {
        return res.status(409).json({
          success: false,
          code: "ROOM_BOOKING_IDEMPOTENCY_CONFLICT",
          message: "This booking retry key was already used for a different request."
        });
      }
      return res.status(409).json({
        success: false,
        code: ROOM_BOOKING_CONFLICT_CODE,
        message: ROOM_BOOKING_CONFLICT_MESSAGE
      });
    }

    const maintenanceBlocked = await fetchMaintenanceBlockedRoomIds({
      supabaseClient: supabase,
      hotelSlug,
      roomIds: [roomId],
      checkInDate,
      checkOutDate
    });
    if (maintenanceBlocked.has(String(roomId))) {
      return res.status(409).json({
        success: false,
        code: "ROOM_MAINTENANCE_CONFLICT",
        message: "This room is unavailable because of scheduled maintenance."
      });
    }

    const totals = await resolveRoomBookingPricing({
      supabaseClient: supabase,
      hotelSlug,
      room: roomResult.room,
      checkInDate,
      checkOutDate,
      advancePaid: 0,
      adults,
      children,
      guestPlaceOfSupply
    });

    if (totals.totalNights <= 0) {
      return res.status(400).json({
        success: false,
        message: "Check-out date must be after check-in date"
      });
    }

    const advancePolicy = await fetchRoomAdvancePolicy({
      supabaseClient: supabase,
      hotelSlug
    });
    const advancePlan = buildRoomAdvancePlan({
      body: { advancePaid, advanceOption, advanceAmount, advancePayments, paymentMethod },
      totalAmount: totals.totalAmount,
      policy: advancePolicy,
      actorIsManager: true
    });

    const bookingPayload = {
      hotel_slug: hotelSlug,
      room_id: roomId,
      guest_name: guestName,
      guest_phone: guestPhone,
      guest_email: guestEmail || null,
      guest_id_proof: guestIdProof || null,
      check_in_date: checkInDate,
      check_out_date: checkOutDate,
      adults: Number(adults || 0),
      children: Number(children || 0),
      total_nights: totals.totalNights,
      room_price: totals.roomPrice,
      tax_amount: totals.taxAmount,
      discount_amount: totals.discountAmount,
      total_amount: totals.totalAmount,
      advance_paid: 0,
      balance_amount: totals.totalAmount,
      booking_status: bookingStatus,
      payment_status: "unpaid",
      booking_source: bookingSource,
      created_by_user_id: req.adminUser?.sub || req.adminUser?.id || null,
      created_by_role: "admin",
      notes: notes || "",
      idempotency_key: idempotency.key,
      request_fingerprint: requestFingerprint,
      updated_at: new Date().toISOString()
    };
    if (totals.supportsSnapshot) {
      bookingPayload.rate_plan_id = totals.ratePlanId;
      bookingPayload.pricing_snapshot = totals.pricingSnapshot;
      if (totals.taxSnapshot?.supportsTaxSnapshot) {
        bookingPayload.tax_rule_id = totals.taxRuleId;
        bookingPayload.tax_snapshot = totals.taxSnapshot;
        bookingPayload.pricing_version = totals.pricingVersion;
        bookingPayload.guest_company_name = guestCompanyName || "";
        bookingPayload.guest_gstin = guestGstin || "";
        bookingPayload.guest_place_of_supply = guestPlaceOfSupply || "";
      }
    }

    if (advancePlan.totalAmount > 0) {
      const actorId = req.adminUser?.sub || req.adminUser?.id || "";
      const { data: atomicResult, error: atomicError } = await supabase.rpc(
        "create_room_booking_with_advance",
        {
          p_hotel_slug: hotelSlug,
          p_booking: bookingPayload,
          p_payments: advancePlan.payments,
          p_idempotency_key: idempotency.key,
          p_actor_id: actorId,
          p_actor_role: "platform_admin"
        }
      );
      if (atomicError) {
        const atomicMessage = String(atomicError.message || "");
        if (atomicMessage.includes("ROOM_ADVANCE_IDEMPOTENCY_CONFLICT")) {
          return res.status(409).json({
            success: false,
            code: "ROOM_ADVANCE_IDEMPOTENCY_CONFLICT",
            message: "This booking retry key was already used with different payment details."
          });
        }
        if (atomicMessage.includes("ROOM_ADVANCE_METHOD_DISABLED")) {
          return res.status(409).json({
            success: false,
            code: "ROOM_ADVANCE_METHOD_DISABLED",
            message: "This payment method is currently unavailable for this hotel."
          });
        }
        if (isMissingAdvanceSchemaError(atomicError)) {
          return res.status(409).json({
            success: false,
            code: "ROOM_ADVANCE_SCHEMA_REQUIRED",
            message: "Apply the Manual Room Booking Advance Payment migration before recording an advance."
          });
        }
        if (isRoomBookingOverlapError(atomicError)) {
          return res.status(409).json({
            success: false,
            code: ROOM_BOOKING_CONFLICT_CODE,
            message: ROOM_BOOKING_CONFLICT_MESSAGE
          });
        }
        throw atomicError;
      }
      const createdPayments = Array.isArray(atomicResult?.payments)
        ? atomicResult.payments
        : [];
      return res.status(atomicResult?.idempotent ? 200 : 201).json({
        success: true,
        idempotent: atomicResult?.idempotent === true,
        message: atomicResult?.idempotent
          ? "Room booking and advance already recorded"
          : "Room booking and advance recorded",
        booking: atomicResult?.booking || null,
        payment: createdPayments[0] || null,
        payments: createdPayments,
        summary: buildAdvanceSummary({
          booking: atomicResult?.booking || {},
          payments: createdPayments,
          policy: advancePolicy
        }),
        advanceReceipt: createdPayments[0]
          ? buildRoomAdvanceReceipt({
              booking: atomicResult?.booking || {},
              payment: createdPayments[0]
            })
          : null
      });
    }

    const { data: atomicResult, error } = await supabase.rpc(
      "task6_create_room_booking_atomic",
      {
        p_hotel_slug: hotelSlug,
        p_booking: bookingPayload,
        p_idempotency_key: idempotency.key
      }
    );

    if (error) {
      if (isTask6BookingIdempotencyConflict(error)) {
        return res.status(409).json({
          success: false,
          code: "ROOM_BOOKING_IDEMPOTENCY_CONFLICT",
          message: "This booking retry key was already used for a different request."
        });
      }
      if (isMissingTask6BookingAtomicRpc(error)) {
        return res.status(503).json({
          success: false,
          code: "TASK6_BOOKING_ATOMIC_CREATE_NOT_READY",
          message: "Atomic room booking creation is not initialized yet."
        });
      }
      if (isTask6BookingMaintenanceConflict(error)) {
        return res.status(409).json({
          success: false,
          code: "ROOM_MAINTENANCE_CONFLICT",
          message: "This room is unavailable because of scheduled maintenance."
        });
      }
      if (isRoomBookingOverlapError(error)) {
        return res.status(409).json({
          success: false,
          code: ROOM_BOOKING_CONFLICT_CODE,
          message: ROOM_BOOKING_CONFLICT_MESSAGE
        });
      }

      if (isMissingRoomBookingSchemaError(error)) {
        return buildMissingSchemaResponse(res);
      }

      throw error;
    }

    const atomicPayload = normalizeTask6BookingAtomicResult(atomicResult);
    createdBooking = atomicPayload?.booking || null;
    if (!createdBooking) throw new Error("Atomic room booking creation returned no booking");

    if (totals.advancePaid > 0) {
      const { data: payment, error: paymentError } = await supabase
        .from("room_booking_payments")
        .insert([
          {
            hotel_slug: hotelSlug,
            booking_id: createdBooking.id,
            amount: totals.advancePaid,
            payment_method: paymentMethod || "cash",
            payment_status: "paid",
            paid_at: new Date().toISOString(),
            notes: "Advance payment recorded during booking creation",
            updated_at: new Date().toISOString()
          }
        ])
        .select()
        .single();

      if (paymentError) {
        await supabase
          .from("room_bookings")
          .delete()
          .eq("id", createdBooking.id)
          .eq("hotel_slug", hotelSlug);

        if (isMissingRoomBookingSchemaError(paymentError)) {
          return buildMissingSchemaResponse(res);
        }

        throw paymentError;
      }

      return res.status(201).json({
        success: true,
        message: "Room booking created",
        booking: createdBooking,
        payment
      });
    }

    res.status(atomicResult?.idempotent ? 200 : 201).json({
      success: true,
      idempotent: atomicResult?.idempotent === true,
      message: atomicResult?.idempotent ? "Room booking already created" : "Room booking created",
      booking: createdBooking,
      payment: null
    });
  } catch (error) {
    if ([400, 403, 409].includes(Number(error?.status)) && String(error?.code || "").startsWith("ROOM_ADVANCE_")) {
      return res.status(Number(error.status)).json({
        success: false,
        code: error.code,
        message: error.message
      });
    }
    if (
      Number(error?.status) === 409 &&
      (String(error?.code || "").startsWith("ROOM_TAX_") ||
        String(error?.code || "").startsWith("ROOM_PRICE_"))
    ) {
      return res.status(409).json({
        success: false,
        code: error.code,
        message: error.message
      });
    }
    console.error("Room booking create error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create room booking"
    });
  }
});

router.patch(
  "/bookings/:id/status",
  validateBody(adminRoomBookingStatusUpdateSchema),
  async (req, res) => {
    try {
      const bookingId = normalizeText(req.params.id, 80);
      const {
        hotelSlug = "",
        bookingStatus,
        notes
      } = req.validatedBody;

      if (!bookingId) {
        return res.status(400).json({
          success: false,
          message: "Room booking id is required"
        });
      }

      const bookingResult = await fetchBookingForAdmin({ bookingId, hotelSlug });

      if (!bookingResult.ok) {
        return res.status(bookingResult.status).json({
          success: false,
          message: bookingResult.message
        });
      }

      const currentBooking = bookingResult.booking;
      const currentStatus = normalizeText(currentBooking.booking_status, 60);

      if (bookingStatus === "checked_out") {
        return res.status(409).json({
          success: false,
          code: "ROOM_CHECKOUT_REQUIRES_FINALIZER",
          message: "Use Combined Checkout to complete payment, room-service settlement, receipt, and final folio together"
        });
      }

      if (FINAL_BOOKING_STATUSES.includes(currentStatus) && currentStatus !== bookingStatus) {
        return res.status(409).json({
          success: false,
          message: "This booking is already closed and cannot be moved to another status"
        });
      }

      const updatePayload = buildBookingStatusUpdatePayload(
        bookingStatus,
        notes,
        currentBooking
      );

      const { data, error } = await supabase
        .from("room_bookings")
        .update(updatePayload)
        .eq("id", bookingId)
        .eq("hotel_slug", currentBooking.hotel_slug)
        .select()
        .maybeSingle();

      if (error) {
        if (isMissingRoomBookingSchemaError(error)) {
          return buildMissingSchemaResponse(res);
        }

        throw error;
      }

      if (!data) {
        return res.status(404).json({
          success: false,
          message: "Room booking not found"
        });
      }

      res.json({
        success: true,
        message: "Room booking status updated",
        booking: data
      });
    } catch (error) {
      console.error("Room booking status update error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to update room booking status"
      });
    }
  }
);

router.get("/bookings/:id/checkout-summary", async (req, res) => {
  try {
    const bookingId = normalizeText(req.params.id, 80);
    const hotelSlug = normalizeText(req.query.hotelSlug || req.query.hotel_slug, 120);

    if (!bookingId) {
      return res.status(400).json({
        success: false,
        message: "Room booking id is required"
      });
    }

    const bookingResult = await fetchBookingForAdmin({ bookingId, hotelSlug });

    if (!bookingResult.ok) {
      return res.status(bookingResult.status).json({
        success: false,
        message: bookingResult.message
      });
    }

    const booking = bookingResult.booking;
    const { data: room, error: roomError } = await supabase
      .from("rooms")
      .select("id,hotel_slug,room_number,title,floor,status")
      .eq("id", booking.room_id)
      .eq("hotel_slug", booking.hotel_slug)
      .maybeSingle();

    if (roomError) {
      if (isMissingRoomBookingSchemaError(roomError)) {
        return buildMissingSchemaResponse(res);
      }

      throw roomError;
    }

    const { data: foodOrders, error: ordersError } = await supabase
      .from("orders")
      .select("id,hotel_slug,payment_method,payment_status,billing_status,status,items,totals,created_at,room_id,room_booking_id,room_number,room_service_guest_name,room_service_charge_to_room")
      .eq("hotel_slug", booking.hotel_slug)
      .eq("room_booking_id", booking.id)
      .order("created_at", { ascending: true });

    if (ordersError) {
      if (isMissingRoomServiceOrderSchemaError(ordersError)) {
        return res.status(400).json({
          success: false,
          schemaReady: false,
          message: "Order room service fields are not initialized yet"
        });
      }

      throw ordersError;
    }

    res.json({
      success: true,
      hotelSlug: booking.hotel_slug,
      summary: buildRoomCheckoutSummary({
        booking,
        room,
        foodOrders: foodOrders || []
      })
    });
  } catch (error) {
    console.error("Admin room checkout summary fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch room checkout summary"
    });
  }
});

router.post(
  "/bookings/:id/combined-checkout",
  requireAdminCombinedBilling,
  requireRoomCombinedCheckoutEnabled,
  validateBody(roomCombinedCheckoutSchema),
  adminRoomCombinedCheckoutHandler
);

router.get("/bookings/:id/payments", async (req, res) => {
  try {
    const bookingId = normalizeText(req.params.id, 80);
    const hotelSlug = normalizeText(req.query?.hotelSlug, 120);
    const bookingResult = await fetchBookingForAdmin({ bookingId, hotelSlug });
    if (!bookingResult.ok) {
      return res.status(bookingResult.status).json({ success: false, message: bookingResult.message });
    }
    const { data, error } = await supabase
      .from("room_booking_payments")
      .select("*")
      .eq("hotel_slug", bookingResult.booking.hotel_slug)
      .eq("booking_id", bookingResult.booking.id)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return res.json({
      success: true,
      payments: data || [],
      summary: buildAdvanceSummary({ booking: bookingResult.booking, payments: data || [] })
    });
  } catch (error) {
    console.error("Room booking payment history error:", error);
    return res.status(500).json({ success: false, message: "Failed to load Room payment history" });
  }
});

router.get("/bookings/:bookingId/payments/:paymentId/receipt", async (req, res) => {
  try {
    const bookingId = normalizeText(req.params.bookingId, 80);
    const paymentId = normalizeText(req.params.paymentId, 80);
    const hotelSlug = normalizeText(req.query?.hotelSlug, 120);
    const bookingResult = await fetchBookingForAdmin({ bookingId, hotelSlug });
    if (!bookingResult.ok) {
      return res.status(bookingResult.status).json({ success: false, message: bookingResult.message });
    }
    const { data: payment, error } = await supabase
      .from("room_booking_payments")
      .select("*")
      .eq("id", paymentId)
      .eq("booking_id", bookingResult.booking.id)
      .eq("hotel_slug", bookingResult.booking.hotel_slug)
      .maybeSingle();
    if (error) throw error;
    if (!payment) {
      return res.status(404).json({ success: false, message: "Advance receipt not found for this hotel and booking" });
    }
    return res.json({
      success: true,
      receipt: buildRoomAdvanceReceipt({ booking: bookingResult.booking, payment })
    });
  } catch (error) {
    console.error("Room advance receipt error:", error);
    return res.status(500).json({ success: false, message: "Failed to prepare advance receipt" });
  }
});

router.post(
  "/bookings/:id/payments",
  validateBody(adminRoomBookingPaymentSchema),
  async (req, res) => {
    let createdPayment = null;

    try {
      const bookingId = normalizeText(req.params.id, 80);
      const {
        hotelSlug = "",
        amount,
        paymentMethod,
        paymentStatus = "paid",
        transactionId,
        notes,
        idempotencyKey
      } = req.validatedBody;

      if (!bookingId) {
        return res.status(400).json({
          success: false,
          message: "Room booking id is required"
        });
      }

      const bookingResult = await fetchBookingForAdmin({ bookingId, hotelSlug });

      if (!bookingResult.ok) {
        return res.status(bookingResult.status).json({
          success: false,
          message: bookingResult.message
        });
      }

      const currentBooking = bookingResult.booking;

      const safeIdempotencyKey = normalizeText(
        idempotencyKey || req.get("Idempotency-Key") || "",
        200
      );
      if (paymentStatus === "paid") {
        const actorId = req.adminUser?.sub || req.adminUser?.id || null;
        const { data: atomicResult, error: atomicError } = await supabase.rpc(
          "record_room_booking_payment",
          {
            p_hotel_slug: currentBooking.hotel_slug,
            p_booking_id: Number(currentBooking.id),
            p_amount: roundMoney(amount),
            p_payment_method: paymentMethod,
            p_transaction_id: transactionId || "",
            p_notes: notes || "",
            p_idempotency_key: safeIdempotencyKey,
            p_actor_id: actorId,
            p_actor_role: "platform_admin"
          }
        );
        const missingRpc = atomicError &&
          ["PGRST202", "42883"].includes(String(atomicError.code || "").toUpperCase());
        if (atomicError && !missingRpc) throw atomicError;
        if (!atomicError) {
          const refreshed = await fetchBookingForAdmin({
            bookingId,
            hotelSlug: currentBooking.hotel_slug
          });
          if (!refreshed.ok) {
            return res.status(refreshed.status).json({ success: false, message: refreshed.message });
          }
          return res.status(atomicResult?.idempotent ? 200 : 201).json({
            success: true,
            idempotent: atomicResult?.idempotent === true,
            message: atomicResult?.idempotent ? "Room booking payment already recorded" : "Room booking payment recorded",
            booking: refreshed.booking,
            payment: atomicResult?.payment || null
          });
        }
      }

      if (paymentStatus === "paid" && currentBooking.booking_status === "cancelled") {
        return res.status(409).json({
          success: false,
          message: "Cannot collect payment for a cancelled booking"
        });
      }

      const currentAdvancePaid = Number(currentBooking.advance_paid || 0);
      const currentTotalAmount = Number(currentBooking.total_amount || 0);
      const storedBalanceAmount = currentBooking.balance_amount;
      const hasStoredBalanceAmount =
        storedBalanceAmount !== null &&
        storedBalanceAmount !== undefined &&
        Number.isFinite(Number(storedBalanceAmount));
      const currentBalanceAmount = roundMoney(
        Math.max(
          0,
          hasStoredBalanceAmount
            ? Number(storedBalanceAmount)
            : currentTotalAmount - currentAdvancePaid
        )
      );
      const requestedAmount = roundMoney(amount);

      if (currentBalanceAmount <= 0) {
        return res.status(409).json({
          success: false,
          message: "Room booking is already paid"
        });
      }

      if (requestedAmount > currentBalanceAmount) {
        return res.status(400).json({
          success: false,
          message: "Payment amount cannot be greater than the current room booking balance"
        });
      }

      const paidAt = paymentStatus === "paid" ? new Date().toISOString() : null;
      const { data: payment, error: paymentError } = await supabase
        .from("room_booking_payments")
        .insert([
          {
            hotel_slug: currentBooking.hotel_slug,
            booking_id: currentBooking.id,
            amount: requestedAmount,
            payment_method: paymentMethod,
            payment_status: paymentStatus,
            transaction_id: transactionId || null,
            notes: notes || "",
            paid_at: paidAt,
            updated_at: new Date().toISOString()
          }
        ])
        .select()
        .single();

      if (paymentError) {
        if (isMissingRoomBookingSchemaError(paymentError)) {
          return buildMissingSchemaResponse(res);
        }

        throw paymentError;
      }

      createdPayment = payment;

      const nextAdvancePaid = roundMoney(currentAdvancePaid + requestedAmount);
      const nextBalanceAmount = roundMoney(
        Math.max(0, currentTotalAmount - nextAdvancePaid)
      );
      const nextPaymentStatus = getPaymentStatusFromAmounts({
        advancePaid: nextAdvancePaid,
        totalAmount: currentTotalAmount
      });

      const { data: updatedBooking, error: bookingUpdateError } = await supabase
        .from("room_bookings")
        .update({
          advance_paid: nextAdvancePaid,
          balance_amount: nextBalanceAmount,
          payment_status: nextPaymentStatus,
          updated_at: new Date().toISOString()
        })
        .eq("id", currentBooking.id)
        .eq("hotel_slug", currentBooking.hotel_slug)
        .select()
        .maybeSingle();

      if (bookingUpdateError || !updatedBooking) {
        await supabase
          .from("room_booking_payments")
          .delete()
          .eq("id", createdPayment.id)
          .eq("hotel_slug", currentBooking.hotel_slug);

        if (bookingUpdateError && isMissingRoomBookingSchemaError(bookingUpdateError)) {
          return buildMissingSchemaResponse(res);
        }

        if (!updatedBooking) {
          return res.status(404).json({
            success: false,
            message: "Room booking not found"
          });
        }

        throw bookingUpdateError;
      }

      res.status(201).json({
        success: true,
        message: "Room booking payment recorded",
        booking: updatedBooking,
        payment: createdPayment
      });
    } catch (error) {
      const message = String(error?.message || "");
      if (message.includes("ROOM_PAYMENT_EXCEEDS_BALANCE")) {
        return res.status(409).json({
          success: false,
          code: "ROOM_PAYMENT_EXCEEDS_BALANCE",
          message: "Payment amount exceeds the latest Room booking balance. Refresh and retry."
        });
      }
      if (message.includes("ROOM_PAYMENT_CANCELLED_BOOKING")) {
        return res.status(409).json({ success: false, code: "ROOM_PAYMENT_CANCELLED_BOOKING", message: "Cannot collect payment for a cancelled booking." });
      }
      if (message.includes("ROOM_PAYMENT_IDEMPOTENCY_REQUIRED")) {
        return res.status(400).json({
          success: false,
          code: "ROOM_PAYMENT_IDEMPOTENCY_REQUIRED",
          message: "A payment retry key is required. Refresh this booking and retry the payment."
        });
      }
      if (message.includes("ROOM_ADVANCE_METHOD_DISABLED")) {
        return res.status(409).json({
          success: false,
          code: "ROOM_ADVANCE_METHOD_DISABLED",
          message: "This payment method is currently unavailable for this hotel."
        });
      }
      if (message.includes("ROOM_MULTIPLE_ADVANCES_DISABLED")) {
        return res.status(409).json({
          success: false,
          code: "ROOM_MULTIPLE_ADVANCES_DISABLED",
          message: "Multiple advance payments are disabled for this hotel."
        });
      }
      if (message.includes("ROOM_PAYMENT_IDEMPOTENCY_CONFLICT")) {
        return res.status(409).json({
          success: false,
          code: "ROOM_PAYMENT_IDEMPOTENCY_CONFLICT",
          message: "This payment retry key was already used with different payment details."
        });
      }
      if (message.includes("ROOM_PAYMENT_IDEMPOTENCY_SCOPE_CONFLICT")) {
        return res.status(409).json({
          success: false,
          code: "ROOM_PAYMENT_IDEMPOTENCY_SCOPE_CONFLICT",
          message: "This payment retry key belongs to another Room booking. Refresh and retry."
        });
      }
      console.error("Room booking payment create error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to record room booking payment"
      });
    }
  }
);

module.exports = router;
