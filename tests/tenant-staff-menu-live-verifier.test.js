"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL ||= "https://tenant-staff-menu-live-test.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const {
  ALLOWED_BASE_URL,
  hasInternalContext,
  normalizeBaseUrl,
  verifyStaffMenu
} = require("../scripts/verify-tenant-staff-menu-live");

test("live verifier allowlists only the approved HTTPS origin", () => {
  assert.equal(
    normalizeBaseUrl(`${ALLOWED_BASE_URL}/`),
    ALLOWED_BASE_URL
  );
  assert.throws(
    () =>
      normalizeBaseUrl(
        "https://example.invalid"
      ),
    { code: "TASK3_STAFF_MENU_LIVE_ORIGIN_NOT_ALLOWED" }
  );
});

test("live verifier accepts the safe staff-menu response contract", () => {
  const body = {
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
    verifyStaffMenu(
      { status: 200, body },
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

test("live verifier rejects hidden ownership fields", () => {
  const body = {
    success: true,
    hotelSlug: "hotel-sai-raj",
    count: 1,
    menuVersion: "0123456789abcdef",
    categorySource: "menu-categories",
    categories: [],
    items: [{ id: "tea-1", property_id: 1 }],
    menu: {}
  };
  assert.equal(hasInternalContext(body), true);
  assert.throws(
    () =>
      verifyStaffMenu(
        { status: 200, body },
        "hotel-sai-raj"
      ),
    { code: "TASK3_STAFF_MENU_LIVE_CONTEXT_EXPOSED" }
  );
});
