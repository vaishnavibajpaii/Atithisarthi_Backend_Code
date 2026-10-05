"use strict";

const { withTenantTransaction } = require("./tenant-database");
const { normalizeScope } = require("./tenant-public-hotel");
const { normalizeHotelFeatureConfig } = require("./hotel-feature-settings");
const { getRoomDefaultNightlyPrice } = require("./room-pricing");
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
} = require("./public-room-presentation");

const PUBLIC_ROOM_DISCOVERY_SCAN_LIMIT = 500;
const ACTIVE_BLOCKING_BOOKING_STATUSES = ["pending", "confirmed", "checked_in"];

function createTenantPublicRoomsError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function getPayloadRows(result) {
  return (Array.isArray(result?.rows) ? result.rows : [])
    .map((row) => row?.payload)
    .filter((row) => row && typeof row === "object");
}

function getSinglePayload(result, label) {
  const rows = getPayloadRows(result);
  if (rows.length > 1) {
    throw createTenantPublicRoomsError(
      "TENANT_PUBLIC_ROOMS_DATA_CONFLICT",
      `Multiple canonical ${label} rows were returned`
    );
  }
  return rows[0] || null;
}

function runReadOnlyScope(scope, work, options = {}) {
  const transactionRunner = options.transactionRunner || withTenantTransaction;
  return transactionRunner(
    { tenantId: scope.tenantId, propertyId: scope.propertyId },
    work,
    { readOnly: true }
  );
}

function createScopedQuery(scope) {
  return {
    params: [scope.tenantId, scope.propertyId, scope.propertySlug],
    conditions: [
      "target.tenant_id = $1::uuid",
      "target.property_id = $2::bigint",
      "target.hotel_slug = $3"
    ]
  };
}

function addParam(query, value, cast = "") {
  query.params.push(value);
  return `$${query.params.length}${cast}`;
}

function addRoomFilters(query, filters = {}, { discovery = false } = {}) {
  const { adults = 0, children = 0 } = filters;
  if (filters.roomTypeId) {
    query.conditions.push(`target.room_type_id = ${addParam(query, filters.roomTypeId, "::bigint")}`);
  }
  if (adults > 0) {
    query.conditions.push(`target.max_adults >= ${addParam(query, adults, "::integer")}`);
  }
  if (children > 0) {
    query.conditions.push(`target.max_children >= ${addParam(query, children, "::integer")}`);
  }
  if (discovery && filters.minPrice !== undefined) {
    query.conditions.push(`target.base_price >= ${addParam(query, filters.minPrice, "::numeric")}`);
  }
  if (discovery && filters.maxPrice !== undefined) {
    query.conditions.push(`target.base_price <= ${addParam(query, filters.maxPrice, "::numeric")}`);
  }
  if (discovery && filters.amenity) {
    query.conditions.push(`target.amenities_json @> jsonb_build_array(${addParam(query, filters.amenity, "::text")})`);
  }
  if (discovery && filters.bedType) {
    query.conditions.push(`target.bed_type ILIKE ${addParam(query, filters.bedType, "::text")}`);
  }
  if (discovery && filters.floor) {
    query.conditions.push(`target.floor ILIKE ${addParam(query, filters.floor, "::text")}`);
  }
  if (discovery && filters.search) {
    const pattern = `%${filters.search}%`;
    query.conditions.push(
      /^[\d-]+$/.test(filters.search)
        ? `target.room_number ILIKE ${addParam(query, pattern, "::text")}`
        : `target.title ILIKE ${addParam(query, pattern, "::text")}`
    );
  }
}

function addRoomTypeFilters(query, filters = {}) {
  const { adults = 0, children = 0 } = filters;
  if (filters.search) {
    query.conditions.push(`target.name ILIKE ${addParam(query, `%${filters.search}%`, "::text")}`);
  }
  if (adults > 0) {
    query.conditions.push(`target.max_adults >= ${addParam(query, adults, "::integer")}`);
  }
  if (children > 0) {
    query.conditions.push(`target.max_children >= ${addParam(query, children, "::integer")}`);
  }
  if (filters.minPrice !== undefined) {
    query.conditions.push(`target.base_price >= ${addParam(query, filters.minPrice, "::numeric")}`);
  }
  if (filters.maxPrice !== undefined) {
    query.conditions.push(`target.base_price <= ${addParam(query, filters.maxPrice, "::numeric")}`);
  }
  if (filters.amenity) {
    query.conditions.push(`target.amenities_json @> jsonb_build_array(${addParam(query, filters.amenity, "::text")})`);
  }
}

async function relationExists(client, qualifiedName) {
  const result = await client.query(
    "SELECT to_regclass($1::text) IS NOT NULL AS present",
    [qualifiedName]
  );
  return result?.rows?.[0]?.present === true;
}

async function fetchImages(client, scope, roomIds = [], roomTypeIds = [], primaryOnly = false) {
  if ((!roomIds.length && !roomTypeIds.length) || !(await relationExists(client, "public.room_images"))) {
    return { room: new Map(), roomType: new Map(), schemaReady: false };
  }
  async function load(key, ids, source) {
    if (!ids.length) return new Map();
    const result = await client.query(
      `SELECT to_jsonb(image) AS payload
         FROM public.room_images AS image
        WHERE image.tenant_id = $1::uuid
          AND image.property_id = $2::bigint
          AND image.hotel_slug = $3
          AND image.is_active = true
          AND image.${key} = ANY($4::bigint[])
          ${primaryOnly ? "AND image.is_primary = true" : ""}
        ORDER BY image.display_order ASC, image.id ASC`,
      [scope.tenantId, scope.propertyId, scope.propertySlug, ids]
    );
    return getPayloadRows(result).reduce((map, row) => {
      const image = mapManagedPublicImage(row, source);
      if (!image) return map;
      const targetId = String(row[key]);
      if (primaryOnly) map.set(targetId, image);
      else map.set(targetId, [...(map.get(targetId) || []), image]);
      return map;
    }, new Map());
  }
  return {
    room: await load("room_id", roomIds, "room"),
    roomType: await load("room_type_id", roomTypeIds, "roomType"),
    schemaReady: true
  };
}

async function fetchBlockedRoomIds(client, scope, roomIds, checkInDate, checkOutDate) {
  if (!checkInDate || !checkOutDate || !roomIds.length) return new Set();
  const bookingResult = await client.query(
    `SELECT booking.room_id
       FROM public.room_bookings AS booking
      WHERE booking.tenant_id = $1::uuid
        AND booking.property_id = $2::bigint
        AND booking.hotel_slug = $3
        AND booking.room_id = ANY($4::bigint[])
        AND booking.booking_status = ANY($5::text[])
        AND booking.check_in_date < $7::date
        AND booking.check_out_date > $6::date`,
    [
      scope.tenantId,
      scope.propertyId,
      scope.propertySlug,
      roomIds,
      ACTIVE_BLOCKING_BOOKING_STATUSES,
      checkInDate,
      checkOutDate
    ]
  );
  const blocked = new Set((bookingResult.rows || []).map((row) => String(row.room_id)));
  if (!(await relationExists(client, "public.room_maintenance"))) return blocked;
  const maintenanceResult = await client.query(
    `SELECT maintenance.room_id
       FROM public.room_maintenance AS maintenance
      WHERE maintenance.tenant_id = $1::uuid
        AND maintenance.property_id = $2::bigint
        AND maintenance.hotel_slug = $3
        AND maintenance.room_id = ANY($4::bigint[])
        AND maintenance.status = ANY($5::text[])
        AND maintenance.start_at < $7::timestamptz
        AND (maintenance.end_at IS NULL OR maintenance.end_at > $6::timestamptz)`,
    [
      scope.tenantId,
      scope.propertyId,
      scope.propertySlug,
      roomIds,
      ["open", "in_progress"],
      `${checkInDate}T00:00:00.000Z`,
      `${checkOutDate}T00:00:00.000Z`
    ]
  );
  (maintenanceResult.rows || []).forEach((row) => blocked.add(String(row.room_id)));
  return blocked;
}

async function loadRooms(client, scope, filters = {}) {
  const query = createScopedQuery(scope);
  query.conditions.push("target.is_active = true", "target.status = 'available'");
  addRoomFilters(query, filters);
  const result = await client.query(
    `SELECT to_jsonb(target) AS payload
       FROM public.rooms AS target
      WHERE ${query.conditions.join("\n        AND ")}
      ORDER BY target.room_number ASC`,
    query.params
  );
  const rooms = getPayloadRows(result);
  const roomTypeIds = [...new Set(rooms.map((room) => room.room_type_id).filter(Boolean))];
  let roomTypes = [];
  if (roomTypeIds.length) {
    const typesResult = await client.query(
      `SELECT to_jsonb(room_type) AS payload
         FROM public.room_types AS room_type
        WHERE room_type.tenant_id = $1::uuid
          AND room_type.property_id = $2::bigint
          AND room_type.hotel_slug = $3
          AND room_type.is_active = true
          AND room_type.id = ANY($4::bigint[])`,
      [scope.tenantId, scope.propertyId, scope.propertySlug, roomTypeIds]
    );
    roomTypes = getPayloadRows(typesResult);
  }
  const typesById = new Map(roomTypes.map((type) => [String(type.id), type]));
  const images = await fetchImages(client, scope, rooms.map((room) => room.id), roomTypeIds);
  return rooms.map((room) => {
    const roomType = typesById.get(String(room.room_type_id)) || null;
    return mapPublicRoom(
      room,
      roomType,
      combinePublicRoomImages(
        room,
        roomType,
        images.room.get(String(room.id)) || [],
        images.roomType.get(String(room.room_type_id)) || []
      )
    );
  });
}

async function fetchTenantPublicRoomFeatureConfig(inputScope, requestedSlug, options = {}) {
  const scope = normalizeScope(inputScope, requestedSlug);
  return runReadOnlyScope(scope, async (client) => {
    const result = await client.query(
      `SELECT to_jsonb(settings) AS payload
         FROM public.hotel_feature_settings AS settings
        WHERE settings.tenant_id = $1::uuid
          AND settings.property_id = $2::bigint
          AND settings.hotel_slug = $3
        LIMIT 2`,
      [scope.tenantId, scope.propertyId, scope.propertySlug]
    );
    return normalizeHotelFeatureConfig(
      getSinglePayload(result, "room feature settings") || {},
      scope.propertySlug
    );
  }, options);
}

async function fetchTenantPublicRooms(inputScope, requestedSlug, filters = {}, options = {}) {
  const scope = normalizeScope(inputScope, requestedSlug);
  return runReadOnlyScope(scope, (client) => loadRooms(client, scope, filters), options);
}

async function fetchTenantPublicRoomDetail(inputScope, requestedSlug, roomId, options = {}) {
  const scope = normalizeScope(inputScope, requestedSlug);
  return runReadOnlyScope(scope, async (client) => {
    const roomResult = await client.query(
      `SELECT to_jsonb(room) AS payload
         FROM public.rooms AS room
        WHERE room.tenant_id = $1::uuid
          AND room.property_id = $2::bigint
          AND room.hotel_slug = $3
          AND room.id = $4::bigint
          AND room.is_active = true
          AND room.status = 'available'
        LIMIT 2`,
      [scope.tenantId, scope.propertyId, scope.propertySlug, roomId]
    );
    const room = getSinglePayload(roomResult, "public room");
    if (!room) return null;
    let roomType = null;
    if (room.room_type_id) {
      const typeResult = await client.query(
        `SELECT to_jsonb(room_type) AS payload
           FROM public.room_types AS room_type
          WHERE room_type.tenant_id = $1::uuid
            AND room_type.property_id = $2::bigint
            AND room_type.hotel_slug = $3
            AND room_type.id = $4::bigint
            AND room_type.is_active = true
          LIMIT 2`,
        [scope.tenantId, scope.propertyId, scope.propertySlug, room.room_type_id]
      );
      roomType = getSinglePayload(typeResult, "public room type");
    }
    const images = await fetchImages(
      client,
      scope,
      [room.id],
      room.room_type_id ? [room.room_type_id] : []
    );
    return mapPublicRoom(
      room,
      roomType,
      combinePublicRoomImages(
        room,
        roomType,
        images.room.get(String(room.id)) || [],
        images.roomType.get(String(room.room_type_id)) || []
      )
    );
  }, options);
}

async function fetchRoomTypeDiscovery(client, scope, filters) {
  const query = createScopedQuery(scope);
  query.conditions.push("target.is_active = true");
  addRoomTypeFilters(query, filters);
  const countResult = await client.query(
    `SELECT count(*)::integer AS count FROM public.room_types AS target WHERE ${query.conditions.join(" AND ")}`,
    query.params
  );
  const total = Number(countResult.rows?.[0]?.count || 0);
  const offset = (filters.page - 1) * filters.pageSize;
  const limitParam = addParam(query, filters.pageSize, "::integer");
  const offsetParam = addParam(query, offset, "::integer");
  const orderBy = filters.sort === "price_asc"
    ? "target.base_price ASC, target.name ASC"
    : filters.sort === "price_desc"
      ? "target.base_price DESC, target.name ASC"
      : filters.sort === "capacity"
        ? "target.max_adults DESC, target.name ASC"
        : "target.id ASC";
  const typesResult = await client.query(
    `SELECT to_jsonb(target) AS payload
       FROM public.room_types AS target
      WHERE ${query.conditions.join("\n        AND ")}
      ORDER BY ${orderBy}
      LIMIT ${limitParam} OFFSET ${offsetParam}`,
    query.params
  );
  const roomTypes = getPayloadRows(typesResult);
  const typeIds = roomTypes.map((type) => type.id);
  if (!typeIds.length) return { items: [], pagination: buildPagination(filters.page, filters.pageSize, total) };
  const roomQuery = createScopedQuery(scope);
  roomQuery.conditions.push(
    "target.is_active = true",
    "target.status = 'available'",
    `target.room_type_id = ANY(${addParam(roomQuery, typeIds, "::bigint[]")})`
  );
  addRoomFilters(roomQuery, filters);
  const roomsResult = await client.query(
    `SELECT to_jsonb(target) AS payload
       FROM public.rooms AS target
      WHERE ${roomQuery.conditions.join("\n        AND ")}
      ORDER BY target.id ASC
      LIMIT ${PUBLIC_ROOM_DISCOVERY_SCAN_LIMIT}`,
    roomQuery.params
  );
  const rooms = getPayloadRows(roomsResult);
  const roomIds = rooms.map((room) => room.id);
  const blocked = await fetchBlockedRoomIds(
    client,
    scope,
    roomIds,
    filters.checkInDate,
    filters.checkOutDate
  );
  const images = await fetchImages(client, scope, roomIds, typeIds, true);
  const availableByType = new Map();
  rooms.forEach((room) => {
    if (blocked.has(String(room.id))) return;
    const key = String(room.room_type_id);
    availableByType.set(key, [...(availableByType.get(key) || []), room]);
  });
  const items = roomTypes.map((type) => {
    const availableRooms = availableByType.get(String(type.id)) || [];
    const prices = availableRooms
      .map((room) => getRoomDefaultNightlyPrice({ room, roomType: type }).amount)
      .filter(Number.isFinite);
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
  return { items, pagination: buildPagination(filters.page, filters.pageSize, total) };
}

async function fetchPhysicalRoomDiscovery(client, scope, filters) {
  const query = createScopedQuery(scope);
  query.conditions.push("target.is_active = true", "target.status = 'available'");
  addRoomFilters(query, filters, { discovery: true });
  const countResult = await client.query(
    `SELECT count(*)::integer AS count FROM public.rooms AS target WHERE ${query.conditions.join(" AND ")}`,
    query.params
  );
  const totalCandidates = Number(countResult.rows?.[0]?.count || 0);
  const candidatesResult = await client.query(
    `SELECT to_jsonb(target) AS payload
       FROM public.rooms AS target
      WHERE ${query.conditions.join("\n        AND ")}
      ORDER BY target.room_number ASC
      LIMIT ${PUBLIC_ROOM_DISCOVERY_SCAN_LIMIT}`,
    query.params
  );
  const candidates = getPayloadRows(candidatesResult);
  const typeIds = [...new Set(candidates.map((room) => room.room_type_id).filter(Boolean))];
  let roomTypes = [];
  if (typeIds.length) {
    const typesResult = await client.query(
      `SELECT to_jsonb(room_type) AS payload
         FROM public.room_types AS room_type
        WHERE room_type.tenant_id = $1::uuid
          AND room_type.property_id = $2::bigint
          AND room_type.hotel_slug = $3
          AND room_type.is_active = true
          AND room_type.id = ANY($4::bigint[])`,
      [scope.tenantId, scope.propertyId, scope.propertySlug, typeIds]
    );
    roomTypes = getPayloadRows(typesResult);
  }
  const blocked = await fetchBlockedRoomIds(
    client,
    scope,
    candidates.map((room) => room.id),
    filters.checkInDate,
    filters.checkOutDate
  );
  const typesById = new Map(roomTypes.map((type) => [String(type.id), type]));
  let summaries = candidates.filter((room) => !blocked.has(String(room.id))).map((room) => {
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
  summaries = applyRoomDiscoverySort(summaries, filters.sort);
  const totalItems = summaries.length;
  const offset = (filters.page - 1) * filters.pageSize;
  const pageItems = summaries.slice(offset, offset + filters.pageSize);
  const images = await fetchImages(
    client,
    scope,
    pageItems.map((item) => item.id),
    [...new Set(pageItems.map((item) => item.roomTypeId).filter(Boolean))],
    true
  );
  const items = pageItems.map((item) => {
    const primary = images.room.get(String(item.id))
      || images.roomType.get(String(item.roomTypeId))
      || firstLegacyImage(item._room.images_json, item.name)
      || firstLegacyImage(item._type?.images_json, item.name);
    const { _room, _type, ...publicItem } = item;
    return { ...publicItem, primaryImage: mapSummaryImage(primary, item.name) };
  });
  return {
    items,
    pagination: buildPagination(filters.page, filters.pageSize, totalItems),
    scannedItems: candidates.length,
    scanLimitReached: totalCandidates > PUBLIC_ROOM_DISCOVERY_SCAN_LIMIT
  };
}

async function fetchTenantPublicRoomDiscovery(inputScope, requestedSlug, filters, options = {}) {
  const scope = normalizeScope(inputScope, requestedSlug);
  return runReadOnlyScope(
    scope,
    (client) => filters.mode === "rooms"
      ? fetchPhysicalRoomDiscovery(client, scope, filters)
      : fetchRoomTypeDiscovery(client, scope, filters),
    options
  );
}

async function fetchTenantPublicRoomAvailability(inputScope, requestedSlug, filters, options = {}) {
  const scope = normalizeScope(inputScope, requestedSlug);
  return runReadOnlyScope(scope, async (client) => {
    const rooms = await loadRooms(client, scope, filters);
    if (!rooms.length) return [];
    const blocked = await fetchBlockedRoomIds(
      client,
      scope,
      rooms.map((room) => room.id),
      filters.checkInDate,
      filters.checkOutDate
    );
    return rooms.filter((room) => !blocked.has(String(room.id)));
  }, options);
}

module.exports = {
  addRoomFilters,
  addRoomTypeFilters,
  fetchTenantPublicRoomAvailability,
  fetchTenantPublicRoomDetail,
  fetchTenantPublicRoomDiscovery,
  fetchTenantPublicRoomFeatureConfig,
  fetchTenantPublicRooms,
  getPayloadRows
};
