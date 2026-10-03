"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL ||= "https://tenant-public-gallery.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const {
  fetchTenantPublicGallery
} = require("../utils/tenant-public-gallery");
const {
  buildPublicGalleryPayload
} = require("../utils/public-gallery-presentation");

const SCOPE = {
  tenantId: "ce77cfbd-40ea-4257-b78f-756ef5a0ec56",
  propertyId: "1",
  propertySlug: "hotel-sai-raj"
};

function createRunner(rows = []) {
  const calls = [];
  const runner = async (context, work, options) => {
    calls.push({ type: "transaction", context, options });
    return work({
      async query(sql, params) {
        calls.push({ type: "query", sql, params });
        return { rows };
      }
    });
  };
  return { runner, calls };
}

test("tenant public gallery is canonical, scoped, ordered, and read only", async () => {
  const item = {
    id: "gallery-1",
    image_url: "/image.webp",
    storage_path: "hotel/gallery/image.webp",
    alt: "Lobby",
    layout_variant: "wide",
    sort_order: 1
  };
  const fake = createRunner([{ payload: item }]);
  const result = await fetchTenantPublicGallery(
    SCOPE,
    SCOPE.propertySlug,
    { transactionRunner: fake.runner }
  );

  assert.deepEqual(result, [item]);
  assert.deepEqual(fake.calls[0], {
    type: "transaction",
    context: {
      tenantId: SCOPE.tenantId,
      propertyId: SCOPE.propertyId
    },
    options: { readOnly: true }
  });
  assert.deepEqual(fake.calls[1].params, [
    SCOPE.tenantId,
    SCOPE.propertyId,
    SCOPE.propertySlug
  ]);
  assert.match(fake.calls[1].sql, /item\.tenant_id = \$1::uuid/);
  assert.match(fake.calls[1].sql, /item\.property_id = \$2::bigint/);
  assert.match(fake.calls[1].sql, /item\.hotel_slug = \$3/);
  assert.match(fake.calls[1].sql, /ORDER BY item\.sort_order ASC, item\.id ASC/);
});

test("gallery presenter preserves the existing public contract", () => {
  assert.deepEqual(
    buildPublicGalleryPayload([{
      id: "gallery-1",
      image_url: "/image.webp",
      storage_path: "hotel/gallery/image.webp",
      alt: "Lobby",
      layout_variant: "wide",
      sort_order: "2",
      tenant_id: "must-not-be-public",
      property_id: 1
    }]),
    {
      success: true,
      gallery: [{
        id: "gallery-1",
        imageUrl: "/image.webp",
        storagePath: "hotel/gallery/image.webp",
        alt: "Lobby",
        layoutVariant: "wide",
        sortOrder: 2
      }]
    }
  );
});

test("tenant public gallery rejects slug/context mismatch before DB use", async () => {
  let runnerCalled = false;
  await assert.rejects(
    fetchTenantPublicGallery(
      SCOPE,
      "the-food-garden",
      {
        transactionRunner: async () => {
          runnerCalled = true;
        }
      }
    ),
    { code: "TENANT_PUBLIC_HOTEL_SCOPE_CONFLICT" }
  );
  assert.equal(runnerCalled, false);
});
