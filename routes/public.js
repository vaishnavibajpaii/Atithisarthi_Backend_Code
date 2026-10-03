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
  isMissingMenuComboSchemaError
} = require("../utils/menu-combos");
const {
  fetchTenantPublicMenuData,
  fetchTenantPublicMenuFeature
} = require("../utils/tenant-public-menu");
const {
  buildPublicMenuPayload
} = require("../utils/public-menu-presentation");
const {
  buildPublicGalleryPayload
} = require("../utils/public-gallery-presentation");
const {
  fetchTenantPublicGallery
} = require("../utils/tenant-public-gallery");
const {
  buildPublicTestimonialsPayload
} = require("../utils/public-testimonials-presentation");
const {
  fetchTenantPublicTestimonials
} = require("../utils/tenant-public-testimonials");
const {
  buildPublicPopupNotificationPayload
} = require("../utils/public-popup-notification-presentation");
const {
  fetchTenantPublicPopupNotifications
} = require("../utils/tenant-public-popup-notifications");
const {
  HOTEL_FEATURE_KEYS,
  buildFeatureDisabledPayload,
  isHotelFeatureEnabled
} = require("../utils/hotel-feature-settings");

const {
  getCachedPublicRoutePayload,
  setCachedPublicRoutePayload
} = require("../utils/public-route-cache");
const {
  fetchHotelMenuCategories,
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

    const canonicalSlug = hotelAccess.slug;

    if (env.tenantRuntimePublicMenuEnabled) {
      const featureConfig = await fetchTenantPublicMenuFeature(
        getTenantRequestScope(req),
        canonicalSlug
      );
      if (!isHotelFeatureEnabled(featureConfig, HOTEL_FEATURE_KEYS.FOOD)) {
        return res
          .status(403)
          .json(buildFeatureDisabledPayload(HOTEL_FEATURE_KEYS.FOOD));
      }
    } else if (!(await ensureHotelFeatureEnabled(
      res,
      { featureKey: "food", hotelSlug: canonicalSlug }
    ))) {
      return;
    }

    const cacheKey = `menu:${canonicalSlug}`;
    const cachedPayload = getCachedPublicRoutePayload(cacheKey);

    if (cachedPayload) {
      res.set("Cache-Control", PUBLIC_ROUTE_CACHE_CONTROL);
      return res.json(cachedPayload);
    }

    let menuItems;
    let categoryResult;
    let comboPresentationMap;

    if (env.tenantRuntimePublicMenuEnabled) {
      const tenantResult = await fetchTenantPublicMenuData(
        getTenantRequestScope(req),
        canonicalSlug
      );
      menuItems = tenantResult.menuItems;
      categoryResult = tenantResult.categoryResult;
      comboPresentationMap = tenantResult.comboPresentationMap;
    } else {
      const { data, error } = await supabase
        .from("menu_items")
        .select(PUBLIC_MENU_FIELDS)
        .eq("hotel_slug", canonicalSlug)
        .eq("is_available", true)
        .eq("is_archived", false)
        .order("category", { ascending: true })
        .order("sort_order", { ascending: true })
        .order("item_id", { ascending: true });

      if (error) throw error;
      menuItems = data || [];
      categoryResult = await fetchHotelMenuCategories({
        supabase,
        hotelSlug: canonicalSlug,
        consumer: "website",
        menuItems
      });
      comboPresentationMap = new Map();

      try {
        comboPresentationMap = await fetchMenuComboPresentationMap({
          hotelSlug: canonicalSlug,
          menuItems
        });
      } catch (comboError) {
        if (!isMissingMenuComboSchemaError(comboError)) {
          throw comboError;
        }
      }
    }

    const payload = buildPublicMenuPayload({
      menuItems,
      categoryResult,
      comboPresentationMap
    });

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

    const canonicalSlug = hotelAccess.slug;
    const cacheKey = `gallery:${canonicalSlug}`;
    const cachedPayload = getCachedPublicRoutePayload(cacheKey);

    if (cachedPayload) {
      res.set("Cache-Control", PUBLIC_ROUTE_CACHE_CONTROL);
      return res.json(cachedPayload);
    }

    let galleryItems;
    if (env.tenantRuntimePublicGalleryEnabled) {
      galleryItems = await fetchTenantPublicGallery(
        getTenantRequestScope(req),
        canonicalSlug
      );
    } else {
      const { data, error } = await supabase
        .from("gallery_items")
        .select(PUBLIC_GALLERY_FIELDS)
        .eq("hotel_slug", canonicalSlug)
        .eq("is_active", true)
        .eq("is_archived", false)
        .order("sort_order", { ascending: true })
        .order("id", { ascending: true });
      if (error) throw error;
      galleryItems = data || [];
    }

    const payload = buildPublicGalleryPayload(galleryItems);

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

    const canonicalSlug = hotelAccess.slug;
    const cacheKey = `testimonials:${canonicalSlug}`;
    const cachedPayload = getCachedPublicRoutePayload(cacheKey);

    if (cachedPayload) {
      res.set("Cache-Control", PUBLIC_ROUTE_CACHE_CONTROL);
      return res.json(cachedPayload);
    }

    let testimonialItems;
    try {
      if (env.tenantRuntimePublicTestimonialsEnabled) {
        testimonialItems = await fetchTenantPublicTestimonials(
          getTenantRequestScope(req),
          canonicalSlug
        );
      } else {
        const { data, error } = await supabase
          .from("testimonials")
          .select(PUBLIC_TESTIMONIAL_FIELDS)
          .eq("hotel_slug", canonicalSlug)
          .eq("is_archived", false)
          .eq("is_active", true)
          .eq("is_approved", true);
        if (error) throw error;
        testimonialItems = data || [];
      }
    } catch (error) {
      if (!isMissingTestimonialsRelationError(error)) throw error;
      testimonialItems = [];
    }

    const payload = buildPublicTestimonialsPayload(
      testimonialItems,
      canonicalSlug
    );

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

    const canonicalSlug = hotelAccess.slug;
    const cacheKey = `popup-notification:${canonicalSlug}`;
    const cachedPayload = getCachedPublicRoutePayload(cacheKey);

    if (cachedPayload) {
      res.set("Cache-Control", PUBLIC_ROUTE_CACHE_CONTROL);
      return res.json(cachedPayload);
    }

    let popupItems;
    try {
      if (env.tenantRuntimePublicPopupEnabled) {
        popupItems = await fetchTenantPublicPopupNotifications(
          getTenantRequestScope(req),
          canonicalSlug
        );
      } else {
        const { data, error } = await supabase
          .from("hotel_popup_notifications")
          .select(PUBLIC_POPUP_NOTIFICATION_FIELDS)
          .eq("hotel_slug", canonicalSlug)
          .eq("is_active", true)
          .order("priority", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(20);
        if (error) throw error;
        popupItems = data || [];
      }
    } catch (error) {
      if (!isMissingPopupNotificationsRelationError(error)) throw error;
      popupItems = [];
    }

    const payload = buildPublicPopupNotificationPayload(popupItems);

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
