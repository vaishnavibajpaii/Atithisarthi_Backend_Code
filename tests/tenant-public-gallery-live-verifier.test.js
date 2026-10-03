"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  hasInternalContext,
  verifyGallery
} = require("../scripts/verify-tenant-public-gallery-live");

test("live gallery verifier accepts a safe response contract", () => {
  assert.deepEqual(
    verifyGallery({ status: 200, body: { success: true, gallery: [{ id: "one" }] } }),
    { httpStatus: 200, itemCount: 1, internalContextExposed: false }
  );
});

test("live gallery verifier rejects nested ownership fields", () => {
  assert.equal(hasInternalContext({ gallery: [{ tenantId: "hidden" }] }), true);
  assert.throws(
    () => verifyGallery({
      status: 200,
      body: { success: true, gallery: [{ property_id: 1 }] }
    }),
    { code: "TASK3_PUBLIC_GALLERY_LIVE_CONTEXT_EXPOSED" }
  );
});

test("live gallery verifier rejects invalid shapes", () => {
  assert.throws(
    () => verifyGallery({ status: 200, body: { success: true, gallery: null } }),
    { code: "TASK3_PUBLIC_GALLERY_LIVE_RESPONSE_MISMATCH" }
  );
});
