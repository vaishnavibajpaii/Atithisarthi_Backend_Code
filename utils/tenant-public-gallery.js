"use strict";

const { withTenantTransaction } = require("./tenant-database");
const { normalizeScope } = require("./tenant-public-hotel");

const PUBLIC_GALLERY_ITEM_JSON_SQL = `
  jsonb_build_object(
    'id', item.id,
    'image_url', item.image_url,
    'storage_path', item.storage_path,
    'alt', item.alt,
    'layout_variant', item.layout_variant,
    'sort_order', item.sort_order
  )
`;

async function fetchTenantPublicGallery(
  inputScope,
  requestedSlug,
  options = {}
) {
  const scope = normalizeScope(inputScope, requestedSlug);
  const transactionRunner = options.transactionRunner || withTenantTransaction;
  return transactionRunner(
    {
      tenantId: scope.tenantId,
      propertyId: scope.propertyId
    },
    async (client) => {
      const result = await client.query(
        `SELECT ${PUBLIC_GALLERY_ITEM_JSON_SQL} AS payload
           FROM public.gallery_items AS item
          WHERE item.tenant_id = $1::uuid
            AND item.property_id = $2::bigint
            AND item.hotel_slug = $3
            AND item.is_active = true
            AND item.is_archived = false
          ORDER BY item.sort_order ASC, item.id ASC`,
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
  fetchTenantPublicGallery
};
