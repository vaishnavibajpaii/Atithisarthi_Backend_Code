"use strict";

const { withTenantTransaction } = require("./tenant-database");
const { normalizeScope } = require("./tenant-public-hotel");

const PUBLIC_TESTIMONIAL_JSON_SQL = `
  jsonb_build_object(
    'id', item.id,
    'hotel_slug', item.hotel_slug,
    'guest_name', item.guest_name,
    'guest_role', item.guest_role,
    'review_text', item.review_text,
    'star_rating', item.star_rating,
    'avatar_url', item.avatar_url,
    'sort_order', item.sort_order,
    'created_at', item.created_at,
    'is_archived', item.is_archived,
    'is_active', item.is_active,
    'is_approved', item.is_approved
  )
`;

async function fetchTenantPublicTestimonials(
  inputScope,
  requestedSlug,
  options = {}
) {
  const scope = normalizeScope(inputScope, requestedSlug);
  const transactionRunner = options.transactionRunner || withTenantTransaction;
  return transactionRunner(
    { tenantId: scope.tenantId, propertyId: scope.propertyId },
    async (client) => {
      const result = await client.query(
        `SELECT ${PUBLIC_TESTIMONIAL_JSON_SQL} AS payload
           FROM public.testimonials AS item
          WHERE item.tenant_id = $1::uuid
            AND item.property_id = $2::bigint
            AND item.hotel_slug = $3
            AND item.is_archived = false
            AND item.is_active = true
            AND item.is_approved = true`,
        [scope.tenantId, scope.propertyId, scope.propertySlug]
      );
      return (Array.isArray(result?.rows) ? result.rows : [])
        .map((row) => row?.payload)
        .filter((row) => row && typeof row === "object");
    },
    { readOnly: true }
  );
}

module.exports = {
  fetchTenantPublicTestimonials
};
