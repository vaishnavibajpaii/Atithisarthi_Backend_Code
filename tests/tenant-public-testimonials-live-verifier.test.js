"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  hasInternalContext,
  verifyTestimonials
} = require("../scripts/verify-tenant-public-testimonials-live");

test("live testimonials verifier accepts a safe property response", () => {
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

test("live testimonials verifier rejects wrong property and ownership fields", () => {
  assert.equal(hasInternalContext({ testimonials: [{ property_id: 1 }] }), true);
  assert.throws(
    () => verifyTestimonials({
      status: 200,
      body: { success: true, testimonials: [{ hotelSlug: "other" }] }
    }, "hotel-sai-raj"),
    { code: "TASK3_PUBLIC_TESTIMONIALS_LIVE_RESPONSE_MISMATCH" }
  );
});

test("live testimonials verifier rejects invalid shapes", () => {
  assert.throws(
    () => verifyTestimonials({ status: 200, body: { success: true } }, "hotel-sai-raj"),
    { code: "TASK3_PUBLIC_TESTIMONIALS_LIVE_RESPONSE_MISMATCH" }
  );
});
