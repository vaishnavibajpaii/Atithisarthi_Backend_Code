"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL ||= "https://tenant-staff-menu-test.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const {
  hasInternalContext,
  verifyLegacyCompatibility,
  verifyStaffMenuResponse
} = require("../scripts/verify-tenant-staff-menu-runtime");

test("runtime verifier accepts the safe staff-menu contract", () => {
  const payload = {
    success: true,
    hotelSlug: "hotel-sai-raj",
    count: 1,
    menuVersion: "0123456789abcdef",
    categorySource: "menu-categories",
    categories: [{ key: "drinks" }],
    items: [{ id: "tea-1", category: "drinks" }],
    menu: { drinks: [{ id: "tea-1" }] }
  };
  assert.deepEqual(
    verifyStaffMenuResponse(
      { status: 200, body: payload },
      "hotel-sai-raj"
    ),
    {
      httpStatus: 200,
      categoryCount: 1,
      itemCount: 1,
      matchedSlug: "hotel-sai-raj",
      internalContextExposed: false
    }
  );
});

test("runtime verifier rejects cross-hotel and internal context output", () => {
  const payload = {
    success: true,
    hotelSlug: "the-food-garden",
    count: 1,
    menuVersion: "0123456789abcdef",
    categorySource: "menu-categories",
    categories: [],
    items: [{ id: "tea-1", tenant_id: "hidden" }],
    menu: {}
  };
  assert.equal(hasInternalContext(payload), true);
  assert.throws(
    () =>
      verifyStaffMenuResponse(
        { status: 200, body: payload },
        "hotel-sai-raj"
      ),
    { code: "TASK3_STAFF_MENU_RESPONSE_MISMATCH" }
  );
});

test("runtime verifier requires exact legacy compatibility", () => {
  assert.equal(
    verifyLegacyCompatibility(
      { success: true, items: [] },
      { success: true, items: [] }
    ).result,
    "PASS"
  );
  assert.throws(
    () =>
      verifyLegacyCompatibility(
        { success: true, items: [] },
        { success: true, items: [{ id: "unexpected" }] }
      ),
    { code: "TASK3_STAFF_MENU_COMPATIBILITY_FAILED" }
  );
});
