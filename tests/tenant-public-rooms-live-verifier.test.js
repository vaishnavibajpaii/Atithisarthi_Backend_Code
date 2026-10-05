"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { verifyExpectedSlug } = require("../scripts/verify-tenant-public-rooms-live");

test("live room verifier accepts canonical public response", () => {
  assert.deepEqual(
    verifyExpectedSlug({ success: true, hotelSlug: "hotel-a", rooms: [] }, "hotel-a", "list"),
    { success: true, hotelSlug: "hotel-a", rooms: [] }
  );
});

test("live room verifier rejects wrong property slug", () => {
  assert.throws(
    () => verifyExpectedSlug({ success: true, hotelSlug: "hotel-b" }, "hotel-a", "list"),
    { code: "TASK3_PUBLIC_ROOMS_LIVE_PROPERTY_MISMATCH" }
  );
});

test("live room verifier rejects exposed internal context", () => {
  assert.throws(
    () => verifyExpectedSlug({ success: true, hotelSlug: "hotel-a", room: { tenant_id: "hidden" } }, "hotel-a", "detail"),
    { code: "TASK3_PUBLIC_ROOMS_LIVE_CONTEXT_EXPOSED" }
  );
});
