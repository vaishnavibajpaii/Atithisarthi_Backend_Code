const express = require("express");
const { supabase } = require("../utils/supabase");
const { env } = require("../config/env");
const {
  ensurePublicHotelAccess,
  normalizePublicText
} = require("../utils/public-hotel-access");
const { fetchHotelOrderingSettings } = require("../utils/hotel-ordering-settings");
const {
  getTenantRequestScope
} = require("../utils/tenant-request-context");
const {
  fetchTenantPublicHotelBundle,
  fetchTenantPublicOrderingSettings
} = require("../utils/tenant-public-hotel");
const { ensureHotelFeatureEnabled } = require("../middleware/require-hotel-feature");
const {
  fetchMenuComboPresentationMap,
  isMenuComboPresentationCurrentlyAvailable,
  isMissingMenuComboSchemaError
} = require("../utils/menu-combos");

const {
  getCachedPublicRoutePayload,
  setCachedPublicRoutePayload
} = require("../utils/public-route-cache");
const {
  buildEligibleCategoryDtos,
  createMenuVersion,
  fetchHotelMenuCategories,
  normalizeMenuCategoryKey,
  resolveMenuItemDisplayImage
} = require("../utils/menu-categories");
const router = express.Router();
const PUBLIC_ROUTE_CACHE_CONTROL = "public, max-age=30, stale-while-revalidate=120";
const PUBLIC_ROUTE_CACHE_TTL_MS = 30 * 1000;
const publicRouteCache = new Map();

const PUBLIC_HOTEL_PROFILE_FIELDS = [
  "hotel_slug",
  "hotel_name",
  "tagline",
  "owner_whatsapp_number",
  "owner_upi_id",
  "gst_percent",
  "contact",
  "branding",
  "theme",
  "hero",
  "about",
  "features",
  "events",
  "reservation",
  "contact_section",
  "location",
  "footer",
  "social"
].join(",");

const PUBLIC_MENU_FIELDS = [
  "item_id",
  "item_type",
  "name",
  "description",
  "price",
  "image",
  "alt",
  "badge",
  "tag",
  "category",
  "sort_order"
].join(",");

const PUBLIC_GALLERY_FIELDS = [
  "id",
  "image_url",
  "storage_path",
  "alt",
  "layout_variant",
  "sort_order"
].join(",");

const PUBLIC_TESTIMONIAL_FIELDS = [
  "id",
  "hotel_slug",
  "guest_name",
  "guest_role",
  "review_text",
  "star_rating",
  "avatar_url",
  "sort_order",
  "created_at",
  "is_archived",
  "is_active",
  "is_approved"
].join(",");
const PUBLIC_POPUP_NOTIFICATION_FIELDS = [
  "id",
  "hotel_slug",
  "title",
  "description",
  "image_url",
  "storage_path",
  "cta_text",
  "cta_link",
  "display_mode",
  "start_at",
  "end_at",
  "priority",
  "created_at"
].join(",");

function isMissingTestimonialsRelationError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();

  return (
    code === "42P01" ||
    code === "PGRST205" ||
    (details.includes("testimonial") &&
      (details.includes("relation") ||
        details.includes("schema cache") ||
        details.includes("could not find")))
  );
}

function isMissingPopupNotificationsRelationError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();

  return (
    code === "42P01" ||
    code === "PGRST205" ||
    (details.includes("hotel_popup_notifications") &&
      (details.includes("relation") ||
        details.includes("schema cache") ||
        details.includes("could not find")))
  );
}

function isPopupNotificationWithinActiveWindow(notification = {}, now = new Date()) {
  const startAt = notification?.start_at ? Date.parse(notification.start_at) : null;
  const endAt = notification?.end_at ? Date.parse(notification.end_at) : null;
  const nowMs = now.getTime();

  if (Number.isFinite(startAt) && startAt > nowMs) {
    return false;
  }

  if (Number.isFinite(endAt) && endAt < nowMs) {
    return false;
  }

  return true;
}

function normalizePopupNotificationLink(value = "") {
  const candidate = normalizePublicText(value, 2000);

  if (!candidate) {
    return "";
  }

  if (candidate.startsWith("/")) {
    return candidate;
  }

  try {
    const parsedUrl = new URL(candidate);
    return ["http:", "https:"].includes(parsedUrl.protocol) ? parsedUrl.toString() : "";
  } catch {
    return "";
  }
}

function mapPublicPopupNotification(notification = {}) {
  return {
    id: notification.id,
    hotelSlug: normalizePublicText(notification.hotel_slug, 120),
    title: normalizePublicText(notification.title, 160),
    description: normalizePublicText(notification.description, 4000),
    imageUrl: normalizePublicText(notification.image_url, 2000),
    storagePath: normalizePublicText(notification.storage_path, 500),
    ctaText: normalizePublicText(notification.cta_text, 120),
    ctaLink: normalizePopupNotificationLink(notification.cta_link),
    displayMode: normalizePublicText(notification.display_mode, 40).toLowerCase(),
    startAt: normalizePublicText(notification.start_at, 80),
    endAt: normalizePublicText(notification.end_at, 80),
    priority: Number.isFinite(Number(notification.priority)) ? Number(notification.priority) : 0
  };
}

function mapPublicOrderingSettings(settings = {}) {
  const normalizedSettings =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? settings
      : {};

  return {
    customerOrderingEnabled: normalizedSettings.customerOrderingEnabled !== false,
    staffOrderingEnabled: normalizedSettings.staffOrderingEnabled !== false,
    whatsappOrderingEnabled: normalizedSettings.whatsappOrderingEnabled !== false,
    secureOnlinePaymentEnabled: normalizedSettings.secureOnlinePaymentEnabled !== false,
    cashOnDeliveryEnabled: normalizedSettings.cashOnDeliveryEnabled !== false,
    manualUpiPaymentEnabled: normalizedSettings.manualUpiPaymentEnabled !== false,
    title: normalizePublicText(normalizedSettings.disabledTitle, 160),
    message: normalizePublicText(normalizedSettings.disabledMessage, 1000),
    buttonText: normalizePublicText(normalizedSettings.disabledButtonText, 120),
    buttonLink: normalizePublicText(normalizedSettings.disabledButtonLink, 2000),
    icon: normalizePublicText(normalizedSettings.disabledIcon, 40)
  };
}


router.get("/hotel/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const hotelAccess = await ensurePublicHotelAccess(req, res, slug);

    if (!hotelAccess) {
      return;
    }

    const canonicalSlug = hotelAccess.slug;
    const cacheKey = `hotel:${canonicalSlug}`;
    const cachedPayload = getCachedPublicRoutePayload(cacheKey);

    if (cachedPayload) {
      const orderingSettings = env.tenantRuntimePublicHotelEnabled
        ? await fetchTenantPublicOrderingSettings(
          getTenantRequestScope(req),
          canonicalSlug
        )
        : await fetchHotelOrderingSettings(slug);
      const refreshedPayload = {
        ...cachedPayload,
        hotel: {
          ...cachedPayload.hotel,
          ordering: mapPublicOrderingSettings(orderingSettings)
        }
      };
      res.set("Cache-Control", PUBLIC_ROUTE_CACHE_CONTROL);
      return res.json(refreshedPayload);
    }

    let data;
    let orderingSettings;

    if (env.tenantRuntimePublicHotelEnabled) {
      const tenantResult = await fetchTenantPublicHotelBundle(
        getTenantRequestScope(req),
        canonicalSlug
      );
      data = tenantResult.profile;
      orderingSettings = tenantResult.orderingSettings;
    } else {
      const profileResult = await supabase
        .from("hotel_profiles")
        .select(PUBLIC_HOTEL_PROFILE_FIELDS)
        .eq("hotel_slug", slug)
        .maybeSingle();

      if (profileResult.error) throw profileResult.error;
      data = profileResult.data;
      orderingSettings = await fetchHotelOrderingSettings(slug);
    }

    if (!data) {
      return res.status(404).json({
        success: false,
        message: "Hotel profile not found"
      });
    }

    const payload = {
      success: true,
      hotel: {
        ...data,
        ordering: mapPublicOrderingSettings(orderingSettings)
      }
    };

    setCachedPublicRoutePayload(cacheKey, payload);
    res.set("Cache-Control", PUBLIC_ROUTE_CACHE_CONTROL);
    res.json(payload);
  } catch (error) {
    console.error("Public hotel fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch hotel profile"
    });
  }
});

router.get("/menu/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const hotelAccess = await ensurePublicHotelAccess(req, res, slug);

    if (!hotelAccess) {
      return;
    }

    if (!(await ensureHotelFeatureEnabled(res, { featureKey: "food", hotelSlug: slug }))) {
      return;
    }

    const cacheKey = `menu:${slug}`;
    const cachedPayload = getCachedPublicRoutePayload(cacheKey);

    if (cachedPayload) {
      res.set("Cache-Control", PUBLIC_ROUTE_CACHE_CONTROL);
      return res.json(cachedPayload);
    }

    const { data, error } = await supabase
      .from("menu_items")
      .select(PUBLIC_MENU_FIELDS)
      .eq("hotel_slug", slug)
      .eq("is_available", true)
      .eq("is_archived", false)
      .order("category", { ascending: true })
      .order("sort_order", { ascending: true });

    if (error) throw error;

    const categoryResult = await fetchHotelMenuCategories({
      supabase,
      hotelSlug: slug,
      consumer: "website",
      menuItems: data || []
    });
    const categoryDtos = buildEligibleCategoryDtos(categoryResult.categories, data || [], {
      hideEmpty: true
    });
    const categoryByKey = new Map(categoryDtos.map((category) => [category.key, category]));

    let comboPresentationMap = new Map();

    try {
      comboPresentationMap = await fetchMenuComboPresentationMap({
        hotelSlug: slug,
        menuItems: data || []
      });
    } catch (comboError) {
      if (!isMissingMenuComboSchemaError(comboError)) {
        throw comboError;
      }
    }

    const groupedMenu = {};

    for (const item of data || []) {
      const category = normalizeMenuCategoryKey(item.category);
      const categoryDto = categoryByKey.get(category);
      if (!categoryDto) continue;
      const displayImage = resolveMenuItemDisplayImage(item, categoryDto);
      const comboPresentation = comboPresentationMap.get(item.item_id);
      const isComboItem = String(item.item_type || "single").trim() === "combo";

      if (isComboItem && !isMenuComboPresentationCurrentlyAvailable(comboPresentation)) {
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
      (category) => Array.isArray(groupedMenu[category.key]) && groupedMenu[category.key].length > 0
    );
    const menuVersion = createMenuVersion({ categories: visibleCategories, items: visibleItems });

    const payload = {
      success: true,
      menuVersion,
      categorySource: categoryResult.source,
      categories: visibleCategories,
      menu: groupedMenu
    };

    setCachedPublicRoutePayload(cacheKey, payload);
    res.set("Cache-Control", PUBLIC_ROUTE_CACHE_CONTROL);
    res.json(payload);
  } catch (error) {
    console.error("Public menu fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch menu"
    });
  }
});

router.get("/gallery/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const hotelAccess = await ensurePublicHotelAccess(req, res, slug);

    if (!hotelAccess) {
      return;
    }

    const cacheKey = `gallery:${slug}`;
    const cachedPayload = getCachedPublicRoutePayload(cacheKey);

    if (cachedPayload) {
      res.set("Cache-Control", PUBLIC_ROUTE_CACHE_CONTROL);
      return res.json(cachedPayload);
    }

    const { data, error } = await supabase
      .from("gallery_items")
      .select(PUBLIC_GALLERY_FIELDS)
      .eq("hotel_slug", slug)
      .eq("is_active", true)
      .eq("is_archived", false)
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true });

    if (error) throw error;

    const payload = {
      success: true,
      gallery: (data || []).map((item) => ({
        id: item.id,
        imageUrl: item.image_url || "",
        storagePath: item.storage_path || "",
        alt: item.alt || "",
        layoutVariant: item.layout_variant || "standard",
        sortOrder: Number(item.sort_order || 0)
      }))
    };

    setCachedPublicRoutePayload(cacheKey, payload);
    res.set("Cache-Control", PUBLIC_ROUTE_CACHE_CONTROL);
    res.json(payload);
  } catch (error) {
    console.error("Public gallery fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch gallery"
    });
  }
});

router.get("/testimonials/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const hotelAccess = await ensurePublicHotelAccess(req, res, slug);

    if (!hotelAccess) {
      return;
    }

    const cacheKey = `testimonials:${slug}`;
    const cachedPayload = getCachedPublicRoutePayload(cacheKey);

    if (cachedPayload) {
      res.set("Cache-Control", PUBLIC_ROUTE_CACHE_CONTROL);
      return res.json(cachedPayload);
    }

    const { data, error } = await supabase
      .from("testimonials")
      .select(PUBLIC_TESTIMONIAL_FIELDS)
      .eq("hotel_slug", slug)
      .eq("is_archived", false)
      .eq("is_active", true)
      .eq("is_approved", true);

    if (error) {
      if (isMissingTestimonialsRelationError(error)) {
        const payload = {
          success: true,
          testimonials: []
        };

        setCachedPublicRoutePayload(cacheKey, payload);
        res.set("Cache-Control", PUBLIC_ROUTE_CACHE_CONTROL);
        return res.json(payload);
      }

      throw error;
    }

    const testimonials = (data || [])
      .filter(
        (item) =>
          item &&
          item.is_archived !== true &&
          item.is_active !== false &&
          item.is_approved === true
      )
      .sort((left, right) => {
        const leftSort = Number.isFinite(Number(left?.sort_order)) ? Number(left.sort_order) : 0;
        const rightSort = Number.isFinite(Number(right?.sort_order)) ? Number(right.sort_order) : 0;

        if (leftSort !== rightSort) {
          return leftSort - rightSort;
        }

        const leftCreated = Date.parse(left?.created_at || "") || 0;
        const rightCreated = Date.parse(right?.created_at || "") || 0;

        return rightCreated - leftCreated;
      })
      .map((item) => ({
        id: item.id,
        hotelSlug: item.hotel_slug || slug,
        name: item.guest_name || item.name || "",
        role: item.guest_role || item.role || "",
        text: item.review_text || item.text || "",
        stars: Number(item.star_rating ?? item.stars ?? 5) || 5,
        avatar: item.avatar_url || item.avatar || ""
      }))
      .filter((item) => item.name && item.text);

    const payload = {
      success: true,
      testimonials
    };

    setCachedPublicRoutePayload(cacheKey, payload);
    res.set("Cache-Control", PUBLIC_ROUTE_CACHE_CONTROL);
    res.json(payload);
  } catch (error) {
    console.error("Public testimonials fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch testimonials"
    });
  }
});

router.get("/popup-notification/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const hotelAccess = await ensurePublicHotelAccess(req, res, slug, {
      notFoundMessage: "Hotel notification is not publicly available",
      forbiddenMessage: "This hotel notification is not available for the current origin"
    });

    if (!hotelAccess) {
      return;
    }

    const cacheKey = `popup-notification:${slug}`;
    const cachedPayload = getCachedPublicRoutePayload(cacheKey);

    if (cachedPayload) {
      res.set("Cache-Control", PUBLIC_ROUTE_CACHE_CONTROL);
      return res.json(cachedPayload);
    }

    const { data, error } = await supabase
      .from("hotel_popup_notifications")
      .select(PUBLIC_POPUP_NOTIFICATION_FIELDS)
      .eq("hotel_slug", slug)
      .eq("is_active", true)
      .order("priority", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) {
      if (isMissingPopupNotificationsRelationError(error)) {
        const payload = {
          success: true,
          notifications: [],
          notification: null
        };

        setCachedPublicRoutePayload(cacheKey, payload);
        res.set("Cache-Control", PUBLIC_ROUTE_CACHE_CONTROL);
        return res.json(payload);
      }

      throw error;
    }

    const activeNotifications = (data || [])
      .filter((notification) => isPopupNotificationWithinActiveWindow(notification))
      .map((notification) => mapPublicPopupNotification(notification));
    const payload = {
      success: true,
      notifications: activeNotifications,
      notification: activeNotifications[0] || null
    };

    setCachedPublicRoutePayload(cacheKey, payload);
    res.set("Cache-Control", PUBLIC_ROUTE_CACHE_CONTROL);
    res.json(payload);
  } catch (error) {
    console.error("Public popup notification fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch popup notification"
    });
  }
});

module.exports = router;
