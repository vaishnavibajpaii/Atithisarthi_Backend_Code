const express = require("express");
const { ZodError } = require("zod");
const { ensurePublicHotelAccess } = require("../utils/public-hotel-access");
const { env } = require("../config/env");
const { getTenantMutationClient } = require("../utils/tenant-route-database");
const { getTenantRequestScope } = require("../utils/tenant-request-context");
const { publicRoomBookingLimiter } = require("../middleware/public-rate-limiters");
const { validateBody, formatZodError } = require("../validators/common");
const {
  publicRoomAvailabilityQuerySchema,
  publicRoomDiscoveryQuerySchema,
  publicRoomBookingCreateSchema
} = require("../validators/rooms");
const { supabase } = require("../utils/supabase");
const { createNotificationEventSafely } = require("../utils/notifications");
const {
  getCachedPublicRoutePayload,
  setCachedPublicRoutePayload
} = require("../utils/public-route-cache");
const { ensureHotelFeatureEnabled } = require("../middleware/require-hotel-feature");
const {
  buildFeatureDisabledPayload,
  isHotelFeatureEnabled
} = require("../utils/hotel-feature-settings");
const {
  fetchTenantPublicRoomAvailability,
  fetchTenantPublicRoomDetail,
  fetchTenantPublicRoomDiscovery,
  fetchTenantPublicRoomFeatureConfig,
  fetchTenantPublicRooms
} = require("../utils/tenant-public-rooms");
const {
  applyRoomDiscoverySort,
  buildPagination,
  combinePublicRoomImages,
  firstLegacyImage,
  getSafeArray,
  mapManagedPublicImage,
  mapPublicRoom,
  mapSummaryImage,
  normalizeText
} = require("../utils/public-room-presentation");
const {
  getRoomDefaultNightlyPrice,
  resolveRoomBookingPricing
} = require("../utils/room-pricing");
const {
  findRoomBookingByIdempotency,
  getRoomIdempotencyKey,
  isRoomIdempotencyConflict
} = require("../utils/room-idempotency");
const {
  ROOM_BOOKING_CONFLICT_CODE,
  ROOM_BOOKING_CONFLICT_MESSAGE,
  applyActiveBookingOverlapFilter,
  fetchMaintenanceBlockedRoomIds,
  isRoomBookingOverlapError
} = require("../utils/room-availability");

const router = express.Router();
const PUBLIC_ROOM_CACHE_CONTROL = "public, max-age=30, stale-while-revalidate=120";
const PUBLIC_ROOM_LIVE_CACHE_CONTROL = "private, no-store";
const PUBLIC_ROOM_DISCOVERY_SCAN_LIMIT = 500;

function isMissingRoomBookingSchemaError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();
  const roomTables = [
    "hotel_feature_settings",
    "room_types",
    "rooms",
    "room_bookings"
  ];

  return (
    code === "42P01" ||
    code === "42703" ||
    code === "PGRST205" ||
    code === "PGRST204" ||
    roomTables.some((tableName) => details.includes(tableName))
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

function isMissingRoomGallerySchemaError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`.toLowerCase();
  return details.includes("room_images") && ["42P01", "42703", "PGRST204", "PGRST205"].includes(code);
}

async function fetchManagedPublicRoomImages(hotelSlug, roomIds, roomTypeIds) {
  if (!roomIds.length && !roomTypeIds.length) return { room: new Map(), roomType: new Map(), schemaReady: true };
  const emptyResult = { data: [], error: null };
  const [roomResult, roomTypeResult] = await Promise.all([
    roomIds.length
      ? supabase.from("room_images")
        .select("id,room_id,room_type_id,original_url,card_url,optimized_url,thumbnail_url,alt_text,caption,is_primary,width,height,display_order")
        .eq("hotel_slug", hotelSlug).eq("is_active", true).in("room_id", roomIds).order("display_order").order("id")
      : Promise.resolve(emptyResult),
    roomTypeIds.length
      ? supabase.from("room_images")
        .select("id,room_id,room_type_id,original_url,card_url,optimized_url,thumbnail_url,alt_text,caption,is_primary,width,height,display_order")
        .eq("hotel_slug", hotelSlug).eq("is_active", true).in("room_type_id", roomTypeIds).order("display_order").order("id")
      : Promise.resolve(emptyResult)
  ]);
  const firstError = roomResult.error || roomTypeResult.error;
  if (firstError) {
    if (isMissingRoomGallerySchemaError(firstError)) return { room: new Map(), roomType: new Map(), schemaReady: false };
    throw firstError;
  }
  const group = (rows, key, source) => (rows || []).reduce((map, row) => {
    const image = mapManagedPublicImage(row, source);
    if (!image) return map;
    const targetId = String(row[key]);
    map.set(targetId, [...(map.get(targetId) || []), image]);
    return map;
  }, new Map());
  return {
    room: group(roomResult.data, "room_id", "room"),
    roomType: group(roomTypeResult.data, "room_type_id", "roomType"),
    schemaReady: true
  };
}

function buildRoomFeatureDisabledResponse(res) {
  return res.status(403).json({
    success: false,
    code: "ROOM_BOOKING_DISABLED",
    message: "Room booking is not enabled for this hotel"
  });
}

function buildMissingSchemaResponse(res) {
  return res.status(400).json({
    success: false,
    schemaReady: false,
    message: "Room booking schema is not initialized yet"
  });
}

async function ensurePublicRoomBookingEnabled(res, hotelSlug = "", tenantScope = null) {
  let featureConfig;
  if (env.tenantRuntimePublicRoomsEnabled && tenantScope) {
    featureConfig = await fetchTenantPublicRoomFeatureConfig(
      tenantScope,
      hotelSlug
    );
    if (!isHotelFeatureEnabled(featureConfig, "rooms")) {
      res.status(403).json(buildFeatureDisabledPayload("rooms"));
      return false;
    }
  } else {
    featureConfig = await ensureHotelFeatureEnabled(res, {
      featureKey: "rooms",
      hotelSlug
    });
  }

  if (!featureConfig) {
    return false;
  }

  if (featureConfig.enableRoomBooking !== true) {
    buildRoomFeatureDisabledResponse(res);
    return false;
  }

  return true;
}

function roundMoney(value = 0) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  return Math.round(numericValue * 100) / 100;
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

function mapPublicBooking(booking = {}) {
  return {
    id: booking.id,
    hotelSlug: normalizeText(booking.hotel_slug, 120),
    roomId: booking.room_id,
    guestName: booking.guest_name || "",
    checkInDate: booking.check_in_date || "",
    checkOutDate: booking.check_out_date || "",
    adults: Number(booking.adults || 0),
    children: Number(booking.children || 0),
    totalNights: Number(booking.total_nights || 0),
    roomPrice: Number(booking.room_price || 0),
    taxAmount: Number(booking.tax_amount || 0),
    discountAmount: Number(booking.discount_amount || 0),
    totalAmount: Number(booking.total_amount || 0),
    bookingStatus: booking.booking_status || "pending",
    paymentStatus: booking.payment_status || "unpaid",
    bookingSource: booking.booking_source || "online",
    createdAt: booking.created_at || ""
  };
}

async function fetchPublicRooms(hotelSlug = "", { adults = 0, children = 0 } = {}) {
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
    throw roomsError;
  }

  const roomTypeIds = [
    ...new Set((rooms || []).map((room) => room.room_type_id).filter(Boolean))
  ];
  let roomTypesById = new Map();

  if (roomTypeIds.length) {
    const { data: roomTypes, error: roomTypesError } = await supabase
      .from("room_types")
      .select("*")
      .eq("hotel_slug", hotelSlug)
      .eq("is_active", true)
      .in("id", roomTypeIds);

    if (roomTypesError) {
      throw roomTypesError;
    }

    roomTypesById = new Map(
      (roomTypes || []).map((roomType) => [String(roomType.id), roomType])
    );
  }

  const roomIds = (rooms || []).map((room) => room.id);
  const managedImages = await fetchManagedPublicRoomImages(hotelSlug, roomIds, roomTypeIds);

  return (rooms || []).map((room) => {
    const roomType = roomTypesById.get(String(room.room_type_id)) || null;
    const galleryImages = combinePublicRoomImages(
      room,
      roomType,
      managedImages.room.get(String(room.id)) || [],
      managedImages.roomType.get(String(room.room_type_id)) || []
    );
    return mapPublicRoom(room, roomType, galleryImages);
  });
}

async function fetchPrimaryPublicImages(hotelSlug, roomIds = [], roomTypeIds = []) {
  const emptyResult = { data: [], error: null };
  const [roomResult, roomTypeResult] = await Promise.all([
    roomIds.length
      ? supabase.from("room_images")
        .select("id,room_id,room_type_id,original_url,card_url,optimized_url,thumbnail_url,alt_text,caption,is_primary,width,height,display_order")
        .eq("hotel_slug", hotelSlug).eq("is_active", true).eq("is_primary", true).in("room_id", roomIds).order("display_order").order("id")
      : Promise.resolve(emptyResult),
    roomTypeIds.length
      ? supabase.from("room_images")
        .select("id,room_id,room_type_id,original_url,card_url,optimized_url,thumbnail_url,alt_text,caption,is_primary,width,height,display_order")
        .eq("hotel_slug", hotelSlug).eq("is_active", true).eq("is_primary", true).in("room_type_id", roomTypeIds).order("display_order").order("id")
      : Promise.resolve(emptyResult)
  ]);
  const firstError = roomResult.error || roomTypeResult.error;
  if (firstError) {
    if (isMissingRoomGallerySchemaError(firstError)) return { room: new Map(), roomType: new Map() };
    throw firstError;
  }
  const toMap = (rows, key, source) => new Map((rows || []).map((row) => [String(row[key]), mapManagedPublicImage(row, source)]));
  return {
    room: toMap(roomResult.data, "room_id", "room"),
    roomType: toMap(roomTypeResult.data, "room_type_id", "roomType")
  };
}

async function fetchBlockedRoomIds({ hotelSlug, roomIds, checkInDate, checkOutDate }) {
  if (!checkInDate || !checkOutDate || !roomIds.length) return new Set();
  const bookingQuery = applyActiveBookingOverlapFilter(
    supabase.from("room_bookings").select("room_id").eq("hotel_slug", hotelSlug).in("room_id", roomIds),
    { checkInDate, checkOutDate }
  );
  const maintenanceQuery = fetchMaintenanceBlockedRoomIds({
    supabaseClient: supabase,
    hotelSlug,
    roomIds,
    checkInDate,
    checkOutDate
  });
  const [{ data, error }, maintenance] = await Promise.all([bookingQuery, maintenanceQuery]);
  if (error) throw error;
  const blocked = new Set((data || []).map((booking) => String(booking.room_id)));
  maintenance.forEach((roomId) => blocked.add(String(roomId)));
  return blocked;
}
async function fetchPublicRoomTypeDiscovery(hotelSlug, filters) {
  const { page, pageSize, search, adults = 0, children = 0, minPrice, maxPrice, amenity, sort, checkInDate, checkOutDate } = filters;
  let query = supabase
    .from("room_types")
    .select("id,name,description,base_price,max_adults,max_children,amenities_json,images_json,cancellation_policy", { count: "exact" })
    .eq("hotel_slug", hotelSlug)
    .eq("is_active", true);
  if (search) query = query.ilike("name", `%${search}%`);
  if (adults > 0) query = query.gte("max_adults", adults);
  if (children > 0) query = query.gte("max_children", children);
  if (minPrice !== undefined) query = query.gte("base_price", minPrice);
  if (maxPrice !== undefined) query = query.lte("base_price", maxPrice);
  if (amenity) query = query.contains("amenities_json", [amenity]);
  if (sort === "price_asc") query = query.order("base_price", { ascending: true }).order("name", { ascending: true });
  else if (sort === "price_desc") query = query.order("base_price", { ascending: false }).order("name", { ascending: true });
  else if (sort === "capacity") query = query.order("max_adults", { ascending: false }).order("name", { ascending: true });
  else query = query.order("id", { ascending: true });
  const offset = (page - 1) * pageSize;
  const { data: roomTypes, count, error } = await query.range(offset, offset + pageSize - 1);
  if (error) throw error;
  const typeIds = (roomTypes || []).map((type) => type.id);
  if (!typeIds.length) return { items: [], pagination: buildPagination(page, pageSize, count) };
  let roomQuery = supabase
    .from("rooms")
    .select("id,room_type_id,title,room_number,base_price,discount_price,max_adults,max_children,images_json")
    .eq("hotel_slug", hotelSlug).eq("is_active", true).eq("status", "available").in("room_type_id", typeIds);
  if (adults > 0) roomQuery = roomQuery.gte("max_adults", adults);
  if (children > 0) roomQuery = roomQuery.gte("max_children", children);
  const { data: rooms, error: roomsError } = await roomQuery
    .order("id", { ascending: true })
    .limit(PUBLIC_ROOM_DISCOVERY_SCAN_LIMIT);
  if (roomsError) throw roomsError;
  const roomIds = (rooms || []).map((room) => room.id);
  const [blockedRoomIds, images] = await Promise.all([
    fetchBlockedRoomIds({ hotelSlug, roomIds, checkInDate, checkOutDate }),
    fetchPrimaryPublicImages(hotelSlug, roomIds, typeIds)
  ]);
  const availableByType = new Map();
  for (const room of rooms || []) {
    if (blockedRoomIds.has(String(room.id))) continue;
    const key = String(room.room_type_id);
    const list = availableByType.get(key) || [];
    list.push(room);
    availableByType.set(key, list);
  }
  const items = (roomTypes || []).map((type) => {
    const availableRooms = availableByType.get(String(type.id)) || [];
    const prices = availableRooms.map((room) => getRoomDefaultNightlyPrice({ room, roomType: type }).amount).filter(Number.isFinite);
    const startingPrice = prices.length ? Math.min(...prices) : Number(type.base_price || 0);
    const representativeRoom = availableRooms.find((room) =>
      images.room.has(String(room.id)) || getSafeArray(room.images_json).length
    ) || availableRooms[0];
    const primary = images.roomType.get(String(type.id))
      || (representativeRoom ? images.room.get(String(representativeRoom.id)) : null)
      || firstLegacyImage(type.images_json, type.name)
      || firstLegacyImage(representativeRoom?.images_json, representativeRoom?.title || type.name);
    return {
      kind: "roomType",
      reference: `room-type-${type.id}`,
      roomTypeId: type.id,
      name: type.name || "Room Type",
      shortDescription: normalizeText(type.description, 320),
      capacity: { adults: Number(type.max_adults || 0), children: Number(type.max_children || 0) },
      startingPrice: Math.max(0, Number(startingPrice || 0)),
      currency: "INR",
      availableCount: availableRooms.length,
      availabilityStatus: availableRooms.length === 0 ? "unavailable" : availableRooms.length <= 2 ? "limited" : "available",
      primaryImage: mapSummaryImage(primary, type.name || "Room type"),
      amenities: getSafeArray(type.amenities_json).slice(0, 6)
    };
  });
  return { items, pagination: buildPagination(page, pageSize, count) };
}

async function fetchPublicRoomDiscovery(hotelSlug, filters) {
  const { page, pageSize, search, roomTypeId, adults = 0, children = 0, minPrice, maxPrice, amenity, bedType, floor, sort, checkInDate, checkOutDate } = filters;
  let query = supabase
    .from("rooms")
    .select("id,room_type_id,room_number,floor,title,capacity,max_adults,max_children,bed_type,base_price,discount_price,tax_percent,amenities_json,images_json,description", { count: "exact" })
    .eq("hotel_slug", hotelSlug).eq("is_active", true).eq("status", "available");
  if (roomTypeId) query = query.eq("room_type_id", roomTypeId);
  if (adults > 0) query = query.gte("max_adults", adults);
  if (children > 0) query = query.gte("max_children", children);
  if (minPrice !== undefined) query = query.gte("base_price", minPrice);
  if (maxPrice !== undefined) query = query.lte("base_price", maxPrice);
  if (amenity) query = query.contains("amenities_json", [amenity]);
  if (bedType) query = query.ilike("bed_type", bedType);
  if (floor) query = query.ilike("floor", floor);
  if (search) query = /^[\d-]+$/.test(search) ? query.ilike("room_number", `%${search}%`) : query.ilike("title", `%${search}%`);
  const { data: candidates, count, error } = await query.order("room_number", { ascending: true }).limit(PUBLIC_ROOM_DISCOVERY_SCAN_LIMIT);
  if (error) throw error;
  const candidateRooms = candidates || [];
  const roomTypeIds = [...new Set(candidateRooms.map((room) => room.room_type_id).filter(Boolean))];
  const roomTypesPromise = roomTypeIds.length
    ? supabase.from("room_types").select("id,name,description,base_price,max_adults,max_children,amenities_json,images_json").eq("hotel_slug", hotelSlug).eq("is_active", true).in("id", roomTypeIds)
    : Promise.resolve({ data: [], error: null });
  const blockedRoomIdsPromise = fetchBlockedRoomIds({ hotelSlug, roomIds: candidateRooms.map((room) => room.id), checkInDate, checkOutDate });
  const [{ data: roomTypes, error: typesError }, blockedRoomIds] = await Promise.all([roomTypesPromise, blockedRoomIdsPromise]);
  if (typesError) throw typesError;
  const typesById = new Map((roomTypes || []).map((type) => [String(type.id), type]));  let availableRooms = candidateRooms.filter((room) => !blockedRoomIds.has(String(room.id)));
  let summaries = availableRooms.map((room) => {
    const type = typesById.get(String(room.room_type_id)) || null;
    return {
      kind: "room",
      reference: `room-${room.id}`,
      id: room.id,
      roomTypeId: room.room_type_id || null,
      roomType: type ? { id: type.id, name: type.name || "" } : null,
      name: room.title || `Room ${room.room_number || ""}`.trim(),
      roomNumber: room.room_number || "",
      shortDescription: normalizeText(room.description || type?.description, 320),
      floor: room.floor || "",
      bedType: room.bed_type || "",
      capacity: { adults: Number(room.max_adults || room.capacity || 0), children: Number(room.max_children || 0) },
      startingPrice: Math.max(0, Number(getRoomDefaultNightlyPrice({ room, roomType: type }).amount || 0)),
      currency: "INR",
      availabilityStatus: "available",
      amenities: (getSafeArray(room.amenities_json).length ? getSafeArray(room.amenities_json) : getSafeArray(type?.amenities_json)).slice(0, 6),
      _room: room,
      _type: type
    };
  });
  summaries = applyRoomDiscoverySort(summaries, sort);
  const totalItems = summaries.length;
  const offset = (page - 1) * pageSize;
  const pageItems = summaries.slice(offset, offset + pageSize);
  const images = await fetchPrimaryPublicImages(hotelSlug, pageItems.map((item) => item.id), [...new Set(pageItems.map((item) => item.roomTypeId).filter(Boolean))]);
  const items = pageItems.map((item) => {
    const primary = images.room.get(String(item.id)) || images.roomType.get(String(item.roomTypeId)) || firstLegacyImage(item._room.images_json, item.name) || firstLegacyImage(item._type?.images_json, item.name);
    const { _room, _type, ...publicItem } = item;
    return { ...publicItem, primaryImage: mapSummaryImage(primary, item.name) };
  });
  return {
    items,
    pagination: buildPagination(page, pageSize, totalItems),
    scannedItems: candidateRooms.length,
    scanLimitReached: Number(count || 0) > PUBLIC_ROOM_DISCOVERY_SCAN_LIMIT
  };
}

async function fetchPublicRoomDetail(hotelSlug, roomId) {
  const { data: room, error } = await supabase
    .from("rooms").select("*").eq("id", roomId).eq("hotel_slug", hotelSlug).eq("is_active", true).eq("status", "available").maybeSingle();
  if (error) throw error;
  if (!room) return null;
  const { data: roomType, error: typeError } = room.room_type_id
    ? await supabase.from("room_types").select("*").eq("id", room.room_type_id).eq("hotel_slug", hotelSlug).eq("is_active", true).maybeSingle()
    : { data: null, error: null };
  if (typeError) throw typeError;
  const managed = await fetchManagedPublicRoomImages(hotelSlug, [room.id], room.room_type_id ? [room.room_type_id] : []);
  const galleryImages = combinePublicRoomImages(room, roomType, managed.room.get(String(room.id)) || [], managed.roomType.get(String(room.room_type_id)) || []);
  return mapPublicRoom(room, roomType, galleryImages);
}
async function fetchPublicBookableRoom({ hotelSlug, roomId }) {
  const { data, error } = await supabase
    .from("rooms")
    .select("*")
    .eq("id", roomId)
    .eq("hotel_slug", hotelSlug)
    .eq("is_active", true)
    .eq("status", "available")
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return {
      ok: false,
      status: 404,
      message: "Room is not available for booking"
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

  if (error) {
    throw error;
  }

  return Array.isArray(data) && data.length > 0;
}

router.get("/:slug/discovery", async (req, res) => {
  try {
    const slug = normalizeText(req.params.slug, 120);
    const parsedQuery = parseQuery(publicRoomDiscoveryQuerySchema, req.query);
    if (parsedQuery.errors) {
      return res.status(400).json({ success: false, message: "Validation failed", errors: parsedQuery.errors });
    }
    const hotelAccess = await ensurePublicHotelAccess(req, res, slug, {
      notFoundMessage: "Hotel rooms are not publicly available",
      forbiddenMessage: "This hotel room discovery is not available for the current origin"
    });
    if (!hotelAccess) return;
    const canonicalSlug = hotelAccess.slug;
    const tenantScope = getTenantRequestScope(req);
    if (!(await ensurePublicRoomBookingEnabled(res, canonicalSlug, tenantScope))) return;
    const filters = parsedQuery.values;
    const hasLiveAvailability = Boolean(filters.checkInDate && filters.checkOutDate);
    const cacheKey = `rooms:${canonicalSlug}:discovery:${JSON.stringify(filters)}`;
    if (!hasLiveAvailability) {
      const cached = getCachedPublicRoutePayload(cacheKey);
      if (cached) {
        res.set("Cache-Control", PUBLIC_ROOM_CACHE_CONTROL);
        return res.json(cached);
      }
    }
    const result = env.tenantRuntimePublicRoomsEnabled
      ? await fetchTenantPublicRoomDiscovery(tenantScope, canonicalSlug, filters)
      : filters.mode === "rooms"
        ? await fetchPublicRoomDiscovery(canonicalSlug, filters)
        : await fetchPublicRoomTypeDiscovery(canonicalSlug, filters);
    const payload = {
      success: true,
      hotelSlug: canonicalSlug,
      mode: filters.mode,
      authoritativeAvailability: hasLiveAvailability,
      query: {
        checkInDate: filters.checkInDate || "",
        checkOutDate: filters.checkOutDate || "",
        adults: Number(filters.adults || 0),
        children: Number(filters.children || 0),
        sort: filters.sort
      },
      ...result
    };
    if (hasLiveAvailability) {
      res.set("Cache-Control", PUBLIC_ROOM_LIVE_CACHE_CONTROL);
    } else {
      setCachedPublicRoutePayload(cacheKey, payload);
      res.set("Cache-Control", PUBLIC_ROOM_CACHE_CONTROL);
    }
    return res.json(payload);
  } catch (error) {
    if (isMissingRoomBookingSchemaError(error)) return buildMissingSchemaResponse(res);
    console.error("Public room discovery error:", error);
    return res.status(500).json({ success: false, message: "Failed to discover rooms" });
  }
});

router.get("/:slug/rooms/:roomId", async (req, res) => {
  try {
    const slug = normalizeText(req.params.slug, 120);
    const roomId = Number(req.params.roomId);
    if (!Number.isSafeInteger(roomId) || roomId <= 0) {
      return res.status(400).json({ success: false, message: "A valid room reference is required" });
    }
    const hotelAccess = await ensurePublicHotelAccess(req, res, slug, {
      notFoundMessage: "Hotel room is not publicly available",
      forbiddenMessage: "This hotel room is not available for the current origin"
    });
    if (!hotelAccess) return;
    const canonicalSlug = hotelAccess.slug;
    const tenantScope = getTenantRequestScope(req);
    if (!(await ensurePublicRoomBookingEnabled(res, canonicalSlug, tenantScope))) return;
    const room = env.tenantRuntimePublicRoomsEnabled
      ? await fetchTenantPublicRoomDetail(tenantScope, canonicalSlug, roomId)
      : await fetchPublicRoomDetail(canonicalSlug, roomId);
    if (!room) return res.status(404).json({ success: false, message: "Room is not publicly available" });
    res.set("Cache-Control", PUBLIC_ROOM_CACHE_CONTROL);
    return res.json({ success: true, hotelSlug: canonicalSlug, room });
  } catch (error) {
    if (isMissingRoomBookingSchemaError(error)) return buildMissingSchemaResponse(res);
    console.error("Public room detail error:", error);
    return res.status(500).json({ success: false, message: "Failed to load room details" });
  }
});
router.get("/:slug", async (req, res) => {
  try {
    const slug = normalizeText(req.params.slug, 120);
    const hotelAccess = await ensurePublicHotelAccess(req, res, slug, {
      notFoundMessage: "Hotel rooms are not publicly available",
      forbiddenMessage: "This hotel room content is not available for the current origin"
    });

    if (!hotelAccess) {
      return;
    }

    const canonicalSlug = hotelAccess.slug;
    const tenantScope = getTenantRequestScope(req);
    if (!(await ensurePublicRoomBookingEnabled(res, canonicalSlug, tenantScope))) {
      return;
    }

    const rooms = env.tenantRuntimePublicRoomsEnabled
      ? await fetchTenantPublicRooms(tenantScope, canonicalSlug)
      : await fetchPublicRooms(canonicalSlug);

    res.set("Cache-Control", PUBLIC_ROOM_CACHE_CONTROL);
    res.json({
      success: true,
      hotelSlug: canonicalSlug,
      count: rooms.length,
      rooms
    });
  } catch (error) {
    if (isMissingRoomBookingSchemaError(error)) {
      return buildMissingSchemaResponse(res);
    }

    console.error("Public rooms fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch rooms"
    });
  }
});

router.get("/:slug/availability", async (req, res) => {
  try {
    const slug = normalizeText(req.params.slug, 120);
    const parsedQuery = parseQuery(publicRoomAvailabilityQuerySchema, req.query);

    if (parsedQuery.errors) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: parsedQuery.errors
      });
    }

    const hotelAccess = await ensurePublicHotelAccess(req, res, slug, {
      notFoundMessage: "Hotel rooms are not publicly available",
      forbiddenMessage: "This hotel room availability is not available for the current origin"
    });

    if (!hotelAccess) {
      return;
    }

    const canonicalSlug = hotelAccess.slug;
    const tenantScope = getTenantRequestScope(req);
    if (!(await ensurePublicRoomBookingEnabled(res, canonicalSlug, tenantScope))) {
      return;
    }

    const {
      checkInDate,
      checkOutDate,
      adults = 0,
      children = 0
    } = parsedQuery.values;
    if (env.tenantRuntimePublicRoomsEnabled) {
      const rooms = await fetchTenantPublicRoomAvailability(
        tenantScope,
        canonicalSlug,
        { checkInDate, checkOutDate, adults, children }
      );
      res.set("Cache-Control", PUBLIC_ROOM_LIVE_CACHE_CONTROL);
      return res.json({
        success: true,
        hotelSlug: canonicalSlug,
        checkInDate,
        checkOutDate,
        count: rooms.length,
        rooms
      });
    }

    const rooms = await fetchPublicRooms(canonicalSlug, { adults, children });
    const roomIds = rooms.map((room) => room.id);

    if (!roomIds.length) {
      res.set("Cache-Control", PUBLIC_ROOM_LIVE_CACHE_CONTROL);
      return res.json({
        success: true,
        hotelSlug: canonicalSlug,
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
        .eq("hotel_slug", canonicalSlug)
        .in("room_id", roomIds),
      { checkInDate, checkOutDate }
    );

    if (bookingsError) {
      throw bookingsError;
    }

    const blockedRoomIds = new Set(
      (blockingBookings || []).map((booking) => String(booking.room_id))
    );
    const maintenanceBlockedRoomIds = await fetchMaintenanceBlockedRoomIds({
      supabaseClient: supabase,
      hotelSlug: canonicalSlug,
      roomIds,
      checkInDate,
      checkOutDate
    });
    const availableRooms = rooms.filter((room) => !blockedRoomIds.has(String(room.id)));
    const dateAvailableRooms = availableRooms.filter(
      (room) => !maintenanceBlockedRoomIds.has(String(room.id))
    );

    res.set("Cache-Control", PUBLIC_ROOM_LIVE_CACHE_CONTROL);
    res.json({
      success: true,
      hotelSlug: canonicalSlug,
      checkInDate,
      checkOutDate,
      count: dateAvailableRooms.length,
      rooms: dateAvailableRooms
    });
  } catch (error) {
    if (isMissingRoomBookingSchemaError(error)) {
      return buildMissingSchemaResponse(res);
    }

    console.error("Public room availability fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch room availability"
    });
  }
});

router.post(
  "/:slug/bookings",
  publicRoomBookingLimiter,
  validateBody(publicRoomBookingCreateSchema),
  async (req, res) => {
    try {
      const slug = normalizeText(req.params.slug, 120);
      const {
        roomId,
        guestName,
        guestPhone,
        guestEmail,
        guestCompanyName,
        guestGstin,
        guestPlaceOfSupply,
        checkInDate,
        checkOutDate,
        adults = 1,
        children = 0,
        notes
      } = req.validatedBody;
      const hotelAccess = await ensurePublicHotelAccess(req, res, slug, {
        notFoundMessage: "Hotel rooms are not publicly available",
        forbiddenMessage: "This hotel room booking is not available for the current origin"
      });

      if (!hotelAccess) {
        return;
      }

      if (!(await ensurePublicRoomBookingEnabled(res, slug))) {
        return;
      }

      const idempotency = getRoomIdempotencyKey(req);
      if (idempotency.error) {
        return res.status(400).json({ success: false, message: idempotency.error });
      }
      if (idempotency.key) {
        const existingBooking = await findRoomBookingByIdempotency({
          supabaseClient: supabase,
          hotelSlug: slug,
          key: idempotency.key
        });
        if (existingBooking) {
          return res.json({
            success: true,
            idempotent: true,
            message: "Room booking request already submitted",
            booking: mapPublicBooking(existingBooking)
          });
        }
      }

      const roomResult = await fetchPublicBookableRoom({
        hotelSlug: slug,
        roomId
      });

      if (!roomResult.ok) {
        return res.status(roomResult.status).json({
          success: false,
          message: roomResult.message
        });
      }

      const room = roomResult.room;

      if (Number(room.max_adults || 0) < Number(adults || 0)) {
        return res.status(400).json({
          success: false,
          message: "Selected room does not support the requested adult guest count"
        });
      }

      if (Number(room.max_children || 0) < Number(children || 0)) {
        return res.status(400).json({
          success: false,
          message: "Selected room does not support the requested child guest count"
        });
      }

      const hasConflict = await hasBlockingBooking({
        hotelSlug: slug,
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
        hotelSlug: slug,
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
        hotelSlug: slug,
        room,
        checkInDate,
        checkOutDate,
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

      const database = getTenantMutationClient(req, supabase);
      const scope = env.tenantRuntimeWritesEnabled ? getTenantRequestScope(req) : null;
      const bookingPayload = {
        ...(scope ? { tenant_id: scope.tenantId, property_id: scope.propertyId } : {}),
        hotel_slug: scope?.propertySlug || slug,
        room_id: roomId,
        guest_name: guestName,
        guest_phone: guestPhone,
        guest_email: guestEmail || null,
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
        booking_status: "pending",
        payment_status: totals.paymentStatus,
        booking_source: "online",
        created_by_role: "public",
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

      const { data, error } = await database
        .from("room_bookings")
        .insert([bookingPayload])
        .select()
        .single();

      if (error) {
        if (idempotency.key && isRoomIdempotencyConflict(error)) {
          const existingBooking = await findRoomBookingByIdempotency({
            supabaseClient: database,
            hotelSlug: slug,
            key: idempotency.key
          });
          if (existingBooking) {
            return res.json({ success: true, idempotent: true, message: "Room booking request already submitted", booking: mapPublicBooking(existingBooking) });
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

      void createNotificationEventSafely({
        databaseClient: database,
        tenantId: scope?.tenantId,
        propertyId: scope?.propertyId,
        hotelSlug: data.hotel_slug || slug,
        sourceType: "room_booking",
        sourceId: data.id,
        payload: {
          bookingId: data.id,
          source: "website",
          bookingStatus: data.booking_status || "pending",
          paymentStatus: data.payment_status || "pending",
          eventVersion: data.updated_at || data.created_at || ""
        }
      });

      res.status(201).json({
        success: true,
        message: "Room booking request submitted",
        booking: mapPublicBooking(data)
      });
    } catch (error) {
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
      if (isMissingRoomBookingSchemaError(error)) {
        return buildMissingSchemaResponse(res);
      }

      console.error("Public room booking create error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to submit room booking request"
      });
    }
  }
);

module.exports = router;
