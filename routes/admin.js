const express = require("express");
const { supabase } = require("../utils/supabase");
const { requireAdminAuth } = require("../middleware/require-admin-auth");
const { requireHotelFeature, resolveAdminHotelSlug } = require("../middleware/require-hotel-feature");
const {
  processNotificationEventDeliverySafely
} = require("../utils/notifications");
const {
  getOrderCreatedByStaffMap,
  getOrderCreatedByStaffResponse,
  normalizeOrderCreatedByStaffId
} = require("../utils/order-staff-attribution");
const router = express.Router();
const { validateBody } = require("../validators/common");
const {
  galleryItemSchema,
  hotelSchema,
  hotelDomainSettingsSchema,
  hotelOrderingSettingsSchema,
  hotelPaymentRouteSettingsSchema,
  hotelNotificationSettingsSchema,
  popupNotificationSchema,
  partialPopupNotificationSchema,
  qrLinkSignatureSchema,
  menuItemSchema,
  partialMenuItemSchema,
  menuCategorySchema,
  partialMenuCategorySchema,
  comboMenuItemSchema,
  partialComboMenuItemSchema,
  partialHotelSchema,
  partialGalleryItemSchema,
  hotelProfileSchema,
  testimonialSchema,
  partialTestimonialSchema
} = require("../validators/admin");
const { buildQrContextToken } = require("../utils/qr-context");
const {
  findHotelDomainConflict,
  validateHotelDomainSettings
} = require("../utils/hotel-domain-settings");
const {
  getTrustedPublicSubdomainParentHosts,
  normalizePublicHostname,
  normalizePublicText
} = require("../utils/public-hotel-access");
const {
  buildHotelOrderingSettings,
  invalidateHotelOrderingSettings,
  isMissingHotelOrderingSettingsTableError
} = require("../utils/hotel-ordering-settings");
const { invalidatePublicMenuCache } = require("../utils/public-route-cache");
const {
  isPropertyStoragePath,
  resolvePropertyStorageScope
} = require("../utils/storage-object-scope");
const {
  buildMenuCategoryDto,
  createMenuCategorySlug,
  fetchHotelMenuCategories,
  isMissingMenuCategoriesSchemaError,
  normalizeMenuCategoryKey,
  normalizeMenuCategoryText
} = require("../utils/menu-categories");

const NOTIFICATION_EVENT_SOURCE_TYPES = [
  "order",
  "reservation",
  "inquiry",
  "contact_submission",
  "testimonial",
  "support_request"
];
const NOTIFICATION_EVENT_STATUSES = ["pending", "sent", "failed", "skipped"];
const NOTIFICATION_EVENT_MAX_RETRIES = 3;
const ORDER_STATUSES = ["new", "confirmed", "preparing", "completed", "cancelled"];
const RESERVATION_STATUSES = ["new", "confirmed", "seated", "completed", "cancelled"];
const INQUIRY_STATUSES = ["new", "contacted", "converted", "closed"];
const CONTACT_SUBMISSION_STATUSES = ["new", "contacted", "resolved", "closed", "archived"];
const ORDER_BILLING_STATUSES = ["not_billed", "billed", "cancelled"];
const ORDER_PAYMENT_STATUSES = ["unpaid", "customer_confirmed", "paid", "refunded"];

async function resolveAdminFoodOperationHotelSlug(req = {}) {
  const directHotelSlug = resolveAdminHotelSlug(req);
  if (directHotelSlug) return directHotelSlug;

  const recordId = String(req.params?.id || "").trim();
  const pathName = String(req.path || "").trim();
  if (!recordId) return "";

  const table = pathName.startsWith("/orders/")
    ? "orders"
    : pathName.startsWith("/reservations/")
      ? "reservations"
      : pathName.startsWith("/menu-categories/")
        ? "menu_categories"
        : pathName.startsWith("/menu-items/") || pathName.startsWith("/menu-combos/")
        ? "menu_items"
        : "";
  if (!table) return "";

  let query = supabase.from(table).select("hotel_slug");
  query = query.eq("id", recordId);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return String(data?.hotel_slug || "").trim();
}

const requireAdminFoodModule = requireHotelFeature("food", {
  resolveHotelSlug: resolveAdminFoodOperationHotelSlug
});
const LEGACY_OPTIONAL_GALLERY_COLUMNS = [
  "storage_path",
  "layout_variant",
  "is_active",
  "is_archived",
  "updated_at"
];

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

function isMissingContactSubmissionsRelationError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();

  return (
    code === "42P01" ||
    code === "PGRST205" ||
    (details.includes("contact_submissions") &&
      (details.includes("relation") ||
        details.includes("schema cache") ||
        details.includes("could not find")))
  );
}

function isMissingMenuComboSchemaError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();

  return (
    code === "42P01" ||
    code === "42703" ||
    code === "PGRST205" ||
    code === "PGRST204" ||
    details.includes("menu_combo_items") ||
    details.includes("menu_combo_settings") ||
    details.includes("item_type")
  );
}

function isMenuItemsIdSequenceConflict(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const message = String(error?.message || "").trim().toLowerCase();
  const details = `${error?.details || ""} ${error?.hint || ""}`.trim().toLowerCase();

  return (
    code === "23505" &&
    (message.includes("menu_items_pkey") ||
      details.includes("menu_items_pkey") ||
      details.includes("key (id)="))
  );
}

function getNotificationEventsLimit(value) {
  const parsedValue = Number.parseInt(String(value || "").trim(), 10);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return 100;
  }

  return Math.min(parsedValue, 200);
}

function normalizeStatusValue(value) {
  return String(value || "").trim().toLowerCase();
}

function getAllowedStatus(value, allowedStatuses = []) {
  const normalizedStatus = normalizeStatusValue(value);
  return allowedStatuses.includes(normalizedStatus) ? normalizedStatus : "";
}

function buildAdminOrderResponse(order = {}, staffById = new Map()) {
  const createdByStaffId = normalizeOrderCreatedByStaffId(order.created_by_staff_id);

  return {
    ...order,
    createdByStaffId: createdByStaffId ? String(createdByStaffId) : "",
    createdByStaff: getOrderCreatedByStaffResponse(order, staffById)
  };
}

function normalizeBillNumberPart(value, fallback = "ORDER", maxLength = 18) {
  const normalizedValue = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return (normalizedValue || fallback).slice(0, maxLength);
}

function getGallerySchemaErrorDetails(error) {
  return `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();
}

function getMissingLegacyGalleryColumn(error, payload = {}) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = getGallerySchemaErrorDetails(error);
  const looksLikeMissingColumnError =
    code === "42703" ||
    code === "PGRST204" ||
    (details.includes("column") &&
      (details.includes("does not exist") ||
        details.includes("schema cache") ||
        details.includes("could not find")));

  if (!looksLikeMissingColumnError) {
    return "";
  }

  return (
    LEGACY_OPTIONAL_GALLERY_COLUMNS.find(
      (columnName) => payload[columnName] !== undefined && details.includes(columnName)
    ) || ""
  );
}

async function insertGalleryItemWithCompatibility(insertPayload = {}) {
  const compatiblePayload = { ...insertPayload };
  let lastError = null;

  for (let attempt = 0; attempt <= LEGACY_OPTIONAL_GALLERY_COLUMNS.length; attempt += 1) {
    const { data, error } = await supabase
      .from("gallery_items")
      .insert([compatiblePayload])
      .select()
      .single();

    if (!error) {
      return { data, error: null };
    }

    lastError = error;
    const missingColumn = getMissingLegacyGalleryColumn(error, compatiblePayload);

    if (!missingColumn) {
      return { data: null, error };
    }

    delete compatiblePayload[missingColumn];
  }

  return { data: null, error: lastError };
}

async function updateGalleryItemWithCompatibility(id, updatePayload = {}) {
  const compatiblePayload = { ...updatePayload };
  let lastError = null;

  for (let attempt = 0; attempt <= LEGACY_OPTIONAL_GALLERY_COLUMNS.length; attempt += 1) {
    const { data, error } = await supabase
      .from("gallery_items")
      .update(compatiblePayload)
      .eq("id", id)
      .select()
      .single();

    if (!error) {
      return { data, error: null };
    }

    lastError = error;
    const missingColumn = getMissingLegacyGalleryColumn(error, compatiblePayload);

    if (!missingColumn) {
      return { data: null, error };
    }

    delete compatiblePayload[missingColumn];
  }

  return { data: null, error: lastError };
}

function buildOrderBillNumber(order = {}, billedAt = new Date().toISOString()) {
  const hotelPart = normalizeBillNumberPart(
    order.hotel_slug || order.hotel_name,
    "HOTEL",
    18
  );
  const datePart = String(billedAt || new Date().toISOString())
    .slice(0, 10)
    .replace(/[^0-9]/g, "");
  const orderIdPart = String(order.id || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(-8);

  return [
    "BILL",
    hotelPart,
    datePart || "DATE",
    orderIdPart || "ORDER"
  ].join("-");
}

function buildOrderBillingUpdatePayload(body = {}) {
  const updatePayload = {};
  const updatedAt = new Date().toISOString();

  if (body.billingStatus !== undefined) {
    const billingStatus = normalizeStatusValue(body.billingStatus);

    if (!ORDER_BILLING_STATUSES.includes(billingStatus)) {
      return {
        error: `Billing status must be one of: ${ORDER_BILLING_STATUSES.join(", ")}`
      };
    }

    updatePayload.billing_status = billingStatus;

    if (billingStatus === "billed") {
      updatePayload.billed_at = updatedAt;
    } else if (billingStatus === "not_billed") {
      updatePayload.billed_at = null;
    }
  }

  if (body.paymentStatus !== undefined) {
    const paymentStatus = normalizeStatusValue(body.paymentStatus);

    if (!ORDER_PAYMENT_STATUSES.includes(paymentStatus)) {
      return {
        error: `Payment status must be one of: ${ORDER_PAYMENT_STATUSES.join(", ")}`
      };
    }

    updatePayload.payment_status = paymentStatus;

    if (paymentStatus === "paid") {
      updatePayload.paid_at = updatedAt;
    } else if (paymentStatus === "unpaid") {
      updatePayload.paid_at = null;
    }
  }

  if (!Object.keys(updatePayload).length) {
    return {
      error: "Billing status or payment status is required"
    };
  }

  return { updatePayload };
}

function isMissingOrderBillingColumnsError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();
  const billingColumns = [
    "payment_status",
    "billing_status",
    "bill_number",
    "billed_at",
    "paid_at"
  ];

  return (
    code === "PGRST204" ||
    (
      details.includes("could not find") &&
      billingColumns.some((columnName) => details.includes(columnName))
    )
  );
}

function buildNotificationSettingsResponse(settingsRow, hotelSlug = "") {
  return {
    hotelSlug: settingsRow?.hotel_slug || String(hotelSlug || "").trim(),
    emailEnabled: !!settingsRow?.email_enabled,
    ownerEmail: settingsRow?.owner_email || "",
    notifyOnNewOrder:
      settingsRow?.notify_on_new_order !== undefined
        ? !!settingsRow.notify_on_new_order
        : true,
    notifyOnNewReservation:
      settingsRow?.notify_on_new_reservation !== undefined
        ? !!settingsRow.notify_on_new_reservation
        : true,
    notifyOnNewInquiry:
      settingsRow?.notify_on_new_inquiry !== undefined
        ? !!settingsRow.notify_on_new_inquiry
      : true
  };
}

function isMissingPaymentRouteSettingsTableError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();

  return (
    code === "42P01" ||
    code === "PGRST205" ||
    details.includes("hotel_payment_route_settings")
  );
}

function buildPaymentRouteSettingsResponse(settingsRow, hotelSlug = "") {
  return {
    hotelSlug: settingsRow?.hotel_slug || String(hotelSlug || "").trim(),
    provider: settingsRow?.provider || "razorpay",
    routeEnabled: !!settingsRow?.route_enabled,
    razorpayLinkedAccountId: settingsRow?.razorpay_linked_account_id || ""
  };
}

function buildOrderingSettingsResponse(settingsRow, hotelSlug = "", options = {}) {
  const settings = buildHotelOrderingSettings(settingsRow, hotelSlug, options);

  return {
    hotelSlug: settings.hotelSlug,
    customerOrderingEnabled: settings.customerOrderingEnabled,
    staffOrderingEnabled: settings.staffOrderingEnabled,
    whatsappOrderingEnabled: settings.whatsappOrderingEnabled,
    secureOnlinePaymentEnabled: settings.secureOnlinePaymentEnabled,
    cashOnDeliveryEnabled: settings.cashOnDeliveryEnabled,
    manualUpiPaymentEnabled: settings.manualUpiPaymentEnabled,
    disabledTitle: settings.disabledTitle,
    disabledMessage: settings.disabledMessage,
    disabledButtonText: settings.disabledButtonText,
    disabledButtonLink: settings.disabledButtonLink,
    disabledIcon: settings.disabledIcon
  };
}

function normalizeAdminPopupLink(value = "") {
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

function normalizePopupTimestamp(value = "") {
  const candidate = normalizePublicText(value, 80);
  return candidate || null;
}

function normalizeComboDateValue(value = "") {
  const candidate = normalizePublicText(value, 20);
  return candidate || null;
}

function normalizeComboTimeValue(value = "") {
  const candidate = normalizePublicText(value, 10);
  return candidate || null;
}

function getMenuComboLookupKey(hotelSlug = "", itemId = "") {
  return `${String(hotelSlug || "").trim()}::${String(itemId || "").trim()}`;
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = Number(statusCode || 500);
  return error;
}

function buildAdminMenuComboResponse(
  menuItemRow = {},
  comboChildRows = [],
  comboSettingsRow = null,
  childMenuItemMap = new Map()
) {
  const childItems = (Array.isArray(comboChildRows) ? comboChildRows : []).map((comboChildRow) => {
    const childMenuItem = childMenuItemMap.get(
      getMenuComboLookupKey(comboChildRow.hotel_slug, comboChildRow.child_item_id)
    );

    return {
      childItemId: comboChildRow.child_item_id || "",
      quantity: Number(comboChildRow.quantity || 1),
      sortOrder: Number(comboChildRow.sort_order || 0),
      childName: childMenuItem?.name || "",
      childPrice: Number(childMenuItem?.price || 0),
      childCategory: childMenuItem?.category || "",
      childImage: childMenuItem?.image || "",
      childIsAvailable: childMenuItem?.is_available !== false
    };
  });

  const originalPrice = childItems.reduce(
    (total, childItem) => total + Number(childItem.childPrice || 0) * Number(childItem.quantity || 0),
    0
  );
  const comboPrice = Number(menuItemRow.price || 0);

  return {
    id: menuItemRow.id,
    hotelSlug: menuItemRow.hotel_slug || "",
    category: menuItemRow.category || "",
    itemId: menuItemRow.item_id || "",
    itemType: menuItemRow.item_type || "combo",
    name: menuItemRow.name || "",
    description: menuItemRow.description || "",
    price: comboPrice,
    originalPrice,
    savings: Math.max(0, originalPrice - comboPrice),
    image: menuItemRow.image || "",
    alt: menuItemRow.alt || menuItemRow.name || "",
    badge: menuItemRow.badge || "",
    tag: menuItemRow.tag || "",
    isAvailable: menuItemRow.is_available !== false,
    isArchived: menuItemRow.is_archived === true,
    sortOrder: Number(menuItemRow.sort_order || 0),
    startDate: comboSettingsRow?.start_date || "",
    endDate: comboSettingsRow?.end_date || "",
    startTime: comboSettingsRow?.start_time || "",
    endTime: comboSettingsRow?.end_time || "",
    childItems,
    createdAt: menuItemRow.created_at || "",
    updatedAt: menuItemRow.updated_at || ""
  };
}

async function fetchValidatedComboChildMenuItems({ hotelSlug, childItems = [] }) {
  const normalizedHotelSlug = normalizePublicText(hotelSlug, 120);
  const normalizedChildItems = Array.isArray(childItems)
    ? childItems.map((childItem) => ({
        childItemId: normalizePublicText(childItem?.childItemId || "", 120),
        quantity: Number(childItem?.quantity || 1),
        sortOrder: Number(childItem?.sortOrder || 0)
      }))
    : [];

  if (!normalizedHotelSlug) {
    throw createHttpError(400, "Hotel slug is required");
  }

  if (!normalizedChildItems.length) {
    throw createHttpError(400, "At least one child menu item is required");
  }

  const childItemIds = [...new Set(normalizedChildItems.map((childItem) => childItem.childItemId))];
  const { data, error } = await supabase
    .from("menu_items")
    .select("hotel_slug,item_id,name,price,category,image,item_type,is_available,is_archived")
    .eq("hotel_slug", normalizedHotelSlug)
    .in("item_id", childItemIds);

  if (error) {
    throw error;
  }

  const menuItemsById = new Map((data || []).map((menuItem) => [menuItem.item_id, menuItem]));

  for (const childItem of normalizedChildItems) {
    const matchedMenuItem = menuItemsById.get(childItem.childItemId);

    if (!matchedMenuItem) {
      throw createHttpError(
        400,
        `Child menu item "${childItem.childItemId}" was not found in hotel "${normalizedHotelSlug}"`
      );
    }

    if (matchedMenuItem.is_archived === true) {
      throw createHttpError(
        400,
        `Child menu item "${childItem.childItemId}" is archived and cannot be used in a combo`
      );
    }

    if ((matchedMenuItem.item_type || "single") === "combo") {
      throw createHttpError(
        400,
        `Nested combos are not supported yet. "${childItem.childItemId}" is already a combo item`
      );
    }
  }

  return normalizedChildItems;
}

async function replaceMenuComboChildren({ hotelSlug, comboItemId, childItems = [] }) {
  const normalizedHotelSlug = normalizePublicText(hotelSlug, 120);
  const normalizedComboItemId = normalizePublicText(comboItemId, 120);

  const deleteResponse = await supabase
    .from("menu_combo_items")
    .delete()
    .eq("hotel_slug", normalizedHotelSlug)
    .eq("combo_item_id", normalizedComboItemId);

  if (deleteResponse.error) {
    throw deleteResponse.error;
  }

  const normalizedChildItems = await fetchValidatedComboChildMenuItems({
    hotelSlug: normalizedHotelSlug,
    childItems
  });

  const { error } = await supabase.from("menu_combo_items").insert(
    normalizedChildItems.map((childItem) => ({
      hotel_slug: normalizedHotelSlug,
      combo_item_id: normalizedComboItemId,
      child_item_id: childItem.childItemId,
      quantity: Number(childItem.quantity || 1),
      sort_order: Number(childItem.sortOrder || 0),
      updated_at: new Date().toISOString()
    }))
  );

  if (error) {
    throw error;
  }
}

async function syncMenuComboSettings({
  hotelSlug,
  comboItemId,
  startDate,
  endDate,
  startTime,
  endTime
}) {
  const normalizedHotelSlug = normalizePublicText(hotelSlug, 120);
  const normalizedComboItemId = normalizePublicText(comboItemId, 120);
  const normalizedSettingsPayload = {
    hotel_slug: normalizedHotelSlug,
    combo_item_id: normalizedComboItemId,
    start_date: normalizeComboDateValue(startDate),
    end_date: normalizeComboDateValue(endDate),
    start_time: normalizeComboTimeValue(startTime),
    end_time: normalizeComboTimeValue(endTime),
    updated_at: new Date().toISOString()
  };
  const hasActiveWindow = [
    normalizedSettingsPayload.start_date,
    normalizedSettingsPayload.end_date,
    normalizedSettingsPayload.start_time,
    normalizedSettingsPayload.end_time
  ].some(Boolean);

  if (!hasActiveWindow) {
    const { error } = await supabase
      .from("menu_combo_settings")
      .delete()
      .eq("hotel_slug", normalizedHotelSlug)
      .eq("combo_item_id", normalizedComboItemId);

    if (error) {
      throw error;
    }

    return null;
  }

  const { data, error } = await supabase
    .from("menu_combo_settings")
    .upsert([normalizedSettingsPayload], { onConflict: "hotel_slug,combo_item_id" })
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function getAdminMenuComboByDbId(id) {
  const { data: comboRow, error: comboError } = await supabase
    .from("menu_items")
    .select("*")
    .eq("id", id)
    .eq("item_type", "combo")
    .maybeSingle();

  if (comboError) {
    throw comboError;
  }

  if (!comboRow) {
    return null;
  }

  const comboLookupKey = getMenuComboLookupKey(comboRow.hotel_slug, comboRow.item_id);
  const { data: comboChildRows, error: comboChildrenError } = await supabase
    .from("menu_combo_items")
    .select("*")
    .eq("hotel_slug", comboRow.hotel_slug)
    .eq("combo_item_id", comboRow.item_id)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (comboChildrenError) {
    throw comboChildrenError;
  }

  const { data: comboSettingsRow, error: comboSettingsError } = await supabase
    .from("menu_combo_settings")
    .select("*")
    .eq("hotel_slug", comboRow.hotel_slug)
    .eq("combo_item_id", comboRow.item_id)
    .maybeSingle();

  if (comboSettingsError) {
    throw comboSettingsError;
  }

  const childItemIds = [...new Set((comboChildRows || []).map((comboChildRow) => comboChildRow.child_item_id))];
  let childMenuItemMap = new Map();

  if (childItemIds.length) {
    const { data: childMenuItems, error: childMenuItemsError } = await supabase
      .from("menu_items")
      .select("hotel_slug,item_id,name,price,category,image,is_available")
      .eq("hotel_slug", comboRow.hotel_slug)
      .in("item_id", childItemIds);

    if (childMenuItemsError) {
      throw childMenuItemsError;
    }

    childMenuItemMap = new Map(
      (childMenuItems || []).map((childMenuItem) => [
        getMenuComboLookupKey(childMenuItem.hotel_slug, childMenuItem.item_id),
        childMenuItem
      ])
    );
  }

  return buildAdminMenuComboResponse(
    comboRow,
    comboChildRows || [],
    comboSettingsRow,
    childMenuItemMap
  );
}

function buildHotelLaunchReadinessResponse(hotelRow = {}) {
  const hotelId = String(hotelRow?.id || "").trim();
  const hotelSlug = normalizePublicText(hotelRow?.slug || "", 120).toLowerCase();
  const hotelName = normalizePublicText(hotelRow?.name || "", 160);
  const primaryDomain = normalizePublicHostname(hotelRow?.primary_domain || "");
  const subdomain = normalizePublicText(hotelRow?.subdomain || "", 120).toLowerCase();
  const trustedParentHosts = getTrustedPublicSubdomainParentHosts();
  const recommendedSharedSubdomainHost =
    subdomain && trustedParentHosts.length
      ? `${subdomain}.${trustedParentHosts[0]}`
      : "";
  const isActive = hotelRow?.is_active === true;
  const hasRoutingTarget = !!(primaryDomain || subdomain);
  const exactPrimaryReady = !!(hotelSlug && primaryDomain && isActive);
  const sharedSubdomainReady = !!(
    hotelSlug &&
    subdomain &&
    trustedParentHosts.length &&
    isActive
  );
  const warnings = [];

  if (!hotelSlug) {
    warnings.push("Hotel slug is missing.");
  }

  if (!isActive) {
    warnings.push("Hotel is inactive, so public tenant routing should stay unavailable.");
  }

  if (!hasRoutingTarget) {
    warnings.push("No primary domain or subdomain is saved yet.");
  }

  if (subdomain && !trustedParentHosts.length) {
    warnings.push(
      "Subdomain is saved, but FRONTEND_URL / FRONTEND_ORIGINS do not currently expose a trusted shared public parent host."
    );
  }

  return {
    hotelId,
    hotelSlug,
    hotelName,
    isActive,
    saved: {
      primaryDomain,
      subdomain
    },
    trustedSharedParentHosts: trustedParentHosts,
    resolveTargets: {
      primaryDomainHost: primaryDomain,
      recommendedSharedSubdomainHost
    },
    checks: {
      hasHotelSlug: !!hotelSlug,
      hasPrimaryDomain: !!primaryDomain,
      hasSubdomain: !!subdomain,
      sharedSubdomainHostConfigured: trustedParentHosts.length > 0,
      hasRoutingTarget,
      exactPrimaryReady,
      sharedSubdomainReady
    },
    warnings
  };
}

async function applyValidatedHotelDomainSettings({
  hotelId = "",
  primaryDomain = undefined,
  subdomain = undefined,
  updatePayload = {}
} = {}) {
  if (primaryDomain === undefined && subdomain === undefined) {
    return {
      ok: true,
      updatePayload
    };
  }

  const validation = validateHotelDomainSettings({
    primaryDomain,
    subdomain
  });

  if (!validation.ok) {
    return {
      ok: false,
      status: 400,
      message: validation.message
    };
  }

  const conflict = await findHotelDomainConflict(supabase, {
    hotelId,
    primaryDomain: validation.values.primaryDomain,
    subdomain: validation.values.subdomain
  });

  if (conflict) {
    return {
      ok: false,
      status: 409,
      message: conflict.message
    };
  }

  if (validation.values.primaryDomain !== undefined) {
    updatePayload.primary_domain = validation.values.primaryDomain;
  }

  if (validation.values.subdomain !== undefined) {
    updatePayload.subdomain = validation.values.subdomain;
  }

  return {
    ok: true,
    updatePayload
  };
}

function buildMenuCategoryWritePayload(body = {}, existing = {}) {
  const payload = {};
  const assign = (inputKey, column, transform = (value) => value) => {
    if (body[inputKey] !== undefined) payload[column] = transform(body[inputKey]);
  };
  assign("hotelSlug", "hotel_slug", (value) => normalizeMenuCategoryText(value, 120));
  assign("categoryKey", "category_key", normalizeMenuCategoryKey);
  assign("name", "name", (value) => normalizeMenuCategoryText(value, 160));
  assign("slug", "slug", (value) => createMenuCategorySlug(value));
  assign("description", "description", (value) => normalizeMenuCategoryText(value, 1000));
  assign("displayOrder", "display_order", (value) => Number(value || 0));
  assign("isActive", "is_active", Boolean);
  assign("isPublished", "is_published", Boolean);
  assign("staffEnabled", "staff_enabled", Boolean);
  assign("websiteEnabled", "website_enabled", Boolean);
  assign("qrEnabled", "qr_enabled", Boolean);
  assign("defaultImageUrl", "default_image_url", (value) => normalizeMenuCategoryText(value, 2000) || null);
  assign("defaultThumbnailUrl", "default_thumbnail_url", (value) => normalizeMenuCategoryText(value, 2000) || null);
  assign("imageStoragePath", "image_storage_path", (value) => normalizeMenuCategoryText(value, 500) || null);
  assign("imageAltText", "image_alt_text", (value) => normalizeMenuCategoryText(value, 300));
  const imageChanged = ["defaultImageUrl", "defaultThumbnailUrl", "imageStoragePath"].some(
    (key) => body[key] !== undefined
  );
  if (imageChanged) payload.image_version = Number(existing.image_version || 0) + 1;
  payload.updated_at = new Date().toISOString();
  return payload;
}

async function assertMenuCategoryImageScope(hotelSlug, body = {}) {
  const storagePath = normalizeMenuCategoryText(body.imageStoragePath, 500).toLowerCase();
  const hasRemoteImage = [body.defaultImageUrl, body.defaultThumbnailUrl].some((value) =>
    /^https?:\/\//i.test(String(value || "").trim())
  );
  if (storagePath) {
    const propertyScope = await resolvePropertyStorageScope(supabase, hotelSlug);
    if (!isPropertyStoragePath(storagePath, propertyScope, { allowLegacy: true })) {
      throw createHttpError(400, "Category image storage path does not belong to this hotel");
    }
  }
  if (hasRemoteImage && !storagePath) {
    throw createHttpError(400, "Uploaded category images require a hotel-scoped storage path");
  }
}

async function ensureAdminMenuCategoryBelongsToHotel(hotelSlug, categoryKey) {
  const normalizedHotelSlug = normalizeMenuCategoryText(hotelSlug, 120);
  const normalizedCategoryKey = normalizeMenuCategoryKey(categoryKey);
  if (!normalizedHotelSlug || !normalizedCategoryKey) {
    throw createHttpError(400, "A valid hotel-scoped menu category is required");
  }
  const { data, error } = await supabase
    .from("menu_categories")
    .select("id,hotel_slug,category_key,is_active")
    .eq("hotel_slug", normalizedHotelSlug)
    .eq("category_key", normalizedCategoryKey)
    .maybeSingle();
  if (error) {
    if (isMissingMenuCategoriesSchemaError(error)) return null;
    throw error;
  }
  if (!data) {
    throw createHttpError(400, "The selected menu category does not belong to this hotel");
  }
  return data;
}

async function writeMenuCategoryAudit({ action, before = null, after = null }) {
  const row = after || before || {};
  const { error } = await supabase.from("menu_category_audit").insert([{
    hotel_slug: row.hotel_slug,
    category_id: row.id,
    action,
    actor: "admin",
    before_data: before,
    after_data: after
  }]);
  if (error && !isMissingMenuCategoriesSchemaError(error)) {
    console.warn("Menu category audit write failed:", error.message || error);
  }
}

router.use(requireAdminAuth);

router.post("/qr-links/sign", validateBody(qrLinkSignatureSchema), requireAdminFoodModule, async (req, res) => {
  try {
    const {
      hotelSlug,
      tableNumber,
      orderSource = "qr"
    } = req.validatedBody;

    const qrContextToken = buildQrContextToken({
      hotelSlug,
      tableNumber,
      orderSource,
      orderType: "dine-in"
    });

    res.json({
      success: true,
      qrContextToken,
      context: {
        hotelSlug,
        tableNumber,
        orderSource: orderSource || "qr",
        orderType: "dine-in"
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to sign QR link"
    });
  }
});
/* ─────────────────────────────────────────────
   GET /api/admin/orders
   Optional query: ?hotelName=Hotel Example
   ───────────────────────────────────────────── */
router.get("/orders", async (req, res) => {
  try {
    const { hotelName, hotelSlug } = req.query;

    let query = supabase
      .from("orders")
      .select("*")
      .order("created_at", { ascending: false });

    if (hotelSlug) {
      query = query.eq("hotel_slug", hotelSlug);
    } else if (hotelName) {
      query = query.eq("hotel_name", hotelName);
    }

    const { data, error } = await query;

    if (error) throw error;

    const safeOrders = data || [];
    const staffById = await getOrderCreatedByStaffMap(supabase, safeOrders);

    res.json({
      success: true,
      count: safeOrders.length,
      orders: safeOrders.map((order) => buildAdminOrderResponse(order, staffById))
    });
  } catch (error) {
    console.error("Admin orders fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch orders"
    });
  }
});

/* ─────────────────────────────────────────────
   GET /api/admin/inquiries
   Optional query: ?hotelName=Hotel Example
   ───────────────────────────────────────────── */
router.get("/inquiries", async (req, res) => {
  try {
    const { hotelName } = req.query;

    let query = supabase
      .from("inquiries")
      .select("*")
      .order("created_at", { ascending: false });

    if (hotelName) {
      query = query.eq("hotel_name", hotelName);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json({
      success: true,
      count: data.length,
      inquiries: data
    });
  } catch (error) {
    console.error("Admin inquiries fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch inquiries"
    });
  }
});

/* ─────────────────────────────────────────────
   GET /api/admin/reservations
   Optional query: ?hotelName=Hotel Example
   ───────────────────────────────────────────── */
router.get("/reservations", async (req, res) => {
  try {
    const { hotelName, hotelSlug } = req.query;

    let query = supabase
      .from("reservations")
      .select("*")
      .order("created_at", { ascending: false });

    if (hotelSlug) {
      query = query.eq("hotel_slug", hotelSlug);
    } else if (hotelName) {
      query = query.eq("hotel_name", hotelName);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json({
      success: true,
      count: data.length,
      reservations: data
    });
  } catch (error) {
    console.error("Admin reservations fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch reservations"
    });
  }
});

router.get("/contact-submissions", async (req, res) => {
  try {
    const { hotelName, hotelSlug } = req.query;

    let query = supabase
      .from("contact_submissions")
      .select("*")
      .order("created_at", { ascending: false });

    if (hotelSlug) {
      query = query.eq("hotel_slug", String(hotelSlug).trim());
    } else if (hotelName) {
      query = query.eq("hotel_name", String(hotelName).trim());
    }

    const { data, error } = await query;

    if (error) {
      if (isMissingContactSubmissionsRelationError(error)) {
        return res.json({
          success: true,
          count: 0,
          contactSubmissions: []
        });
      }

      throw error;
    }

    res.json({
      success: true,
      count: Array.isArray(data) ? data.length : 0,
      contactSubmissions: data || []
    });
  } catch (error) {
    console.error("Admin contact submissions fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch contact submissions"
    });
  }
});

router.get("/notification-events", async (req, res) => {
  try {
    const { hotelSlug, sourceType, status } = req.query;
    const limit = getNotificationEventsLimit(req.query.limit);

    let query = supabase
      .from("notification_events")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (hotelSlug) {
      query = query.eq("hotel_slug", String(hotelSlug).trim());
    }

    if (
      sourceType &&
      NOTIFICATION_EVENT_SOURCE_TYPES.includes(
        String(sourceType).trim().toLowerCase()
      )
    ) {
      query = query.eq("source_type", String(sourceType).trim().toLowerCase());
    }

    if (
      status &&
      NOTIFICATION_EVENT_STATUSES.includes(String(status).trim().toLowerCase())
    ) {
      query = query.eq("status", String(status).trim().toLowerCase());
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json({
      success: true,
      count: data.length,
      notificationEvents: data,
      notificationEventMaxRetries: NOTIFICATION_EVENT_MAX_RETRIES
    });
  } catch (error) {
    console.error("Notification events fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch notification events"
    });
  }
});

router.post("/notification-events/:id/resend", async (req, res) => {
  try {
    const notificationEventId = String(req.params.id || "").trim();

    if (!notificationEventId) {
      return res.status(400).json({
        success: false,
        message: "Notification event id is required"
      });
    }

    const { data: notificationEvent, error } = await supabase
      .from("notification_events")
      .select("*")
      .eq("id", notificationEventId)
      .maybeSingle();

    if (error) throw error;

    if (!notificationEvent) {
      return res.status(404).json({
        success: false,
        message: "Notification event not found"
      });
    }

    const currentStatus = String(notificationEvent.status || "")
      .trim()
      .toLowerCase();

    if (!["failed", "skipped"].includes(currentStatus)) {
      return res.status(400).json({
        success: false,
        message: "Only failed or skipped notification events can be resent"
      });
    }

    const currentRetryCount = Number.parseInt(
      String(notificationEvent.retry_count ?? "0"),
      10
    );
    const safeRetryCount =
      Number.isFinite(currentRetryCount) && currentRetryCount >= 0
        ? currentRetryCount
        : 0;

    if (safeRetryCount >= NOTIFICATION_EVENT_MAX_RETRIES) {
      return res.status(400).json({
        success: false,
        message: `Maximum resend attempts reached (${NOTIFICATION_EVENT_MAX_RETRIES})`
      });
    }

    const nextRetryCount = safeRetryCount + 1;
    const lastRetryAt = new Date().toISOString();

    const { error: prepareRetryError } = await supabase
      .from("notification_events")
      .update({
        status: "pending",
        error_message: null,
        processed_at: null,
        retry_count: nextRetryCount,
        last_retry_at: lastRetryAt,
        updated_at: lastRetryAt
      })
      .eq("id", notificationEventId);

    if (prepareRetryError) throw prepareRetryError;

    const processedEvent = await processNotificationEventDeliverySafely({
      ...notificationEvent,
      status: "pending",
      error_message: null,
      processed_at: null,
      retry_count: nextRetryCount,
      last_retry_at: lastRetryAt
    });

    if (processedEvent) {
      return res.json({
        success: true,
        message: `Notification resend processed (attempt ${nextRetryCount}/${NOTIFICATION_EVENT_MAX_RETRIES})`,
        notificationEventMaxRetries: NOTIFICATION_EVENT_MAX_RETRIES,
        notificationEvent: processedEvent
      });
    }

    const { data: latestNotificationEvent, error: latestError } = await supabase
      .from("notification_events")
      .select("*")
      .eq("id", notificationEventId)
      .maybeSingle();

    if (latestError) throw latestError;

    return res.json({
      success: true,
      message: `Notification resend attempted (attempt ${nextRetryCount}/${NOTIFICATION_EVENT_MAX_RETRIES})`,
      notificationEventMaxRetries: NOTIFICATION_EVENT_MAX_RETRIES,
      notificationEvent: latestNotificationEvent || null
    });
  } catch (error) {
    console.error("Notification resend error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to resend notification event"
    });
  }
});

router.get("/notification-settings/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();

    if (!slug) {
      return res.status(400).json({
        success: false,
        message: "Hotel slug is required"
      });
    }

    const { data, error } = await supabase
      .from("hotel_notification_settings")
      .select("*")
      .eq("hotel_slug", slug)
      .maybeSingle();

    if (error) throw error;

    res.json({
      success: true,
      settings: buildNotificationSettingsResponse(data, slug)
    });
  } catch (error) {
    console.error("Notification settings fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch notification settings"
    });
  }
});

router.get("/payment-route-settings/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();

    if (!slug) {
      return res.status(400).json({
        success: false,
        message: "Hotel slug is required"
      });
    }

    const { data, error } = await supabase
      .from("hotel_payment_route_settings")
      .select("*")
      .eq("hotel_slug", slug)
      .maybeSingle();

    if (error) {
      if (isMissingPaymentRouteSettingsTableError(error)) {
        return res.json({
          success: true,
          schemaReady: false,
          message: "Payment Route settings table is not initialized yet",
          settings: buildPaymentRouteSettingsResponse(null, slug)
        });
      }

      throw error;
    }

    res.json({
      success: true,
      schemaReady: true,
      settings: buildPaymentRouteSettingsResponse(data, slug)
    });
  } catch (error) {
    console.error("Payment Route settings fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch payment Route settings"
    });
  }
});

router.get("/ordering-settings/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();

    if (!slug) {
      return res.status(400).json({
        success: false,
        message: "Hotel slug is required"
      });
    }

    const { data, error } = await supabase
      .from("hotel_ordering_settings")
      .select("*")
      .eq("hotel_slug", slug)
      .maybeSingle();

    if (error) {
      if (isMissingHotelOrderingSettingsTableError(error)) {
        return res.json({
          success: true,
          schemaReady: false,
          message: "Ordering settings table is not initialized yet",
          settings: buildOrderingSettingsResponse(null, slug, {
            schemaReady: false
          })
        });
      }

      throw error;
    }

    res.json({
      success: true,
      schemaReady: true,
      settings: buildOrderingSettingsResponse(data, slug)
    });
  } catch (error) {
    console.error("Ordering settings fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch ordering settings"
    });
  }
});


router.get("/hotels", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("hotels")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      count: data.length,
      hotels: data
    });
  } catch (error) {
    console.error("Admin hotels fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch hotels"
    });
  }
});


router.patch("/orders/:id/status", requireAdminFoodModule, async (req, res) => {
  try {
    const { id } = req.params;
    const status = getAllowedStatus(req.body?.status, ORDER_STATUSES);

    if (!status) {
      return res.status(400).json({
        success: false,
        message: `Status must be one of: ${ORDER_STATUSES.join(", ")}`
      });
    }
    const lifecycleUpdate = {
      status,
      kitchen_status: {
        new: "new",
        confirmed: "accepted",
        preparing: "preparing",
        completed: "served",
        cancelled: "cancelled"
      }[status]
    };


    const { data, error } = await supabase
      .from("orders")
      .update(lifecycleUpdate)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: "Order status updated",
      order: data
    });
  } catch (error) {
    console.error("Order status update error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update order status"
    });
  }
});

router.get("/hotels/:id/launch-readiness", async (req, res) => {
  try {
    const hotelId = String(req.params.id || "").trim();

    if (!hotelId) {
      return res.status(400).json({
        success: false,
        message: "Hotel id is required"
      });
    }

    const { data, error } = await supabase
      .from("hotels")
      .select("id,slug,name,primary_domain,subdomain,is_active")
      .eq("id", hotelId)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        success: false,
        message: "Hotel not found"
      });
    }

    res.json({
      success: true,
      readiness: buildHotelLaunchReadinessResponse(data)
    });
  } catch (error) {
    console.error("Hotel launch readiness fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch hotel launch readiness"
    });
  }
});

router.patch("/orders/:id/billing", requireAdminFoodModule, async (req, res) => {
  try {
    const { id } = req.params;
    const { updatePayload, error: validationError } = buildOrderBillingUpdatePayload(req.body);

    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError
      });
    }

    if (updatePayload.billing_status === "billed") {
      const { data: currentOrder, error: currentOrderError } = await supabase
        .from("orders")
        .select("id,hotel_slug,hotel_name,bill_number")
        .eq("id", id)
        .maybeSingle();

      if (currentOrderError) {
        if (isMissingOrderBillingColumnsError(currentOrderError)) {
          return res.status(400).json({
            success: false,
            message: "Order billing fields are not initialized yet"
          });
        }

        throw currentOrderError;
      }

      if (!currentOrder) {
        return res.status(404).json({
          success: false,
          message: "Order not found"
        });
      }

      if (!currentOrder.bill_number) {
        updatePayload.bill_number = buildOrderBillNumber(
          currentOrder,
          updatePayload.billed_at
        );
      }
    }

    const { data, error } = await supabase
      .from("orders")
      .update(updatePayload)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      if (isMissingOrderBillingColumnsError(error)) {
        return res.status(400).json({
          success: false,
          message: "Order billing fields are not initialized yet"
        });
      }

      throw error;
    }

    res.json({
      success: true,
      message: "Order billing updated",
      order: data
    });
  } catch (error) {
    console.error("Order billing update error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update order billing"
    });
  }
});

router.patch("/inquiries/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const status = getAllowedStatus(req.body?.status, INQUIRY_STATUSES);

    if (!status) {
      return res.status(400).json({
        success: false,
        message: `Status must be one of: ${INQUIRY_STATUSES.join(", ")}`
      });
    }

    const { data, error } = await supabase
      .from("inquiries")
      .update({ status })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: "Inquiry status updated",
      inquiry: data
    });
  } catch (error) {
    console.error("Inquiry status update error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update inquiry status"
    });
  }
});

router.patch("/reservations/:id/status", requireAdminFoodModule, async (req, res) => {
  try {
    const { id } = req.params;
    const status = getAllowedStatus(req.body?.status, RESERVATION_STATUSES);

    if (!status) {
      return res.status(400).json({
        success: false,
        message: `Status must be one of: ${RESERVATION_STATUSES.join(", ")}`
      });
    }

    const { data, error } = await supabase
      .from("reservations")
      .update({ status })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: "Reservation status updated",
      reservation: data
    });
  } catch (error) {
    console.error("Reservation status update error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update reservation status"
    });
  }
});

router.patch("/hotels/:id/domain", validateBody(hotelDomainSettingsSchema), async (req, res) => {
  try {
    const { id } = req.params;
    const { primaryDomain, subdomain, isActive } = req.validatedBody;

    const updatePayload = {};
    const domainSettingsResult = await applyValidatedHotelDomainSettings({
      hotelId: id,
      primaryDomain,
      subdomain,
      updatePayload
    });

    if (!domainSettingsResult.ok) {
      return res.status(domainSettingsResult.status).json({
        success: false,
        message: domainSettingsResult.message
      });
    }

    if (isActive !== undefined) {
      updatePayload.is_active = !!isActive;
    }

    if (!Object.keys(updatePayload).length) {
      return res.status(400).json({
        success: false,
        message: "At least one domain setting is required"
      });
    }

    const { data, error } = await supabase
      .from("hotels")
      .update(updatePayload)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: "Hotel domain settings updated",
      hotel: data
    });
  } catch (error) {
    console.error("Hotel domain update error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update hotel domain settings"
    });
  }
});

router.post("/hotels", validateBody(hotelSchema), async (req, res) => {
  try {
    const {
      slug,
      name,
      whatsappNumber,
      upiId,
      gstPercent,
      primaryDomain,
      subdomain,
      isActive
    } = req.validatedBody;
    const insertPayload = {
      slug,
      name,
      whatsapp_number: whatsappNumber || null,
      upi_id: upiId || null,
      gst_percent: gstPercent ?? 5,
      is_active: isActive !== undefined ? !!isActive : true
    };
    const domainSettingsResult = await applyValidatedHotelDomainSettings({
      primaryDomain,
      subdomain,
      updatePayload: insertPayload
    });

    if (!domainSettingsResult.ok) {
      return res.status(domainSettingsResult.status).json({
        success: false,
        message: domainSettingsResult.message
      });
    }

    const { data, error } = await supabase
      .from("hotels")
      .insert([domainSettingsResult.updatePayload])
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({
      success: true,
      message: "Hotel created successfully",
      hotel: data
    });
  } catch (error) {
    console.error("Hotel create error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create hotel"
    });
  }
});

router.patch("/hotels/:id", validateBody(partialHotelSchema), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      slug,
      name,
      whatsappNumber,
      upiId,
      gstPercent,
      primaryDomain,
      subdomain,
      isActive
    } = req.validatedBody;

    const updatePayload = {};

    if (slug !== undefined) updatePayload.slug = slug;
    if (name !== undefined) updatePayload.name = name;
    if (whatsappNumber !== undefined) updatePayload.whatsapp_number = whatsappNumber || null;
    if (upiId !== undefined) updatePayload.upi_id = upiId || null;
    if (gstPercent !== undefined) updatePayload.gst_percent = gstPercent;
    const domainSettingsResult = await applyValidatedHotelDomainSettings({
      hotelId: id,
      primaryDomain,
      subdomain,
      updatePayload
    });

    if (!domainSettingsResult.ok) {
      return res.status(domainSettingsResult.status).json({
        success: false,
        message: domainSettingsResult.message
      });
    }

    if (isActive !== undefined) updatePayload.is_active = !!isActive;

    if (!Object.keys(updatePayload).length) {
      return res.status(400).json({
        success: false,
        message: "At least one hotel field is required"
      });
    }

    const { data, error } = await supabase
      .from("hotels")
      .update(updatePayload)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: "Hotel updated successfully",
      hotel: data
    });
  } catch (error) {
    console.error("Hotel update error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update hotel"
    });
  }
});

router.post("/hotel-profiles", validateBody(hotelProfileSchema), async (req, res) => {
  try {
    const {
      hotelSlug,
      hotelName,
      tagline,
      ownerWhatsAppNumber,
      ownerUpiId,
      gstPercent,
      contact,
      branding,
      theme,
      hero,
      about,
      features,
      events,
      reservation,
      contactSection,
      location,
      footer,
      social
    } = req.validatedBody;

    const { data, error } = await supabase
      .from("hotel_profiles")
      .upsert(
        [
          {
            hotel_slug: hotelSlug,
            hotel_name: hotelName,
            tagline: tagline || "",
            owner_whatsapp_number: ownerWhatsAppNumber || "",
            owner_upi_id: ownerUpiId || "",
            gst_percent: gstPercent ?? 5,
            contact: contact || {},
            branding: branding || {},
            theme: theme || {},
            hero: hero || {},
            about: about || {},
            features: features || [],
            events: events || {},
            reservation: reservation || {},
            contact_section: contactSection || {},
            location: location || {},
            footer: footer || {},
            social: social || {},
            updated_at: new Date().toISOString()
          }
        ],
        { onConflict: "hotel_slug" }
      )
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: "Hotel profile saved successfully",
      profile: data
    });
  } catch (error) {
    console.error("Hotel profile save error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to save hotel profile"
    });
  }
});

router.patch("/contact-submissions/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const status = getAllowedStatus(req.body?.status, CONTACT_SUBMISSION_STATUSES);

    if (!status) {
      return res.status(400).json({
        success: false,
        message: `Status must be one of: ${CONTACT_SUBMISSION_STATUSES.join(", ")}`
      });
    }

    const { data, error } = await supabase
      .from("contact_submissions")
      .update({
        status,
        updated_at: new Date().toISOString()
      })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      if (isMissingContactSubmissionsRelationError(error)) {
        return res.status(400).json({
          success: false,
          message: "Contact submissions table is not initialized yet"
        });
      }

      throw error;
    }

    res.json({
      success: true,
      message: "Contact submission status updated",
      contactSubmission: data
    });
  } catch (error) {
    console.error("Contact submission status update error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update contact submission status"
    });
  }
});

router.post(
  "/notification-settings",
  validateBody(hotelNotificationSettingsSchema),
  async (req, res) => {
    try {
      const {
        hotelSlug,
        emailEnabled,
        ownerEmail,
        notifyOnNewOrder,
        notifyOnNewReservation,
        notifyOnNewInquiry
      } = req.validatedBody;

      const { data, error } = await supabase
        .from("hotel_notification_settings")
        .upsert(
          [
            {
              hotel_slug: hotelSlug,
              email_enabled: emailEnabled !== undefined ? !!emailEnabled : false,
              owner_email: ownerEmail ? String(ownerEmail).trim() : null,
              notify_on_new_order:
                notifyOnNewOrder !== undefined ? !!notifyOnNewOrder : true,
              notify_on_new_reservation:
                notifyOnNewReservation !== undefined
                  ? !!notifyOnNewReservation
                  : true,
              notify_on_new_inquiry:
                notifyOnNewInquiry !== undefined ? !!notifyOnNewInquiry : true,
              updated_at: new Date().toISOString()
            }
          ],
          { onConflict: "hotel_slug" }
        )
        .select()
        .single();

      if (error) throw error;

      res.json({
        success: true,
        message: "Notification settings saved successfully",
        settings: buildNotificationSettingsResponse(data, hotelSlug)
      });
    } catch (error) {
      console.error("Notification settings save error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to save notification settings"
      });
    }
  }
);

router.post(
  "/payment-route-settings",
  validateBody(hotelPaymentRouteSettingsSchema),
  async (req, res) => {
    try {
      const {
        hotelSlug,
        provider = "razorpay",
        routeEnabled,
        razorpayLinkedAccountId
      } = req.validatedBody;
      const linkedAccountId = String(razorpayLinkedAccountId || "").trim();

      const { data, error } = await supabase
        .from("hotel_payment_route_settings")
        .upsert(
          [
            {
              hotel_slug: hotelSlug,
              provider,
              route_enabled: routeEnabled !== undefined ? !!routeEnabled : false,
              razorpay_linked_account_id: linkedAccountId || null,
              updated_at: new Date().toISOString()
            }
          ],
          { onConflict: "hotel_slug" }
        )
        .select()
        .single();

      if (error) {
        if (isMissingPaymentRouteSettingsTableError(error)) {
          return res.status(400).json({
            success: false,
            message: "Payment Route settings table is not initialized yet"
          });
        }

        throw error;
      }

      res.json({
        success: true,
        message: "Payment Route settings saved successfully",
        settings: buildPaymentRouteSettingsResponse(data, hotelSlug)
      });
    } catch (error) {
      console.error("Payment Route settings save error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to save payment Route settings"
      });
    }
  }
);

router.post(
  "/ordering-settings",
  validateBody(hotelOrderingSettingsSchema),
  async (req, res) => {
    try {
      const {
        hotelSlug,
        customerOrderingEnabled,
        staffOrderingEnabled,
        whatsappOrderingEnabled,
        secureOnlinePaymentEnabled,
        cashOnDeliveryEnabled,
        manualUpiPaymentEnabled,
        disabledTitle,
        disabledMessage,
        disabledButtonText,
        disabledButtonLink,
        disabledIcon
      } = req.validatedBody;

      const { data, error } = await supabase
        .from("hotel_ordering_settings")
        .upsert(
          [
            {
              hotel_slug: hotelSlug,
              customer_ordering_enabled:
                customerOrderingEnabled !== undefined ? !!customerOrderingEnabled : true,
              staff_ordering_enabled:
                staffOrderingEnabled !== undefined ? !!staffOrderingEnabled : true,
              secure_online_payment_enabled:
                secureOnlinePaymentEnabled !== undefined ? !!secureOnlinePaymentEnabled : true,
              cash_on_delivery_enabled:
                cashOnDeliveryEnabled !== undefined ? !!cashOnDeliveryEnabled : true,
              manual_upi_payment_enabled:
                manualUpiPaymentEnabled !== undefined ? !!manualUpiPaymentEnabled : true,
              whatsapp_ordering_enabled:
                whatsappOrderingEnabled !== undefined ? !!whatsappOrderingEnabled : true,
              disabled_title: normalizePublicText(disabledTitle || "", 160) || null,
              disabled_message: normalizePublicText(disabledMessage || "", 1000) || null,
              disabled_button_text: normalizePublicText(disabledButtonText || "", 120) || null,
              disabled_button_link: normalizePublicText(disabledButtonLink || "", 2000) || null,
              disabled_icon: normalizePublicText(disabledIcon || "", 40) || null,
              updated_at: new Date().toISOString()
            }
          ],
          { onConflict: "hotel_slug" }
        )
        .select()
        .single();

      if (error) {
        if (isMissingHotelOrderingSettingsTableError(error)) {
          return res.status(400).json({
            success: false,
            message: "Ordering settings table is not initialized yet"
          });
        }

        throw error;
      }

      invalidateHotelOrderingSettings(hotelSlug);
      res.json({
        success: true,
        message: "Ordering settings saved successfully",
        settings: buildOrderingSettingsResponse(data, hotelSlug)
      });
    } catch (error) {
      console.error("Ordering settings save error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to save ordering settings"
      });
    }
  }
);

router.get("/hotel-profiles/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    const { data, error } = await supabase
      .from("hotel_profiles")
      .select("*")
      .eq("hotel_slug", slug)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        success: false,
        message: "Hotel profile not found"
      });
    }

    res.json({
      success: true,
      profile: data
    });
  } catch (error) {
    console.error("Hotel profile fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch hotel profile"
    });
  }
});

router.get("/menu-categories", requireAdminFoodModule, async (req, res) => {
  try {
    const hotelSlug = normalizeMenuCategoryText(req.query.hotelSlug, 120);
    if (!hotelSlug) {
      return res.status(400).json({ success: false, message: "Select a hotel to manage its menu categories" });
    }
    const { data: menuItems, error: menuItemsError } = await supabase
      .from("menu_items")
      .select("hotel_slug,category,sort_order")
      .eq("hotel_slug", hotelSlug)
      .order("sort_order", { ascending: true });
    if (menuItemsError) throw menuItemsError;
    const result = await fetchHotelMenuCategories({
      supabase,
      hotelSlug,
      consumer: "manager",
      menuItems: menuItems || []
    });
    res.json({
      success: true,
      hotelSlug,
      source: result.source,
      categories: result.categories.map((category) => buildMenuCategoryDto(
        category,
        (menuItems || []).filter((item) => item.category === category.category_key).length
      ))
    });
  } catch (error) {
    console.error("Menu categories fetch error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch menu categories" });
  }
});

router.post(
  "/menu-categories",
  validateBody(menuCategorySchema),
  requireAdminFoodModule,
  async (req, res) => {
    try {
      const input = req.validatedBody;
      await assertMenuCategoryImageScope(input.hotelSlug, input);
      const payload = buildMenuCategoryWritePayload({
        ...input,
        slug: input.slug || createMenuCategorySlug(input.name)
      });
      const { data, error } = await supabase.from("menu_categories").insert([payload]).select().single();
      if (error) {
        if (String(error.code || "") === "23505") {
          return res.status(409).json({
            success: false,
            message: "Category key or public slug already exists for this hotel"
          });
        }
        throw error;
      }
      await writeMenuCategoryAudit({ action: "create", after: data });
      invalidatePublicMenuCache(data.hotel_slug);
      res.status(201).json({
        success: true,
        message: "Menu category created successfully",
        category: buildMenuCategoryDto(data, 0)
      });
    } catch (error) {
      console.error("Menu category create error:", error);
      res.status(Number(error.statusCode || 500)).json({
        success: false,
        message: error.statusCode ? error.message : "Failed to create menu category"
      });
    }
  }
);

router.patch(
  "/menu-categories/:id",
  validateBody(partialMenuCategorySchema),
  requireAdminFoodModule,
  async (req, res) => {
    try {
      const { data: existing, error: existingError } = await supabase
        .from("menu_categories")
        .select("*")
        .eq("id", req.params.id)
        .maybeSingle();
      if (existingError) throw existingError;
      if (!existing) return res.status(404).json({ success: false, message: "Menu category not found" });
      await assertMenuCategoryImageScope(existing.hotel_slug, req.validatedBody);
      const updatePayload = buildMenuCategoryWritePayload(req.validatedBody, existing);
      const { data, error } = await supabase
        .from("menu_categories")
        .update(updatePayload)
        .eq("id", existing.id)
        .eq("hotel_slug", existing.hotel_slug)
        .select()
        .single();
      if (error) {
        if (String(error.code || "") === "23505") {
          return res.status(409).json({ success: false, message: "Public category slug already exists" });
        }
        throw error;
      }
      await writeMenuCategoryAudit({ action: "update", before: existing, after: data });
      invalidatePublicMenuCache(existing.hotel_slug);
      res.json({
        success: true,
        message: "Menu category updated successfully",
        category: buildMenuCategoryDto(data, 0)
      });
    } catch (error) {
      console.error("Menu category update error:", error);
      res.status(Number(error.statusCode || 500)).json({
        success: false,
        message: error.statusCode ? error.message : "Failed to update menu category"
      });
    }
  }
);

router.delete("/menu-categories/:id", requireAdminFoodModule, async (req, res) => {
  try {
    const { data: existing, error: existingError } = await supabase
      .from("menu_categories")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing) return res.status(404).json({ success: false, message: "Menu category not found" });

    const { count, error: countError } = await supabase
      .from("menu_items")
      .select("item_id", { count: "exact", head: true })
      .eq("hotel_slug", existing.hotel_slug)
      .eq("category", existing.category_key);
    if (countError) throw countError;
    if (Number(count || 0) > 0) {
      return res.status(409).json({
        success: false,
        message: "This category still has menu items. Move the items or archive the category instead."
      });
    }

    const { error } = await supabase
      .from("menu_categories")
      .delete()
      .eq("id", existing.id)
      .eq("hotel_slug", existing.hotel_slug);
    if (error) throw error;
    await writeMenuCategoryAudit({ action: "delete", before: existing });
    invalidatePublicMenuCache(existing.hotel_slug);
    res.json({ success: true, message: "Menu category deleted successfully" });
  } catch (error) {
    console.error("Menu category delete error:", error);
    res.status(500).json({ success: false, message: "Failed to delete menu category" });
  }
});

router.get("/menu-items", async (req, res) => {
  try {
    const { hotelSlug } = req.query;

    let query = supabase
      .from("menu_items")
      .select("*")
      .order("category", { ascending: true })
      .order("sort_order", { ascending: true });

    if (hotelSlug) {
      query = query.eq("hotel_slug", hotelSlug);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json({
      success: true,
      count: data.length,
      menuItems: data
    });
  } catch (error) {
    console.error("Menu items fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch menu items"
    });
  }
});

router.get("/gallery-items", async (req, res) => {
  try {
    const { hotelSlug } = req.query;

    let query = supabase
      .from("gallery_items")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true });

    if (hotelSlug) {
      query = query.eq("hotel_slug", hotelSlug);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json({
      success: true,
      count: data.length,
      galleryItems: data
    });
  } catch (error) {
    console.error("Gallery items fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch gallery items"
    });
  }
});

router.get("/testimonials", async (req, res) => {
  try {
    const { hotelSlug } = req.query;

    let query = supabase
      .from("testimonials")
      .select("*")
      .order("hotel_slug", { ascending: true })
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true });

    if (hotelSlug) {
      query = query.eq("hotel_slug", String(hotelSlug).trim());
    }

    const { data, error } = await query;

    if (error) {
      if (isMissingTestimonialsRelationError(error)) {
        return res.json({
          success: true,
          count: 0,
          testimonials: []
        });
      }

      throw error;
    }

    res.json({
      success: true,
      count: Array.isArray(data) ? data.length : 0,
      testimonials: data || []
    });
  } catch (error) {
    console.error("Testimonials fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch testimonials"
    });
  }
});

router.post("/testimonials", validateBody(testimonialSchema), async (req, res) => {
  try {
    const {
      hotelSlug,
      name,
      role,
      text,
      stars,
      avatar,
      sortOrder,
      isActive,
      isApproved
    } = req.validatedBody;

    const { data, error } = await supabase
      .from("testimonials")
      .insert([
        {
          hotel_slug: hotelSlug,
          guest_name: name,
          guest_role: role || "",
          review_text: text,
          star_rating: Number(stars || 5),
          avatar_url: avatar || "",
          sort_order: Number(sortOrder || 0),
          is_active: isActive !== undefined ? !!isActive : true,
          is_approved: isApproved !== undefined ? !!isApproved : true,
          updated_at: new Date().toISOString()
        }
      ])
      .select()
      .single();

    if (error) {
      if (isMissingTestimonialsRelationError(error)) {
        return res.status(400).json({
          success: false,
          message: "Testimonials table is not initialized yet"
        });
      }

      throw error;
    }

    res.status(201).json({
      success: true,
      message: "Testimonial created successfully",
      testimonial: data
    });
  } catch (error) {
    console.error("Testimonial create error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create testimonial"
    });
  }
});

router.patch("/testimonials/:id", validateBody(partialTestimonialSchema), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      hotelSlug,
      name,
      role,
      text,
      stars,
      avatar,
      sortOrder,
      isActive,
      isApproved
    } = req.validatedBody;

    const updatePayload = {
      updated_at: new Date().toISOString()
    };

    if (hotelSlug !== undefined) updatePayload.hotel_slug = hotelSlug;
    if (name !== undefined) updatePayload.guest_name = name;
    if (role !== undefined) updatePayload.guest_role = role || "";
    if (text !== undefined) updatePayload.review_text = text;
    if (stars !== undefined) updatePayload.star_rating = Number(stars);
    if (avatar !== undefined) updatePayload.avatar_url = avatar || "";
    if (sortOrder !== undefined) updatePayload.sort_order = Number(sortOrder);
    if (isActive !== undefined) updatePayload.is_active = !!isActive;
    if (isApproved !== undefined) updatePayload.is_approved = !!isApproved;

    if (Object.keys(updatePayload).length === 1) {
      return res.status(400).json({
        success: false,
        message: "At least one field is required to update a testimonial"
      });
    }

    const { data, error } = await supabase
      .from("testimonials")
      .update(updatePayload)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      if (isMissingTestimonialsRelationError(error)) {
        return res.status(400).json({
          success: false,
          message: "Testimonials table is not initialized yet"
        });
      }

      throw error;
    }

    res.json({
      success: true,
      message: "Testimonial updated successfully",
      testimonial: data
    });
  } catch (error) {
    console.error("Testimonial update error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update testimonial"
    });
  }
});

router.patch("/testimonials/:id/archive", async (req, res) => {
  try {
    const { id } = req.params;
    const { isArchived } = req.body;

    const { data, error } = await supabase
      .from("testimonials")
      .update({
        is_archived: !!isArchived,
        is_active: !!isArchived ? false : true,
        updated_at: new Date().toISOString()
      })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      if (isMissingTestimonialsRelationError(error)) {
        return res.status(400).json({
          success: false,
          message: "Testimonials table is not initialized yet"
        });
      }

      throw error;
    }

    res.json({
      success: true,
      message: !!isArchived ? "Testimonial archived" : "Testimonial restored",
      testimonial: data
    });
  } catch (error) {
    console.error("Testimonial archive error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to archive testimonial"
    });
  }
});

router.patch("/testimonials/:id/approval", async (req, res) => {
  try {
    const { id } = req.params;
    const { isApproved } = req.body;

    const { data, error } = await supabase
      .from("testimonials")
      .update({
        is_approved: !!isApproved,
        updated_at: new Date().toISOString()
      })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      if (isMissingTestimonialsRelationError(error)) {
        return res.status(400).json({
          success: false,
          message: "Testimonials table is not initialized yet"
        });
      }

      throw error;
    }

    res.json({
      success: true,
      message: !!isApproved ? "Testimonial approved" : "Testimonial unapproved",
      testimonial: data
    });
  } catch (error) {
    console.error("Testimonial approval error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update testimonial approval"
    });
  }
});

router.delete("/testimonials/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase.from("testimonials").delete().eq("id", id);

    if (error) {
      if (isMissingTestimonialsRelationError(error)) {
        return res.status(400).json({
          success: false,
          message: "Testimonials table is not initialized yet"
        });
      }

      throw error;
    }

    res.json({
      success: true,
      message: "Testimonial deleted successfully"
    });
  } catch (error) {
    console.error("Testimonial delete error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete testimonial"
    });
  }
});

router.get("/popup-notifications", async (req, res) => {
  try {
    const hotelSlug = normalizePublicText(req.query.hotelSlug, 120);
    let query = supabase
      .from("hotel_popup_notifications")
      .select("*")
      .order("priority", { ascending: false })
      .order("created_at", { ascending: false });

    if (hotelSlug) {
      query = query.eq("hotel_slug", hotelSlug);
    }

    const { data, error } = await query;

    if (error) {
      if (isMissingPopupNotificationsRelationError(error)) {
        return res.json({
          success: true,
          count: 0,
          popupNotifications: []
        });
      }

      throw error;
    }

    res.json({
      success: true,
      count: Array.isArray(data) ? data.length : 0,
      popupNotifications: data || []
    });
  } catch (error) {
    console.error("Popup notifications fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch popup notifications"
    });
  }
});

router.post("/popup-notifications", validateBody(popupNotificationSchema), async (req, res) => {
  try {
    const {
      hotelSlug,
      title,
      description,
      imageUrl,
      storagePath,
      ctaText,
      ctaLink,
      isActive,
      displayMode,
      startAt,
      endAt,
      priority
    } = req.validatedBody;

    const { data, error } = await supabase
      .from("hotel_popup_notifications")
      .insert([
        {
          hotel_slug: hotelSlug,
          title,
          description: description || "",
          image_url: imageUrl || "",
          storage_path: storagePath || null,
          cta_text: ctaText || "",
          cta_link: normalizeAdminPopupLink(ctaLink || ""),
          is_active: isActive !== undefined ? !!isActive : true,
          display_mode: displayMode || "once_per_session",
          start_at: normalizePopupTimestamp(startAt),
          end_at: normalizePopupTimestamp(endAt),
          priority: Number(priority || 0),
          updated_at: new Date().toISOString()
        }
      ])
      .select()
      .single();

    if (error) {
      if (isMissingPopupNotificationsRelationError(error)) {
        return res.status(400).json({
          success: false,
          message: "Popup notifications table is not initialized yet"
        });
      }

      throw error;
    }

    res.status(201).json({
      success: true,
      message: "Popup notification created successfully",
      popupNotification: data
    });
  } catch (error) {
    console.error("Popup notification create error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create popup notification"
    });
  }
});

router.patch("/popup-notifications/:id", validateBody(partialPopupNotificationSchema), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      hotelSlug,
      title,
      description,
      imageUrl,
      storagePath,
      ctaText,
      ctaLink,
      isActive,
      displayMode,
      startAt,
      endAt,
      priority
    } = req.validatedBody;

    const updatePayload = {
      updated_at: new Date().toISOString()
    };

    if (hotelSlug !== undefined) updatePayload.hotel_slug = hotelSlug;
    if (title !== undefined) updatePayload.title = title;
    if (description !== undefined) updatePayload.description = description || "";
    if (imageUrl !== undefined) updatePayload.image_url = imageUrl || "";
    if (storagePath !== undefined) updatePayload.storage_path = storagePath || null;
    if (ctaText !== undefined) updatePayload.cta_text = ctaText || "";
    if (ctaLink !== undefined) updatePayload.cta_link = normalizeAdminPopupLink(ctaLink || "");
    if (isActive !== undefined) updatePayload.is_active = !!isActive;
    if (displayMode !== undefined) updatePayload.display_mode = displayMode;
    if (startAt !== undefined) updatePayload.start_at = normalizePopupTimestamp(startAt);
    if (endAt !== undefined) updatePayload.end_at = normalizePopupTimestamp(endAt);
    if (priority !== undefined) updatePayload.priority = Number(priority);

    if (Object.keys(updatePayload).length === 1) {
      return res.status(400).json({
        success: false,
        message: "At least one field is required to update a popup notification"
      });
    }

    const { data, error } = await supabase
      .from("hotel_popup_notifications")
      .update(updatePayload)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      if (isMissingPopupNotificationsRelationError(error)) {
        return res.status(400).json({
          success: false,
          message: "Popup notifications table is not initialized yet"
        });
      }

      throw error;
    }

    res.json({
      success: true,
      message: "Popup notification updated successfully",
      popupNotification: data
    });
  } catch (error) {
    console.error("Popup notification update error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update popup notification"
    });
  }
});

router.patch("/popup-notifications/:id/active", async (req, res) => {
  try {
    const { id } = req.params;
    const isActive = req.body?.isActive;

    const { data, error } = await supabase
      .from("hotel_popup_notifications")
      .update({
        is_active: !!isActive,
        updated_at: new Date().toISOString()
      })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      if (isMissingPopupNotificationsRelationError(error)) {
        return res.status(400).json({
          success: false,
          message: "Popup notifications table is not initialized yet"
        });
      }

      throw error;
    }

    res.json({
      success: true,
      message: !!isActive ? "Popup notification activated" : "Popup notification deactivated",
      popupNotification: data
    });
  } catch (error) {
    console.error("Popup notification active toggle error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update popup notification status"
    });
  }
});

router.delete("/popup-notifications/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from("hotel_popup_notifications")
      .delete()
      .eq("id", id);

    if (error) {
      if (isMissingPopupNotificationsRelationError(error)) {
        return res.status(400).json({
          success: false,
          message: "Popup notifications table is not initialized yet"
        });
      }

      throw error;
    }

    res.json({
      success: true,
      message: "Popup notification deleted successfully"
    });
  } catch (error) {
    console.error("Popup notification delete error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete popup notification"
    });
  }
});

router.get("/menu-combos", async (req, res) => {
  try {
    const hotelSlug = normalizePublicText(req.query.hotelSlug, 120);
    let comboQuery = supabase
      .from("menu_items")
      .select("*")
      .eq("item_type", "combo")
      .order("category", { ascending: true })
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true });

    if (hotelSlug) {
      comboQuery = comboQuery.eq("hotel_slug", hotelSlug);
    }

    const { data: comboRows, error: comboRowsError } = await comboQuery;

    if (comboRowsError) {
      if (isMissingMenuComboSchemaError(comboRowsError)) {
        return res.json({
          success: true,
          count: 0,
          menuCombos: []
        });
      }

      throw comboRowsError;
    }

    const combos = Array.isArray(comboRows) ? comboRows : [];

    if (!combos.length) {
      return res.json({
        success: true,
        count: 0,
        menuCombos: []
      });
    }

    const hotelSlugs = [...new Set(combos.map((comboRow) => comboRow.hotel_slug).filter(Boolean))];
    const comboItemIds = [...new Set(combos.map((comboRow) => comboRow.item_id).filter(Boolean))];
    const { data: comboChildRows, error: comboChildRowsError } = await supabase
      .from("menu_combo_items")
      .select("*")
      .in("hotel_slug", hotelSlugs)
      .in("combo_item_id", comboItemIds)
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true });

    if (comboChildRowsError) {
      if (isMissingMenuComboSchemaError(comboChildRowsError)) {
        return res.status(400).json({
          success: false,
          message: "Combo menu schema is not initialized yet"
        });
      }

      throw comboChildRowsError;
    }

    const { data: comboSettingsRows, error: comboSettingsRowsError } = await supabase
      .from("menu_combo_settings")
      .select("*")
      .in("hotel_slug", hotelSlugs)
      .in("combo_item_id", comboItemIds);

    if (comboSettingsRowsError) {
      if (isMissingMenuComboSchemaError(comboSettingsRowsError)) {
        return res.status(400).json({
          success: false,
          message: "Combo menu schema is not initialized yet"
        });
      }

      throw comboSettingsRowsError;
    }

    const comboChildRowsList = Array.isArray(comboChildRows) ? comboChildRows : [];
    const childItemIds = [
      ...new Set(comboChildRowsList.map((comboChildRow) => comboChildRow.child_item_id).filter(Boolean))
    ];
    let childMenuItems = [];

    if (childItemIds.length) {
      const childMenuItemsResponse = await supabase
        .from("menu_items")
        .select("hotel_slug,item_id,name,price,category,image,is_available")
        .in("hotel_slug", hotelSlugs)
        .in("item_id", childItemIds);

      if (childMenuItemsResponse.error) {
        throw childMenuItemsResponse.error;
      }

      childMenuItems = Array.isArray(childMenuItemsResponse.data)
        ? childMenuItemsResponse.data
        : [];
    }

    const childMenuItemMap = new Map(
      childMenuItems.map((childMenuItem) => [
        getMenuComboLookupKey(childMenuItem.hotel_slug, childMenuItem.item_id),
        childMenuItem
      ])
    );
    const comboChildRowsByKey = comboChildRowsList.reduce((accumulator, comboChildRow) => {
      const comboLookupKey = getMenuComboLookupKey(
        comboChildRow.hotel_slug,
        comboChildRow.combo_item_id
      );

      if (!accumulator.has(comboLookupKey)) {
        accumulator.set(comboLookupKey, []);
      }

      accumulator.get(comboLookupKey).push(comboChildRow);
      return accumulator;
    }, new Map());
    const comboSettingsByKey = (Array.isArray(comboSettingsRows) ? comboSettingsRows : []).reduce(
      (accumulator, comboSettingsRow) => {
        accumulator.set(
          getMenuComboLookupKey(comboSettingsRow.hotel_slug, comboSettingsRow.combo_item_id),
          comboSettingsRow
        );
        return accumulator;
      },
      new Map()
    );

    const menuCombos = combos.map((comboRow) => {
      const comboLookupKey = getMenuComboLookupKey(comboRow.hotel_slug, comboRow.item_id);

      return buildAdminMenuComboResponse(
        comboRow,
        comboChildRowsByKey.get(comboLookupKey) || [],
        comboSettingsByKey.get(comboLookupKey) || null,
        childMenuItemMap
      );
    });

    res.json({
      success: true,
      count: menuCombos.length,
      menuCombos
    });
  } catch (error) {
    console.error("Menu combos fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch menu combos"
    });
  }
});

router.get("/menu-combos/:id", async (req, res) => {
  try {
    const combo = await getAdminMenuComboByDbId(req.params.id);

    if (!combo) {
      return res.status(404).json({
        success: false,
        message: "Menu combo not found"
      });
    }

    res.json({
      success: true,
      menuCombo: combo
    });
  } catch (error) {
    if (isMissingMenuComboSchemaError(error)) {
      return res.status(400).json({
        success: false,
        message: "Combo menu schema is not initialized yet"
      });
    }

    console.error("Menu combo fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch menu combo"
    });
  }
});

router.post("/menu-combos", validateBody(comboMenuItemSchema), requireAdminFoodModule, async (req, res) => {
  let createdComboRow = null;

  try {
    const {
      hotelSlug,
      category,
      itemId,
      name,
      description,
      price,
      image,
      alt,
      badge,
      tag,
      isAvailable,
      sortOrder,
      childItems,
      startDate,
      endDate,
      startTime,
      endTime
    } = req.validatedBody;

    const normalizedHotelSlug = normalizePublicText(hotelSlug, 120);
    const normalizedItemId = normalizePublicText(itemId, 120);
    const { data: existingMenuItem, error: existingMenuItemError } = await supabase
      .from("menu_items")
      .select("id,item_id")
      .eq("hotel_slug", normalizedHotelSlug)
      .eq("item_id", normalizedItemId)
      .maybeSingle();

    if (existingMenuItemError) {
      throw existingMenuItemError;
    }

    if (existingMenuItem) {
      throw createHttpError(
        409,
        `Menu item "${normalizedItemId}" already exists for hotel "${normalizedHotelSlug}"`
      );
    }

    await fetchValidatedComboChildMenuItems({
      hotelSlug: normalizedHotelSlug,
      childItems
    });

    const { data, error } = await supabase
      .from("menu_items")
      .insert([
        {
          hotel_slug: normalizedHotelSlug,
          category,
          item_id: normalizedItemId,
          item_type: "combo",
          name,
          description: description || "",
          price: Number(price || 0),
          image: image || "",
          alt: alt || "",
          badge: badge || "",
          tag: tag || "",
          is_available: isAvailable !== undefined ? !!isAvailable : true,
          sort_order: Number(sortOrder || 0),
          updated_at: new Date().toISOString()
        }
      ])
      .select()
      .single();

    if (error) {
      if (isMenuItemsIdSequenceConflict(error)) {
        throw createHttpError(
          409,
          "menu_items id sequence is out of sync. Run backend/scripts/reset-menu-items-id-sequence.sql once, then retry."
        );
      }

      throw error;
    }

    createdComboRow = data;

    await replaceMenuComboChildren({
      hotelSlug: normalizedHotelSlug,
      comboItemId: normalizedItemId,
      childItems
    });

    await syncMenuComboSettings({
      hotelSlug: normalizedHotelSlug,
      comboItemId: normalizedItemId,
      startDate,
      endDate,
      startTime,
      endTime
    });

    const createdCombo = await getAdminMenuComboByDbId(createdComboRow.id);

    res.status(201).json({
      success: true,
      message: "Menu combo created successfully",
      menuCombo: createdCombo
    });
  } catch (error) {
    if (createdComboRow?.id) {
      await supabase
        .from("menu_combo_items")
        .delete()
        .eq("hotel_slug", createdComboRow.hotel_slug)
        .eq("combo_item_id", createdComboRow.item_id);
      await supabase
        .from("menu_combo_settings")
        .delete()
        .eq("hotel_slug", createdComboRow.hotel_slug)
        .eq("combo_item_id", createdComboRow.item_id);
      await supabase.from("menu_items").delete().eq("id", createdComboRow.id);
    }

    if (error?.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message
      });
    }

    if (isMissingMenuComboSchemaError(error)) {
      return res.status(400).json({
        success: false,
        message: "Combo menu schema is not initialized yet"
      });
    }

    console.error("Menu combo create error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create menu combo"
    });
  }
});

router.patch("/menu-combos/:id", validateBody(partialComboMenuItemSchema), requireAdminFoodModule, async (req, res) => {
  try {
    const { id } = req.params;
    const existingCombo = await getAdminMenuComboByDbId(id);

    if (!existingCombo) {
      return res.status(404).json({
        success: false,
        message: "Menu combo not found"
      });
    }

    if (
      req.validatedBody.hotelSlug !== undefined &&
      String(req.validatedBody.hotelSlug).trim() !== existingCombo.hotelSlug
    ) {
      return res.status(400).json({
        success: false,
        message: "Combo hotel slug cannot be changed after creation"
      });
    }

    if (
      req.validatedBody.itemId !== undefined &&
      String(req.validatedBody.itemId).trim() !== existingCombo.itemId
    ) {
      return res.status(400).json({
        success: false,
        message: "Combo item id cannot be changed after creation"
      });
    }

    const {
      category,
      name,
      description,
      price,
      image,
      alt,
      badge,
      tag,
      isAvailable,
      sortOrder,
      childItems
    } = req.validatedBody;

    const updatePayload = {
      updated_at: new Date().toISOString()
    };

    if (category !== undefined) updatePayload.category = category;
    if (name !== undefined) updatePayload.name = name;
    if (description !== undefined) updatePayload.description = description || "";
    if (price !== undefined) updatePayload.price = Number(price);
    if (image !== undefined) updatePayload.image = image || "";
    if (alt !== undefined) updatePayload.alt = alt || "";
    if (badge !== undefined) updatePayload.badge = badge || "";
    if (tag !== undefined) updatePayload.tag = tag || "";
    if (isAvailable !== undefined) updatePayload.is_available = !!isAvailable;
    if (sortOrder !== undefined) updatePayload.sort_order = Number(sortOrder);

    if (Object.keys(updatePayload).length > 1) {
      const { error: updateError } = await supabase
        .from("menu_items")
        .update(updatePayload)
        .eq("id", id)
        .eq("item_type", "combo");

      if (updateError) {
        throw updateError;
      }
    }

    if (childItems !== undefined) {
      await replaceMenuComboChildren({
        hotelSlug: existingCombo.hotelSlug,
        comboItemId: existingCombo.itemId,
        childItems
      });
    }

    if (
      req.validatedBody.startDate !== undefined ||
      req.validatedBody.endDate !== undefined ||
      req.validatedBody.startTime !== undefined ||
      req.validatedBody.endTime !== undefined
    ) {
      await syncMenuComboSettings({
        hotelSlug: existingCombo.hotelSlug,
        comboItemId: existingCombo.itemId,
        startDate:
          req.validatedBody.startDate !== undefined
            ? req.validatedBody.startDate
            : existingCombo.startDate,
        endDate:
          req.validatedBody.endDate !== undefined
            ? req.validatedBody.endDate
            : existingCombo.endDate,
        startTime:
          req.validatedBody.startTime !== undefined
            ? req.validatedBody.startTime
            : existingCombo.startTime,
        endTime:
          req.validatedBody.endTime !== undefined
            ? req.validatedBody.endTime
            : existingCombo.endTime
      });
    }

    if (
      Object.keys(updatePayload).length === 1 &&
      childItems === undefined &&
      req.validatedBody.startDate === undefined &&
      req.validatedBody.endDate === undefined &&
      req.validatedBody.startTime === undefined &&
      req.validatedBody.endTime === undefined
    ) {
      return res.status(400).json({
        success: false,
        message: "At least one field is required to update a menu combo"
      });
    }

    const updatedCombo = await getAdminMenuComboByDbId(id);

    res.json({
      success: true,
      message: "Menu combo updated successfully",
      menuCombo: updatedCombo
    });
  } catch (error) {
    if (error?.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message
      });
    }

    if (isMissingMenuComboSchemaError(error)) {
      return res.status(400).json({
        success: false,
        message: "Combo menu schema is not initialized yet"
      });
    }

    console.error("Menu combo update error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update menu combo"
    });
  }
});

router.patch("/menu-combos/:id/active", requireAdminFoodModule, async (req, res) => {
  try {
    const { id } = req.params;
    const isAvailable = req.body?.isAvailable;
    const { data, error } = await supabase
      .from("menu_items")
      .update({
        is_available: !!isAvailable,
        updated_at: new Date().toISOString()
      })
      .eq("id", id)
      .eq("item_type", "combo")
      .select()
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      return res.status(404).json({
        success: false,
        message: "Menu combo not found"
      });
    }

    const updatedCombo = await getAdminMenuComboByDbId(id);

    res.json({
      success: true,
      message: !!isAvailable ? "Menu combo activated" : "Menu combo deactivated",
      menuCombo: updatedCombo
    });
  } catch (error) {
    if (isMissingMenuComboSchemaError(error)) {
      return res.status(400).json({
        success: false,
        message: "Combo menu schema is not initialized yet"
      });
    }

    console.error("Menu combo active toggle error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update menu combo status"
    });
  }
});

router.delete("/menu-combos/:id", requireAdminFoodModule, async (req, res) => {
  try {
    const existingCombo = await getAdminMenuComboByDbId(req.params.id);

    if (!existingCombo) {
      return res.status(404).json({
        success: false,
        message: "Menu combo not found"
      });
    }

    const { error: comboChildrenDeleteError } = await supabase
      .from("menu_combo_items")
      .delete()
      .eq("hotel_slug", existingCombo.hotelSlug)
      .eq("combo_item_id", existingCombo.itemId);

    if (comboChildrenDeleteError) {
      throw comboChildrenDeleteError;
    }

    const { error: comboSettingsDeleteError } = await supabase
      .from("menu_combo_settings")
      .delete()
      .eq("hotel_slug", existingCombo.hotelSlug)
      .eq("combo_item_id", existingCombo.itemId);

    if (comboSettingsDeleteError) {
      throw comboSettingsDeleteError;
    }

    const { error: comboDeleteError } = await supabase
      .from("menu_items")
      .delete()
      .eq("id", req.params.id)
      .eq("item_type", "combo");

    if (comboDeleteError) {
      throw comboDeleteError;
    }

    res.json({
      success: true,
      message: "Menu combo deleted successfully"
    });
  } catch (error) {
    if (isMissingMenuComboSchemaError(error)) {
      return res.status(400).json({
        success: false,
        message: "Combo menu schema is not initialized yet"
      });
    }

    console.error("Menu combo delete error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete menu combo"
    });
  }
});

router.post("/menu-items", validateBody(menuItemSchema), requireAdminFoodModule, async (req, res) => {
  try {
    const {
      hotelSlug,
      category,
      itemId,
      name,
      description,
      price,
      image,
      alt,
      badge,
      tag,
      isAvailable,
      sortOrder
    } = req.validatedBody;

    await ensureAdminMenuCategoryBelongsToHotel(hotelSlug, category);

    const { data, error } = await supabase
      .from("menu_items")
      .insert([
        {
          hotel_slug: hotelSlug,
          category,
          item_id: itemId,
          name,
          description: description || "",
          price: Number(price || 0),
          image: image || "",
          alt: alt || "",
          badge: badge || "",
          tag: tag || "",
          is_available: isAvailable !== undefined ? !!isAvailable : true,
          sort_order: Number(sortOrder || 0)
        }
      ])
      .select()
      .single();

    if (error) throw error;

    invalidatePublicMenuCache(hotelSlug);
    res.status(201).json({
      success: true,
      message: "Menu item created successfully",
      menuItem: data
    });
  } catch (error) {
    console.error("Menu item create error:", error);
    res.status(Number(error.statusCode || 500)).json({
      success: false,
      message: error.statusCode ? error.message : "Failed to create menu item"
    });
  }
});

router.post("/gallery-items", validateBody(galleryItemSchema), async (req, res) => {
  try {
    const {
      hotelSlug,
      imageUrl,
      storagePath,
      alt,
      layoutVariant,
      isActive,
      sortOrder
    } = req.validatedBody;

    const { data, error } = await insertGalleryItemWithCompatibility({
      hotel_slug: hotelSlug,
      image_url: imageUrl,
      storage_path: storagePath || null,
      alt: alt || "",
      layout_variant: layoutVariant || "standard",
      is_active: isActive !== undefined ? !!isActive : true,
      sort_order: Number(sortOrder || 0)
    });

    if (error) throw error;

    res.status(201).json({
      success: true,
      message: "Gallery item created successfully",
      galleryItem: data
    });
  } catch (error) {
    console.error("Gallery item create error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create gallery item"
    });
  }
});

router.patch("/menu-items/:id", validateBody(partialMenuItemSchema), requireAdminFoodModule, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      category,
      itemId,
      name,
      description,
      price,
      image,
      alt,
      badge,
      tag,
      isAvailable,
      sortOrder
    } = req.validatedBody;

    const { data: existing, error: existingError } = await supabase
      .from("menu_items")
      .select("id,hotel_slug,category")
      .eq("id", id)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing) return res.status(404).json({ success: false, message: "Menu item not found" });
    if (category !== undefined) {
      await ensureAdminMenuCategoryBelongsToHotel(existing.hotel_slug, category);
    }

    const updatePayload = {};

    if (category !== undefined) updatePayload.category = category;
    if (itemId !== undefined) updatePayload.item_id = itemId;
    if (name !== undefined) updatePayload.name = name;
    if (description !== undefined) updatePayload.description = description;
    if (price !== undefined) updatePayload.price = Number(price);
    if (image !== undefined) updatePayload.image = image;
    if (alt !== undefined) updatePayload.alt = alt;
    if (badge !== undefined) updatePayload.badge = badge;
    if (tag !== undefined) updatePayload.tag = tag;
    if (isAvailable !== undefined) updatePayload.is_available = !!isAvailable;
    if (sortOrder !== undefined) updatePayload.sort_order = Number(sortOrder);

    const { data, error } = await supabase
      .from("menu_items")
      .update(updatePayload)
      .eq("id", id)
      .eq("hotel_slug", existing.hotel_slug)
      .select()
      .single();

    if (error) throw error;

    invalidatePublicMenuCache(existing.hotel_slug);
    res.json({
      success: true,
      message: "Menu item updated successfully",
      menuItem: data
    });
  } catch (error) {
    console.error("Menu item update error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update menu item"
    });
  }
});

router.patch("/gallery-items/:id", validateBody(partialGalleryItemSchema), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      hotelSlug,
      imageUrl,
      storagePath,
      alt,
      layoutVariant,
      isActive,
      sortOrder
    } = req.validatedBody;

    const updatePayload = {
      updated_at: new Date().toISOString()
    };

    if (hotelSlug !== undefined) updatePayload.hotel_slug = hotelSlug;
    if (imageUrl !== undefined) updatePayload.image_url = imageUrl;
    if (storagePath !== undefined) updatePayload.storage_path = storagePath || null;
    if (alt !== undefined) updatePayload.alt = alt || "";
    if (layoutVariant !== undefined) updatePayload.layout_variant = layoutVariant;
    if (isActive !== undefined) updatePayload.is_active = !!isActive;
    if (sortOrder !== undefined) updatePayload.sort_order = Number(sortOrder);

    if (Object.keys(updatePayload).length === 1) {
      return res.status(400).json({
        success: false,
        message: "At least one field is required to update a gallery item"
      });
    }

    const { data, error } = await updateGalleryItemWithCompatibility(id, updatePayload);

    if (error) throw error;

    invalidatePublicMenuCache(data.hotel_slug);
    res.json({
      success: true,
      message: "Gallery item updated successfully",
      galleryItem: data
    });
  } catch (error) {
    console.error("Gallery item update error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update gallery item"
    });
  }
});

router.patch("/menu-items/:id/archive", requireAdminFoodModule, async (req, res) => {
  try {
    const { id } = req.params;
    const { isArchived } = req.body;

    const { data, error } = await supabase
      .from("menu_items")
      .update({
        is_archived: !!isArchived,
        is_available: !!isArchived ? false : true
      })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    if (existing?.hotel_slug) invalidatePublicMenuCache(existing.hotel_slug);

    res.json({
      success: true,
      message: isArchived ? "Menu item archived" : "Menu item restored",
      menuItem: data
    });
  } catch (error) {
    console.error("Menu item archive error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to archive menu item"
    });
  }
});

router.patch("/gallery-items/:id/archive", async (req, res) => {
  try {
    const { id } = req.params;
    const { isArchived } = req.body;

    const { data, error } = await supabase
      .from("gallery_items")
      .update({
        is_archived: !!isArchived,
        is_active: !!isArchived ? false : true,
        updated_at: new Date().toISOString()
      })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      if (isMenuItemsIdSequenceConflict(error)) {
        return res.status(409).json({
          success: false,
          message:
            "menu_items id sequence is out of sync. Run backend/scripts/reset-menu-items-id-sequence.sql once, then retry."
        });
      }

      throw error;
    }

    res.json({
      success: true,
      message: isArchived ? "Gallery item archived" : "Gallery item restored",
      galleryItem: data
    });
  } catch (error) {
    console.error("Gallery item archive error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to archive gallery item"
    });
  }
});

router.delete("/menu-items/:id", requireAdminFoodModule, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: existing, error: existingError } = await supabase
      .from("menu_items")
      .select("hotel_slug")
      .eq("id", id)
      .maybeSingle();
    if (existingError) throw existingError;

    const { error } = await supabase
      .from("menu_items")
      .delete()
      .eq("id", id);

    if (error) throw error;

    res.json({
      success: true,
      message: "Menu item deleted successfully"
    });
  } catch (error) {
    console.error("Menu item delete error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete menu item"
    });
  }
});

router.patch("/gallery-items/:id/active", async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    const { data, error } = await supabase
      .from("gallery_items")
      .update({
        is_active: !!isActive,
        updated_at: new Date().toISOString()
      })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: isActive ? "Gallery item activated" : "Gallery item deactivated",
      galleryItem: data
    });
  } catch (error) {
    console.error("Gallery item active toggle error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update gallery item active state"
    });
  }
});

router.delete("/gallery-items/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from("gallery_items")
      .delete()
      .eq("id", id);

    if (error) throw error;

    res.json({
      success: true,
      message: "Gallery item deleted successfully"
    });
  } catch (error) {
    console.error("Gallery item delete error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete gallery item"
    });
  }
});

router.patch("/hotels/:id/active", async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    const { data, error } = await supabase
      .from("hotels")
      .update({
        is_active: !!isActive
      })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      message: isActive ? "Hotel activated" : "Hotel deactivated",
      hotel: data
    });
  } catch (error) {
    console.error("Hotel active toggle error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update hotel active state"
    });
  }
});

module.exports = router;
