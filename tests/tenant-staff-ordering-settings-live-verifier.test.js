"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL ||= "https://tenant-staff-ordering-live-test.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const {
  ALLOWED_BASE_URL,
  hasInternalContext,
  normalizeBaseUrl,
  verifyOrderingResponse
} = require("../scripts/verify-tenant-staff-ordering-settings-live");

function validPayload() {
  return {
    success: true,
    hotelSlug: "hotel-sai-raj",
    ordering: {
      staffOrderingEnabled: true,
      enforceTableMaster: false,
      secureOnlinePaymentEnabled: true,
      cashOnDeliveryEnabled: true,
      manualUpiPaymentEnabled: true,
      title: "",
      message: "",
      icon: ""
    }
  };
}

test("live ordering verifier allowlists only approved origin", () => {
  assert.equal(
    normalizeBaseUrl(`${ALLOWED_BASE_URL}/`),
    ALLOWED_BASE_URL
  );
  assert.throws(
    () => normalizeBaseUrl("https://example.invalid"),
    { code: "TASK3_STAFF_ORDERING_LIVE_ORIGIN_NOT_ALLOWED" }
  );
});

test("live ordering verifier accepts safe response contract", () => {
  assert.deepEqual(
    verifyOrderingResponse(
      { status: 200, body: validPayload() },
      "hotel-sai-raj"
    ),
    {
      httpStatus: 200,
      matchedSlug: "hotel-sai-raj",
      internalContextExposed: false
    }
  );
});

test("live ordering verifier rejects hidden ownership fields", () => {
  const payload = validPayload();
  payload.ordering.property_id = 1;
  assert.equal(hasInternalContext(payload), true);
  assert.throws(
    () =>
      verifyOrderingResponse(
        { status: 200, body: payload },
        "hotel-sai-raj"
      ),
    { code: "TASK3_STAFF_ORDERING_LIVE_CONTEXT_EXPOSED" }
  );
});
