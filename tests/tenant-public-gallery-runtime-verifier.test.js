"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL ||= "https://tenant-public-gallery-verifier.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const {
  hasInternalContext,
  readPositiveInteger,
  verifyGallery,
  verifyLegacyCompatibility
} = require("../scripts/verify-tenant-public-gallery-runtime");

test("gallery verifier accepts a safe response contract", () => {
  assert.deepEqual(
    verifyGallery({ status: 200, body: { success: true, gallery: [{ id: "one" }] } }),
    { httpStatus: 200, itemCount: 1, internalContextExposed: false }
  );
});

test("gallery verifier rejects nested ownership fields", () => {
  assert.equal(hasInternalContext({ gallery: [{ tenant_id: "hidden" }] }), true);
  assert.throws(
    () => verifyGallery({
      status: 200,
      body: { success: true, gallery: [{ property_id: 1 }] }
    }),
    { code: "TASK3_PUBLIC_GALLERY_CONTEXT_EXPOSED" }
  );
});

test("gallery verifier requires exact legacy compatibility", () => {
  const payload = { success: true, gallery: [{ id: "one" }] };
  assert.equal(verifyLegacyCompatibility(payload, { ...payload }).result, "PASS");
  assert.throws(
    () => verifyLegacyCompatibility(payload, { success: true, gallery: [] }),
    { code: "TASK3_PUBLIC_GALLERY_COMPATIBILITY_FAILED" }
  );
});

test("gallery verifier bounds concurrency iterations", () => {
  assert.equal(readPositiveInteger("10", 1), 10);
  assert.throws(
    () => readPositiveInteger("0", 1),
    { code: "TASK3_PUBLIC_GALLERY_ITERATIONS_INVALID" }
  );
});
