"use strict";

const { withTenantTransaction } = require("./tenant-database");
const {
  normalizeHotelFeatureConfig
} = require("./hotel-feature-settings");
const {
  isCategoryEligible,
  sortMenuCategories
} = require("./menu-categories");
const {
  buildMenuComboPresentationMap
} = require("./menu-combos");
const {
  normalizeScope,
  getSinglePayload
} = require("./tenant-public-hotel");

const PUBLIC_MENU_ITEM_JSON_SQL = `
  jsonb_build_object(
    'item_id', item.item_id,
    'item_type', item.item_type,
    'name', item.name,
    'description', item.description,
    'price', item.price,
    'image', item.image,
    'alt', item.alt,
    'badge', item.badge,
    'tag', item.tag,
    'category', item.category,
    'sort_order', item.sort_order
  )
`;

async function runReadOnlyScope(scope, work, options = {}) {
  const transactionRunner = options.transactionRunner || withTenantTransaction;
  return transactionRunner(
    {
      tenantId: scope.tenantId,
      propertyId: scope.propertyId
    },
    work,
    { readOnly: true }
  );
}

function getPayloads(result) {
  return (Array.isArray(result?.rows) ? result.rows : [])
    .map((row) => row?.payload)
    .filter((row) => row && typeof row === "object");
}

async function fetchTenantPublicMenuFeature(
  inputScope,
  requestedSlug,
  options = {}
) {
  const scope = normalizeScope(inputScope, requestedSlug);
  return runReadOnlyScope(
    scope,
    async (client) => {
      const result = await client.query(
        `SELECT to_jsonb(settings) AS payload
           FROM public.hotel_feature_settings AS settings
          WHERE settings.tenant_id = $1::uuid
            AND settings.property_id = $2::bigint
            AND settings.hotel_slug = $3
          LIMIT 2`,
        [scope.tenantId, scope.propertyId, scope.propertySlug]
      );
      return normalizeHotelFeatureConfig(
        getSinglePayload(result, "hotel feature settings") || {},
        scope.propertySlug
      );
    },
    options
  );
}

async function fetchTenantPublicMenuData(
  inputScope,
  requestedSlug,
  options = {}
) {
  const scope = normalizeScope(inputScope, requestedSlug);
  return runReadOnlyScope(
    scope,
    async (client) => {
      const params = [scope.tenantId, scope.propertyId, scope.propertySlug];
      const menuResult = await client.query(
        `SELECT ${PUBLIC_MENU_ITEM_JSON_SQL} AS payload
           FROM public.menu_items AS item
          WHERE item.tenant_id = $1::uuid
            AND item.property_id = $2::bigint
            AND item.hotel_slug = $3
            AND item.is_available = true
            AND item.is_archived = false
          ORDER BY item.category ASC,
                   item.sort_order ASC,
                   item.item_id ASC`,
        params
      );
      const menuItems = getPayloads(menuResult);

      const categoriesResult = await client.query(
        `SELECT to_jsonb(category) AS payload
           FROM public.menu_categories AS category
          WHERE category.tenant_id = $1::uuid
            AND category.property_id = $2::bigint
            AND category.hotel_slug = $3
          ORDER BY category.display_order ASC,
                   category.name ASC,
                   category.id ASC`,
        params
      );
      const categories = sortMenuCategories(
        getPayloads(categoriesResult)
      ).filter((category) => isCategoryEligible(category, "website"));
      const comboItemIds = menuItems
        .filter((item) => String(item.item_type || "single").trim() === "combo")
        .map((item) => String(item.item_id || "").trim())
        .filter(Boolean);

      let comboPresentationMap = new Map();
      if (comboItemIds.length) {
        const comboParams = [...params, comboItemIds];
        const comboChildrenResult = await client.query(
          `SELECT to_jsonb(combo_child) AS payload
             FROM public.menu_combo_items AS combo_child
            WHERE combo_child.tenant_id = $1::uuid
              AND combo_child.property_id = $2::bigint
              AND combo_child.hotel_slug = $3
              AND combo_child.combo_item_id::text = ANY($4::text[])
            ORDER BY combo_child.sort_order ASC, combo_child.id ASC`,
          comboParams
        );
        const comboChildren = getPayloads(comboChildrenResult);
        const comboSettingsResult = await client.query(
          `SELECT to_jsonb(combo_settings) AS payload
             FROM public.menu_combo_settings AS combo_settings
            WHERE combo_settings.tenant_id = $1::uuid
              AND combo_settings.property_id = $2::bigint
              AND combo_settings.hotel_slug = $3
              AND combo_settings.combo_item_id::text = ANY($4::text[])`,
          comboParams
        );
        const childItemIds = [
          ...new Set(
            comboChildren
              .map((row) => String(row.child_item_id || "").trim())
              .filter(Boolean)
          )
        ];
        let childMenuItems = [];
        if (childItemIds.length) {
          const childItemsResult = await client.query(
            `SELECT to_jsonb(item) AS payload
               FROM public.menu_items AS item
              WHERE item.tenant_id = $1::uuid
                AND item.property_id = $2::bigint
                AND item.hotel_slug = $3
                AND item.item_id::text = ANY($4::text[])`,
            [...params, childItemIds]
          );
          childMenuItems = getPayloads(childItemsResult);
        }

        comboPresentationMap = buildMenuComboPresentationMap({
          hotelSlug: scope.propertySlug,
          menuItems,
          comboChildRows: comboChildren,
          comboSettingsRows: getPayloads(comboSettingsResult),
          childMenuItems
        });
      }

      return {
        menuItems,
        categoryResult: {
          categories,
          source: "menu-categories"
        },
        comboPresentationMap
      };
    },
    options
  );
}

module.exports = {
  fetchTenantPublicMenuData,
  fetchTenantPublicMenuFeature,
  getPayloads
};
