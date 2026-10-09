const express = require("express");
const { ZodError } = require("zod");
const {
  requireStaffAuth,
  requireStaffManagerAccess
} = require("../middleware/require-staff-auth");
const { validateBody, formatZodError } = require("../validators/common");
const {
  adminRoomBookingPaymentSchema,
  adminRoomBookingStatusUpdateSchema,
  roomCombinedCheckoutSchema,
  roomAdvancePolicySchema,
  staffRoomAvailabilityQuerySchema,
  staffRoomBookingCreateSchema,
  staffRoomBookingListQuerySchema
} = require("../validators/rooms");
const { roomRefundSchema } = require("../validators/room-tax");
const { env } = require("../config/env");
const { supabase } = require("../utils/supabase");
const { getStaffTenantMutationClient } = require("../utils/tenant-route-database");
const {
  getRoomDefaultNightlyPrice,
  resolveRoomBookingPricing
} = require("../utils/room-pricing");
const { buildRoomRefundCreditNote } = require("../utils/room-credit-note");
const {
  findRoomBookingByIdempotency,
  getRoomIdempotencyKey,
  isRoomIdempotencyConflict
} = require("../utils/room-idempotency");
const {
  requireHotelFeature,
  resolveStaffHotelSlug
} = require("../middleware/require-hotel-feature");
const {
  createRoomCombinedCheckoutFeatureGate,
  createRoomCombinedCheckoutHandler,
  resolveStaffCombinedCheckoutContext
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
  hashRoomAdvanceRequest,
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
} = require("../utils/room-availability");const {
  getRoomBookingSourceFilterValues,
  getRoomBookingSourceGroup,
  getRoomBookingSourceLabel
} = require("../utils/room-booking-source");

const router = express.Router();
const STAFF_BOOKING_STATUS_TRANSITIONS = Object.freeze({
  pending: Object.freeze(["pending", "confirmed", "cancelled", "no_show"]),
  confirmed: Object.freeze(["confirmed", "checked_in", "cancelled", "no_show"]),
  checked_in: Object.freeze(["checked_in", "checked_out"]),
  checked_out: Object.freeze(["checked_out"]),
  cancelled: Object.freeze(["cancelled"]),
  no_show: Object.freeze(["no_show"])
});
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
const requireStaffRoomModule = requireHotelFeature("rooms", {
  resolveHotelSlug: resolveStaffHotelSlug
});
const requireStaffCombinedBilling = requireHotelFeature("combined_billing", {
  resolveHotelSlug: resolveStaffHotelSlug
});
const staffRoomCombinedCheckoutHandler =
  createRoomCombinedCheckoutHandler({
    supabaseClient: supabase,
    resolveDatabaseClient: (req) => (
      req.tenantMutationDatabase ||
      getStaffTenantMutationClient(req, supabase)
    ),
    resolveRequestContext: resolveStaffCombinedCheckoutContext
  });

router.use(requireStaffAuth);
router.use(requireStaffRoomModule);
router.use(async (req, res, next) => {
  try {
    req.tenantMutationDatabase = await getStaffTenantMutationClient(req, supabase);
    return next();
  } catch (error) {
    return next(error);
  }
});

function mutationDatabase(req) {
  return req.tenantMutationDatabase || supabase;
}

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

function calculateRoomBookingTotals({ room, checkInDate, checkOutDate }) {
  const totalNights = getTotalNights(checkInDate, checkOutDate);
  const roomPrice = roundMoney(getEffectiveRoomNightlyPrice(room) * totalNights);
  const taxPercent = Math.min(Math.max(Number(room.tax_percent || 0), 0), 100);
  const taxAmount = roundMoney((roomPrice * taxPercent) / 100);
  const discountAmount = 0;
  const totalAmount = roundMoney(roomPrice + taxAmount - discountAmount);

  return {
    totalNights,
    roomPrice,
    taxAmount,
    discountAmount,
    totalAmount,
    advancePaid: 0,
    balanceAmount: totalAmount,
    paymentStatus: "unpaid"
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

function isStaffManager(req = {}) {
  return !!(req.staffCanViewManagerData || req.staffUser?.isManager);
}

function buildStaffRoomResponse(room = {}, canViewFinancial = false) {
  const response = { ...room };

  if (!canViewFinancial) {
    delete response.base_price;
    delete response.discount_price;
    delete response.tax_percent;
  }

  return response;
}

function buildStaffBookingResponse(booking = {}, canViewFinancial = false) {
  const response = {
    ...booking,
    booking_source_group: getRoomBookingSourceGroup(booking.booking_source),
    booking_source_label: getRoomBookingSourceLabel(booking.booking_source)
  };

  if (!canViewFinancial) {
    delete response.room_price;
    delete response.tax_amount;
    delete response.discount_amount;
    delete response.total_amount;
    delete response.advance_paid;
    delete response.balance_amount;
    delete response.payment_status;
    delete response.rate_plan_id;
    delete response.pricing_snapshot;
    delete response.tax_rule_id;
    delete response.tax_snapshot;
    delete response.pricing_version;
  }

  return response;
}

const ROOM_BOOKING_SUMMARY_SELECT = [
  "id",
  "room_id",
  "guest_name",
  "check_in_date",
  "check_out_date",
  "total_nights",
  "adults",
  "children",
  "booking_status",
  "booking_source",
  "created_at",
  "updated_at",
  "payment_status",
  "advance_paid",
  "balance_amount",
  "rooms!room_bookings_room_id_fkey!inner(id,hotel_slug,room_number,title,room_type_id,floor)"
].join(",");

function buildStaffBookingDetailResponse(booking = {}, canViewFinancial = false) {
  const response = {
    id: booking.id,
    room_id: booking.room_id,
    previous_room_id: booking.previous_room_id || null,
    guest_name: booking.guest_name,
    guest_phone: booking.guest_phone,
    guest_email: booking.guest_email,
    check_in_date: booking.check_in_date,
    check_out_date: booking.check_out_date,
    adults: Number(booking.adults || 0),
    children: Number(booking.children || 0),
    total_nights: Number(booking.total_nights || 0),
    booking_status: booking.booking_status,
    booking_source: booking.booking_source,
    booking_source_group: getRoomBookingSourceGroup(booking.booking_source),
    booking_source_label: getRoomBookingSourceLabel(booking.booking_source),
    notes: booking.notes || "",
    checked_in_at: booking.checked_in_at || null,
    checked_out_at: booking.checked_out_at || null,
    cancelled_at: booking.cancelled_at || null,
    created_at: booking.created_at,
    updated_at: booking.updated_at,
    version: booking.updated_at || booking.created_at || ""
  };

  if (canViewFinancial) {
    Object.assign(response, {
      guest_id_proof: booking.guest_id_proof || "",
      guest_company_name: booking.guest_company_name || "",
      guest_gstin: booking.guest_gstin || "",
      guest_place_of_supply: booking.guest_place_of_supply || "",
      room_price: Number(booking.room_price || 0),
      tax_amount: Number(booking.tax_amount || 0),
      discount_amount: Number(booking.discount_amount || 0),
      total_amount: Number(booking.total_amount || 0),
      advance_paid: Number(booking.advance_paid || 0),
      balance_amount: Number(booking.balance_amount || 0),
      payment_status: booking.payment_status,
      rate_plan_id: booking.rate_plan_id || null,
      pricing_snapshot: booking.pricing_snapshot || {},
      tax_rule_id: booking.tax_rule_id || null,
      tax_snapshot: booking.tax_snapshot || {},
      pricing_version: booking.pricing_version || null
    });
  }

  return response;
}

function buildStaffRoomDetailResponse(room = {}, canViewFinancial = false) {
  const response = {
    id: room.id,
    room_number: room.room_number,
    title: room.title,
    room_type_id: room.room_type_id || null,
    floor: room.floor || "",
    floor_id: room.floor_id || null,
    capacity: room.capacity || room.max_adults || null,
    bed_type: room.bed_type || "",
    status: room.status,
    is_active: room.is_active !== false
  };

  if (canViewFinancial) {
    response.base_price = room.base_price;
    response.discount_price = room.discount_price;
    response.tax_percent = room.tax_percent;
  }

  return response;
}

function getRoomBookingActionRequired(booking = {}, canViewFinancial = false) {
  const status = normalizeText(booking.booking_status, 40).toLowerCase() || "pending";
  const today = new Date().toISOString().slice(0, 10);

  if (status === "pending") return "Confirm booking";
  if (status === "confirmed" && booking.check_in_date && booking.check_in_date <= today) {
    return "Check-in due";
  }
  if (status === "checked_in" && booking.check_out_date && booking.check_out_date <= today) {
    return "Checkout due";
  }
  if (canViewFinancial && Number(booking.balance_amount || 0) > 0) return "Collect balance";
  return "";
}

function buildStaffBookingSummary(booking = {}, canViewFinancial = false) {
  const room = booking.rooms && typeof booking.rooms === "object" ? booking.rooms : {};
  const actionRequired = getRoomBookingActionRequired(booking, canViewFinancial);
  const summary = {
    id: booking.id,
    booking_reference: "#" + booking.id,
    booking_source: booking.booking_source,
    booking_source_group: getRoomBookingSourceGroup(booking.booking_source),
    booking_source_label: getRoomBookingSourceLabel(booking.booking_source),
    guest_name: booking.guest_name,
    check_in_date: booking.check_in_date,
    check_out_date: booking.check_out_date,
    total_nights: Number(booking.total_nights || getTotalNights(booking.check_in_date, booking.check_out_date) || 0),
    adults: Number(booking.adults || 0),
    children: Number(booking.children || 0),
    room_id: booking.room_id,
    room_number: room.room_number || "",
    room_type: room.title || room.room_type_id || "",
    room_floor: room.floor || "",
    booking_status: booking.booking_status,
    created_at: booking.created_at,
    updated_at: booking.updated_at,
    version: booking.updated_at || booking.created_at || "",
    action_required: actionRequired || null
  };

  if (canViewFinancial) {
    summary.payment_status = booking.payment_status;
    summary.advance_paid = Number(booking.advance_paid || 0);
    summary.balance_amount = Number(booking.balance_amount || 0);
  }

  return summary;
}

function buildRoomBookingActivity({ booking = {}, payments = [], refunds = [], auditRows = [] } = {}) {
  const activity = [];
  const add = (type, label, timestamp, extra = {}) => {
    if (!timestamp) return;
    activity.push({ type, label, timestamp, ...extra });
  };

  add("booking_created", "Booking created", booking.created_at, {
    actorRole: booking.created_by_role || "",
    source: getRoomBookingSourceLabel(booking.booking_source)
  });
  add("checked_in", "Guest checked in", booking.checked_in_at);
  add("checked_out", "Guest checked out", booking.checked_out_at);
  add("cancelled", "Booking cancelled", booking.cancelled_at);

  payments.forEach((payment) => add(
    "payment",
    "Payment " + (normalizeText(payment.payment_status, 40) || "recorded"),
    payment.paid_at || payment.created_at,
    { amount: Number(payment.amount || 0), paymentMethod: payment.payment_method || "" }
  ));
  refunds.forEach((refund) => add(
    "refund",
    "Refund " + (normalizeText(refund.status, 40) || "recorded"),
    refund.created_at,
    { amount: Number(refund.amount || 0), paymentMethod: refund.payment_method || "" }
  ));
  auditRows.forEach((row) => {
    const action = normalizeText(row.action, 80) || "booking_updated";
    const label = action
      .replace(/_/g, " ")
      .replace(/\b\w/g, (character) => character.toUpperCase());
    add(action, label, row.created_at, {
      actorRole: normalizeText(row.actor_role, 80),
      reason: normalizeText(row.reason, 500)
    });
  });

  return activity.sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
}

async function fetchFeatureSettings(hotelSlug = "") {
  const { data, error } = await supabase
    .from("hotel_feature_settings")
    .select("hotel_slug,enable_room_booking")
    .eq("hotel_slug", hotelSlug)
    .maybeSingle();

  if (error) throw error;

  return {
    schemaReady: true,
    roomBookingEnabled: data?.enable_room_booking === true
  };
}

async function ensureRoomBookingFeatureEnabled(res, hotelSlug = "") {
  try {
    const settings = await fetchFeatureSettings(hotelSlug);

    if (!settings.roomBookingEnabled) {
      res.status(403).json({
        success: false,
        code: "ROOM_BOOKING_DISABLED",
        message: "Room booking is not enabled for this hotel"
      });
      return false;
    }

    return true;
  } catch (error) {
    if (isMissingRoomBookingSchemaError(error)) {
      buildMissingSchemaResponse(res);
      return false;
    }

    throw error;
  }
}

async function ensureNegotiatedRateInfrastructure(res) {
  const { data, error } = await supabase.rpc("room_negotiated_rate_ready");

  if (error || data !== true) {
    res.status(503).json({
      success: false,
      code: "ROOM_NEGOTIATED_RATE_SCHEMA_REQUIRED",
      message: "Negotiated Room rates are not enabled yet. Apply and verify the negotiated-rate migration first."
    });
    return false;
  }

  return true;
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

async function hasOtherBlockingBooking({
  hotelSlug,
  roomId,
  bookingId,
  checkInDate,
  checkOutDate
}) {
  const { data, error } = await applyActiveBookingOverlapFilter(
    supabase
      .from("room_bookings")
      .select("id")
      .eq("hotel_slug", hotelSlug)
      .eq("room_id", roomId)
      .neq("id", bookingId),
    { checkInDate, checkOutDate }
  ).limit(1);

  if (error) throw error;

  return Array.isArray(data) && data.length > 0;
}

function getStaffRoomLiveStatus(room = {}, blockingBooking = null) {
  const roomStatus = normalizeText(room.status, 40).toLowerCase() || "available";
  const bookingStatus = normalizeText(blockingBooking?.booking_status, 40).toLowerCase();

  if (room.is_active === false || roomStatus === "inactive") return "inactive";
  if (roomStatus === "maintenance") return "maintenance";
  if (roomStatus === "cleaning") return "cleaning";
  if (bookingStatus === "checked_in") return "occupied";
  if (bookingStatus === "pending") return "pending";
  if (bookingStatus === "confirmed") return "booked";
  return "available";
}

function buildStaffBlockingBookingResponse(booking = {}, canViewFinancial = false) {
  const response = buildStaffBookingResponse(
    {
      id: booking.id,
      room_id: booking.room_id,
      check_in_date: booking.check_in_date,
      check_out_date: booking.check_out_date,
      booking_status: booking.booking_status,
      payment_status: booking.payment_status,
      booking_source: booking.booking_source,
      created_at: booking.created_at,
      updated_at: booking.updated_at
    },
    canViewFinancial
  );

  return response;
}

async function fetchBookingForStaff({ bookingId, hotelSlug = "" }) {
  const { data, error } = await supabase
    .from("room_bookings")
    .select("*")
    .eq("id", bookingId)
    .eq("hotel_slug", hotelSlug)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    return {
      ok: false,
      status: 404,
      message: "Room booking not found for this hotel"
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

router.get("/advance-policy", async (req, res) => {
  try {
    const hotelSlug = normalizeText(req.staffHotelSlug, 120);
    const policy = await fetchRoomAdvancePolicy({ supabaseClient: supabase, hotelSlug });
    return res.json({ success: true, policy });
  } catch (error) {
    console.error("Room advance policy fetch error:", error);
    return res.status(500).json({ success: false, message: "Failed to load Room advance policy" });
  }
});

router.put(
  "/advance-policy",
  requireStaffManagerAccess,
  validateBody(roomAdvancePolicySchema),
  async (req, res) => {
    try {
      const hotelSlug = normalizeText(req.staffHotelSlug, 120);
      const body = req.validatedBody;
      const current = await fetchRoomAdvancePolicy({ supabaseClient: supabase, hotelSlug });
      if (current.schemaReady && Number(body.version) !== Number(current.version)) {
        return res.status(409).json({
          success: false,
          code: "ROOM_ADVANCE_POLICY_CHANGED",
          message: "The Room advance policy was updated by another user. Reload and retry.",
          policy: current
        });
      }
      const payload = {
        hotel_slug: hotelSlug,
        advance_mode: body.advanceMode,
        minimum_type: body.minimumType,
        minimum_value: body.minimumValue,
        allow_zero_advance: body.allowZeroAdvance,
        allow_multiple_payments: body.allowMultiplePayments,
        allow_split_payments: body.allowSplitPayments,
        allow_staff_advance: body.allowStaffAdvance,
        allowed_payment_methods: body.allowedPaymentMethods,
        currency: body.currency,
        automatic_cancellation_enabled: false,
        version: current.schemaReady ? current.version + 1 : 1,
        updated_by: req.staffUser?.sub || req.staffUser?.id || null,
        updated_at: new Date().toISOString()
      };
      const query = mutationDatabase(req).from("hotel_room_advance_policies");
      const result = current.recordExists
        ? await query.update(payload).eq("hotel_slug", hotelSlug).eq("version", current.version).select().maybeSingle()
        : await query.insert([payload]).select().single();
      if (result.error) {
        if (isMissingAdvanceSchemaError(result.error)) {
          return res.status(409).json({
            success: false,
            code: "ROOM_ADVANCE_SCHEMA_REQUIRED",
            message: "Apply the Manual Room Booking Advance Payment migration before saving policy."
          });
        }
        throw result.error;
      }
      if (!result.data) {
        return res.status(409).json({
          success: false,
          code: "ROOM_ADVANCE_POLICY_CHANGED",
          message: "The Room advance policy was updated by another user. Reload and retry."
        });
      }
      return res.json({
        success: true,
        message: "Room advance policy saved",
        policy: normalizeRoomAdvancePolicy(result.data)
      });
    } catch (error) {
      console.error("Room advance policy save error:", error);
      return res.status(500).json({ success: false, message: "Failed to save Room advance policy" });
    }
  }
);

router.get("/rooms", async (req, res) => {
  try {
    const hotelSlug = normalizeText(req.staffHotelSlug, 120);

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    if (!(await ensureRoomBookingFeatureEnabled(res, hotelSlug))) {
      return;
    }

    const { data, error } = await supabase
      .from("rooms")
      .select("*")
      .eq("hotel_slug", hotelSlug)
      .order("room_number", { ascending: true });

    if (error) {
      if (isMissingRoomBookingSchemaError(error)) {
        return buildMissingSchemaResponse(res);
      }

      throw error;
    }

    const canViewFinancial = isStaffManager(req);

    res.json({
      success: true,
      hotelSlug,
      count: data.length,
      rooms: data.map((room) => buildStaffRoomResponse(room, canViewFinancial))
    });
  } catch (error) {
    console.error("Staff rooms fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch rooms"
    });
  }
});

router.get("/operations", async (req, res) => {
  try {
    const hotelSlug = normalizeText(req.staffHotelSlug, 120);
    const parsedQuery = parseQuery(staffRoomAvailabilityQuerySchema, req.query);

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    if (parsedQuery.errors) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: parsedQuery.errors
      });
    }

    if (!(await ensureRoomBookingFeatureEnabled(res, hotelSlug))) {
      return;
    }

    const { checkInDate, checkOutDate } = parsedQuery.values;
    const { data: rooms, error: roomsError } = await supabase
      .from("rooms")
      .select("*")
      .eq("hotel_slug", hotelSlug)
      .order("room_number", { ascending: true });

    if (roomsError) throw roomsError;

    const roomIds = (rooms || []).map((room) => room.id);
    let blockingBookings = [];

    if (roomIds.length) {
      const { data, error } = await applyActiveBookingOverlapFilter(
        supabase
          .from("room_bookings")
          .select("id,room_id,check_in_date,check_out_date,booking_status,payment_status,booking_source,created_at,updated_at")
          .eq("hotel_slug", hotelSlug)
          .in("room_id", roomIds),
        { checkInDate, checkOutDate }
      ).order("check_in_date", { ascending: true });

      if (error) throw error;
      blockingBookings = data || [];
    }

    const canViewFinancial = isStaffManager(req);
    const maintenanceBlockedRoomIds = await fetchMaintenanceBlockedRoomIds({
      supabaseClient: supabase,
      hotelSlug,
      roomIds,
      checkInDate,
      checkOutDate
    });
    const bookingByRoomId = new Map(
      blockingBookings.map((booking) => [String(booking.room_id), booking])
    );
    const operationRooms = (rooms || []).map((room) => {
      const blockingBooking = bookingByRoomId.get(String(room.id)) || null;

      return {
        ...buildStaffRoomResponse(room, canViewFinancial),
        operationalStatus: normalizeText(room.status, 40).toLowerCase() || "available",
        liveStatus: maintenanceBlockedRoomIds.has(String(room.id))
          ? "maintenance"
          : getStaffRoomLiveStatus(room, blockingBooking),
        blockingBooking: blockingBooking
          ? buildStaffBlockingBookingResponse(blockingBooking, canViewFinancial)
          : null
      };
    });

    res.json({
      success: true,
      hotelSlug,
      checkInDate,
      checkOutDate,
      financialsVisible: canViewFinancial,
      count: operationRooms.length,
      rooms: operationRooms,
      floors: [...new Set(operationRooms.map((room) => room.floor || "Unassigned"))]
        .sort((left, right) => String(left).localeCompare(String(right), undefined, { numeric: true }))
        .map((floor) => ({
          name: floor,
          rooms: operationRooms.filter((room) => (room.floor || "Unassigned") === floor)
        }))
    });
  } catch (error) {
    if (isMissingRoomBookingSchemaError(error)) {
      return buildMissingSchemaResponse(res);
    }

    console.error("Staff room operations fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch room operations"
    });
  }
});

router.get("/availability", async (req, res) => {
  try {
    const hotelSlug = normalizeText(req.staffHotelSlug, 120);
    const parsedQuery = parseQuery(staffRoomAvailabilityQuerySchema, req.query);

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    if (parsedQuery.errors) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: parsedQuery.errors
      });
    }

    if (!(await ensureRoomBookingFeatureEnabled(res, hotelSlug))) {
      return;
    }

    const {
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
    const canViewFinancial = isStaffManager(req);
    const availableRooms = (rooms || [])
      .filter((room) =>
        !blockedRoomIds.has(String(room.id)) &&
        !maintenanceBlockedRoomIds.has(String(room.id))
      )
      .map((room) => buildStaffRoomResponse(room, canViewFinancial));

    res.json({
      success: true,
      hotelSlug,
      checkInDate,
      checkOutDate,
      count: availableRooms.length,
      rooms: availableRooms
    });
  } catch (error) {
    console.error("Staff room availability fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch room availability"
    });
  }
});

async function fetchRoomBookingSourceSummary(hotelSlug = "") {
  const rpcResult = await supabase.rpc("get_room_booking_source_summary", {
    p_hotel_slug: hotelSlug
  });

  if (!rpcResult.error) {
    const rows = Array.isArray(rpcResult.data) ? rpcResult.data : [];
    return rows.reduce(
      (summary, row) => {
        const group = ["website", "manual", "legacy"].includes(row.source_group)
          ? row.source_group
          : "legacy";
        summary[group] = {
          total: Math.max(0, Number(row.total_count || 0) || 0),
          pending: Math.max(0, Number(row.pending_count || 0) || 0),
          today: Math.max(0, Number(row.today_count || 0) || 0)
        };
        return summary;
      },
      {
        website: { total: 0, pending: 0, today: 0 },
        manual: { total: 0, pending: 0, today: 0 },
        legacy: { total: 0, pending: 0, today: 0 }
      }
    );
  }

  const rpcCode = String(rpcResult.error?.code || "").toUpperCase();
  if (!["42883", "PGRST202"].includes(rpcCode)) throw rpcResult.error;

  const knownSources = [
    ...getRoomBookingSourceFilterValues("website"),
    ...getRoomBookingSourceFilterValues("manual")
  ].join(",");
  const applySourceGroup = (query, group) => {
    if (group === "legacy") {
      return query.or(`booking_source.is.null,booking_source.not.in.(${knownSources})`);
    }
    return query.in("booking_source", getRoomBookingSourceFilterValues(group));
  };
  const countRows = async (group, mode = "total") => {
    let query = applySourceGroup(
      supabase.from("room_bookings").select("id", { count: "exact", head: true }).eq("hotel_slug", hotelSlug),
      group
    );
    if (mode === "pending") query = query.eq("booking_status", "pending");
    if (mode === "today") query = query.gte("created_at", `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    const result = await query;
    if (result.error) throw result.error;
    return Math.max(0, Number(result.count || 0) || 0);
  };
  const groups = ["website", "manual", "legacy"];
  const counts = await Promise.all(
    groups.flatMap((group) => ["total", "pending", "today"].map((mode) => countRows(group, mode)))
  );
  return Object.fromEntries(
    groups.map((group, index) => [group, { total: counts[index * 3], pending: counts[index * 3 + 1], today: counts[index * 3 + 2] }])
  );
}

router.get("/bookings", async (req, res) => {
  try {
    const hotelSlug = normalizeText(req.staffHotelSlug, 120);
    const parsedQuery = parseQuery(staffRoomBookingListQuerySchema, req.query);

    if (!hotelSlug) {
      return res.status(403).json({ success: false, message: "Staff hotel scope is missing" });
    }
    if (parsedQuery.errors) {
      return res.status(400).json({ success: false, message: "Validation failed", errors: parsedQuery.errors });
    }
    if (!(await ensureRoomBookingFeatureEnabled(res, hotelSlug))) return;

    const {
      status,
      paymentStatus,
      source,
      fromDate,
      toDate,
      search,
      sort = "created_desc",
      page = 1,
      limit = 25
    } = parsedQuery.values;
    const canViewFinancial = isStaffManager(req);
    if ((paymentStatus || sort === "payment_status") && !canViewFinancial) {
      return res.status(403).json({
        success: false,
        code: "ROOM_FINANCIAL_FILTER_MANAGER_REQUIRED",
        message: "Only a Manager may filter Room bookings by payment status"
      });
    }

    let query = supabase
      .from("room_bookings")
      .select(ROOM_BOOKING_SUMMARY_SELECT, { count: "exact" })
      .eq("hotel_slug", hotelSlug)
      .eq("rooms.hotel_slug", hotelSlug);

    if (status) query = query.eq("booking_status", status);
    if (paymentStatus) query = query.eq("payment_status", paymentStatus);
    if (fromDate) query = query.gte("check_in_date", fromDate);
    if (toDate) query = query.lte("check_in_date", toDate);
    if (search) {
      const searchFilters = [
        "guest_name.ilike.%" + search + "%",
        "guest_phone.ilike.%" + search + "%",
        "guest_email.ilike.%" + search + "%"
      ];
      const roomSearchResult = await supabase
        .from("rooms")
        .select("id")
        .eq("hotel_slug", hotelSlug)
        .or("room_number.ilike.%" + search + "%,title.ilike.%" + search + "%")
        .limit(100);
      if (roomSearchResult.error) throw roomSearchResult.error;
      const matchingRoomIds = (roomSearchResult.data || [])
        .map((room) => Number(room.id))
        .filter((roomId) => Number.isSafeInteger(roomId) && roomId > 0);
      if (matchingRoomIds.length) {
        searchFilters.push("room_id.in.(" + matchingRoomIds.join(",") + ")");
      }
      const referenceSearch = String(search).replace(/^#/, "");
      if (/^\d+$/.test(referenceSearch)) searchFilters.unshift("id.eq." + referenceSearch);
      query = query.or(searchFilters.join(","));
    }
    if (source === "legacy") {
      const knownSources = [
        ...getRoomBookingSourceFilterValues("website"),
        ...getRoomBookingSourceFilterValues("manual")
      ].join(",");
      query = query.or(`booking_source.is.null,booking_source.not.in.(${knownSources})`);
    } else if (source) {
      const sourceValues = getRoomBookingSourceFilterValues(source);
      if (sourceValues.length) query = query.in("booking_source", sourceValues);
    }

    const sortMap = {
      created_desc: ["created_at", false],
      created_asc: ["created_at", true],
      check_in_asc: ["check_in_date", true],
      check_in_desc: ["check_in_date", false],
      action_required: ["booking_status", false],
      payment_status: ["payment_status", true]
    };
    const [sortColumn, ascending] = sortMap[sort] || sortMap.created_desc;
    query = query.order(sortColumn, { ascending });
    if (sortColumn !== "created_at") {
      query = query.order("created_at", { ascending: false });
    }
    query = query.range((page - 1) * limit, page * limit - 1);

    const [{ data, error, count }, sourceSummary] = await Promise.all([
      query,
      fetchRoomBookingSourceSummary(hotelSlug)
    ]);
    if (error) {
      if (isMissingRoomBookingSchemaError(error)) return buildMissingSchemaResponse(res);
      throw error;
    }

    const total = Math.max(0, Number(count || 0) || 0);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    res.set("Cache-Control", "private, no-store");
    res.json({
      success: true,
      hotelSlug,
      count: (data || []).length,
      total,
      source: source || "all",
      sourceSummary,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasPrevious: page > 1,
        hasNext: page < totalPages
      },
      contract: "room-booking-summary-v1",
      bookings: (data || []).map((booking) => buildStaffBookingSummary(booking, canViewFinancial))
    });
  } catch (error) {
    console.error("Staff room bookings fetch error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch room bookings" });
  }
});

router.post("/bookings", validateBody(staffRoomBookingCreateSchema), async (req, res) => {
  try {
    const hotelSlug = normalizeText(req.staffHotelSlug, 120);

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    if (!(await ensureRoomBookingFeatureEnabled(res, hotelSlug))) {
      return;
    }

    const idempotency = getRoomIdempotencyKey(req);
    if (idempotency.error) {
      return res.status(400).json({ success: false, message: idempotency.error });
    }
    if (idempotency.key) {
      const existingBooking = await findRoomBookingByIdempotency({ supabaseClient: supabase, hotelSlug, key: idempotency.key });
      if (existingBooking) {
        return res.json({ success: true, idempotent: true, message: "Room booking already created", booking: buildStaffBookingResponse(existingBooking, isStaffManager(req)) });
      }
    }

    const {
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
      bookingSource = "staff",
      advanceOption,
      advanceAmount,
      advancePayments,
      paymentMethod,
      negotiatedNightlyRate,
      negotiatedRateReason,
      notes
    } = req.validatedBody;
    const allowedStaffBookingSources = ["walk-in", "phone", "whatsapp", "staff"];
    if (!allowedStaffBookingSources.includes(bookingSource)) {
      return res.status(400).json({
        success: false,
        code: "INVALID_STAFF_BOOKING_SOURCE",
        message: "Staff may create walk-in, phone, WhatsApp, or staff-assisted bookings only"
      });
    }
    const hasNegotiatedRate = Number.isFinite(Number(negotiatedNightlyRate));
    if (hasNegotiatedRate && !isStaffManager(req)) {
      return res.status(403).json({
        success: false,
        code: "ROOM_NEGOTIATED_RATE_MANAGER_REQUIRED",
        message: "Only a Manager may approve a negotiated Room rate."
      });
    }
    if (hasNegotiatedRate && !(await ensureNegotiatedRateInfrastructure(res))) {
      return;
    }
    const negotiatedRate = hasNegotiatedRate
      ? {
          nightlyRate: Number(negotiatedNightlyRate),
          reason: normalizeText(negotiatedRateReason, 500),
          approvedBy: normalizeText(req.staffUser?.sub || req.staffUser?.id || "", 200),
          approverRole: normalizeText(req.staffRole, 80).toLowerCase() === "owner"
            ? "owner"
            : "manager"
        }
      : null;
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
      adults,
      children,
      guestPlaceOfSupply,
      negotiatedRate
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
      body: { advanceOption, advanceAmount, advancePayments, paymentMethod },
      totalAmount: totals.totalAmount,
      policy: advancePolicy,
      actorIsManager: isStaffManager(req)
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
      advance_paid: totals.advancePaid,
      balance_amount: totals.balanceAmount,
      booking_status: "confirmed",
      payment_status: totals.paymentStatus,
      booking_source: bookingSource,
      created_by_user_id: req.staffUser?.sub || req.staffUser?.id || null,
      created_by_role: req.staffRole || "staff",
      notes: notes || "",
      updated_at: new Date().toISOString()
    };
    if (totals.supportsSnapshot) {
      bookingPayload.rate_plan_id = totals.ratePlanId;
      bookingPayload.pricing_snapshot = totals.pricingSnapshot;
      bookingPayload.idempotency_key = idempotency.key;
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
      bookingPayload.request_fingerprint = hashRoomAdvanceRequest({
        booking: bookingPayload,
        payments: advancePlan.payments
      });
      if (!idempotency.key) {
        return res.status(400).json({
          success: false,
          code: "ROOM_ADVANCE_IDEMPOTENCY_REQUIRED",
          message: "A booking retry key is required when an advance is collected."
        });
      }
      const actorId = req.staffUser?.sub || req.staffUser?.id || "";
      const { data: atomicResult, error: atomicError } = await mutationDatabase(req).rpc(
        "create_room_booking_with_advance",
        {
          p_hotel_slug: hotelSlug,
          p_booking: bookingPayload,
          p_payments: advancePlan.payments,
          p_idempotency_key: idempotency.key,
          p_actor_id: actorId,
          p_actor_role: req.staffRole || "staff"
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
      const responseBooking = buildStaffBookingResponse(
        atomicResult?.booking || {},
        isStaffManager(req) || advancePolicy.allowStaffAdvance
      );
      return res.status(atomicResult?.idempotent ? 200 : 201).json({
        success: true,
        idempotent: atomicResult?.idempotent === true,
        message: atomicResult?.idempotent
          ? "Room booking and advance already recorded"
          : "Room booking and advance recorded",
        booking: responseBooking,
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

    const { data, error } = await mutationDatabase(req)
      .from("room_bookings")
      .insert([bookingPayload])
      .select()
      .single();

    if (error) {
      if (idempotency.key && isRoomIdempotencyConflict(error)) {
        const existingBooking = await findRoomBookingByIdempotency({ supabaseClient: mutationDatabase(req), hotelSlug, key: idempotency.key });
        if (existingBooking) {
          return res.json({ success: true, idempotent: true, message: "Room booking already created", booking: buildStaffBookingResponse(existingBooking, isStaffManager(req)) });
        }
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

    res.status(201).json({
      success: true,
      message: "Room booking created",
      booking: buildStaffBookingResponse(data, isStaffManager(req))
    });
  } catch (error) {
    const errorCode = String(error?.code || "");
    const isSafePricingError =
      errorCode.startsWith("ROOM_TAX_") ||
      errorCode.startsWith("ROOM_PRICE_") ||
      errorCode.startsWith("ROOM_NEGOTIATED_RATE_") ||
      errorCode.startsWith("ROOM_ADVANCE_");
    if ([400, 403, 409].includes(Number(error?.status)) && isSafePricingError) {
      return res.status(Number(error.status)).json({
        success: false,
        code: errorCode,
        message: error.message
      });
    }
    console.error("Staff room booking create error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create room booking"
    });
  }
});

router.patch(
  "/bookings/:id/status",
  requireStaffManagerAccess,
  validateBody(adminRoomBookingStatusUpdateSchema),
  async (req, res) => {
    try {
      const hotelSlug = normalizeText(req.staffHotelSlug, 120);
      const bookingId = normalizeText(req.params.id, 80);
      const {
        bookingStatus,
        notes
      } = req.validatedBody;

      if (!hotelSlug) {
        return res.status(403).json({
          success: false,
          message: "Staff hotel scope is missing"
        });
      }

      if (!bookingId) {
        return res.status(400).json({
          success: false,
          message: "Room booking id is required"
        });
      }

      if (!(await ensureRoomBookingFeatureEnabled(res, hotelSlug))) {
        return;
      }

      const bookingResult = await fetchBookingForStaff({ bookingId, hotelSlug });

      if (!bookingResult.ok) {
        return res.status(bookingResult.status).json({
          success: false,
          message: bookingResult.message
        });
      }

      const currentBooking = bookingResult.booking;
      const currentStatus = normalizeText(currentBooking.booking_status, 60);
      const allowedNextStatuses = STAFF_BOOKING_STATUS_TRANSITIONS[currentStatus] || [];

      if (!allowedNextStatuses.includes(bookingStatus)) {
        return res.status(409).json({
          success: false,
          code: "INVALID_ROOM_BOOKING_TRANSITION",
          message: `Room booking cannot move from ${currentStatus || "unknown"} to ${bookingStatus}`
        });
      }

      if (["confirmed", "checked_in"].includes(bookingStatus)) {
        const hasConflict = await hasOtherBlockingBooking({
          hotelSlug,
          roomId: currentBooking.room_id,
          bookingId: currentBooking.id,
          checkInDate: currentBooking.check_in_date,
          checkOutDate: currentBooking.check_out_date
        });

        if (hasConflict) {
          return res.status(409).json({
            success: false,
            code: ROOM_BOOKING_CONFLICT_CODE,
            message: ROOM_BOOKING_CONFLICT_MESSAGE
          });
        }
      }

      if (bookingStatus === "checked_in") {
        const { data: room, error: roomError } = await supabase
          .from("rooms")
          .select("id,hotel_slug,status,is_active")
          .eq("id", currentBooking.room_id)
          .eq("hotel_slug", hotelSlug)
          .maybeSingle();

        if (roomError) throw roomError;

        if (!room) {
          return res.status(404).json({
            success: false,
            message: "Room not found for this hotel"
          });
        }

        const operationalStatus = normalizeText(room.status, 40).toLowerCase();
        if (
          room.is_active === false ||
          ["inactive", "maintenance", "cleaning"].includes(operationalStatus)
        ) {
          return res.status(409).json({
            success: false,
            code: "ROOM_NOT_READY_FOR_CHECK_IN",
            message: "This room is not operationally ready for check-in"
          });
        }
      }

      const { data, error } = await mutationDatabase(req)
        .from("room_bookings")
        .update(buildBookingStatusUpdatePayload(bookingStatus, notes, currentBooking))
        .eq("id", bookingId)
        .eq("hotel_slug", hotelSlug)
        .select()
        .maybeSingle();

      if (error) {
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

      if (!data) {
        return res.status(404).json({
          success: false,
          message: "Room booking not found for this hotel"
        });
      }

      res.json({
        success: true,
        message: "Room booking status updated",
        booking: data
      });
    } catch (error) {
      console.error("Staff room booking status update error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to update room booking status"
      });
    }
  }
);

router.get("/bookings/:id", async (req, res) => {
  try {
    const hotelSlug = normalizeText(req.staffHotelSlug, 120);
    const bookingId = normalizeText(req.params.id, 80);

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    if (!bookingId) {
      return res.status(400).json({
        success: false,
        message: "Room booking id is required"
      });
    }

    if (!(await ensureRoomBookingFeatureEnabled(res, hotelSlug))) {
      return;
    }

    const bookingResult = await fetchBookingForStaff({ bookingId, hotelSlug });

    if (!bookingResult.ok) {
      return res.status(bookingResult.status).json({
        success: false,
        message: bookingResult.message
      });
    }

    const booking = bookingResult.booking;
    const { data: room, error: roomError } = await supabase
      .from("rooms")
      .select("*")
      .eq("id", booking.room_id)
      .eq("hotel_slug", hotelSlug)
      .maybeSingle();

    if (roomError) throw roomError;

    const canViewFinancial = isStaffManager(req);
    let payments = [];
    let refunds = [];
    let auditRows = [];
    if (canViewFinancial) {
      const [paymentResult, refundResult, auditResult] = await Promise.all([
        supabase
          .from("room_booking_payments")
          .select("id,amount,payment_method,payment_status,transaction_id,notes,paid_at,created_at")
          .eq("hotel_slug", hotelSlug)
          .eq("booking_id", booking.id)
          .order("created_at", { ascending: false }),
        supabase
          .from("room_booking_refunds")
          .select("id,amount,payment_method,status,transaction_id,reason,created_at")
          .eq("hotel_slug", hotelSlug)
          .eq("booking_id", booking.id)
          .order("created_at", { ascending: false }),
        supabase
          .from("room_operation_audit")
          .select("id,actor_role,action,reason,created_at")
          .eq("hotel_slug", hotelSlug)
          .eq("target_type", "room_booking")
          .eq("target_id", String(booking.id))
          .order("created_at", { ascending: false })
          .limit(100)
      ]);
      const optionalResults = [paymentResult, refundResult, auditResult];
      const fatalResult = optionalResults.find(
        (result) => result.error && !isMissingRoomBookingSchemaError(result.error)
      );
      if (fatalResult?.error) throw fatalResult.error;
      payments = paymentResult.error ? [] : paymentResult.data || [];
      refunds = refundResult.error ? [] : refundResult.data || [];
      auditRows = auditResult.error ? [] : auditResult.data || [];
    }
    res.set("Cache-Control", "private, no-store");
    res.json({
      success: true,
      hotelSlug,
      contract: "room-booking-detail-v1",
      financialsVisible: canViewFinancial,
      permissions: {
        canViewFinancials: canViewFinancial,
        canManageBooking: canViewFinancial,
        canViewGuestContact: true,
        canViewIdentityProof: canViewFinancial
      },
      version: booking.updated_at || booking.created_at || "",
      room: room ? buildStaffRoomDetailResponse(room, canViewFinancial) : null,
      booking: buildStaffBookingDetailResponse(booking, canViewFinancial),
      payments,
      refunds,
      activity: buildRoomBookingActivity({ booking, payments, refunds, auditRows })
    });
  } catch (error) {
    if (isMissingRoomBookingSchemaError(error)) {
      return buildMissingSchemaResponse(res);
    }

    console.error("Staff room booking detail fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch room booking details"
    });
  }
});

router.get(
  "/bookings/:id/checkout-summary",
  requireStaffManagerAccess,
  async (req, res) => {
    try {
      const hotelSlug = normalizeText(req.staffHotelSlug, 120);
      const bookingId = normalizeText(req.params.id, 80);

      if (!hotelSlug) {
        return res.status(403).json({
          success: false,
          message: "Staff hotel scope is missing"
        });
      }

      if (!bookingId) {
        return res.status(400).json({
          success: false,
          message: "Room booking id is required"
        });
      }

      if (!(await ensureRoomBookingFeatureEnabled(res, hotelSlug))) {
        return;
      }

      const bookingResult = await fetchBookingForStaff({ bookingId, hotelSlug });

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
        .eq("hotel_slug", hotelSlug)
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
        .eq("hotel_slug", hotelSlug)
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
        hotelSlug,
        summary: buildRoomCheckoutSummary({
          booking,
          room,
          foodOrders: foodOrders || []
        })
      });
    } catch (error) {
      console.error("Staff room checkout summary fetch error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch room checkout summary"
      });
    }
  }
);

router.post(
  "/bookings/:id/combined-checkout",
  requireStaffManagerAccess,
  requireStaffCombinedBilling,
  requireRoomCombinedCheckoutEnabled,
  validateBody(roomCombinedCheckoutSchema),
  staffRoomCombinedCheckoutHandler
);

router.get("/bookings/:id/payments", requireStaffManagerAccess, async (req, res) => {
  try {
    const hotelSlug = normalizeText(req.staffHotelSlug, 120);
    const bookingId = normalizeText(req.params.id, 80);
    const bookingResult = await fetchBookingForStaff({ bookingId, hotelSlug });
    if (!bookingResult.ok) {
      return res.status(bookingResult.status).json({ success: false, message: bookingResult.message });
    }
    const { data, error } = await supabase
      .from("room_booking_payments")
      .select("*")
      .eq("hotel_slug", hotelSlug)
      .eq("booking_id", bookingResult.booking.id)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return res.json({
      success: true,
      payments: data || [],
      summary: buildAdvanceSummary({ booking: bookingResult.booking, payments: data || [] })
    });
  } catch (error) {
    console.error("Staff Room payment history error:", error);
    return res.status(500).json({ success: false, message: "Failed to load Room payment history" });
  }
});

router.get("/bookings/:bookingId/payments/:paymentId/receipt", async (req, res) => {
  try {
    const hotelSlug = normalizeText(req.staffHotelSlug, 120);
    const bookingId = normalizeText(req.params.bookingId, 80);
    const paymentId = normalizeText(req.params.paymentId, 80);
    const bookingResult = await fetchBookingForStaff({ bookingId, hotelSlug });
    if (!bookingResult.ok) {
      return res.status(bookingResult.status).json({ success: false, message: bookingResult.message });
    }
    const { data: payment, error } = await supabase
      .from("room_booking_payments")
      .select("*")
      .eq("id", paymentId)
      .eq("booking_id", bookingResult.booking.id)
      .eq("hotel_slug", hotelSlug)
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
    console.error("Staff Room advance receipt error:", error);
    return res.status(500).json({ success: false, message: "Failed to prepare advance receipt" });
  }
});

router.post(
  "/bookings/:id/payments",
  requireStaffManagerAccess,
  validateBody(adminRoomBookingPaymentSchema),
  async (req, res) => {
    let createdPayment = null;

    try {
      const hotelSlug = normalizeText(req.staffHotelSlug, 120);
      const bookingId = normalizeText(req.params.id, 80);
      const {
        amount,
        paymentMethod,
        paymentStatus = "paid",
        transactionId,
        notes,
        idempotencyKey
      } = req.validatedBody;

      if (!hotelSlug) {
        return res.status(403).json({
          success: false,
          message: "Staff hotel scope is missing"
        });
      }

      if (!bookingId) {
        return res.status(400).json({
          success: false,
          message: "Room booking id is required"
        });
      }

      if (!(await ensureRoomBookingFeatureEnabled(res, hotelSlug))) {
        return;
      }

      const bookingResult = await fetchBookingForStaff({ bookingId, hotelSlug });

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
        const actorId = req.staffUser?.sub || req.staffUser?.id || null;
        const { data: atomicResult, error: atomicError } = await mutationDatabase(req).rpc(
          "record_room_booking_payment",
          {
            p_hotel_slug: hotelSlug,
            p_booking_id: Number(currentBooking.id),
            p_amount: roundMoney(amount),
            p_payment_method: paymentMethod,
            p_transaction_id: transactionId || "",
            p_notes: notes || "",
            p_idempotency_key: safeIdempotencyKey,
            p_actor_id: actorId,
            p_actor_role: req.staffRole || "manager"
          }
        );
        const missingRpc = atomicError &&
          ["PGRST202", "42883"].includes(String(atomicError.code || "").toUpperCase());
        if (atomicError && !missingRpc) throw atomicError;
        if (!atomicError) {
          const refreshed = await fetchBookingForStaff({ bookingId, hotelSlug });
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

      if (currentBooking.booking_status === "cancelled") {
        return res.status(409).json({
          success: false,
          message: "Cannot collect payment for a cancelled booking"
        });
      }

      const currentTotalAmount = Number(currentBooking.total_amount || 0);
      const currentAdvancePaid = Number(currentBooking.advance_paid || 0);
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

      const { data: payment, error: paymentError } = await mutationDatabase(req)
        .from("room_booking_payments")
        .insert([
          {
            hotel_slug: hotelSlug,
            booking_id: currentBooking.id,
            amount: requestedAmount,
            payment_method: paymentMethod,
            payment_status: paymentStatus,
            transaction_id: transactionId || null,
            notes: notes || "",
            paid_at: new Date().toISOString(),
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

      const { data: updatedBooking, error: bookingUpdateError } = await mutationDatabase(req)
        .from("room_bookings")
        .update({
          advance_paid: nextAdvancePaid,
          balance_amount: nextBalanceAmount,
          payment_status: nextPaymentStatus,
          updated_at: new Date().toISOString()
        })
        .eq("id", currentBooking.id)
        .eq("hotel_slug", hotelSlug)
        .select()
        .maybeSingle();

      if (bookingUpdateError || !updatedBooking) {
        await mutationDatabase(req)
          .from("room_booking_payments")
          .delete()
          .eq("id", createdPayment.id)
          .eq("hotel_slug", hotelSlug);

        if (bookingUpdateError && isMissingRoomBookingSchemaError(bookingUpdateError)) {
          return buildMissingSchemaResponse(res);
        }

        if (!updatedBooking) {
          return res.status(404).json({
            success: false,
            message: "Room booking not found for this hotel"
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
          message: "Payment amount exceeds the latest Room booking balance. The booking has been refreshed."
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
      console.error("Staff room booking payment create error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to record room booking payment"
      });
    }
  }
);

router.post(
  "/bookings/:id/refunds",
  requireStaffManagerAccess,
  validateBody(roomRefundSchema),
  async (req, res) => {
    try {
      const hotelSlug = normalizeText(req.staffHotelSlug, 120);
      const bookingId = Number(req.params.id);
      if (!Number.isSafeInteger(bookingId) || bookingId <= 0) {
        return res.status(400).json({ success: false, message: "Valid room booking id is required" });
      }
      const bookingResult = await fetchBookingForStaff({ bookingId, hotelSlug });
      if (!bookingResult.ok) {
        return res.status(bookingResult.status).json({ success: false, message: bookingResult.message });
      }
      const body = req.validatedBody;
      const actorId = req.staffUser?.sub || req.staffUser?.id || null;
      const { data, error } = await mutationDatabase(req).rpc("record_room_booking_refund", {
        p_hotel_slug: hotelSlug,
        p_booking_id: bookingId,
        p_amount: body.amount,
        p_payment_method: body.paymentMethod,
        p_transaction_id: body.transactionId || "",
        p_reason: body.reason,
        p_idempotency_key: body.idempotencyKey,
        p_actor_id: actorId
      });
      if (error) {
        const message = String(error.message || "");
        if (message.includes("ROOM_REFUND_EXCEEDS_PAID_AMOUNT")) {
          return res.status(409).json({
            success: false,
            code: "ROOM_REFUND_EXCEEDS_PAID_AMOUNT",
            message: "Refund amount cannot exceed the currently paid room amount."
          });
        }
        if (["PGRST202", "42883"].includes(String(error.code || "").toUpperCase())) {
          return res.status(409).json({
            success: false,
            code: "ROOM_REFUND_SCHEMA_REQUIRED",
            message: "Apply the production Room pricing and GST migration before recording refunds."
          });
        }
        throw error;
      }
      const refreshed = await fetchBookingForStaff({ bookingId, hotelSlug });
      const effectiveBooking = refreshed.ok ? refreshed.booking : bookingResult.booking;
      const creditNote = buildRoomRefundCreditNote({
        booking: effectiveBooking,
        refund: data?.refund || {}
      });
      res.status(data?.idempotent ? 200 : 201).json({
        success: true,
        idempotent: data?.idempotent === true,
        message: data?.idempotent ? "Room refund already recorded" : "Room refund recorded",
        booking: effectiveBooking,
        refund: data?.refund || null,
        creditNote
      });
    } catch (error) {
      console.error("Staff room booking refund error:", error);
      res.status(500).json({ success: false, message: "Failed to record room booking refund" });
    }
  }
);

router.get(
  "/bookings/:bookingId/refunds/:refundId/credit-note",
  requireStaffManagerAccess,
  async (req, res) => {
    try {
      const hotelSlug = normalizeText(req.staffHotelSlug, 120);
      const bookingId = Number(req.params.bookingId);
      const refundId = Number(req.params.refundId);
      if (![bookingId, refundId].every((value) => Number.isSafeInteger(value) && value > 0)) {
        return res.status(400).json({ success: false, message: "Valid booking and refund ids are required" });
      }
      const [bookingResult, refundResult] = await Promise.all([
        fetchBookingForStaff({ bookingId, hotelSlug }),
        supabase.from("room_booking_refunds").select("*")
          .eq("id", refundId).eq("booking_id", bookingId).eq("hotel_slug", hotelSlug).maybeSingle()
      ]);
      if (!bookingResult.ok) {
        return res.status(bookingResult.status).json({ success: false, message: bookingResult.message });
      }
      if (refundResult.error) throw refundResult.error;
      if (!refundResult.data) {
        return res.status(404).json({ success: false, message: "Room refund not found for this hotel and booking" });
      }
      res.json({
        success: true,
        creditNote: buildRoomRefundCreditNote({
          booking: bookingResult.booking,
          refund: refundResult.data
        })
      });
    } catch (error) {
      console.error("Room refund credit-note fetch error:", error);
      res.status(500).json({ success: false, message: "Failed to load Room refund credit note" });
    }
  }
);

module.exports = router;





