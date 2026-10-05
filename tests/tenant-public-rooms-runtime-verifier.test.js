"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  compatibilityDigest,
  hasInternalContext,
  readPositiveInteger,
  summarizeSuite,
  verifyRoomListOutcome,
  verifyRoomPayload
} = require("../scripts/verify-tenant-public-rooms-runtime");

test("room runtime verifier accepts safe list, discovery, availability, and detail shapes", () => {
  assert.deepEqual(
    verifyRoomPayload({ status: 200, body: { success: true, count: 1, rooms: [{ id: 1 }] } }, "list"),
    { success: true, count: 1, rooms: [{ id: 1 }] }
  );
  assert.equal(
    verifyRoomPayload({ status: 200, body: { success: true, items: [], pagination: {} } }, "discovery-types").success,
    true
  );
  assert.equal(
    verifyRoomPayload({ status: 200, body: { success: true, room: { id: 1 } } }, "detail").success,
    true
  );
});

test("room runtime verifier rejects ownership fields and malformed lists", () => {
  assert.equal(hasInternalContext({ rooms: [{ tenantId: "hidden" }] }), true);
  assert.throws(
    () => verifyRoomPayload({ status: 200, body: { success: true, count: 1, rooms: [] } }, "list"),
    { code: "TASK3_PUBLIC_ROOMS_RESPONSE_MISMATCH" }
  );
  assert.throws(
    () => verifyRoomPayload({ status: 200, body: { success: true, room: { property_id: 2 } } }, "detail"),
    { code: "TASK3_PUBLIC_ROOMS_CONTEXT_EXPOSED" }
  );
});

test("room runtime verifier accepts a canonical feature-disabled tenant", () => {
  assert.deepEqual(
    verifyRoomListOutcome({
      status: 403,
      body: {
        success: false,
        code: "FEATURE_DISABLED",
        feature: "rooms",
        message: "Room Operations are not enabled for this hotel."
      }
    }),
    {
      featureDisabled: true,
      httpStatus: 403,
      code: "FEATURE_DISABLED",
      body: {
        success: false,
        code: "FEATURE_DISABLED",
        feature: "rooms",
        message: "Room Operations are not enabled for this hotel."
      }
    }
  );
});

test("room runtime verifier enforces exact legacy compatibility", () => {
  assert.equal(compatibilityDigest({ success: true }, { success: true }, "list").length, 16);
  assert.throws(
    () => compatibilityDigest({ count: 1 }, { count: 2 }, "list"),
    { code: "TASK3_PUBLIC_ROOMS_COMPATIBILITY_FAILED" }
  );
});

test("room runtime verifier validates concurrency bounds and summarizes without internal context", () => {
  assert.equal(readPositiveInteger("10", 3), 10);
  assert.throws(() => readPositiveInteger("0", 3), { code: "TASK3_PUBLIC_ROOMS_ITERATIONS_INVALID" });
  assert.deepEqual(
    summarizeSuite({
      list: { rooms: [{ id: 1 }], hotelSlug: "hotel-a" },
      typeDiscovery: { items: [{ id: 2 }] },
      roomDiscovery: { items: [{ id: 1 }] },
      availability: { rooms: [{ id: 1 }] },
      detail: { room: { id: 1 } }
    }),
    {
      featureDisabled: false,
      listCount: 1,
      typeDiscoveryCount: 1,
      roomDiscoveryCount: 1,
      availabilityCount: 1,
      detailChecked: true,
      matchedSlug: "hotel-a",
      internalContextExposed: false
    }
  );
  assert.deepEqual(
    summarizeSuite({ featureDisabled: true, featureGate: { code: "FEATURE_DISABLED" } }),
    {
      featureDisabled: true,
      httpStatus: 403,
      code: "FEATURE_DISABLED",
      internalContextExposed: false
    }
  );
});
