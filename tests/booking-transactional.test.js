"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildRoomBookingRequestFingerprint,
  classifyRoomBookingReplay,
  isMissingTask6BookingAtomicRpc,
  isTask6BookingIdempotencyConflict,
  isTask6BookingMaintenanceConflict,
  normalizeTask6BookingAtomicResult
} = require("../utils/room-idempotency");
const {
  ACTIVE_BLOCKING_BOOKING_STATUSES,
  applyActiveBookingOverlapFilter,
  isRoomBookingOverlapError
} = require("../utils/room-availability");

const backendRoot = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(backendRoot, relativePath), "utf8");
}

test("booking request fingerprints are canonical and ignore volatile persistence fields", () => {
  const first = buildRoomBookingRequestFingerprint({
    booking: {
      operation: "public_room_booking_create",
      room_id: 42,
      check_in_date: "2026-11-10",
      check_out_date: "2026-11-12",
      adults: 2,
      updated_at: "2026-10-15T01:00:00.000Z",
      idempotency_key: "request-one"
    }
  });
  const retry = buildRoomBookingRequestFingerprint({
    booking: {
      adults: 2,
      check_out_date: "2026-11-12",
      check_in_date: "2026-11-10",
      room_id: 42,
      operation: "public_room_booking_create",
      updated_at: "2026-10-15T02:00:00.000Z",
      idempotency_key: "request-one",
      request_fingerprint: "ignored"
    }
  });

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(retry, first);
});

test("same booking key with changed dates is an idempotency conflict", () => {
  const original = buildRoomBookingRequestFingerprint({
    booking: { room_id: 42, check_in_date: "2026-11-10", check_out_date: "2026-11-12" }
  });
  const changed = buildRoomBookingRequestFingerprint({
    booking: { room_id: 42, check_in_date: "2026-11-10", check_out_date: "2026-11-13" }
  });

  assert.notEqual(changed, original);
  assert.deepEqual(
    classifyRoomBookingReplay({ request_fingerprint: original }, original),
    { replay: true, conflict: false, legacy: false }
  );
  assert.deepEqual(
    classifyRoomBookingReplay({ request_fingerprint: original }, changed),
    { replay: false, conflict: true, legacy: false }
  );
});

test("legacy key-only booking cannot be misreported as the same request", () => {
  const fingerprint = buildRoomBookingRequestFingerprint({
    booking: { room_id: 42, check_in_date: "2026-11-10", check_out_date: "2026-11-12" }
  });

  assert.deepEqual(
    classifyRoomBookingReplay({ request_fingerprint: null }, fingerprint),
    { replay: false, conflict: true, legacy: true }
  );
});

test("booking RPC errors are classified without exposing database details", () => {
  assert.equal(isMissingTask6BookingAtomicRpc({ code: "PGRST202" }), true);
  assert.equal(
    isTask6BookingIdempotencyConflict({ message: "TASK6_BOOKING_IDEMPOTENCY_CONFLICT" }),
    true
  );
  assert.equal(
    isTask6BookingMaintenanceConflict({ message: "TASK6_BOOKING_MAINTENANCE_CONFLICT" }),
    true
  );
});

test("booking overlap preview uses half-open interval semantics", () => {
  const calls = [];
  const query = {
    in(column, values) {
      calls.push(["in", column, values]);
      return this;
    },
    lt(column, value) {
      calls.push(["lt", column, value]);
      return this;
    },
    gt(column, value) {
      calls.push(["gt", column, value]);
      return this;
    }
  };

  applyActiveBookingOverlapFilter(query, {
    checkInDate: "2026-11-12",
    checkOutDate: "2026-11-14"
  });

  assert.deepEqual(ACTIVE_BLOCKING_BOOKING_STATUSES, ["pending", "confirmed", "checked_in"]);
  assert.deepEqual(calls, [
    ["in", "booking_status", ["pending", "confirmed", "checked_in"]],
    ["lt", "check_in_date", "2026-11-14"],
    ["gt", "check_out_date", "2026-11-12"]
  ]);
  assert.equal(isRoomBookingOverlapError({ code: "23P01" }), true);
});

test("all booking create routes require key plus digest and distinguish replay from conflict", () => {
  for (const route of [
    "routes/public-room-booking.js",
    "routes/staff-room-booking.js",
    "routes/admin-room-booking.js"
  ]) {
    const source = read(route);
    assert.match(source, /ROOM_BOOKING_IDEMPOTENCY_REQUIRED/);
    assert.match(source, /buildRoomBookingRequestFingerprint/);
    assert.match(source, /classifyRoomBookingReplay/);
    assert.match(source, /ROOM_BOOKING_IDEMPOTENCY_CONFLICT/);
    assert.match(source, /request_fingerprint/);
    assert.match(source, /task6_create_room_booking_atomic/);
    assert.match(source, /TASK6_BOOKING_ATOMIC_CREATE_NOT_READY/);
  }
});

test("the live-source booking constraint remains half-open and status-selective", () => {
  const migration = read("scripts/create-room-booking-tables.sql");
  assert.match(migration, /exclude using gist/i);
  assert.match(migration, /daterange\(check_in_date, check_out_date, '\[\)'\)/i);
  assert.match(migration, /pending', 'confirmed', 'checked_in/i);
});

test("TASK6-B RPC serializes retries and leaves overlap authority in PostgreSQL", () => {
  const migration = read("scripts/task6-b-booking-atomic-create.sql");
  assert.match(migration, /security invoker/i);
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(migration, /for update/i);
  assert.match(migration, /TASK6_BOOKING_IDEMPOTENCY_CONFLICT/);
  assert.match(migration, /TASK6_BOOKING_FINANCIAL_SNAPSHOT_INVALID/);
  assert.match(migration, /TASK6_BOOKING_MAINTENANCE_CONFLICT/);
  assert.match(migration, /insert into public\.room_bookings/i);
  assert.doesNotMatch(migration, /update\s+public\.room_bookings/i);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.room_bookings/i);
});

test("tenant-runtime writes allow the TASK6-B atomic booking RPC", () => {
  const source = read("utils/tenant-mutation-client.js");
  assert.match(source, /TENANT_RPCS[\s\S]*task6_create_room_booking_atomic/);
});

test("TASK6-B result normalization supports PostgREST and tenant-runtime shapes", () => {
  const payload = { idempotent: false, booking: { id: 42 } };
  assert.deepEqual(normalizeTask6BookingAtomicResult(payload), payload);
  assert.deepEqual(
    normalizeTask6BookingAtomicResult([{ task6_create_room_booking_atomic: payload }]),
    payload
  );
  assert.equal(normalizeTask6BookingAtomicResult([]), null);
});

test("TASK6-B runtime fix preserves least privilege and room serialization", () => {
  const migration = read("scripts/task6-b-booking-atomic-runtime-fix.sql");
  assert.match(migration, /from public\.hotels\s+where slug = v_slug;/i);
  assert.doesNotMatch(migration, /where slug = v_slug\s+for key share/i);
  assert.match(migration, /from public\.rooms[\s\S]*for update/i);
  assert.match(migration, /has_table_privilege\('app_tenant_runtime', 'public\.hotels', 'UPDATE'\)/i);
  assert.match(migration, /revoke create on schema public from app_tenant_rpc_owner/i);
});
