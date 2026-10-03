"use strict";

const { withTenantTransaction } = require("./tenant-database");
const { normalizeScope } = require("./tenant-public-hotel");

const PUBLIC_POPUP_JSON_SQL = `
  jsonb_build_object(
    'id', item.id,
    'hotel_slug', item.hotel_slug,
    'title', item.title,
    'description', item.description,
    'image_url', item.image_url,
    'storage_path', item.storage_path,
    'cta_text', item.cta_text,
    'cta_link', item.cta_link,
    'display_mode', item.display_mode,
    'start_at', item.start_at,
    'end_at', item.end_at,
    'priority', item.priority,
    'created_at', item.created_at
  )
`;

async function fetchTenantPublicPopupNotifications(
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
        `SELECT ${PUBLIC_POPUP_JSON_SQL} AS payload
           FROM public.hotel_popup_notifications AS item
          WHERE item.tenant_id = $1::uuid
            AND item.property_id = $2::bigint
            AND item.hotel_slug = $3
            AND item.is_active = true
          ORDER BY item.priority DESC, item.created_at DESC
          LIMIT 20`,
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
  fetchTenantPublicPopupNotifications
};
