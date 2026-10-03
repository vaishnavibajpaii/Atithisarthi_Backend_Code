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

function buildPublicMenuPayload({
  menuItems = [],
  categoryResult = { categories: [], source: "none" },
  comboPresentationMap = new Map()
} = {}) {
  const normalizedItems = Array.isArray(menuItems) ? menuItems : [];
  const normalizedComboMap = comboPresentationMap instanceof Map
    ? comboPresentationMap
    : new Map();
  const categoryDtos = buildEligibleCategoryDtos(
    categoryResult.categories || [],
    normalizedItems,
    { hideEmpty: true }
  );
  const categoryByKey = new Map(
    categoryDtos.map((category) => [category.key, category])
  );
  const groupedMenu = {};

  for (const item of normalizedItems) {
    const category = normalizeMenuCategoryKey(item.category);
    const categoryDto = categoryByKey.get(category);
    if (!categoryDto) continue;
    const displayImage = resolveMenuItemDisplayImage(item, categoryDto);
    const comboPresentation = normalizedComboMap.get(item.item_id);
    const isComboItem = String(item.item_type || "single").trim() === "combo";

    if (
      isComboItem &&
      !isMenuComboPresentationCurrentlyAvailable(comboPresentation)
    ) {
      continue;
    }

    if (!groupedMenu[category]) {
      groupedMenu[category] = [];
    }

    groupedMenu[category].push({
      id: item.item_id,
      name: item.name,
      desc: item.description || "",
      price: Number(item.price || 0),
      image: displayImage.url,
      imageMeta: displayImage,
      alt: item.alt || item.name || "",
      badge: item.badge || (comboPresentation ? "Combo" : ""),
      tag: item.tag || "",
      itemType: comboPresentation?.itemType || item.item_type || "single",
      comboItems: comboPresentation?.comboItems || [],
      originalPrice: Number(comboPresentation?.originalPrice || 0),
      savings: Number(comboPresentation?.savings || 0),
      startDate: comboPresentation?.startDate || "",
      endDate: comboPresentation?.endDate || "",
      startTime: comboPresentation?.startTime || "",
      endTime: comboPresentation?.endTime || ""
    });
  }

  const visibleItems = Object.values(groupedMenu).flat();
  const visibleCategories = categoryDtos.filter(
    (category) =>
      Array.isArray(groupedMenu[category.key]) &&
      groupedMenu[category.key].length > 0
  );

  return {
    success: true,
    menuVersion: createMenuVersion({
      categories: visibleCategories,
      items: visibleItems
    }),
    categorySource: categoryResult.source,
    categories: visibleCategories,
    menu: groupedMenu
  };
}

module.exports = {
  buildPublicMenuPayload
};
