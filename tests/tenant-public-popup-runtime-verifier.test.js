"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL ||= "https://tenant-public-popup-verifier.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const {
  hasInternalContext,
  readPositiveInteger,
  verifyLegacyCompatibility,
  verifyPopup
} = require("../scripts/verify-tenant-public-popup-runtime");

test("popup verifier accepts empty and populated safe contracts", () => {
  assert.equal(
    verifyPopup({
      status: 200,
      body: { success: true, notifications: [], notification: null }
    }, "hotel-sai-raj").itemCount,
    0
  );
  assert.equal(
    verifyPopup({
      status: 200,
      body: {
        success: true,
        notifications: [{ id: "one", hotelSlug: "hotel-sai-raj" }],
        notification: { id: "one", hotelSlug: "hotel-sai-raj" }
      }
    }, "hotel-sai-raj").itemCount,
    1
  );
});

test("popup verifier rejects wrong property and internal ownership", () => {
  assert.equal(hasInternalContext({ notifications: [{ tenant_id: "hidden" }] }), true);
  assert.throws(
    () => verifyPopup({
      status: 200,
      body: {
        success: true,
        notifications: [{ id: "one", hotelSlug: "other" }],
        notification: { id: "one", hotelSlug: "other" }
      }
    }, "hotel-sai-raj"),
    { code: "TASK3_PUBLIC_POPUP_RESPONSE_MISMATCH" }
  );
});

test("popup verifier requires exact legacy compatibility", () => {
  const payload = { success: true, notifications: [], notification: null };
  assert.equal(verifyLegacyCompatibility(payload, { ...payload }).result, "PASS");
  assert.throws(
    () => verifyLegacyCompatibility(payload, { success: true, notifications: [{}], notification: {} }),
    { code: "TASK3_PUBLIC_POPUP_COMPATIBILITY_FAILED" }
  );
});

test("popup verifier bounds concurrency iterations", () => {
  assert.equal(readPositiveInteger("10", 1), 10);
  assert.throws(
    () => readPositiveInteger("0", 1),
    { code: "TASK3_PUBLIC_POPUP_ITERATIONS_INVALID" }
  );
});
