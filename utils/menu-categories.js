"use strict";

const crypto = require("crypto");

const GLOBAL_MENU_IMAGE = Object.freeze({
  thumbnailUrl: "/img/default-food.v1.webp",
  cardUrl: "/img/default-food.v1.webp",
  fallbackUrl: "/img/default-food.v1.jpg",
  alt: "Restaurant dish"
});

const MENU_CATEGORY_FIELDS = [
  "id",
  "hotel_slug",
  "category_key",
  "name",
  "slug",
  "description",
  "display_order",
  "is_active",
  "is_published",
  "staff_enabled",
  "website_enabled",
  "qr_enabled",
  "default_image_url",
  "default_thumbnail_url",
  "image_storage_path",
  "image_alt_text",
  "image_version",
  "created_at",
  "updated_at"
].join(",");

function normalizeMenuCategoryText(value = "", maxLength = 160) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeMenuCategoryKey(value = "") {
  return normalizeMenuCategoryText(value, 120);
}

function createMenuCategorySlug(value = "") {
  const source = normalizeMenuCategoryText(value, 160).normalize("NFKD");
  const slug = source
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return slug || `category-${crypto.createHash("sha1").update(source).digest("hex").slice(0, 12)}`;
}

function isSafeMenuImageUrl(value = "") {
  const candidate = normalizeMenuCategoryText(value, 2000);
  if (!candidate) return false;
  if (candidate.startsWith("/") || candidate.startsWith("./") || candidate.startsWith("../")) {
    return !candidate.startsWith("//") && !/[<>"'`]/.test(candidate);
  }
  try {
    const parsed = new URL(candidate);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function getSafeMenuImageUrl(value = "") {
  const candidate = normalizeMenuCategoryText(value, 2000);
  return isSafeMenuImageUrl(candidate) ? candidate : "";
}

function isMissingMenuCategoriesSchemaError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`.toLowerCase();
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    (details.includes("menu_categories") &&
      (details.includes("relation") || details.includes("schema cache") || details.includes("could not find")))
  );
}

function formatLegacyCategoryName(value = "") {
  const normalized = normalizeMenuCategoryKey(value).replace(/[-_]+/g, " ");
  return normalized ? normalized.replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase()) : "Other";
}

function buildLegacyCategoriesFromItems(items = []) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).reduce((categories, item, index) => {
    const key = normalizeMenuCategoryKey(item?.category);
    const identity = key.toLocaleLowerCase();
    if (!key || seen.has(identity)) return categories;
    seen.add(identity);
    categories.push({
      id: `legacy:${crypto.createHash("sha1").update(key).digest("hex").slice(0, 16)}`,
      hotel_slug: normalizeMenuCategoryText(item?.hotel_slug, 120),
      category_key: key,
      name: formatLegacyCategoryName(key),
      slug: createMenuCategorySlug(key),
      description: "",
      display_order: index,
      is_active: true,
      is_published: true,
      staff_enabled: true,
      website_enabled: true,
      qr_enabled: true,
      default_image_url: "",
      default_thumbnail_url: "",
      image_storage_path: "",
      image_alt_text: "",
      image_version: 1,
      legacy: true
    });
    return categories;
  }, []);
}

function sortMenuCategories(categories = []) {
  return [...categories].sort((left, right) => {
    const orderDifference = Number(left?.display_order || 0) - Number(right?.display_order || 0);
    if (orderDifference) return orderDifference;
    const nameDifference = normalizeMenuCategoryText(left?.name).localeCompare(
      normalizeMenuCategoryText(right?.name),
      undefined,
      { sensitivity: "base" }
    );
    if (nameDifference) return nameDifference;
    return String(left?.id || left?.category_key || "").localeCompare(
      String(right?.id || right?.category_key || "")
    );
  });
}

function isCategoryEligible(category = {}, consumer = "manager") {
  if (consumer === "manager") return true;
  if (category.is_active === false) return false;
  if (consumer === "staff") return category.staff_enabled !== false;
  if (category.is_published === false) return false;
  if (consumer === "qr") return category.qr_enabled !== false;
  return category.website_enabled !== false;
}

async function fetchHotelMenuCategories({ supabase, hotelSlug, consumer = "manager", menuItems = [] }) {
  const normalizedHotelSlug = normalizeMenuCategoryText(hotelSlug, 120);
  if (!normalizedHotelSlug) return { categories: [], source: "none" };

  const { data, error } = await supabase
    .from("menu_categories")
    .select(MENU_CATEGORY_FIELDS)
    .eq("hotel_slug", normalizedHotelSlug)
    .order("display_order", { ascending: true })
    .order("name", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    if (!isMissingMenuCategoriesSchemaError(error)) throw error;
    return {
      categories: sortMenuCategories(buildLegacyCategoriesFromItems(menuItems)).filter((category) =>
        isCategoryEligible(category, consumer)
      ),
      source: "legacy-menu-items"
    };
  }

  return {
    categories: sortMenuCategories(data || []).filter((category) => isCategoryEligible(category, consumer)),
    source: "menu-categories"
  };
}

async function filterEligibleMenuItems({ supabase, hotelSlug, consumer, menuItems = [] }) {
  const result = await fetchHotelMenuCategories({
    supabase,
    hotelSlug,
    consumer,
    menuItems
  });
  const eligibleKeys = new Set(
    result.categories.map((category) => normalizeMenuCategoryKey(category.category_key)).filter(Boolean)
  );
  return (Array.isArray(menuItems) ? menuItems : []).filter((item) =>
    eligibleKeys.has(normalizeMenuCategoryKey(item.category))
  );
}

function getCategoryItemCountMap(items = []) {
  return (Array.isArray(items) ? items : []).reduce((counts, item) => {
    const key = normalizeMenuCategoryKey(item?.category);
    if (key) counts.set(key, Number(counts.get(key) || 0) + 1);
    return counts;
  }, new Map());
}

function buildMenuCategoryDto(category = {}, itemCount = 0) {
  const name = normalizeMenuCategoryText(category.name, 160) || formatLegacyCategoryName(category.category_key);
  const cardUrl = getSafeMenuImageUrl(category.default_image_url);
  const thumbnailUrl = getSafeMenuImageUrl(category.default_thumbnail_url) || cardUrl;
  return {
    reference: String(category.id || category.category_key || ""),
    key: normalizeMenuCategoryKey(category.category_key),
    name,
    slug: normalizeMenuCategoryText(category.slug, 140) || createMenuCategorySlug(name),
    description: normalizeMenuCategoryText(category.description, 1000),
    displayOrder: Number(category.display_order || 0),
    itemCount: Number(itemCount || 0),
    isActive: category.is_active !== false,
    isPublished: category.is_published !== false,
    staffEnabled: category.staff_enabled !== false,
    websiteEnabled: category.website_enabled !== false,
    qrEnabled: category.qr_enabled !== false,
    imageStoragePath: normalizeMenuCategoryText(category.image_storage_path, 500),
    defaultImage: {
      thumbnailUrl,
      cardUrl,
      fallbackUrl: GLOBAL_MENU_IMAGE.cardUrl,
      alt: normalizeMenuCategoryText(category.image_alt_text, 300) || `${name} food`,
      version: Number(category.image_version || 1)
    }
  };
}

function buildEligibleCategoryDtos(categories = [], items = [], { hideEmpty = false } = {}) {
  const counts = getCategoryItemCountMap(items);
  return sortMenuCategories(categories)
    .map((category) => buildMenuCategoryDto(category, counts.get(normalizeMenuCategoryKey(category.category_key)) || 0))
    .filter((category) => !hideEmpty || category.itemCount > 0);
}

function resolveMenuItemDisplayImage(item = {}, category = null) {
  const itemUrl = getSafeMenuImageUrl(item.image);
  const categoryCardUrl = getSafeMenuImageUrl(category?.defaultImage?.cardUrl || category?.default_image_url);
  const categoryThumbnailUrl = getSafeMenuImageUrl(
    category?.defaultImage?.thumbnailUrl || category?.default_thumbnail_url
  );
  const primaryUrl = itemUrl || categoryCardUrl || categoryThumbnailUrl || GLOBAL_MENU_IMAGE.cardUrl;
  const categoryFallbackUrl = itemUrl ? categoryCardUrl || categoryThumbnailUrl : "";
  return {
    url: primaryUrl,
    thumbnailUrl: itemUrl || categoryThumbnailUrl || categoryCardUrl || GLOBAL_MENU_IMAGE.thumbnailUrl,
    categoryFallbackUrl,
    globalFallbackUrl: GLOBAL_MENU_IMAGE.cardUrl,
    fallbackFormatUrl: GLOBAL_MENU_IMAGE.fallbackUrl,
    source: itemUrl ? "item" : categoryCardUrl || categoryThumbnailUrl ? "category" : "global",
    alt: normalizeMenuCategoryText(item.alt, 300) || normalizeMenuCategoryText(item.name, 160) || GLOBAL_MENU_IMAGE.alt
  };
}

function createMenuVersion({ categories = [], items = [] } = {}) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        categories: categories.map((category) => [
          category.reference || category.id,
          category.key || category.category_key,
          category.displayOrder ?? category.display_order,
          category.defaultImage?.version ?? category.image_version,
          category.itemCount
        ]),
        items: items.map((item) => [
          item.id || item.item_id,
          item.category,
          item.price,
          item.sortOrder ?? item.sort_order,
          item.image?.url || item.image
        ])
      })
    )
    .digest("hex")
    .slice(0, 16);
}

module.exports = {
  GLOBAL_MENU_IMAGE,
  MENU_CATEGORY_FIELDS,
  buildEligibleCategoryDtos,
  buildLegacyCategoriesFromItems,
  buildMenuCategoryDto,
  createMenuCategorySlug,
  createMenuVersion,
  fetchHotelMenuCategories,
  filterEligibleMenuItems,
  getSafeMenuImageUrl,
  isCategoryEligible,
  isMissingMenuCategoriesSchemaError,
  normalizeMenuCategoryKey,
  normalizeMenuCategoryText,
  resolveMenuItemDisplayImage,
  sortMenuCategories
};
