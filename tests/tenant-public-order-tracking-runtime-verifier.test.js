"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL ||= "https://tenant-order-tracking-verifier-test.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const {
  compatibilityDigest,
  fixtureDigest,
  hasInternalContext,
  readPositiveInteger,
  safeFailure,
  verifyTrackingDenied,
  verifyTrackingSuccess
} = require("../scripts/verify-tenant-public-order-tracking-runtime");

test("tracking verifier accepts safe successful public payloads", () => {
  const body = {
    success: true,
    order: {
      id: "42",
      hotelSlug: "hotel-sai-raj",
      items: [],
      totals: {},
      addOns: []
    }
  };
  assert.deepEqual(
    verifyTrackingSuccess({ status: 200, body }),
    body
  );
  assert.equal(hasInternalContext(body), false);
});

test("tracking verifier rejects ownership and token metadata exposure", () => {
  assert.equal(hasInternalContext({ order: { tenant_id: "secret" } }), true);
  assert.equal(hasInternalContext({ order: { trackingToken: "secret" } }), true);
  assert.throws(
    () => verifyTrackingSuccess({
      status: 200,
      body: { success: true, order: { propertyId: "1" } }
    }),
    { code: "TASK3_PUBLIC_ORDER_TRACKING_CONTEXT_EXPOSED" }
  );
});

test("tracking verifier accepts only safe 403 or 404 denials", () => {
  assert.deepEqual(
    verifyTrackingDenied({
      status: 404,
      body: { success: false, message: "Order tracking link is invalid or expired" }
    }),
    { httpStatus: 404, code: "", internalContextExposed: false }
  );
  assert.throws(
    () => verifyTrackingDenied({ status: 200, body: { success: true } }),
    { code: "TASK3_PUBLIC_ORDER_TRACKING_DENY_FAILED" }
  );
});

test("compatibility and fixture digests are deterministic without exposing tokens", () => {
  const payload = { success: true, order: { id: "42" } };
  assert.equal(
    compatibilityDigest(payload, payload),
    compatibilityDigest(payload, payload)
  );
  assert.throws(
    () => compatibilityDigest(payload, { success: true, order: { id: "43" } }),
    { code: "TASK3_PUBLIC_ORDER_TRACKING_COMPATIBILITY_FAILED" }
  );
  const digest = fixtureDigest({
    slug: "hotel-sai-raj",
    orderId: "42",
    token: "must-not-affect-output"
  });
  assert.match(digest, /^[a-f0-9]{16}$/);
  assert.equal(digest.includes("must-not-affect-output"), false);
});

test("tracking verifier validates concurrency bounds and sanitizes unknown failures", () => {
  assert.equal(readPositiveInteger("10", 1), 10);
  assert.throws(
    () => readPositiveInteger("0", 10),
    { code: "TASK3_PUBLIC_ORDER_TRACKING_ITERATIONS_INVALID" }
  );
  assert.deepEqual(
    safeFailure(Object.assign(new Error("safe"), { code: "TASK3_SAFE" })),
    { success: false, code: "TASK3_SAFE", message: "safe" }
  );
  assert.deepEqual(
    safeFailure(new Error("database password leaked")),
    {
      success: false,
      code: "TASK3_PUBLIC_ORDER_TRACKING_FAILED",
      message: "Tenant public order-tracking connection or query failed"
    }
  );
});
