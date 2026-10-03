"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL ||= "https://tenant-public-testimonials.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const { fetchTenantPublicTestimonials } = require("../utils/tenant-public-testimonials");
const { buildPublicTestimonialsPayload } = require("../utils/public-testimonials-presentation");

const SCOPE = {
  tenantId: "ce77cfbd-40ea-4257-b78f-756ef5a0ec56",
  propertyId: "1",
  propertySlug: "hotel-sai-raj"
};

test("tenant public testimonials query is canonical and read only", async () => {
  const calls = [];
  const item = {
    id: "review-1",
    hotel_slug: SCOPE.propertySlug,
    guest_name: "Synthetic Guest",
    review_text: "Synthetic review",
    is_archived: false,
    is_active: true,
    is_approved: true
  };
  const transactionRunner = async (context, work, options) => {
    calls.push({ type: "transaction", context, options });
    return work({
      async query(sql, params) {
        calls.push({ type: "query", sql, params });
        return { rows: [{ payload: item }] };
      }
    });
  };
  const result = await fetchTenantPublicTestimonials(
    SCOPE,
    SCOPE.propertySlug,
    { transactionRunner }
  );
  assert.deepEqual(result, [item]);
  assert.equal(calls[0].options.readOnly, true);
  assert.deepEqual(calls[1].params, [SCOPE.tenantId, SCOPE.propertyId, SCOPE.propertySlug]);
  assert.match(calls[1].sql, /item\.tenant_id = \$1::uuid/);
  assert.match(calls[1].sql, /item\.property_id = \$2::bigint/);
  assert.match(calls[1].sql, /item\.hotel_slug = \$3/);
});

test("testimonials presenter preserves filtering, ordering, and public fields", () => {
  const payload = buildPublicTestimonialsPayload([
    {
      id: "later",
      hotel_slug: SCOPE.propertySlug,
      guest_name: "Later Guest",
      review_text: "Later",
      star_rating: 4,
      sort_order: 1,
      created_at: "2026-01-02T00:00:00Z",
      is_archived: false,
      is_active: true,
      is_approved: true,
      tenant_id: "hidden"
    },
    {
      id: "earlier",
      hotel_slug: SCOPE.propertySlug,
      guest_name: "Earlier Guest",
      review_text: "Earlier",
      sort_order: 2,
      created_at: "2026-01-01T00:00:00Z",
      is_archived: false,
      is_active: true,
      is_approved: true
    },
    {
      id: "unapproved",
      guest_name: "Hidden",
      review_text: "Hidden",
      is_approved: false
    }
  ], SCOPE.propertySlug);
  assert.deepEqual(payload.testimonials.map((item) => item.id), ["later", "earlier"]);
  assert.equal(payload.testimonials[0].hotelSlug, SCOPE.propertySlug);
  assert.equal("tenant_id" in payload.testimonials[0], false);
});

test("tenant public testimonials reject slug/context mismatch before DB use", async () => {
  let called = false;
  await assert.rejects(
    fetchTenantPublicTestimonials(SCOPE, "the-food-garden", {
      transactionRunner: async () => { called = true; }
    }),
    { code: "TENANT_PUBLIC_HOTEL_SCOPE_CONFLICT" }
  );
  assert.equal(called, false);
});
