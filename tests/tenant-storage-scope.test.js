"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  authorizePlatformAdminStoragePath,
  buildPlatformStoragePath,
  buildPropertyStoragePath,
  isPlatformStoragePath,
  isPropertyStoragePath,
  isSafeObjectPath,
  resolvePropertyStorageScope
} = require("../utils/storage-object-scope");

const TENANT_A = "ce77cfbd-40ea-4257-b78f-756ef5a0ec56";
const TENANT_B = "01d26c08-4fea-44f2-837a-61f546aa31c2";
const SCOPE_A = { tenantId: TENANT_A, propertyId: 1, propertySlug: "hotel-sai-raj" };
const SCOPE_B = { tenantId: TENANT_B, propertyId: 2, propertySlug: "the-food-garden" };

function fakeSupabase(rows) {
  return {
    from(table) {
      assert.equal(table, "hotels");
      const filters = {};
      return {
        select() { return this; },
        eq(column, value) { filters[column] = value; return this; },
        async maybeSingle() {
          const row = rows.find((candidate) => Object.entries(filters).every(([key, value]) => String(candidate[key]) === String(value)));
          return { data: row || null, error: null };
        }
      };
    }
  };
}

test("new property objects use canonical tenant/property paths", () => {
  assert.equal(
    buildPropertyStoragePath(SCOPE_A, "room-images/room-7", "fixture.webp"),
    `tenants/${TENANT_A}/properties/1/room-images/room-7/fixture.webp`
  );
});

test("canonical path ownership cannot cross tenants", () => {
  const path = buildPropertyStoragePath(SCOPE_A, "gallery", "fixture.webp");
  assert.equal(isPropertyStoragePath(path, SCOPE_A, { resource: "gallery" }), true);
  assert.equal(isPropertyStoragePath(path, SCOPE_B, { resource: "gallery" }), false);
});

test("legacy current-hotel paths remain scoped compatibility paths", () => {
  const path = "hotel-sai-raj/room-images/room-7/fixture.webp";
  assert.equal(isPropertyStoragePath(path, SCOPE_A, { resource: "room-images", allowLegacy: true }), true);
  assert.equal(isPropertyStoragePath(path, SCOPE_B, { resource: "room-images", allowLegacy: true }), false);
});

test("unknown legacy prefixes do not gain mutation authority", async () => {
  const client = fakeSupabase([
    { id: 1, tenant_id: TENANT_A, slug: "hotel-sai-raj" },
    { id: 2, tenant_id: TENANT_B, slug: "the-food-garden" }
  ]);
  assert.equal(await authorizePlatformAdminStoragePath(client, "chai-chaska-ujjain/gallery/fixture.webp"), null);
  assert.equal(await authorizePlatformAdminStoragePath(client, "snaky-hut-ujjain/gallery/fixture.webp"), null);
});

test("unsafe and ambiguous object paths are rejected", () => {
  for (const value of [
    "../hotel/file.webp",
    "hotel/../file.webp",
    "hotel/%2e%2e/file.webp",
    "hotel/%2F/file.webp",
    "hotel\\file.webp",
    "/hotel/file.webp",
    "hotel//file.webp"
  ]) {
    assert.equal(isSafeObjectPath(value), false, value);
  }
});

test("platform namespace is explicit and separate", () => {
  const path = buildPlatformStoragePath("login-branding", "logo.webp");
  assert.equal(path, "platform/login-branding/logo.webp");
  assert.equal(isPlatformStoragePath(path, "login-branding"), true);
  assert.equal(isPropertyStoragePath(path, SCOPE_A, { allowLegacy: true }), false);
});

test("database resolution requires canonical tenant ownership", async () => {
  const client = fakeSupabase([{ id: 1, tenant_id: TENANT_A, slug: "hotel-sai-raj" }]);
  assert.deepEqual(await resolvePropertyStorageScope(client, "HOTEL-SAI-RAJ"), SCOPE_A);
  await assert.rejects(
    resolvePropertyStorageScope(client, "missing-hotel"),
    (error) => error.code === "STORAGE_HOTEL_SCOPE_NOT_FOUND" && error.statusCode === 404
  );
});

test("platform admin authorization accepts only catalog-bound property paths", async () => {
  const client = fakeSupabase([{ id: 1, tenant_id: TENANT_A, slug: "hotel-sai-raj" }]);
  const canonical = buildPropertyStoragePath(SCOPE_A, "gallery", "fixture.webp");
  const allowed = await authorizePlatformAdminStoragePath(client, canonical);
  assert.equal(allowed.kind, "property");
  assert.equal(allowed.legacy, false);
  assert.equal(await authorizePlatformAdminStoragePath(client, `tenants/${TENANT_B}/properties/1/gallery/fixture.webp`), null);
});
