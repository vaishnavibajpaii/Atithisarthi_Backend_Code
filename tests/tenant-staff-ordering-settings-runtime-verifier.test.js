"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL ||= "https://tenant-staff-ordering-test.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const {
  hasInternalContext,
  verifyLegacyCompatibility,
  verifyOrderingResponse
} = require("../scripts/verify-tenant-staff-ordering-settings-runtime");

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

test("runtime verifier accepts the safe ordering-settings contract", () => {
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

test("runtime verifier rejects cross-hotel and ownership output", () => {
  const payload = validPayload();
  payload.hotelSlug = "the-food-garden";
  payload.ordering.tenant_id = "hidden";
  assert.equal(hasInternalContext(payload), true);
  assert.throws(
    () =>
      verifyOrderingResponse(
        { status: 200, body: payload },
        "hotel-sai-raj"
      ),
    { code: "TASK3_STAFF_ORDERING_RESPONSE_MISMATCH" }
  );
});

test("runtime verifier requires exact legacy compatibility", () => {
  const payload = validPayload();
  assert.equal(
    verifyLegacyCompatibility(payload, payload).result,
    "PASS"
  );
  assert.throws(
    () =>
      verifyLegacyCompatibility(payload, {
        ...payload,
        ordering: {
          ...payload.ordering,
          cashOnDeliveryEnabled: false
        }
      }),
    { code: "TASK3_STAFF_ORDERING_COMPATIBILITY_FAILED" }
  );
});
