"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

process.env.SUPABASE_URL ||= "https://tenant-staff-session-live-test.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "tenant-staff-session-live-test-only-secret";

const {
  ALLOWED_BASE_URL,
  hasInternalContext,
  normalizeBaseUrl,
  verifySessionResponse
} = require("../scripts/verify-tenant-staff-session-live");

function validPayload() {
  const features = {
    hotelSlug: "hotel-sai-raj",
    enableFoodModule: true,
    enableRoomModule: false,
    businessType: "restaurant_only"
  };
  return {
    success: true,
    staffUser: {
      id: "TASK3E_STAFF_SESSION_LIVE_TEST",
      hotelSlug: "hotel-sai-raj",
      displayName: "Synthetic Staff",
      role: "staff",
      isManager: false,
      kdsRole: "general",
      features
    },
    features
  };
}

test("live session verifier allowlists only approved origin", () => {
  assert.equal(
    normalizeBaseUrl(`${ALLOWED_BASE_URL}/`),
    ALLOWED_BASE_URL
  );
  assert.throws(
    () => normalizeBaseUrl("https://example.invalid"),
    { code: "TASK3_STAFF_SESSION_LIVE_ORIGIN_NOT_ALLOWED" }
  );
});

test("live session verifier accepts safe response contract", () => {
  assert.deepEqual(
    verifySessionResponse(
      { status: 200, body: validPayload() },
      "hotel-sai-raj"
    ),
    {
      httpStatus: 200,
      matchedSlug: "hotel-sai-raj",
      businessType: "restaurant_only",
      internalContextExposed: false
    }
  );
});

test("live session verifier rejects hidden ownership fields", () => {
  const payload = validPayload();
  payload.features.property_id = 1;
  assert.equal(hasInternalContext(payload), true);
  assert.throws(
    () =>
      verifySessionResponse(
        { status: 200, body: payload },
        "hotel-sai-raj"
      ),
    { code: "TASK3_STAFF_SESSION_LIVE_CONTEXT_EXPOSED" }
  );
});
