"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  hasInternalContext,
  verifyMenu
} = require("../scripts/verify-tenant-public-menu-live");

test("live menu verifier accepts a safe response contract", () => {
  assert.deepEqual(
    verifyMenu({
      status: 200,
      body: {
        success: true,
        menuVersion: "0123456789abcdef",
        categorySource: "menu-categories",
        categories: [{ key: "drinks" }],
        menu: { drinks: [{ id: "tea-1" }] }
      }
    }),
    {
      httpStatus: 200,
      categoryCount: 1,
      itemCount: 1,
      internalContextExposed: false
    }
  );
});

test("live menu verifier rejects nested ownership fields", () => {
  assert.equal(hasInternalContext({ categories: [{ tenantId: "hidden" }] }), true);
  assert.throws(
    () => verifyMenu({
      status: 200,
      body: {
        success: true,
        menuVersion: "0123456789abcdef",
        categorySource: "menu-categories",
        categories: [],
        menu: { drinks: [{ property_id: 1 }] }
      }
    }),
    { code: "TASK3_PUBLIC_MENU_LIVE_CONTEXT_EXPOSED" }
  );
});

test("live menu verifier rejects invalid shapes", () => {
  assert.throws(
    () => verifyMenu({
      status: 200,
      body: {
        success: true,
        menuVersion: "bad",
        categorySource: "menu-categories",
        categories: [],
        menu: {}
      }
    }),
    { code: "TASK3_PUBLIC_MENU_LIVE_RESPONSE_MISMATCH" }
  );
});
