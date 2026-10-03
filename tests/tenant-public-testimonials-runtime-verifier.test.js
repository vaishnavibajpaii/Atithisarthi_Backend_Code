"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL ||= "https://tenant-public-testimonials-verifier.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const {
  hasInternalContext,
  readPositiveInteger,
  verifyLegacyCompatibility,
  verifyTestimonials
} = require("../scripts/verify-tenant-public-testimonials-runtime");

test("testimonials verifier accepts a safe property response", () => {
  assert.deepEqual(
    verifyTestimonials({
      status: 200,
      body: { success: true, testimonials: [{ hotelSlug: "hotel-sai-raj" }] }
    }, "hotel-sai-raj"),
    {
      httpStatus: 200,
      itemCount: 1,
      matchedSlug: "hotel-sai-raj",
      internalContextExposed: false
    }
  );
});

test("testimonials verifier rejects wrong property and internal ownership", () => {
  assert.equal(hasInternalContext({ testimonials: [{ tenant_id: "hidden" }] }), true);
  assert.throws(
    () => verifyTestimonials({
      status: 200,
      body: { success: true, testimonials: [{ hotelSlug: "other" }] }
    }, "hotel-sai-raj"),
    { code: "TASK3_PUBLIC_TESTIMONIALS_RESPONSE_MISMATCH" }
  );
});

test("testimonials verifier requires exact legacy compatibility", () => {
  const payload = { success: true, testimonials: [] };
  assert.equal(verifyLegacyCompatibility(payload, { ...payload }).result, "PASS");
  assert.throws(
    () => verifyLegacyCompatibility(payload, { success: true, testimonials: [{ id: "x" }] }),
    { code: "TASK3_PUBLIC_TESTIMONIALS_COMPATIBILITY_FAILED" }
  );
});

test("testimonials verifier bounds concurrency iterations", () => {
  assert.equal(readPositiveInteger("10", 1), 10);
  assert.throws(
    () => readPositiveInteger("51", 1),
    { code: "TASK3_PUBLIC_TESTIMONIALS_ITERATIONS_INVALID" }
  );
});
