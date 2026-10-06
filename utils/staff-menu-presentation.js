"use strict";

const {
  buildEligibleCategoryDtos,
  createMenuVersion,
  normalizeMenuCategoryKey,
  resolveMenuItemDisplayImage
} = require("./menu-categories");
const {
  isMenuComboPresentationCurrentlyAvailable
} = require("./menu-combos");

function buildStaffMenuItemResponse(
  item = {},
  comboPresentation = null,
  category = null
) {
  const displayImage = resolveMenuItemDisplayImage(item, category);
  return {
    id: item.item_id || "",
    name: item.name || "",
    desc: item.description || "",
    price: Number(item.price || 0),
    image: displayImage.url,
    imageMeta: displayImage,
    alt: item.alt || item.name || "",
    badge: item.badge || (comboPresentation ? "Combo" : ""),
    tag: item.tag || "",
    category: normalizeMenuCategoryKey(item.category),
    categoryName:
      category?.name || normalizeMenuCategoryKey(item.category),
    categorySlug: category?.slug || "",
    sortOrder: Number(item.sort_order || 0),
    itemType:
      comboPresentation?.itemType || item.item_type || "single",
    comboItems: comboPresentation?.comboItems || [],
    originalPrice: Number(comboPresentation?.originalPrice || 0),
    savings: Number(comboPresentation?.savings || 0),
    startDate: comboPresentation?.startDate || "",
    endDate: comboPresentation?.endDate || "",
    startTime: comboPresentation?.startTime || "",
    endTime: comboPresentation?.endTime || ""
  };
}

function groupStaffMenuItemsByCategory(items = []) {
  return items.reduce((groupedMenu, item) => {
    const category = item.category || "others";
    if (!groupedMenu[category]) groupedMenu[category] = [];
    groupedMenu[category].push(item);
    return groupedMenu;
  }, {});
}

function buildStaffMenuPayload({
  hotelSlug = "",
  menuItems = [],
  categoryResult = {},
  comboPresentationMap = new Map()
} = {}) {
  const categoryDtos = buildEligibleCategoryDtos(
    categoryResult.categories || [],
    menuItems,
    { hideEmpty: true }
  );
  const categoryByKey = new Map(
    categoryDtos.map((category) => [category.key, category])
  );
  const categoryOrder = new Map(
    categoryDtos.map((category, index) => [category.key, index])
  );
  const items = menuItems
    .filter((item) => {
      if (!categoryByKey.has(normalizeMenuCategoryKey(item.category))) {
        return false;
      }
      const comboPresentation =
        comboPresentationMap.get(item.item_id) || null;
      const isComboItem =
        String(item.item_type || "single").trim() === "combo";
      return (
        !isComboItem ||
        isMenuComboPresentationCurrentlyAvailable(comboPresentation)
      );
    })
    .map((item) =>
      buildStaffMenuItemResponse(
        item,
        comboPresentationMap.get(item.item_id) || null,
        categoryByKey.get(normalizeMenuCategoryKey(item.category))
      )
    )
    .sort(
      (left, right) =>
        Number(categoryOrder.get(left.category) || 0) -
          Number(categoryOrder.get(right.category) || 0) ||
        Number(left.sortOrder || 0) - Number(right.sortOrder || 0) ||
        String(left.id).localeCompare(String(right.id))
    );
  const visibleCategories = categoryDtos.filter((category) =>
    items.some((item) => item.category === category.key)
  );

  return {
    success: true,
    hotelSlug,
    count: items.length,
    menuVersion: createMenuVersion({
      categories: visibleCategories,
      items
    }),
    categorySource: categoryResult.source,
    categories: visibleCategories,
    items,
    menu: groupStaffMenuItemsByCategory(items)
  };
}

module.exports = {
  buildStaffMenuItemResponse,
  buildStaffMenuPayload,
  groupStaffMenuItemsByCategory
};
