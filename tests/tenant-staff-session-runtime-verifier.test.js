"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

process.env.SUPABASE_URL ||= "https://tenant-staff-session-test.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "tenant-staff-session-test-only-secret";

const {
  hasInternalContext,
  verifyLegacyCompatibility,
  verifySessionResponse
} = require("../scripts/verify-tenant-staff-session-runtime");

function validPayload() {
  const features = {
    hotelSlug: "hotel-sai-raj",
    enableFoodModule: true,
    enableRoomModule: false,
    enableRoomService: false,
    enableFoodReports: true,
    enableRoomReports: false,
    enableCombinedReports: false,
    enableCombinedBilling: false,
    enableFoodOrdering: true,
    enableRoomBooking: false,
    version: 1,
    updatedAt: "",
    updatedBy: "",
    businessType: "restaurant_only",
    canUseFood: true,
    canUseRooms: false,
    canUseRoomService: false,
    canUseFoodReports: true,
    canUseRoomReports: false,
    canUseCombinedReports: false,
    canUseCombinedBilling: false
  };
  return {
    success: true,
    staffUser: {
      id: "TASK3E_STAFF_SESSION_TEST",
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

test("runtime verifier accepts the safe staff session contract", () => {
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

test("runtime verifier rejects cross-hotel and ownership output", () => {
  const payload = validPayload();
  payload.staffUser.hotelSlug = "the-food-garden";
  payload.features.tenant_id = "hidden";
  assert.equal(hasInternalContext(payload), true);
  assert.throws(
    () =>
      verifySessionResponse(
        { status: 200, body: payload },
        "hotel-sai-raj"
      ),
    { code: "TASK3_STAFF_SESSION_RESPONSE_MISMATCH" }
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
        features: {
          ...payload.features,
          enableFoodModule: false
        }
      }),
    { code: "TASK3_STAFF_SESSION_COMPATIBILITY_FAILED" }
  );
});
