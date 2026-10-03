"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL ||= "https://tenant-public-menu-verifier.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const {
  hasInternalContext,
  readPositiveInteger,
  verifyLegacyCompatibility,
  verifySuccessfulMenuResponse
} = require("../scripts/verify-tenant-public-menu-runtime");

test("menu verifier accepts a valid public response contract", () => {
  assert.deepEqual(
    verifySuccessfulMenuResponse({
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

test("menu verifier rejects internal ownership fields at any depth", () => {
  assert.equal(hasInternalContext({ menu: { drinks: [{ tenant_id: "x" }] } }), true);
  assert.throws(
    () => verifySuccessfulMenuResponse({
      status: 200,
      body: {
        success: true,
        menuVersion: "0123456789abcdef",
        categorySource: "menu-categories",
        categories: [],
        menu: { drinks: [{ property_id: 1 }] }
      }
    }),
    { code: "TASK3_PUBLIC_MENU_CONTEXT_EXPOSED" }
  );
});

test("menu verifier rejects invalid response shapes", () => {
  assert.throws(
    () => verifySuccessfulMenuResponse({
      status: 200,
      body: {
        success: true,
        menuVersion: "not-a-version",
        categorySource: "menu-categories",
        categories: [],
        menu: {}
      }
    }),
    { code: "TASK3_PUBLIC_MENU_RESPONSE_MISMATCH" }
  );
});

test("menu verifier bounds concurrency iterations", () => {
  assert.equal(readPositiveInteger("10", 1), 10);
  assert.throws(
    () => readPositiveInteger("51", 1),
    { code: "TASK3_PUBLIC_MENU_ITERATIONS_INVALID" }
  );
});

test("menu verifier requires exact legacy-output compatibility", () => {
  const payload = {
    success: true,
    menuVersion: "0123456789abcdef",
    categorySource: "menu-categories",
    categories: [],
    menu: {}
  };
  assert.equal(
    verifyLegacyCompatibility(payload, { ...payload }).result,
    "PASS"
  );
  assert.throws(
    () => verifyLegacyCompatibility(payload, { ...payload, menuVersion: "fedcba9876543210" }),
    { code: "TASK3_PUBLIC_MENU_COMPATIBILITY_FAILED" }
  );
});
