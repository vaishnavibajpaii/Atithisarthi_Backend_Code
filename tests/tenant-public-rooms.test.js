"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL ||= "https://tenant-public-rooms.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const {
  fetchTenantPublicRoomAvailability,
  fetchTenantPublicRoomDiscovery,
  fetchTenantPublicRoomFeatureConfig,
  fetchTenantPublicRooms
} = require("../utils/tenant-public-rooms");
const { mapPublicRoom } = require("../utils/public-room-presentation");

const SCOPE = {
  tenantId: "ce77cfbd-40ea-4257-b78f-756ef5a0ec56",
  propertyId: "1",
  propertySlug: "hotel-sai-raj"
};

function createRunner(handler) {
  const calls = [];
  const runner = async (context, work, options) => {
    calls.push({ type: "transaction", context, options });
    return work({
      async query(sql, params = []) {
        calls.push({ type: "query", sql, params });
        return handler(sql, params, calls);
      }
    });
  };
  return { runner, calls };
}

function room(overrides = {}) {
  return {
    id: 11,
    tenant_id: SCOPE.tenantId,
    property_id: 1,
    hotel_slug: SCOPE.propertySlug,
    room_type_id: 21,
    room_number: "101",
    title: "Deluxe Room",
    floor: "1",
    capacity: 3,
    max_adults: 2,
    max_children: 1,
    bed_type: "King",
    base_price: 2000,
    discount_price: 1800,
    tax_percent: 12,
    amenities_json: ["WiFi"],
    images_json: [],
    description: "Quiet room",
    is_active: true,
    status: "available",
    ...overrides
  };
}

function roomType(overrides = {}) {
  return {
    id: 21,
    tenant_id: SCOPE.tenantId,
    property_id: 1,
    hotel_slug: SCOPE.propertySlug,
    name: "Deluxe",
    description: "Deluxe type",
    base_price: 2100,
    max_adults: 2,
    max_children: 1,
    amenities_json: ["WiFi"],
    images_json: [],
    cancellation_policy: "Standard",
    is_active: true,
    ...overrides
  };
}

test("tenant room feature lookup is canonical and read only", async () => {
  const fake = createRunner((sql) => ({
    rows: sql.includes("hotel_feature_settings")
      ? [{ payload: { hotel_slug: SCOPE.propertySlug, enable_room_module: true, enable_room_booking: true } }]
      : []
  }));
  const result = await fetchTenantPublicRoomFeatureConfig(
    SCOPE,
    SCOPE.propertySlug,
    { transactionRunner: fake.runner }
  );
  assert.equal(result.enableRoomBooking, true);
  assert.deepEqual(fake.calls[0], {
    type: "transaction",
    context: { tenantId: SCOPE.tenantId, propertyId: SCOPE.propertyId },
    options: { readOnly: true }
  });
  assert.match(fake.calls[1].sql, /settings\.tenant_id = \$1::uuid/);
  assert.match(fake.calls[1].sql, /settings\.property_id = \$2::bigint/);
  assert.match(fake.calls[1].sql, /settings\.hotel_slug = \$3/);
});

test("tenant public room list preserves the existing presentation contract", async () => {
  const fake = createRunner((sql) => {
    if (sql.includes("FROM public.rooms AS target")) return { rows: [{ payload: room() }] };
    if (sql.includes("FROM public.room_types AS room_type")) return { rows: [{ payload: roomType() }] };
    if (sql.includes("to_regclass")) return { rows: [{ present: false }] };
    return { rows: [] };
  });
  const result = await fetchTenantPublicRooms(
    SCOPE,
    SCOPE.propertySlug,
    {},
    { transactionRunner: fake.runner }
  );
  assert.deepEqual(result, [mapPublicRoom(room(), roomType(), [])]);
  const roomQuery = fake.calls.find((call) => call.type === "query" && call.sql.includes("FROM public.rooms AS target"));
  assert.deepEqual(roomQuery.params.slice(0, 3), [SCOPE.tenantId, SCOPE.propertyId, SCOPE.propertySlug]);
  assert.match(roomQuery.sql, /target\.tenant_id = \$1::uuid/);
  assert.match(roomQuery.sql, /target\.property_id = \$2::bigint/);
  assert.match(roomQuery.sql, /target\.hotel_slug = \$3/);
});

test("room-type discovery applies bounded canonical queries", async () => {
  const fake = createRunner((sql) => {
    if (sql.includes("count(*)") && sql.includes("room_types")) return { rows: [{ count: 1 }] };
    if (sql.includes("FROM public.room_types AS target")) return { rows: [{ payload: roomType() }] };
    if (sql.includes("FROM public.rooms AS target")) return { rows: [{ payload: room() }] };
    if (sql.includes("to_regclass")) return { rows: [{ present: false }] };
    return { rows: [] };
  });
  const result = await fetchTenantPublicRoomDiscovery(
    SCOPE,
    SCOPE.propertySlug,
    {
      mode: "types",
      page: 1,
      pageSize: 12,
      sort: "recommended",
      adults: 2,
      children: 0
    },
    { transactionRunner: fake.runner }
  );
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].reference, "room-type-21");
  assert.equal(result.items[0].availableCount, 1);
  assert.deepEqual(result.pagination, {
    page: 1,
    pageSize: 12,
    totalItems: 1,
    totalPages: 1,
    hasMore: false
  });
  const scans = fake.calls.filter((call) => call.type === "query" && /FROM public\.(rooms|room_types)/.test(call.sql));
  assert.ok(scans.every((call) => call.sql.includes("tenant_id") && call.sql.includes("property_id") && call.sql.includes("hotel_slug")));
  assert.ok(scans.some((call) => call.sql.includes("LIMIT 500")));
});

test("availability removes canonically scoped blocking bookings", async () => {
  const fake = createRunner((sql) => {
    if (sql.includes("FROM public.rooms AS target")) return { rows: [{ payload: room() }] };
    if (sql.includes("FROM public.room_types AS room_type")) return { rows: [{ payload: roomType() }] };
    if (sql.includes("to_regclass") && sql.includes("$1")) {
      const isMaintenanceCheck = fake.calls.filter((call) => call.type === "query" && call.sql.includes("to_regclass")).length > 1;
      return { rows: [{ present: isMaintenanceCheck ? false : false }] };
    }
    if (sql.includes("FROM public.room_bookings AS booking")) return { rows: [{ room_id: 11 }] };
    return { rows: [] };
  });
  const result = await fetchTenantPublicRoomAvailability(
    SCOPE,
    SCOPE.propertySlug,
    { checkInDate: "2026-10-10", checkOutDate: "2026-10-12", adults: 1, children: 0 },
    { transactionRunner: fake.runner }
  );
  assert.deepEqual(result, []);
  const bookingQuery = fake.calls.find((call) => call.type === "query" && call.sql.includes("room_bookings AS booking"));
  assert.match(bookingQuery.sql, /booking\.tenant_id = \$1::uuid/);
  assert.match(bookingQuery.sql, /booking\.property_id = \$2::bigint/);
  assert.match(bookingQuery.sql, /booking\.hotel_slug = \$3/);
  assert.match(bookingQuery.sql, /booking\.check_in_date < \$7::date/);
  assert.match(bookingQuery.sql, /booking\.check_out_date > \$6::date/);
});

test("tenant room reads reject slug/context mismatch before database use", async () => {
  let runnerCalled = false;
  await assert.rejects(
    fetchTenantPublicRooms(
      SCOPE,
      "the-food-garden",
      {},
      { transactionRunner: async () => { runnerCalled = true; } }
    ),
    { code: "TENANT_PUBLIC_HOTEL_SCOPE_CONFLICT" }
  );
  assert.equal(runnerCalled, false);
});
