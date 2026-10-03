"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  hasInternalContext,
  verifyPopup
} = require("../scripts/verify-tenant-public-popup-live");

test("live popup verifier accepts safe empty and populated contracts", () => {
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

test("live popup verifier rejects wrong property and ownership fields", () => {
  assert.equal(hasInternalContext({ notification: { property_id: 1 } }), true);
  assert.throws(
    () => verifyPopup({
      status: 200,
      body: {
        success: true,
        notifications: [{ id: "one", hotelSlug: "other" }],
        notification: { id: "one", hotelSlug: "other" }
      }
    }, "hotel-sai-raj"),
    { code: "TASK3_PUBLIC_POPUP_LIVE_RESPONSE_MISMATCH" }
  );
});

test("live popup verifier rejects inconsistent primary notification", () => {
  assert.throws(
    () => verifyPopup({
      status: 200,
      body: {
        success: true,
        notifications: [{ id: "one", hotelSlug: "hotel-sai-raj" }],
        notification: { id: "two", hotelSlug: "hotel-sai-raj" }
      }
    }, "hotel-sai-raj"),
    { code: "TASK3_PUBLIC_POPUP_LIVE_RESPONSE_MISMATCH" }
  );
});
