"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL ||= "https://tenant-order-tracking-live-test.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const {
  AUTHORIZED_BASE_URL,
  buildLiveRequest,
  readInputs,
  safeFailure,
  verifyExpectedSlug
} = require("../scripts/verify-tenant-public-order-tracking-live");

const ORIGINAL_ENV = { ...process.env };

test.afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

test("live tracking request keeps the opaque token out of the URL", () => {
  const request = buildLiveRequest(
    AUTHORIZED_BASE_URL,
    {
      slug: "hotel-sai-raj",
      orderId: "42",
      token: "opaque-secret-token"
    },
    {
      forgedTenantId: "01d26c08-4fea-44f2-837a-61f546aa31c2",
      forgedPropertyId: "2"
    }
  );
  assert.equal(request.url.includes("opaque-secret-token"), false);
  assert.equal(
    request.options.headers["X-Order-Tracking-Token"],
    "opaque-secret-token"
  );
});

test("live tracking verifier only accepts the explicitly authorized origin", () => {
  process.env.TASK3_PUBLIC_ORDER_TRACKING_LIVE_CONFIRM =
    "TASK3E_PUBLIC_ORDER_TRACKING_LIVE_READ_ONLY";
  process.env.TASK3_PUBLIC_ORDER_TRACKING_LIVE_BASE_URL =
    "https://example.invalid";
  process.env.TASK3_TEST_PROPERTY_A_SLUG = "hotel-sai-raj";
  process.env.TASK3_TEST_PROPERTY_B_SLUG = "the-food-garden";
  assert.throws(
    () => readInputs(),
    { code: "TASK3_PUBLIC_ORDER_TRACKING_LIVE_DESTINATION_DENIED" }
  );
});

test("live tracking verifier accepts only canonical output without token fields", () => {
  const result = {
    status: 200,
    body: {
      success: true,
      order: {
        id: "42",
        hotelSlug: "hotel-sai-raj",
        items: [],
        totals: {},
        addOns: []
      }
    }
  };
  assert.deepEqual(
    verifyExpectedSlug(result, "hotel-sai-raj"),
    result.body
  );
  assert.throws(
    () => verifyExpectedSlug(result, "the-food-garden"),
    { code: "TASK3_PUBLIC_ORDER_TRACKING_LIVE_PROPERTY_MISMATCH" }
  );
});

test("live tracking verifier sanitizes unknown failures", () => {
  assert.deepEqual(
    safeFailure(new Error("opaque-secret-token")),
    {
      success: false,
      code: "TASK3_PUBLIC_ORDER_TRACKING_LIVE_FAILED",
      message: "Live public order-tracking request failed"
    }
  );
});
