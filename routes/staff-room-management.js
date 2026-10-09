"use strict";

const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const { requireStaffAuth, requireStaffManagerAccess } = require("../middleware/require-staff-auth");
const { requireHotelFeature, resolveStaffHotelSlug } = require("../middleware/require-hotel-feature");
const { validateBody } = require("../validators/common");
const {
  amenitySchema, amenityUpdateSchema, floorCreateSchema, floorUpdateSchema,
  housekeepingCreateSchema, housekeepingUpdateSchema,
  maintenanceCreateSchema, maintenanceUpdateSchema,
  managerRoomCreateSchema, managerRoomUpdateSchema,
  managerRoomTypeCreateSchema, managerRoomTypeUpdateSchema,
  ratePlanCreateSchema, ratePlanUpdateSchema, roomShiftSchema, stayExtensionSchema
} = require("../validators/room-operations");
const {
  roomTaxPreviewSchema,
  roomTaxRuleActionSchema,
  roomTaxRuleCreateSchema,
  roomTaxRuleUpdateSchema,
  roomTaxSettingsSchema
} = require("../validators/room-tax");
const {
  roomImageMetadataSchema,
  roomImageReorderSchema,
  roomImageUpdateSchema
} = require("../validators/room-media");
const { supabase } = require("../utils/supabase");
const { getStaffTenantMutationClient } = require("../utils/tenant-route-database");
const { getImageDimensions } = require("../utils/image-dimensions");
const {
  buildPropertyStoragePath,
  isPropertyStoragePath,
  resolvePropertyStorageScope
} = require("../utils/storage-object-scope");
const { invalidatePublicRoomsCache } = require("../utils/public-route-cache");
const { isRoomBookingOverlapError, ROOM_BOOKING_CONFLICT_CODE, ROOM_BOOKING_CONFLICT_MESSAGE } = require("../utils/room-availability");
const {
  calculateRoomTaxFromRule,
  isMissingRoomTaxSchemaError,
  resolveRoomTax
} = require("../utils/room-tax");

const router = express.Router();
const requireRooms = requireHotelFeature("rooms", { resolveHotelSlug: resolveStaffHotelSlug });
const ROOM_IMAGE_BUCKET = "hotel-assets";
const ROOM_IMAGE_LIMIT = 50;
const ROOM_IMAGE_TYPES = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"]
]);
const roomImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter(req, file, callback) {
    const allowed = ROOM_IMAGE_TYPES.has(String(file?.mimetype || "").toLowerCase());
    callback(allowed ? null : new Error("Room image must be a JPG, PNG, or WebP file"), allowed);
  }
});

router.use(requireStaffAuth);
router.use(requireRooms);
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

function scope(req) {
  return String(req.staffHotelSlug || "").trim();
}

function actor(req) {
  return {
    id: String(req.staffUser?.sub || req.staffUser?.id || "").trim() || null,
    role: String(req.staffRole || "staff").trim()
  };
}

function id(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function handleRoomImageUpload(req, res, next) {
  roomImageUpload.single("file")(req, res, (error) => {
    if (!error) return next();
    const message = error.code === "LIMIT_FILE_SIZE"
      ? "Room image must be 8 MB or smaller"
      : error.message || "Invalid room image upload";
    return res.status(400).json({ success: false, code: "ROOM_IMAGE_INVALID", message });
  });
}

function parseBooleanField(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return value;
}

function safeStorageSegment(value, fallback = "hotel") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || fallback;
}

function roomImageTarget(value) {
  if (value === "room") return { type: "room", table: "rooms", column: "room_id" };
  if (value === "room_type") return { type: "room_type", table: "room_types", column: "room_type_id" };
  return null;
}

async function requireOwnedRoomImageTarget(req, res) {
  const target = roomImageTarget(String(req.params.targetType || ""));
  const targetId = id(req.params.targetId);
  if (!target || !targetId) {
    res.status(400).json({ success: false, code: "ROOM_IMAGE_TARGET_INVALID", message: "A valid room or room type is required" });
    return null;
  }
  const resource = await owned(target.table, targetId, scope(req), "id");
  if (!resource) {
    res.status(404).json({ success: false, code: "ROOM_IMAGE_TARGET_NOT_FOUND", message: "Room image target was not found for this hotel" });
    return null;
  }
  return { ...target, targetId };
}

function roomImageUrls(storagePath) {
  const bucket = supabase.storage.from(ROOM_IMAGE_BUCKET);
  const original = bucket.getPublicUrl(storagePath).data.publicUrl;
  const transformed = (width, height, quality) => bucket.getPublicUrl(storagePath, {
    transform: { width, height, resize: "cover", quality }
  }).data.publicUrl || original;
  return {
    originalUrl: original,
    cardUrl: transformed(720, 480, 82),
    optimizedUrl: transformed(1440, 960, 84),
    thumbnailUrl: transformed(240, 160, 76)
  };
}

function mapRoomImage(row = {}) {
  return {
    id: row.id,
    originalUrl: row.original_url || "",
    cardUrl: row.card_url || row.original_url || "",
    optimizedUrl: row.optimized_url || row.original_url || "",
    thumbnailUrl: row.thumbnail_url || row.card_url || row.original_url || "",
    altText: row.alt_text || "",
    caption: row.caption || "",
    displayOrder: Number(row.display_order || 0),
    isPrimary: row.is_primary === true,
    isActive: row.is_active !== false,
    width: Number(row.width || 0),
    height: Number(row.height || 0),
    fileSize: Number(row.file_size || 0)
  };
}

function roomGallerySchemaUnavailable(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`.toLowerCase();
  return message.includes("room_images") && ["42P01", "42703", "PGRST204", "PGRST205"].includes(code);
}

function schemaUnavailable(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = `${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  return ["42P01", "42703", "PGRST204", "PGRST205"].includes(code) ||
    ["hotel_floors", "room_rate_plans", "room_maintenance", "room_housekeeping_tasks", "room_operation_audit"].some((name) => message.includes(name));
}

function fail(res, error, fallback) {
  if (roomGallerySchemaUnavailable(error)) {
    return res.status(503).json({ success: false, schemaReady: false, code: "ROOM_GALLERY_UPGRADE_REQUIRED", message: "Room image gallery migration is not applied yet" });
  }
  if (schemaUnavailable(error)) {
    return res.status(503).json({ success: false, schemaReady: false, code: "ROOM_OPERATIONS_UPGRADE_REQUIRED", message: "Professional Room Operations migration is not applied yet" });
  }
  if (isRoomBookingOverlapError(error) || String(error?.message || "").includes("ROOM_ALREADY_BOOKED")) {
    return res.status(409).json({ success: false, code: ROOM_BOOKING_CONFLICT_CODE, message: ROOM_BOOKING_CONFLICT_MESSAGE });
  }
  console.error(fallback, error);
  return res.status(500).json({ success: false, message: fallback });
}

async function audit(req, action, targetType, targetId, oldValue = {}, newValue = {}, reason = "") {
  const who = actor(req);
  const { error } = await mutationDatabase(req).from("room_operation_audit").insert([{
    hotel_slug: scope(req), actor_id: who.id, actor_role: who.role, action,
    target_type: targetType, target_id: String(targetId), old_value: oldValue || {},
    new_value: newValue || {}, reason: String(reason || "").slice(0, 2000)
  }]);
  if (error) throw error;
}

async function owned(table, resourceId, hotelSlug, columns = "*") {
  const { data, error } = await supabase.from(table).select(columns).eq("id", resourceId).eq("hotel_slug", hotelSlug).maybeSingle();
  if (error) throw error;
  return data;
}

async function ensureReferences(hotelSlug, { floorId, roomTypeId, roomId, bookingId } = {}) {
  if (floorId && !(await owned("hotel_floors", floorId, hotelSlug, "id"))) throw Object.assign(new Error("Floor not found for this hotel"), { status: 404 });
  if (roomTypeId && !(await owned("room_types", roomTypeId, hotelSlug, "id"))) throw Object.assign(new Error("Room type not found for this hotel"), { status: 404 });
  if (roomId && !(await owned("rooms", roomId, hotelSlug, "id"))) throw Object.assign(new Error("Room not found for this hotel"), { status: 404 });
  if (bookingId && !(await owned("room_bookings", bookingId, hotelSlug, "id"))) throw Object.assign(new Error("Booking not found for this hotel"), { status: 404 });
}

function handleKnown(res, error) {
  const message = String(error?.message || "");
  const conflictMessages = {
    ROOM_PRICE_PERIOD_CONFLICT: "This room has an active or confirmed booking affected by the price change. Schedule a non-conflicting future rate instead.",
    ROOM_TYPE_PRICE_PERIOD_CONFLICT: "This room type has an active or confirmed booking affected by the price change. Schedule a non-conflicting future rate instead.",
    ROOM_RATE_PLAN_OVERLAP: "Another active rate plan overlaps this room, room type, and effective period.",
    ROOM_RATE_BOOKING_CONFLICT: "This rate change overlaps an active or confirmed booking. Choose a non-conflicting effective period.",
    ROOM_TAX_RULE_OVERLAP: "Another active GST rule overlaps this effective period and taxable-value range.",
    ROOM_TAX_RULE_CHANGED: "This GST rule changed after it was loaded. Refresh and retry.",
    ROOM_TAX_RULE_NOT_FOUND: "GST rule not found for this hotel."
  };
  const code = Object.keys(conflictMessages).find((item) => message.includes(item));
  if (code) return res.status(409).json({ success: false, code, message: conflictMessages[code] });
  if (error?.status) return res.status(error.status).json({ success: false, code: error.code, message: error.message });
  return null;
}

async function optionalTaxConfiguration(hotelSlug) {
  const [settings, rules] = await Promise.all([
    supabase.from("hotel_room_tax_settings").select("*").eq("hotel_slug", hotelSlug).maybeSingle(),
    supabase.from("room_tax_rules").select("*").eq("hotel_slug", hotelSlug).order("effective_from", { ascending: false }).order("id", { ascending: false })
  ]);
  const error = settings.error || rules.error;
  if (error) {
    if (isMissingRoomTaxSchemaError(error)) {
      return { schemaReady: false, settings: null, rules: [] };
    }
    throw error;
  }
  return { schemaReady: true, settings: settings.data || null, rules: rules.data || [] };
}

async function optionalRoomRefunds(hotelSlug, from, to) {
  const result = await supabase
    .from("room_booking_refunds")
    .select("id,booking_id,amount,payment_method,status,created_at,tax_adjustment_snapshot")
    .eq("hotel_slug", hotelSlug)
    .gte("created_at", `${from}T00:00:00Z`)
    .lte("created_at", `${to}T23:59:59Z`)
    .limit(2000);
  if (result.error) {
    if (isMissingRoomTaxSchemaError(result.error)) return [];
    throw result.error;
  }
  return result.data || [];
}

function taxSettingsPayload(body, version) {
  return {
    is_configured: true,
    gst_enabled: body.gstEnabled,
    gst_registered: body.gstRegistered,
    gstin: body.gstin || "",
    legal_business_name: body.legalBusinessName || "",
    state_name: body.stateName || "",
    state_code: body.stateCode || "",
    place_of_supply: body.placeOfSupply || "",
    accommodation_sac: body.accommodationSac || "",
    default_tax_mode: body.defaultTaxMode,
    default_supply_type: body.defaultSupplyType,
    invoice_type: body.invoiceType,
    rounding_rule: body.roundingRule,
    currency: body.currency || "INR",
    version,
    updated_at: new Date().toISOString()
  };
}

function taxRulePayload(body) {
  const map = {
    ruleName: "rule_name",
    accommodationCategory: "accommodation_category",
    calculationBasis: "calculation_basis",
    minimumTaxableValue: "minimum_taxable_value",
    maximumTaxableValue: "maximum_taxable_value",
    cgstRate: "cgst_rate",
    sgstRate: "sgst_rate",
    igstRate: "igst_rate",
    cessRate: "cess_rate",
    isExempt: "is_exempt",
    exemptionReason: "exemption_reason",
    taxInclusive: "tax_inclusive",
    effectiveFrom: "effective_from",
    effectiveTo: "effective_to",
    status: "status"
  };
  return Object.fromEntries(
    Object.entries(map)
      .filter(([key]) => body[key] !== undefined)
      .map(([key, column]) => [column, body[key]])
  );
}

// Operational daily data is intentionally available to both Manager and Staff.
// It contains no document data and Staff financial fields are omitted.
router.get("/daily", async (req, res) => {
  try {
    const hotelSlug = scope(req);
    const today = new Date().toISOString().slice(0, 10);
    const [roomsResult, arrivalsResult, departuresResult, activeResult, housekeepingResult, maintenanceResult] = await Promise.all([
      supabase.from("rooms").select("id,room_number,title,floor,floor_id,room_type_id,status,is_active").eq("hotel_slug", hotelSlug).order("room_number"),
      supabase.from("room_bookings").select("id,room_id,guest_name,check_in_date,check_out_date,booking_status,booking_source").eq("hotel_slug", hotelSlug).eq("check_in_date", today).in("booking_status", ["pending", "confirmed"]),
      supabase.from("room_bookings").select("id,room_id,guest_name,check_in_date,check_out_date,booking_status").eq("hotel_slug", hotelSlug).eq("check_out_date", today).eq("booking_status", "checked_in"),
      supabase.from("room_bookings").select("id,room_id,guest_name,check_in_date,check_out_date,booking_status").eq("hotel_slug", hotelSlug).eq("booking_status", "checked_in"),
      supabase.from("room_housekeeping_tasks").select("id,room_id,status,priority,assigned_to,notes,created_at,updated_at").eq("hotel_slug", hotelSlug).in("status", ["dirty", "cleaning", "clean"]).order("created_at", { ascending: false }).limit(100),
      supabase.from("room_maintenance").select("id,room_id,maintenance_type,priority,description,start_at,end_at,status,assigned_to").eq("hotel_slug", hotelSlug).in("status", ["open", "in_progress"]).order("start_at").limit(100)
    ]);
    const firstError = [roomsResult, arrivalsResult, departuresResult, activeResult, housekeepingResult, maintenanceResult].find((result) => result.error)?.error;
    if (firstError) throw firstError;
    const rooms = roomsResult.data || [];
    res.json({ success: true, hotelSlug, date: today, summary: {
      rooms: rooms.length, activeRooms: rooms.filter((room) => room.is_active !== false).length,
      arrivals: (arrivalsResult.data || []).length, departures: (departuresResult.data || []).length,
      currentGuests: (activeResult.data || []).length,
      pendingConfirmations: (arrivalsResult.data || []).filter((booking) => booking.booking_status === "pending").length,
      housekeeping: (housekeepingResult.data || []).length, maintenance: (maintenanceResult.data || []).length
    }, rooms, arrivals: arrivalsResult.data || [], departures: departuresResult.data || [],
      currentStays: activeResult.data || [], housekeeping: housekeepingResult.data || [], maintenance: maintenanceResult.data || [] });
  } catch (error) {
    return fail(res, error, "Failed to load daily Room Operations");
  }
});

router.use(requireStaffManagerAccess);
router.use((req, res, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    res.on("finish", () => {
      if (res.statusCode < 400) invalidatePublicRoomsCache(scope(req));
    });
  }
  next();
});

router.get("/inventory", async (req, res) => {
  try {
    const hotelSlug = scope(req);
    const page = Math.max(1, Math.min(100000, Number.parseInt(req.query.page, 10) || 1));
    const pageSize = Math.max(10, Math.min(100, Number.parseInt(req.query.pageSize, 10) || 25));
    const status = String(req.query.status || "").trim().toLowerCase();
    const allowedStatuses = new Set(["available", "booked", "occupied", "cleaning", "maintenance", "inactive"]);
    const floorId = id(req.query.floorId);
    const roomTypeId = id(req.query.roomTypeId);
    const isActiveText = String(req.query.isActive ?? "").trim().toLowerCase();
    const search = String(req.query.search || "")
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}\s_-]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    const sortColumns = {
      roomNumber: "room_number",
      floor: "floor",
      roomType: "room_type_id",
      status: "status",
      price: "base_price",
      updated: "updated_at"
    };
    const sortColumn = sortColumns[String(req.query.sort || "roomNumber")] || "room_number";
    const ascending = String(req.query.direction || "asc").toLowerCase() !== "desc";
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let inventoryQuery = supabase
      .from("rooms")
      .select("id,room_number,title,floor,floor_id,room_type_id,capacity,max_adults,max_children,bed_type,base_price,discount_price,tax_percent,status,is_active,display_order,smoking_policy,base_occupancy,extra_bed_limit,description,notes,amenities_json,updated_at", { count: "exact" })
      .eq("hotel_slug", hotelSlug);
    if (search) inventoryQuery = inventoryQuery.or(`room_number.ilike.%${search}%,title.ilike.%${search}%`);
    if (allowedStatuses.has(status)) inventoryQuery = inventoryQuery.eq("status", status);
    if (floorId) inventoryQuery = inventoryQuery.eq("floor_id", floorId);
    if (roomTypeId) inventoryQuery = inventoryQuery.eq("room_type_id", roomTypeId);
    if (isActiveText === "true" || isActiveText === "false") {
      inventoryQuery = inventoryQuery.eq("is_active", isActiveText === "true");
    }
    inventoryQuery = inventoryQuery
      .order(sortColumn, { ascending, nullsFirst: false })
      .order("id", { ascending: true })
      .range(from, to);

    const [inventory, floors, roomTypes] = await Promise.all([
      inventoryQuery,
      supabase.from("hotel_floors").select("id,floor_code,floor_name,display_order,is_active").eq("hotel_slug", hotelSlug).order("display_order").order("id"),
      supabase.from("room_types").select("id,name,short_code,is_active").eq("hotel_slug", hotelSlug).order("name")
    ]);
    const firstError = [inventory, floors, roomTypes].find((result) => result.error)?.error;
    if (firstError) throw firstError;
    const total = Number(inventory.count || 0);
    return res.json({
      success: true,
      rooms: inventory.data || [],
      filters: { floors: floors.data || [], roomTypes: roomTypes.data || [] },
      pagination: { page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) },
      sort: { field: Object.keys(sortColumns).find((key) => sortColumns[key] === sortColumn) || "roomNumber", direction: ascending ? "asc" : "desc" }
    });
  } catch (error) {
    return fail(res, error, "Failed to load room inventory");
  }
});

router.get("/inventory/:id", async (req, res) => {
  try {
    const hotelSlug = scope(req);
    const roomId = id(req.params.id);
    if (!roomId) return res.status(400).json({ success: false, message: "A valid room is required" });
    const room = await owned("rooms", roomId, hotelSlug);
    if (!room) return res.status(404).json({ success: false, message: "Room not found for this hotel" });
    const [floor, roomType, images] = await Promise.all([
      room.floor_id ? owned("hotel_floors", room.floor_id, hotelSlug) : Promise.resolve(null),
      room.room_type_id ? owned("room_types", room.room_type_id, hotelSlug) : Promise.resolve(null),
      supabase.from("room_images").select("id,is_primary,is_active", { count: "exact" }).eq("hotel_slug", hotelSlug).eq("room_id", roomId).order("display_order")
    ]);
    if (images.error && !roomGallerySchemaUnavailable(images.error)) throw images.error;
    const imageRows = images.error ? [] : (images.data || []);
    return res.json({
      success: true,
      room,
      floor,
      roomType,
      imageSummary: {
        schemaReady: !images.error,
        total: images.error ? 0 : Number(images.count || 0),
        active: imageRows.filter((image) => image.is_active).length,
        primaryImageId: imageRows.find((image) => image.is_primary)?.id || null
      }
    });
  } catch (error) {
    return fail(res, error, "Failed to load room details");
  }
});

router.get("/media/:targetType/:targetId/images", async (req, res) => {
  try {
    const target = await requireOwnedRoomImageTarget(req, res);
    if (!target) return;
    const { data, error } = await supabase
      .from("room_images")
      .select("id,original_url,card_url,optimized_url,thumbnail_url,alt_text,caption,display_order,is_primary,is_active,width,height,file_size")
      .eq("hotel_slug", scope(req))
      .eq(target.column, target.targetId)
      .order("display_order")
      .order("id");
    if (error) throw error;
    return res.json({ success: true, target: { type: target.type, id: target.targetId }, images: (data || []).map(mapRoomImage), limit: ROOM_IMAGE_LIMIT });
  } catch (error) {
    return fail(res, error, "Failed to load room images");
  }
});

router.post("/media/:targetType/:targetId/images", handleRoomImageUpload, async (req, res) => {
  let uploadedPath = "";
  try {
    const target = await requireOwnedRoomImageTarget(req, res);
    if (!target) return;
    if (!req.file?.buffer) return res.status(400).json({ success: false, code: "ROOM_IMAGE_REQUIRED", message: "Choose an image to upload" });
    const metadataResult = roomImageMetadataSchema.safeParse({
      altText: req.body?.altText,
      caption: req.body?.caption || "",
      isPrimary: parseBooleanField(req.body?.isPrimary, false),
      isActive: parseBooleanField(req.body?.isActive, true)
    });
    if (!metadataResult.success) {
      return res.status(400).json({ success: false, code: "ROOM_IMAGE_METADATA_INVALID", message: metadataResult.error.issues[0]?.message || "Valid image details are required" });
    }
    const metadata = metadataResult.data;
    if (metadata.isPrimary && !metadata.isActive) {
      return res.status(400).json({ success: false, code: "ROOM_IMAGE_PRIMARY_INACTIVE", message: "A primary room image must be active" });
    }
    const dimensions = getImageDimensions(req.file.buffer, req.file.mimetype);
    if (!dimensions || dimensions.width < 320 || dimensions.height < 240 || dimensions.width > 8000 || dimensions.height > 8000) {
      return res.status(400).json({ success: false, code: "ROOM_IMAGE_DIMENSIONS_INVALID", message: "Room image dimensions must be between 320x240 and 8000x8000 pixels" });
    }
    const hotelSlug = scope(req);
    const propertyScope = await resolvePropertyStorageScope(supabase, hotelSlug);
    const countResult = await supabase
      .from("room_images")
      .select("id,display_order", { count: "exact" })
      .eq("hotel_slug", hotelSlug)
      .eq(target.column, target.targetId)
      .order("display_order", { ascending: false })
      .limit(1);
    if (countResult.error) throw countResult.error;
    const currentCount = Number(countResult.count || 0);
    const nextDisplayOrder = Number(countResult.data?.[0]?.display_order ?? -1) + 1;
    if (currentCount >= ROOM_IMAGE_LIMIT) {
      return res.status(409).json({ success: false, code: "ROOM_IMAGE_LIMIT_REACHED", message: `A room can have up to ${ROOM_IMAGE_LIMIT} images` });
    }
    if (currentCount === 0 && !metadata.isActive) {
      return res.status(400).json({ success: false, code: "ROOM_IMAGE_FIRST_INACTIVE", message: "The first room image must be active" });
    }
    const extension = ROOM_IMAGE_TYPES.get(req.file.mimetype);
    uploadedPath = buildPropertyStoragePath(
      propertyScope,
      `room-images/${target.type}-${target.targetId}`,
      `${Date.now()}-${crypto.randomUUID()}${extension}`
    );
    const { error: uploadError } = await supabase.storage
      .from(ROOM_IMAGE_BUCKET)
      .upload(uploadedPath, req.file.buffer, { contentType: req.file.mimetype, cacheControl: "31536000", upsert: false });
    if (uploadError) throw uploadError;
    const urls = roomImageUrls(uploadedPath);
    const payload = {
      hotel_slug: hotelSlug,
      [target.column]: target.targetId,
      storage_path: uploadedPath,
      original_url: urls.originalUrl,
      card_url: urls.cardUrl,
      optimized_url: urls.optimizedUrl,
      thumbnail_url: urls.thumbnailUrl,
      mime_type: req.file.mimetype,
      alt_text: metadata.altText,
      caption: metadata.caption,
      display_order: nextDisplayOrder,
      is_primary: metadata.isPrimary || currentCount === 0,
      is_active: metadata.isActive,
      width: dimensions.width,
      height: dimensions.height,
      file_size: req.file.size,
      created_by: actor(req).id
    };
    const inserted = await mutationDatabase(req).from("room_images").insert([payload]).select().single();
    if (inserted.error) throw inserted.error;
    try {
      await audit(req, "room_image_uploaded", target.type, target.targetId, {}, { imageId: inserted.data.id, altText: metadata.altText });
    } catch (auditError) {
      await mutationDatabase(req).from("room_images").delete().eq("id", inserted.data.id).eq("hotel_slug", hotelSlug);
      if (inserted.data.is_primary) {
        const fallback = await supabase.from("room_images").select("id").eq("hotel_slug", hotelSlug).eq(target.column, target.targetId).eq("is_active", true).order("display_order").order("id").limit(1).maybeSingle();
        if (fallback.data?.id) await mutationDatabase(req).from("room_images").update({ is_primary: true }).eq("id", fallback.data.id).eq("hotel_slug", hotelSlug);
      }
      throw auditError;
    }
    uploadedPath = "";
    return res.status(201).json({ success: true, message: "Room image uploaded", image: mapRoomImage(inserted.data) });
  } catch (error) {
    if (uploadedPath) await supabase.storage.from(ROOM_IMAGE_BUCKET).remove([uploadedPath]);
    if (String(error?.message || "").includes("duplicate key")) {
      return res.status(409).json({ success: false, code: "ROOM_IMAGE_UPLOAD_CONFLICT", message: "The room image list changed. Refresh and retry." });
    }
    return fail(res, error, "Failed to upload room image");
  }
});

router.patch("/media/:targetType/:targetId/images/:imageId", validateBody(roomImageUpdateSchema), async (req, res) => {
  try {
    const target = await requireOwnedRoomImageTarget(req, res);
    if (!target) return;
    const imageId = id(req.params.imageId);
    if (!imageId) return res.status(400).json({ success: false, message: "A valid room image is required" });
    const currentResult = await supabase.from("room_images").select("*").eq("id", imageId).eq("hotel_slug", scope(req)).eq(target.column, target.targetId).maybeSingle();
    if (currentResult.error) throw currentResult.error;
    const current = currentResult.data;
    if (!current) return res.status(404).json({ success: false, code: "ROOM_IMAGE_NOT_FOUND", message: "Room image not found for this hotel" });
    const body = req.validatedBody;
    if (
      (body.isPrimary === true && (body.isActive === false || (current.is_active === false && body.isActive !== true))) ||
      (current.is_primary && body.isActive === false) ||
      (current.is_primary && body.isPrimary === false)
    ) {
      return res.status(409).json({ success: false, code: "ROOM_IMAGE_PRIMARY_INACTIVE", message: "Choose another active primary image before changing this one" });
    }
    const payload = {};
    if (body.altText !== undefined) payload.alt_text = body.altText;
    if (body.caption !== undefined) payload.caption = body.caption;
    if (body.isPrimary !== undefined) payload.is_primary = body.isPrimary;
    if (body.isActive !== undefined) payload.is_active = body.isActive;
    const updated = await mutationDatabase(req).from("room_images").update(payload).eq("id", imageId).eq("hotel_slug", scope(req)).eq(target.column, target.targetId).select().maybeSingle();
    if (updated.error) throw updated.error;
    if (!updated.data) return res.status(409).json({ success: false, code: "ROOM_IMAGE_CHANGED", message: "The room image changed. Refresh and retry." });
    await audit(req, "room_image_updated", "room_image", imageId, mapRoomImage(current), mapRoomImage(updated.data));
    return res.json({ success: true, message: "Room image updated", image: mapRoomImage(updated.data) });
  } catch (error) {
    return fail(res, error, "Failed to update room image");
  }
});

router.post("/media/:targetType/:targetId/images/reorder", validateBody(roomImageReorderSchema), async (req, res) => {
  try {
    const target = await requireOwnedRoomImageTarget(req, res);
    if (!target) return;
    const who = actor(req);
    const { data, error } = await mutationDatabase(req).rpc("reorder_room_images", {
      p_hotel_slug: scope(req),
      p_target_type: target.type,
      p_target_id: target.targetId,
      p_image_ids: req.validatedBody.imageIds,
      p_actor_id: who.id,
      p_actor_role: who.role
    });
    if (error) throw error;
    return res.json({ success: true, message: "Room images reordered", result: data });
  } catch (error) {
    const message = String(error?.message || "");
    if (message.includes("ROOM_IMAGE_REORDER_SET_MISMATCH")) {
      return res.status(409).json({ success: false, code: "ROOM_IMAGE_REORDER_SET_MISMATCH", message: "The room image list changed. Refresh and retry." });
    }
    return fail(res, error, "Failed to reorder room images");
  }
});

router.delete("/media/:targetType/:targetId/images/:imageId", async (req, res) => {
  try {
    const target = await requireOwnedRoomImageTarget(req, res);
    if (!target) return;
    const imageId = id(req.params.imageId);
    if (!imageId) return res.status(400).json({ success: false, message: "A valid room image is required" });
    const current = await supabase.from("room_images").select("id,storage_path").eq("id", imageId).eq("hotel_slug", scope(req)).eq(target.column, target.targetId).maybeSingle();
    if (current.error) throw current.error;
    if (!current.data) return res.status(404).json({ success: false, code: "ROOM_IMAGE_NOT_FOUND", message: "Room image not found for this hotel" });
    const who = actor(req);
    const removed = await mutationDatabase(req).rpc("delete_room_image", { p_hotel_slug: scope(req), p_image_id: imageId, p_actor_id: who.id, p_actor_role: who.role });
    if (removed.error) throw removed.error;
    const propertyScope = await resolvePropertyStorageScope(supabase, scope(req));
    let storageWarning = "";
    if (isPropertyStoragePath(current.data.storage_path, propertyScope, {
      resource: "room-images",
      allowLegacy: true
    })) {
      const storageResult = await supabase.storage.from(ROOM_IMAGE_BUCKET).remove([current.data.storage_path]);
      if (storageResult.error) {
        console.error("Room image object cleanup failed", storageResult.error);
        storageWarning = "Image metadata was removed, but storage cleanup requires retry";
      }
    }
    return res.json({ success: true, message: "Room image removed", warning: storageWarning || undefined });
  } catch (error) {
    return fail(res, error, "Failed to remove room image");
  }
});

router.get("/configuration", async (req, res) => {
  try {
    const hotelSlug = scope(req);
    const [results, tax] = await Promise.all([Promise.all([
      supabase.from("hotel_floors").select("*").eq("hotel_slug", hotelSlug).order("display_order").order("id"),
      supabase.from("room_types").select("*").eq("hotel_slug", hotelSlug).order("name"),
      supabase.from("rooms").select("id,room_number,room_type_id,is_active", { count: "exact" }).eq("hotel_slug", hotelSlug).order("display_order").order("room_number").limit(1000),
      supabase.from("room_rate_plans").select("*").eq("hotel_slug", hotelSlug).order("priority", { ascending: false }).order("plan_name"),
      supabase.from("hotel_room_amenities").select("*").eq("hotel_slug", hotelSlug).order("display_order").order("amenity_name")
    ]), optionalTaxConfiguration(hotelSlug)]);
    const firstError = results.find((result) => result.error)?.error;
    if (firstError) throw firstError;
    res.json({
      success: true,
      hotelSlug,
      floors: results[0].data || [],
      roomTypes: results[1].data || [],
      rooms: results[2].data || [],
      roomReferences: { total: Number(results[2].count || 0), returned: (results[2].data || []).length, truncated: Number(results[2].count || 0) > (results[2].data || []).length },
      ratePlans: results[3].data || [],
      amenities: results[4].data || [],
      roomTax: tax
    });
  } catch (error) {
    return fail(res, error, "Failed to load Room Operations configuration");
  }
});

router.put("/tax/settings", validateBody(roomTaxSettingsSchema), async (req, res) => {
  try {
    const hotelSlug = scope(req);
    const who = actor(req);
    const { data: current, error: currentError } = await supabase
      .from("hotel_room_tax_settings")
      .select("*")
      .eq("hotel_slug", hotelSlug)
      .maybeSingle();
    if (currentError) throw currentError;

    const expectedVersion = req.validatedBody.expectedVersion;
    if (current && expectedVersion && Number(current.version) !== expectedVersion) {
      return res.status(409).json({
        success: false,
        code: "ROOM_TAX_SETTINGS_CHANGED",
        message: "Room GST settings changed after they were loaded. Refresh and retry."
      });
    }

    let result;
    if (current) {
      result = await mutationDatabase(req)
        .from("hotel_room_tax_settings")
        .update({
          ...taxSettingsPayload(req.validatedBody, Number(current.version || 1) + 1),
          updated_by: who.id
        })
        .eq("hotel_slug", hotelSlug)
        .eq("version", Number(current.version || 1))
        .select()
        .maybeSingle();
      if (!result.error && !result.data) {
        return res.status(409).json({
          success: false,
          code: "ROOM_TAX_SETTINGS_CHANGED",
          message: "Room GST settings changed after they were loaded. Refresh and retry."
        });
      }
    } else {
      result = await mutationDatabase(req)
        .from("hotel_room_tax_settings")
        .insert([{
          hotel_slug: hotelSlug,
          ...taxSettingsPayload(req.validatedBody, 1),
          updated_by: who.id
        }])
        .select()
        .single();
    }
    if (result.error) throw result.error;
    await audit(req, "room_tax_settings_updated", "hotel_room_tax_settings", hotelSlug, current || {}, result.data);
    res.json({ success: true, message: "Room GST settings saved", settings: result.data });
  } catch (error) {
    if (isMissingRoomTaxSchemaError(error)) {
      return res.status(409).json({ success: false, code: "ROOM_TAX_SCHEMA_REQUIRED", message: "Apply the production Room pricing and GST migration first." });
    }
    const known = handleKnown(res, error);
    return known || fail(res, error, "Failed to save Room GST settings");
  }
});

router.post("/tax/rules", validateBody(roomTaxRuleCreateSchema), async (req, res) => {
  try {
    const who = actor(req);
    const payload = taxRulePayload(req.validatedBody);
    payload.status = "draft";
    const { data, error } = await mutationDatabase(req)
      .from("room_tax_rules")
      .insert([{ hotel_slug: scope(req), ...payload, version: 1, created_by: who.id }])
      .select()
      .single();
    if (error) throw error;
    await audit(req, "room_tax_rule_created", "room_tax_rule", data.id, {}, data);
    res.status(201).json({ success: true, message: "Room GST rule saved as draft", rule: data });
  } catch (error) {
    if (isMissingRoomTaxSchemaError(error)) {
      return res.status(409).json({ success: false, code: "ROOM_TAX_SCHEMA_REQUIRED", message: "Apply the production Room pricing and GST migration first." });
    }
    const known = handleKnown(res, error);
    return known || fail(res, error, "Failed to create Room GST rule");
  }
});

router.patch("/tax/rules/:id", validateBody(roomTaxRuleUpdateSchema), async (req, res) => {
  try {
    const ruleId = id(req.params.id);
    if (!ruleId) return res.status(400).json({ success: false, message: "Valid GST rule id is required" });
    const current = await owned("room_tax_rules", ruleId, scope(req));
    if (!current) return res.status(404).json({ success: false, message: "GST rule not found for this hotel" });
    if (current.status !== "draft") {
      return res.status(409).json({
        success: false,
        code: "ROOM_TAX_RULE_IMMUTABLE",
        message: "Active or retired GST rules cannot be edited. Create a new effective-dated draft."
      });
    }
    if (Number(current.version) !== req.validatedBody.expectedVersion) {
      return res.status(409).json({ success: false, code: "ROOM_TAX_RULE_CHANGED", message: "This GST rule changed after it was loaded. Refresh and retry." });
    }
    const payload = taxRulePayload(req.validatedBody);
    payload.status = "draft";
    const { data, error } = await mutationDatabase(req)
      .from("room_tax_rules")
      .update({ ...payload, version: Number(current.version) + 1, updated_at: new Date().toISOString() })
      .eq("id", ruleId)
      .eq("hotel_slug", scope(req))
      .eq("version", Number(current.version))
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ success: false, code: "ROOM_TAX_RULE_CHANGED", message: "This GST rule changed after it was loaded. Refresh and retry." });
    await audit(req, "room_tax_rule_updated", "room_tax_rule", ruleId, current, data);
    res.json({ success: true, message: "Room GST draft updated", rule: data });
  } catch (error) {
    const known = handleKnown(res, error);
    return known || fail(res, error, "Failed to update Room GST rule");
  }
});

router.post("/tax/rules/:id/activate", validateBody(roomTaxRuleActionSchema), async (req, res) => {
  try {
    const ruleId = id(req.params.id);
    if (!ruleId) return res.status(400).json({ success: false, message: "Valid GST rule id is required" });
    const who = actor(req);
    const { data, error } = await mutationDatabase(req).rpc("activate_room_tax_rule", {
      p_hotel_slug: scope(req),
      p_rule_id: ruleId,
      p_expected_version: req.validatedBody.expectedVersion,
      p_actor_id: who.id
    });
    if (error) throw error;
    res.json({ success: true, message: "Room GST rule activated", rule: data });
  } catch (error) {
    const known = handleKnown(res, error);
    return known || fail(res, error, "Failed to activate Room GST rule");
  }
});

router.post("/tax/rules/:id/retire", validateBody(roomTaxRuleActionSchema), async (req, res) => {
  try {
    const ruleId = id(req.params.id);
    if (!ruleId) return res.status(400).json({ success: false, message: "Valid GST rule id is required" });
    const current = await owned("room_tax_rules", ruleId, scope(req));
    if (!current) return res.status(404).json({ success: false, message: "GST rule not found for this hotel" });
    if (Number(current.version) !== req.validatedBody.expectedVersion) {
      return res.status(409).json({ success: false, code: "ROOM_TAX_RULE_CHANGED", message: "This GST rule changed after it was loaded. Refresh and retry." });
    }
    const { data, error } = await mutationDatabase(req)
      .from("room_tax_rules")
      .update({ status: "retired", retired_at: new Date().toISOString(), version: Number(current.version) + 1, updated_at: new Date().toISOString() })
      .eq("id", ruleId)
      .eq("hotel_slug", scope(req))
      .eq("version", Number(current.version))
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ success: false, code: "ROOM_TAX_RULE_CHANGED", message: "This GST rule changed after it was loaded. Refresh and retry." });
    await audit(req, "room_tax_rule_retired", "room_tax_rule", ruleId, current, data);
    res.json({ success: true, message: "Room GST rule retired", rule: data });
  } catch (error) {
    const known = handleKnown(res, error);
    return known || fail(res, error, "Failed to retire Room GST rule");
  }
});

router.post("/tax/preview", validateBody(roomTaxPreviewSchema), async (req, res) => {
  try {
    const hotelSlug = scope(req);
    const body = req.validatedBody;
    let preview;
    if (body.ruleId) {
      const [rule, tax] = await Promise.all([
        owned("room_tax_rules", body.ruleId, hotelSlug),
        optionalTaxConfiguration(hotelSlug)
      ]);
      if (!rule) return res.status(404).json({ success: false, message: "GST rule not found for this hotel" });
      if (!tax.settings) return res.status(409).json({ success: false, code: "ROOM_TAX_CONFIGURATION_REQUIRED", message: "Save Room GST settings before previewing a rule." });
      const settings = {
        ...tax.settings,
        default_supply_type: body.guestPlaceOfSupply && tax.settings.state_code &&
          String(body.guestPlaceOfSupply) !== String(tax.settings.state_code)
          ? "interstate"
          : tax.settings.default_supply_type
      };
      preview = {
        source: "room_tax_rule_preview",
        ruleId: rule.id,
        ruleVersion: rule.version,
        currency: settings.currency || "INR",
        ...calculateRoomTaxFromRule({ amount: body.amount, rule, settings })
      };
    } else {
      preview = await resolveRoomTax({
        supabaseClient: supabase,
        hotelSlug,
        amount: body.amount,
        effectiveDate: body.effectiveDate,
        guestPlaceOfSupply: body.guestPlaceOfSupply
      });
    }
    res.json({ success: true, hotelSlug, preview });
  } catch (error) {
    const known = handleKnown(res, error);
    return known || fail(res, error, "Failed to preview Room GST");
  }
});

function floorPayload(body) {
  const payload = {};
  if (body.floorCode !== undefined) payload.floor_code = body.floorCode;
  if (body.floorName !== undefined) payload.floor_name = body.floorName;
  if (body.displayOrder !== undefined) payload.display_order = body.displayOrder;
  if (body.description !== undefined) payload.description = body.description || "";
  if (body.isActive !== undefined) payload.is_active = body.isActive;
  return payload;
}

router.post("/floors", validateBody(floorCreateSchema), async (req, res) => {
  try {
    const { data, error } = await mutationDatabase(req).from("hotel_floors").insert([{ hotel_slug: scope(req), ...floorPayload(req.validatedBody) }]).select().single();
    if (error) throw error;
    await audit(req, "floor_created", "hotel_floor", data.id, {}, data);
    res.status(201).json({ success: true, floor: data });
  } catch (error) { return fail(res, error, "Failed to create floor"); }
});

router.patch("/floors/:id", validateBody(floorUpdateSchema), async (req, res) => {
  try {
    const floorId = id(req.params.id); if (!floorId) return res.status(400).json({ success: false, message: "Valid floor id is required" });
    const current = await owned("hotel_floors", floorId, scope(req)); if (!current) return res.status(404).json({ success: false, message: "Floor not found for this hotel" });
    if (req.validatedBody.isActive === false) {
      const { count, error: countError } = await supabase.from("rooms").select("id", { count: "exact", head: true }).eq("hotel_slug", scope(req)).eq("floor_id", floorId).eq("is_active", true);
      if (countError) throw countError;
      if (count > 0) return res.status(409).json({ success: false, code: "FLOOR_HAS_ACTIVE_ROOMS", message: "Move or deactivate active rooms before deactivating this floor" });
    }
    const { data, error } = await mutationDatabase(req).from("hotel_floors").update({ ...floorPayload(req.validatedBody), updated_at: new Date().toISOString() }).eq("id", floorId).eq("hotel_slug", scope(req)).select().maybeSingle();
    if (error) throw error; await audit(req, "floor_updated", "hotel_floor", floorId, current, data); res.json({ success: true, floor: data });
  } catch (error) { return fail(res, error, "Failed to update floor"); }
});

function roomTypePayload(body) {
  const map = { name: "name", shortCode: "short_code", description: "description", basePrice: "base_price", baseCapacity: "base_capacity", maxAdults: "max_adults", maxChildren: "max_children", extraAdultRate: "extra_adult_rate", extraChildRate: "extra_child_rate", amenities: "amenities_json", cancellationPolicy: "cancellation_policy", checkInTime: "check_in_time", checkOutTime: "check_out_time", isActive: "is_active" };
  return Object.fromEntries(Object.entries(map).filter(([key]) => body[key] !== undefined).map(([key, column]) => [column, body[key] ?? (key === "amenities" ? [] : "")]));
}

router.post("/room-types", validateBody(managerRoomTypeCreateSchema), async (req, res) => {
  try { const { data, error } = await mutationDatabase(req).from("room_types").insert([{ hotel_slug: scope(req), ...roomTypePayload(req.validatedBody) }]).select().single(); if (error) throw error; await audit(req, "room_type_created", "room_type", data.id, {}, data); res.status(201).json({ success: true, roomType: data }); }
  catch (error) { return fail(res, error, "Failed to create room type"); }
});

router.patch("/room-types/:id", validateBody(managerRoomTypeUpdateSchema), async (req, res) => {
  try {
    const resourceId = id(req.params.id);
    const current = await owned("room_types", resourceId, scope(req));
    if (!current) return res.status(404).json({ success: false, message: "Room type not found for this hotel" });
    const financialChange = ["basePrice", "extraAdultRate", "extraChildRate"]
      .some((field) => req.validatedBody[field] !== undefined);
    if (financialChange && await roomTypeHasFinancialConflict(scope(req), resourceId)) {
      return res.status(409).json({
        success: false,
        code: "ROOM_TYPE_PRICE_PERIOD_CONFLICT",
        message: "This room type has an active or confirmed booking affected by the change. Schedule a non-conflicting future rate plan instead."
      });
    }
    const { data, error } = await mutationDatabase(req)
      .from("room_types")
      .update({ ...roomTypePayload(req.validatedBody), updated_at: new Date().toISOString() })
      .eq("id", resourceId)
      .eq("hotel_slug", scope(req))
      .select()
      .maybeSingle();
    if (error) throw error;
    await audit(req, "room_type_updated", "room_type", resourceId, current, data);
    res.json({ success: true, roomType: data });
  } catch (error) {
    const known = handleKnown(res, error);
    return known || fail(res, error, "Failed to update room type");
  }
});

function roomPayload(body) {
  const map={roomTypeId:"room_type_id",floorId:"floor_id",roomNumber:"room_number",floor:"floor",title:"title",capacity:"capacity",maxAdults:"max_adults",maxChildren:"max_children",baseOccupancy:"base_occupancy",extraBedLimit:"extra_bed_limit",bedType:"bed_type",basePrice:"base_price",discountPrice:"discount_price",taxPercent:"tax_percent",status:"status",smokingPolicy:"smoking_policy",amenities:"amenities_json",description:"description",notes:"notes",displayOrder:"display_order",isActive:"is_active"};
  return Object.fromEntries(Object.entries(map).filter(([key])=>body[key]!==undefined).map(([key,column])=>[column,body[key]]));
}

async function roomHasActiveConflict(hotelSlug, roomId) {
  const [booking, stay, maintenance] = await Promise.all([
    supabase.from("room_bookings").select("id").eq("hotel_slug",hotelSlug).eq("room_id",roomId).in("booking_status",["pending","confirmed","checked_in"]).limit(1),
    supabase.from("guest_stays").select("id").eq("hotel_slug",hotelSlug).eq("room_id",roomId).eq("stay_status","checked_in").limit(1),
    supabase.from("room_maintenance").select("id").eq("hotel_slug",hotelSlug).eq("room_id",roomId).in("status",["open","in_progress"]).limit(1)
  ]);
  const error=[booking,stay,maintenance].find((result)=>result.error)?.error;if(error)throw error;
  return (booking.data||[]).length || (stay.data||[]).length || (maintenance.data||[]).length;
}

async function roomHasFinancialConflict(hotelSlug, roomId) {
  const today = new Date().toISOString().slice(0, 10);
  const [booking, stay, maintenance] = await Promise.all([
    supabase.from("room_bookings").select("id").eq("hotel_slug", hotelSlug).eq("room_id", roomId)
      .in("booking_status", ["pending", "confirmed", "checked_in"]).gt("check_out_date", today).limit(1),
    supabase.from("guest_stays").select("id").eq("hotel_slug", hotelSlug).eq("room_id", roomId)
      .eq("stay_status", "checked_in").limit(1),
    supabase.from("room_maintenance").select("id").eq("hotel_slug", hotelSlug).eq("room_id", roomId)
      .in("status", ["open", "in_progress"]).limit(1)
  ]);
  const error = [booking, stay, maintenance].find((result) => result.error)?.error;
  if (error) throw error;
  return [booking, stay, maintenance].some((result) => (result.data || []).length > 0);
}

async function roomTypeHasFinancialConflict(hotelSlug, roomTypeId) {
  const { data: rooms, error: roomError } = await supabase
    .from("rooms")
    .select("id,status")
    .eq("hotel_slug", hotelSlug)
    .eq("room_type_id", roomTypeId);
  if (roomError) throw roomError;
  if ((rooms || []).some((room) => ["occupied", "maintenance"].includes(room.status))) return true;
  const roomIds = (rooms || []).map((room) => room.id);
  if (!roomIds.length) return false;
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("room_bookings")
    .select("id")
    .eq("hotel_slug", hotelSlug)
    .in("room_id", roomIds)
    .in("booking_status", ["pending", "confirmed", "checked_in"])
    .gt("check_out_date", today)
    .limit(1);
  if (error) throw error;
  return (data || []).length > 0;
}

router.post("/rooms", validateBody(managerRoomCreateSchema), async (req,res)=>{
  try{await ensureReferences(scope(req),req.validatedBody);const payload=roomPayload(req.validatedBody);if(req.validatedBody.floorId){const floor=await owned("hotel_floors",req.validatedBody.floorId,scope(req),"floor_name");payload.floor=floor.floor_name;}const {data,error}=await mutationDatabase(req).from("rooms").insert([{hotel_slug:scope(req),...payload}]).select().single();if(error)throw error;await audit(req,"room_created","room",data.id,{},data);res.status(201).json({success:true,room:data});}
  catch(error){const known=handleKnown(res,error);return known||fail(res,error,"Failed to create room");}
});

router.patch("/rooms/:id", validateBody(managerRoomUpdateSchema), async (req, res) => {
  try {
    const roomId = id(req.params.id);
    const current = await owned("rooms", roomId, scope(req));
    if (!current) return res.status(404).json({ success: false, message: "Room not found for this hotel" });
    await ensureReferences(scope(req), req.validatedBody);
    const deactivating = req.validatedBody.isActive === false || req.validatedBody.status === "inactive";
    if (deactivating && await roomHasActiveConflict(scope(req), roomId)) {
      return res.status(409).json({
        success: false,
        code: "ROOM_HAS_ACTIVE_OPERATIONS",
        message: "This room has an active stay, booking, hold, or maintenance record and cannot be deactivated"
      });
    }
    const protectedChange = ["basePrice", "discountPrice", "taxPercent", "roomTypeId", "floorId"]
      .some((field) => req.validatedBody[field] !== undefined);
    if (
      protectedChange &&
      (["occupied", "maintenance"].includes(current.status) || await roomHasFinancialConflict(scope(req), roomId))
    ) {
      return res.status(409).json({
        success: false,
        code: "ROOM_PRICE_PERIOD_CONFLICT",
        message: "This room has an active or confirmed stay affected by the change. Schedule a non-conflicting future rate instead."
      });
    }
    const payload = roomPayload(req.validatedBody);
    if (req.validatedBody.floorId) {
      const floor = await owned("hotel_floors", req.validatedBody.floorId, scope(req), "floor_name");
      payload.floor = floor.floor_name;
    }
    const { data, error } = await mutationDatabase(req)
      .from("rooms")
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq("id", roomId)
      .eq("hotel_slug", scope(req))
      .select()
      .maybeSingle();
    if (error) throw error;
    await audit(req, "room_updated", "room", roomId, current, data);
    res.json({ success: true, room: data });
  } catch (error) {
    const known = handleKnown(res, error);
    return known || fail(res, error, "Failed to update room");
  }
});

function ratePayload(body){const map={roomId:"room_id",roomTypeId:"room_type_id",planName:"plan_name",planCode:"plan_code",startDate:"start_date",endDate:"end_date",daysOfWeek:"days_of_week",nightlyPrice:"nightly_price",extraAdultPrice:"extra_adult_price",extraChildPrice:"extra_child_price",includedServices:"included_services",cancellationRule:"cancellation_rule",minimumStay:"minimum_stay",maximumStay:"maximum_stay",priority:"priority",isActive:"is_active",status:"status"};return Object.fromEntries(Object.entries(map).filter(([key])=>body[key]!==undefined).map(([key,column])=>[column,body[key]]));}

router.post("/rate-plans",validateBody(ratePlanCreateSchema),async(req,res)=>{try{await ensureReferences(scope(req),req.validatedBody);const payload=ratePayload(req.validatedBody);if(payload.status==="active")payload.is_active=true;const{data,error}=await mutationDatabase(req).from("room_rate_plans").insert([{hotel_slug:scope(req),...payload}]).select().single();if(error)throw error;await audit(req,"rate_plan_created","rate_plan",data.id,{},data);res.status(201).json({success:true,ratePlan:data});}catch(error){const known=handleKnown(res,error);return known||fail(res,error,"Failed to create rate plan");}});
router.patch("/rate-plans/:id",validateBody(ratePlanUpdateSchema),async(req,res)=>{try{const resourceId=id(req.params.id);const current=await owned("room_rate_plans",resourceId,scope(req));if(!current)return res.status(404).json({success:false,message:"Rate plan not found for this hotel"});await ensureReferences(scope(req),req.validatedBody);if(req.validatedBody.expectedVersion&&Number(current.version||1)!==req.validatedBody.expectedVersion)return res.status(409).json({success:false,code:"ROOM_RATE_PLAN_CHANGED",message:"This rate plan changed after it was loaded. Refresh and retry."});const payload=ratePayload(req.validatedBody);if(payload.status==="active")payload.is_active=true;if(payload.status==="retired")payload.is_active=false;let query=mutationDatabase(req).from("room_rate_plans").update({...payload,updated_at:new Date().toISOString()}).eq("id",resourceId).eq("hotel_slug",scope(req));if(req.validatedBody.expectedVersion)query=query.eq("version",req.validatedBody.expectedVersion);const{data,error}=await query.select().maybeSingle();if(error)throw error;if(!data)return res.status(409).json({success:false,code:"ROOM_RATE_PLAN_CHANGED",message:"This rate plan changed after it was loaded. Refresh and retry."});await audit(req,"rate_plan_updated","rate_plan",resourceId,current,data);res.json({success:true,ratePlan:data});}catch(error){const known=handleKnown(res,error);return known||fail(res,error,"Failed to update rate plan");}});

function amenityPayload(body){const map={amenityCode:"amenity_code",amenityName:"amenity_name",description:"description",displayOrder:"display_order",isActive:"is_active"};return Object.fromEntries(Object.entries(map).filter(([key])=>body[key]!==undefined).map(([key,column])=>[column,body[key]]));}
router.post("/amenities",validateBody(amenitySchema),async(req,res)=>{try{const{data,error}=await mutationDatabase(req).from("hotel_room_amenities").insert([{hotel_slug:scope(req),...amenityPayload(req.validatedBody)}]).select().single();if(error)throw error;await audit(req,"amenity_created","room_amenity",data.id,{},data);res.status(201).json({success:true,amenity:data});}catch(error){return fail(res,error,"Failed to create amenity");}});
router.patch("/amenities/:id",validateBody(amenityUpdateSchema),async(req,res)=>{try{const resourceId=id(req.params.id);const current=await owned("hotel_room_amenities",resourceId,scope(req));if(!current)return res.status(404).json({success:false,message:"Amenity not found for this hotel"});const{data,error}=await mutationDatabase(req).from("hotel_room_amenities").update({...amenityPayload(req.validatedBody),updated_at:new Date().toISOString()}).eq("id",resourceId).eq("hotel_slug",scope(req)).select().maybeSingle();if(error)throw error;await audit(req,"amenity_updated","room_amenity",resourceId,current,data);res.json({success:true,amenity:data});}catch(error){return fail(res,error,"Failed to update amenity");}});

router.post("/maintenance",validateBody(maintenanceCreateSchema),async(req,res)=>{try{await ensureReferences(scope(req),req.validatedBody);const b=req.validatedBody,w=actor(req);const{data,error}=await mutationDatabase(req).from("room_maintenance").insert([{hotel_slug:scope(req),room_id:b.roomId,maintenance_type:b.maintenanceType||"repair",priority:b.priority||"normal",description:b.description,start_at:b.startAt,end_at:b.endAt||null,assigned_to:b.assignedTo||null,cost:b.cost??null,created_by_user_id:w.id}]).select().single();if(error)throw error;await audit(req,"maintenance_created","room_maintenance",data.id,{},data,b.description);res.status(201).json({success:true,maintenance:data});}catch(error){const known=handleKnown(res,error);return known||fail(res,error,"Failed to create maintenance block");}});
router.patch("/maintenance/:id",validateBody(maintenanceUpdateSchema),async(req,res)=>{try{const resourceId=id(req.params.id);const current=await owned("room_maintenance",resourceId,scope(req));if(!current)return res.status(404).json({success:false,message:"Maintenance record not found for this hotel"});const b=req.validatedBody,payload={status:b.status,updated_at:new Date().toISOString()};if(b.endAt!==undefined)payload.end_at=b.endAt;if(b.assignedTo!==undefined)payload.assigned_to=b.assignedTo||null;if(b.cost!==undefined)payload.cost=b.cost;if(b.description!==undefined)payload.description=b.description||current.description;if(b.status==="completed")payload.completed_at=new Date().toISOString();const{data,error}=await mutationDatabase(req).from("room_maintenance").update(payload).eq("id",resourceId).eq("hotel_slug",scope(req)).select().maybeSingle();if(error)throw error;await audit(req,"maintenance_updated","room_maintenance",resourceId,current,data);res.json({success:true,maintenance:data});}catch(error){return fail(res,error,"Failed to update maintenance block");}});

router.post("/housekeeping",validateBody(housekeepingCreateSchema),async(req,res)=>{try{await ensureReferences(scope(req),req.validatedBody);const b=req.validatedBody,w=actor(req);const{data,error}=await mutationDatabase(req).from("room_housekeeping_tasks").insert([{hotel_slug:scope(req),room_id:b.roomId,booking_id:b.bookingId||null,status:b.status||"dirty",priority:b.priority||"normal",assigned_to:b.assignedTo||null,notes:b.notes||"",updated_by_user_id:w.id}]).select().single();if(error)throw error;await audit(req,"housekeeping_created","housekeeping_task",data.id,{},data);res.status(201).json({success:true,housekeeping:data});}catch(error){const known=handleKnown(res,error);return known||fail(res,error,"Failed to create housekeeping task");}});
router.patch("/housekeeping/:id",validateBody(housekeepingUpdateSchema),async(req,res)=>{try{const resourceId=id(req.params.id);const current=await owned("room_housekeeping_tasks",resourceId,scope(req));if(!current)return res.status(404).json({success:false,message:"Housekeeping task not found for this hotel"});const b=req.validatedBody,w=actor(req),now=new Date().toISOString(),payload={status:b.status,updated_by_user_id:w.id,updated_at:now};if(b.assignedTo!==undefined)payload.assigned_to=b.assignedTo||null;if(b.notes!==undefined)payload.notes=b.notes||"";if(b.status==="cleaning"&&!current.started_at)payload.started_at=now;if(b.status==="clean")payload.completed_at=now;if(b.status==="inspected")payload.inspected_at=now;const{data,error}=await mutationDatabase(req).from("room_housekeeping_tasks").update(payload).eq("id",resourceId).eq("hotel_slug",scope(req)).select().maybeSingle();if(error)throw error;await audit(req,"housekeeping_updated","housekeeping_task",resourceId,current,data);res.json({success:true,housekeeping:data});}catch(error){return fail(res,error,"Failed to update housekeeping task");}});

router.post("/bookings/:id/shift",validateBody(roomShiftSchema),async(req,res)=>{try{const bookingId=id(req.params.id);await ensureReferences(scope(req),{bookingId,roomId:req.validatedBody.targetRoomId});const w=actor(req);const{data,error}=await mutationDatabase(req).rpc("shift_room_booking",{p_hotel_slug:scope(req),p_booking_id:bookingId,p_target_room_id:req.validatedBody.targetRoomId,p_reason:req.validatedBody.reason,p_actor_id:w.id,p_actor_role:w.role,p_effective_at:req.validatedBody.effectiveAt||new Date().toISOString()});if(error)throw error;res.json({success:true,message:"Room shift completed",shift:data});}catch(error){const known=handleKnown(res,error);return known||fail(res,error,"Failed to shift room");}});
router.post("/bookings/:id/extend",validateBody(stayExtensionSchema),async(req,res)=>{try{const bookingId=id(req.params.id);await ensureReferences(scope(req),{bookingId});const w=actor(req);const{data,error}=await mutationDatabase(req).rpc("extend_room_booking",{p_hotel_slug:scope(req),p_booking_id:bookingId,p_new_check_out:req.validatedBody.newCheckOutDate,p_actor_id:w.id,p_actor_role:w.role,p_reason:req.validatedBody.reason||""});if(error)throw error;res.json({success:true,message:"Stay extended",extension:data});}catch(error){const known=handleKnown(res,error);return known||fail(res,error,"Failed to extend stay");}});

router.get("/reports/summary", async (req, res) => {
  try {
    const hotelSlug = scope(req);
    const from = String(
      req.query.from || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10)
    );
    const to = String(req.query.to || new Date().toISOString().slice(0, 10));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) {
      return res.status(400).json({ success: false, message: "Valid report dates are required" });
    }

    const [bookings, payments, shifts, maintenance, refunds] = await Promise.all([
      supabase.from("room_bookings")
        .select("id,room_id,total_nights,room_price,tax_amount,discount_amount,total_amount,pricing_snapshot,booking_status,booking_source,check_in_date,check_out_date")
        .eq("hotel_slug", hotelSlug).gte("check_in_date", from).lte("check_in_date", to).limit(2000),
      supabase.from("room_booking_payments")
        .select("id,booking_id,amount,payment_method,payment_status,paid_at,created_at")
        .eq("hotel_slug", hotelSlug).gte("created_at", `${from}T00:00:00Z`).lte("created_at", `${to}T23:59:59Z`).limit(2000),
      supabase.from("room_shifts")
        .select("id,booking_id,shift_kind,rate_difference,effective_at")
        .eq("hotel_slug", hotelSlug).gte("effective_at", `${from}T00:00:00Z`).lte("effective_at", `${to}T23:59:59Z`).limit(1000),
      supabase.from("room_maintenance")
        .select("id,room_id,status,cost,start_at,end_at")
        .eq("hotel_slug", hotelSlug).gte("start_at", `${from}T00:00:00Z`).lte("start_at", `${to}T23:59:59Z`).limit(1000),
      optionalRoomRefunds(hotelSlug, from, to)
    ]);
    const requestError = [bookings, payments, shifts, maintenance].find((result) => result.error)?.error;
    if (requestError) throw requestError;

    const rows = bookings.data || [];
    const completed = rows.filter((booking) => booking.booking_status === "checked_out");
    const occupiedNights = completed.reduce((sum, booking) => sum + Number(booking.total_nights || 0), 0);
    const roomSubtotal = completed.reduce((sum, booking) => sum + Number(booking.room_price || 0), 0);
    const discountTotal = completed.reduce((sum, booking) => sum + Number(booking.discount_amount || 0), 0);
    const taxTotal = completed.reduce((sum, booking) => sum + Number(booking.tax_amount || 0), 0);
    const netRoomRevenue = Math.max(0, roomSubtotal - discountTotal);
    const paymentTotal = (payments.data || [])
      .filter((payment) => payment.payment_status === "paid")
      .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
    const refundTotal = refunds
      .filter((refund) => refund.status === "completed")
      .reduce((sum, refund) => sum + Number(refund.amount || 0), 0);
    const gstComponents = completed.reduce((totals, booking) => {
      const components = booking.pricing_snapshot?.taxSnapshot?.components || {};
      for (const [key, component] of Object.entries(components)) {
        totals[key] = Math.round(((totals[key] || 0) + Number(component.amount || 0)) * 100) / 100;
      }
      return totals;
    }, {});

    res.json({
      success: true,
      hotelSlug,
      period: { from, to },
      dataWindow: {
        truncated: rows.length >= 2000 || (payments.data || []).length >= 2000 ||
          (shifts.data || []).length >= 1000 || (maintenance.data || []).length >= 1000 ||
          refunds.length >= 2000,
        limits: { bookings: 2000, payments: 2000, refunds: 2000, shifts: 1000, maintenance: 1000 }
      },
      formulas: {
        occupancyRate: "occupied room nights / available room nights x 100",
        adr: "net room revenue / occupied room nights",
        revpar: "net room revenue / available room nights",
        averageStay: "completed occupied nights / completed stays"
      },
      summary: {
        bookings: rows.length,
        completedStays: completed.length,
        cancelled: rows.filter((booking) => booking.booking_status === "cancelled").length,
        noShows: rows.filter((booking) => booking.booking_status === "no_show").length,
        occupiedRoomNights: occupiedNights,
        roomSubtotal: Math.round(roomSubtotal * 100) / 100,
        discounts: Math.round(discountTotal * 100) / 100,
        netRoomRevenue,
        roomTax: Math.round(taxTotal * 100) / 100,
        gstComponents,
        adr: occupiedNights ? Math.round((netRoomRevenue / occupiedNights) * 100) / 100 : 0,
        payments: paymentTotal,
        refunds: Math.round(refundTotal * 100) / 100,
        netPayments: Math.round((paymentTotal - refundTotal) * 100) / 100,
        roomShifts: (shifts.data || []).length,
        maintenanceEvents: (maintenance.data || []).length
      },
      bookings: rows,
      payments: payments.data || [],
      refunds,
      shifts: shifts.data || [],
      maintenance: maintenance.data || []
    });
  } catch (error) {
    return fail(res, error, "Failed to load Room Reports");
  }
});

module.exports = router;
