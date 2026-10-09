const express = require("express");
const rateLimit = require("express-rate-limit");
const { supabase } = require("../utils/supabase");
const { getTenantMutationClient } = require("../utils/tenant-route-database");
const { getTenantRequestScope } = require("../utils/tenant-request-context");
const { ensurePublicHotelAccess } = require("../utils/public-hotel-access");
const { env } = require("../config/env");
const {
  fetchTenantPublicOrderTrackingBundle
} = require("../utils/tenant-public-order-tracking");
const {
  buildOrderTrackingReference,
  getOrderTrackingColumns,
  isMissingOrderTrackingColumnsError
} = require("../utils/order-tracking");
const { createNotificationEventSafely } = require("../utils/notifications");
const {
  buildFeatureDisabledPayload,
  isHotelFeatureEnabled,
  normalizeHotelSlug
} = require("../utils/hotel-feature-settings");
const {
  buildCustomerOrderingDisabledPayload,
  fetchHotelOrderingSettings
} = require("../utils/hotel-ordering-settings");
const {
  buildOrderItemSnapshots,
  buildComboSummaryLine
} = require("../utils/order-item-snapshots");
const { validateRequestedMenuCombos } = require("../utils/menu-combos");
const { filterEligibleMenuItems } = require("../utils/menu-categories");
const { requireHotelFeature } = require("../middleware/require-hotel-feature");

const router = express.Router();
const TRACKING_ROUTE_WINDOW_MS = 10 * 60 * 1000;
const requirePublicFoodModule = requireHotelFeature("food", {
  resolveHotelSlug: (req = {}) => req.params?.hotelSlug
});

function requirePublicFoodTrackingRead(req, res, next) {
  if (env.tenantRuntimePublicOrderTrackingEnabled) {
    return next();
  }
  return requirePublicFoodModule(req, res, next);
}

function getTrackingRateLimitKey(req = {}) {
  const hotelSlug = String(req.params?.hotelSlug || "").trim().toLowerCase();
  const orderId = String(req.params?.orderId || "").trim().toLowerCase();
  const normalizedIp = req.ip
    ? rateLimit.ipKeyGenerator(req.ip)
    : "unknown";
  return `${normalizedIp}:${hotelSlug}:${orderId}`;
}

const trackingViewLimiter = rateLimit({
  windowMs: TRACKING_ROUTE_WINDOW_MS,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getTrackingRateLimitKey,
  message: {
    success: false,
    message: "Too many order tracking refreshes. Please wait a moment and try again."
  }
});

const trackingSupportLimiter = rateLimit({
  windowMs: TRACKING_ROUTE_WINDOW_MS,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getTrackingRateLimitKey,
  message: {
    success: false,
    message: "Too many support requests for this order. Please wait a moment and try again."
  }
});

const TRACKING_SELECT_FULL = [
  "id",
  "hotel_slug",
  "hotel_name",
  "order_type",
  "table_number",
  "order_source",
  "payment_method",
  "payment_status",
  "billing_status",
  "bill_number",
  "room_id",
  "room_booking_id",
  "room_number",
  "room_service_guest_name",
  "room_service_charge_to_room",
  "items",
  "totals",
  "status",
  "created_at"
].join(",");

const TRACKING_SELECT_CORE = [
  "id",
  "hotel_slug",
  "hotel_name",
  "payment_method",
  "items",
  "totals",
  "status",
  "created_at"
].join(",");

const OPTIONAL_TRACKING_PUBLIC_COLUMNS = [
  "order_type",
  "table_number",
  "order_source",
  "payment_status",
  "billing_status",
  "bill_number",
  "room_id",
  "room_booking_id",
  "room_number",
  "room_service_guest_name",
  "room_service_charge_to_room"
];
const ADDON_ORDER_METADATA_COLUMNS = [
  "parent_order_id",
  "order_group_id",
  "order_entry_type",
  "order_sequence_label",
  "addon_sequence"
];
const ADDON_BASE_SELECT = [
  "id",
  "hotel_slug",
  "hotel_name",
  "customer_name",
  "customer_phone",
  "customer_address",
  "payment_method",
  "order_type",
  "table_number",
  "order_source",
  "payment_status",
  "billing_status",
  "status",
  "order_group_id",
  "created_at"
].join(",");
const ADDON_PUBLIC_SELECT = [
  "id",
  "hotel_slug",
  "parent_order_id",
  "order_sequence_label",
  "addon_sequence",
  "payment_method",
  "payment_status",
  "billing_status",
  "items",
  "totals",
  "status",
  "created_at"
].join(",");
const SUPPORT_REQUEST_TYPES = ["bill", "help"];
const CLOSED_TRACKING_STATUSES = new Set(["completed", "cancelled", "payment_failed"]);

function normalizePublicText(value = "", maxLength = 120) {
  const text = typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim()
    : "";
  return text.slice(0, maxLength);
}

function cleanPhone(value = "") {
  return String(value || "").replace(/\D/g, "");
}

function isClosedTrackingStatus(order = {}) {
  const status = normalizePublicText(order.status, 60).toLowerCase();
  return CLOSED_TRACKING_STATUSES.has(status);
}

function isAddonBlockedByBillingOrPayment(order = {}) {
  const status = normalizePublicText(order.status, 60).toLowerCase();
  const paymentStatus = normalizePublicText(order.payment_status, 60).toLowerCase();
  const billingStatus = normalizePublicText(order.billing_status, 60).toLowerCase();

  return (
    status === "payment_pending" ||
    ["paid", "refunded"].includes(paymentStatus) ||
    ["bill_ready", "billed", "closed"].includes(billingStatus)
  );
}

function isMissingAddonMetadataColumnsError(error) {
  if (!error) return false;

  const code = String(error.code || "").trim().toUpperCase();
  const details = [
    error.message,
    error.details,
    error.hint
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    code === "PGRST204" ||
    (
      details.includes("could not find") &&
      ADDON_ORDER_METADATA_COLUMNS.some((columnName) => details.includes(columnName))
    )
  );
}

function isMissingSupportRequestsRelationError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();

  return (
    code === "42P01" ||
    code === "PGRST205" ||
    (
      details.includes("order_support_requests") &&
      (
        details.includes("relation") ||
        details.includes("schema cache") ||
        details.includes("could not find")
      )
    )
  );
}

function getSupportRequestType(value = "") {
  const normalizedType = normalizePublicText(value, 20).toLowerCase();
  return SUPPORT_REQUEST_TYPES.includes(normalizedType) ? normalizedType : "";
}

function getSafeAddonItems(items = []) {
  if (!Array.isArray(items)) return [];

  return items
    .map((item) => {
      const id = normalizePublicText(item?.id || item?.itemId, 120);
      const qty = Number(item?.qty || item?.quantity || 0);

      return {
        id,
        qty: Number.isInteger(qty) ? qty : 0
      };
    })
    .filter((item) => item.id && item.qty > 0 && item.qty <= 99);
}

function isUpiPaymentMethod(paymentMethod = "") {
  const normalizedPaymentMethod = normalizePublicText(paymentMethod, 60).toLowerCase();

  return (
    normalizedPaymentMethod.includes("upi") ||
    normalizedPaymentMethod.includes("gpay") ||
    normalizedPaymentMethod.includes("google pay")
  );
}

function getUpiDiscountPercent(hotel = {}) {
  const candidate = Number(hotel?.theme?.payment?.upiDiscountPercent);

  if (Number.isFinite(candidate)) {
    return Math.min(Math.max(candidate, 0), 100);
  }

  return 10;
}

async function getHotelPricingContext(hotelSlug) {
  const normalizedHotelSlug = normalizePublicText(hotelSlug, 120);

  if (!normalizedHotelSlug) {
    return {
      error: "Hotel slug is required for add-on pricing"
    };
  }

  const { data, error } = await supabase
    .from("hotel_profiles")
    .select("hotel_slug,hotel_name,gst_percent,theme")
    .eq("hotel_slug", normalizedHotelSlug)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    return {
      error: "Hotel profile not found"
    };
  }

  return { hotel: data };
}

async function getAvailableMenuItemsById(hotelSlug, itemIds = []) {
  const { data, error } = await supabase
    .from("menu_items")
    .select("hotel_slug,item_id,name,price,item_type,category")
    .eq("hotel_slug", hotelSlug)
    .eq("is_available", true)
    .eq("is_archived", false)
    .in("item_id", itemIds);

  if (error) throw error;

  const eligibleItems = await filterEligibleMenuItems({ supabase, hotelSlug, consumer: "website", menuItems: data || [] });
  return new Map(eligibleItems.map((item) => [String(item.item_id), item]));
}

async function calculateVerifiedAddonPricing({ hotelSlug, items, paymentMethod }) {
  const pricingContext = await getHotelPricingContext(hotelSlug);

  if (pricingContext.error) {
    return pricingContext;
  }

  const hotel = pricingContext.hotel;
  const uniqueItemIds = [...new Set((items || []).map((item) => String(item.id || "")))].filter(Boolean);
  const menuItemsById = await getAvailableMenuItemsById(hotel.hotel_slug, uniqueItemIds);
  const missingItems = uniqueItemIds.filter((itemId) => !menuItemsById.has(itemId));

  if (missingItems.length) {
    return {
      error: `Some menu items are unavailable: ${missingItems.join(", ")}`
    };
  }

  const comboValidation = await validateRequestedMenuCombos({
    hotelSlug: hotel.hotel_slug,
    requestedItems: items || [],
    menuItemRows: Array.from(menuItemsById.values())
  });

  if (!comboValidation.ok) {
    return {
      error: comboValidation.error || "Some combo items are unavailable right now"
    };
  }

  const verifiedItems = await buildOrderItemSnapshots({
    hotelSlug: hotel.hotel_slug,
    requestedItems: items || [],
    menuItemRows: Array.from(menuItemsById.values())
  });
  const subtotal = verifiedItems.reduce((sum, item) => sum + item.lineTotal, 0);
  const gstPercent = Number(hotel.gst_percent || 5);
  const gst = Math.round((subtotal * gstPercent) / 100);
  const normalTotal = subtotal + gst;
  const upiDiscountPercent = getUpiDiscountPercent(hotel);
  const gpayDiscount = Math.round((normalTotal * upiDiscountPercent) / 100);
  const gpayFinalTotal = Math.max(0, normalTotal - gpayDiscount);
  const isUpi = isUpiPaymentMethod(paymentMethod);
  const verifiedTotals = {
    subtotal,
    gst,
    gstPercent,
    normalTotal,
    upiDiscountPercent,
    total: normalTotal
  };

  if (isUpi) {
    verifiedTotals.gpayDiscount = gpayDiscount;
    verifiedTotals.gpayFinalTotal = gpayFinalTotal;
    verifiedTotals.total = gpayFinalTotal;
  }

  return {
    hotel,
    items: verifiedItems,
    totals: verifiedTotals
  };
}

function formatMoney(amount = 0) {
  return `Rs. ${Number(amount || 0).toFixed(2)}`;
}

function formatDiscountPercent(percent = 0) {
  const safePercent = Number.isFinite(Number(percent)) ? Number(percent) : 0;
  return Number.isInteger(safePercent)
    ? `${safePercent}%`
    : `${safePercent.toFixed(2).replace(/\.?0+$/, "")}%`;
}

function getAddonSequenceLabel(parentOrderId, sequenceNumber) {
  const safeParentOrderId = String(parentOrderId || "").trim();
  const safeSequence = Number.isInteger(sequenceNumber) && sequenceNumber > 0
    ? sequenceNumber
    : 1;
  let remaining = safeSequence;
  let suffix = "";

  while (remaining > 0) {
    remaining -= 1;
    suffix = String.fromCharCode(65 + (remaining % 26)) + suffix;
    remaining = Math.floor(remaining / 26);
  }

  return `#${safeParentOrderId}-${suffix || "A"}`;
}

async function getNextAddonSequence({ hotelSlug, parentOrderId }) {
  const { count, error } = await supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("hotel_slug", hotelSlug)
    .eq("parent_order_id", String(parentOrderId));

  if (error) throw error;

  return Number(count || 0) + 1;
}

function buildAddonOrderSummary({
  baseOrder,
  sequenceLabel,
  paymentMethod,
  paymentConfirmed,
  note,
  items,
  totals
}) {
  const isUpi = isUpiPaymentMethod(paymentMethod);
  const lines = [
    `Add-on Order - ${baseOrder.hotel_name || "Hotel"}`,
    "----------------------",
    `Add-on: ${sequenceLabel}`,
    `Parent Order: #${baseOrder.id}`,
    `Name: ${baseOrder.customer_name || "Guest"}`,
    `Phone: ${baseOrder.customer_phone || "Not provided"}`,
    "Order Type: Dine-in",
    `Table: ${baseOrder.table_number || "Not provided"}`,
    `Source: ${baseOrder.order_source === "qr" ? "QR code" : baseOrder.order_source || "qr"}`,
    ""
  ];

  (items || []).forEach((item) => {
    lines.push(`${item.name} x${item.qty} = ${formatMoney(item.price * item.qty)}`);
    const comboSummaryLine = buildComboSummaryLine(item);

    if (comboSummaryLine) {
      lines.push(comboSummaryLine);
    }
  });

  lines.push("");
  lines.push(`Subtotal = ${formatMoney(totals.subtotal)}`);
  lines.push(`GST = ${formatMoney(totals.gst)}`);

  if (isUpi) {
    lines.push(`Original Total = ${formatMoney(totals.normalTotal)}`);
    lines.push(`Google Pay Discount (${formatDiscountPercent(totals.upiDiscountPercent)}) = -${formatMoney(totals.gpayDiscount)}`);
    lines.push(`Final Paid Amount = ${formatMoney(totals.gpayFinalTotal)}`);
    lines.push("Payment Method = Google Pay / UPI");
    lines.push(`Payment Status = ${paymentConfirmed ? "Confirmed" : "Pending"}`);
  } else {
    lines.push(`Total = ${formatMoney(totals.normalTotal)}`);
    lines.push(`Payment Method = ${paymentMethod || "COD"}`);
  }

  if (note) {
    lines.push("");
    lines.push(`Add-on Note = ${note}`);
  }

  return lines.join("\n");
}

function hasDineInTrackingContext(order = {}) {
  const orderType = normalizePublicText(order.order_type, 40).toLowerCase();

  return (
    !!order.table_number ||
    orderType === "dine-in" ||
    orderType === "dine_in" ||
    normalizePublicText(order.order_source, 40).toLowerCase() === "qr"
  );
}

async function getOwnerWhatsAppNumber(hotelSlug) {
  const normalizedHotelSlug = normalizePublicText(hotelSlug, 120);
  if (!normalizedHotelSlug) {
    return cleanPhone(process.env.OWNER_WHATSAPP_NUMBER || "");
  }

  try {
    const { data, error } = await supabase
      .from("hotel_profiles")
      .select("owner_whatsapp_number")
      .eq("hotel_slug", normalizedHotelSlug)
      .maybeSingle();

    if (error) {
      console.warn("Tracking hotel owner WhatsApp lookup failed:", error.message);
    }

    const profileWhatsAppNumber = cleanPhone(data?.owner_whatsapp_number || "");
    if (profileWhatsAppNumber) {
      return profileWhatsAppNumber;
    }
  } catch (error) {
    console.warn("Tracking hotel owner WhatsApp lookup failed:", error.message);
  }

  try {
    const { data, error } = await supabase
      .from("hotels")
      .select("whatsapp_number")
      .eq("slug", normalizedHotelSlug)
      .maybeSingle();

    if (error) {
      console.warn("Tracking hotel WhatsApp lookup failed:", error.message);
    }

    const hotelWhatsAppNumber = cleanPhone(data?.whatsapp_number || "");
    if (hotelWhatsAppNumber) {
      return hotelWhatsAppNumber;
    }
  } catch (error) {
    console.warn("Tracking hotel WhatsApp lookup failed:", error.message);
  }

  return cleanPhone(process.env.OWNER_WHATSAPP_NUMBER || "");
}

function buildWhatsAppLink(phoneNumber = "", message = "") {
  const cleanedPhoneNumber = cleanPhone(phoneNumber);

  if (!cleanedPhoneNumber || !message) {
    return "";
  }

  return `https://wa.me/${cleanedPhoneNumber}?text=${encodeURIComponent(message)}`;
}

function buildTrackingActionMessage(order = {}, action = "help") {
  const hotelName = normalizePublicText(order.hotel_name || "Hotel", 140);
  const orderId = String(order.id || "").trim();
  const tableNumber = normalizePublicText(order.table_number, 80) || "Not provided";
  const actionTitle = action === "bill"
    ? "Bill Request"
    : "Staff Help Request";
  const actionLine = action === "bill"
    ? "Please prepare the bill for this table."
    : "Please send staff assistance to this table.";

  return [
    `${actionTitle} - ${hotelName}`,
    "----------------------",
    `Order: #${orderId}`,
    `Table: ${tableNumber}`,
    `Status: ${normalizePublicText(order.status || "new", 60)}`,
    "",
    actionLine
  ].join("\n");
}

function buildTrackingActions(order = {}, ownerWhatsAppNumber = "") {
  if (!hasDineInTrackingContext(order) || isClosedTrackingStatus(order)) {
    return {
      tableActionsEnabled: false,
      requestBillWhatsappLink: "",
      callStaffWhatsappLink: ""
    };
  }

  return {
    tableActionsEnabled: true,
    requestBillWhatsappLink: buildWhatsAppLink(
      ownerWhatsAppNumber,
      buildTrackingActionMessage(order, "bill")
    ),
    callStaffWhatsappLink: buildWhatsAppLink(
      ownerWhatsAppNumber,
      buildTrackingActionMessage(order, "help")
    )
  };
}

function buildSupportRequestMessage(order = {}, requestType = "help") {
  return requestType === "bill"
    ? "Customer requested the bill from the order tracking page."
    : "Customer requested staff help from the order tracking page.";
}

function buildSupportRequestResponse(supportRequest = {}) {
  return {
    id: String(supportRequest.id || ""),
    hotelSlug: supportRequest.hotel_slug || "",
    orderId: String(supportRequest.order_id || ""),
    tableNumber: supportRequest.table_number || "",
    requestType: supportRequest.request_type || "",
    status: supportRequest.status || "new",
    createdAt: supportRequest.created_at || ""
  };
}

function isMissingPublicOptionalColumnError(error) {
  if (!error) return false;

  const code = String(error.code || "").trim().toUpperCase();
  const details = [
    error.message,
    error.details,
    error.hint
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    code === "PGRST204" ||
    (
      details.includes("could not find") &&
      OPTIONAL_TRACKING_PUBLIC_COLUMNS.some((columnName) => details.includes(columnName))
    )
  );
}

function getSafePublicOrderItems(items = []) {
  if (!Array.isArray(items)) return [];

  return items.map((item) => ({
    id: normalizePublicText(item?.id, 120),
    name: normalizePublicText(item?.name, 160),
    qty: Number(item?.qty || 0),
    price: Number(item?.price || 0),
    lineTotal: Number(item?.lineTotal || (Number(item?.price || 0) * Number(item?.qty || 0))),
    itemType: normalizePublicText(item?.itemType || item?.item_type || "single", 20) || "single",
    comboItems: Array.isArray(item?.comboItems)
      ? item.comboItems.map((comboItem) => ({
          itemId: normalizePublicText(comboItem?.itemId, 120),
          name: normalizePublicText(comboItem?.name, 160),
          quantity: Number(comboItem?.quantity || 0) || 0
        }))
      : [],
    originalPrice: Number(item?.originalPrice || 0),
    savings: Number(item?.savings || 0)
  }));
}

function getSafePublicTotals(totals = {}) {
  const source = totals && typeof totals === "object" && !Array.isArray(totals)
    ? totals
    : {};

  return {
    subtotal: Number(source.subtotal || 0),
    gst: Number(source.gst || 0),
    total: Number(source.total || source.gatewayAmount || source.normalTotal || 0),
    normalTotal: Number(source.normalTotal || source.total || 0),
    gpayDiscount: Number(source.gpayDiscount || 0),
    gpayFinalTotal: Number(source.gpayFinalTotal || 0),
    gatewayAmount: Number(source.gatewayAmount || 0)
  };
}

function buildPublicAddonOrder(order = {}) {
  return {
    id: String(order.id || ""),
    parentOrderId: order.parent_order_id ? String(order.parent_order_id) : "",
    orderSequenceLabel: order.order_sequence_label || "",
    addonSequence: order.addon_sequence || null,
    status: order.status || "new",
    paymentMethod: order.payment_method || "",
    paymentStatus: order.payment_status || "",
    billingStatus: order.billing_status || "",
    items: getSafePublicOrderItems(order.items),
    totals: getSafePublicTotals(order.totals),
    createdAt: order.created_at || ""
  };
}

function buildPublicTrackingOrder(order = {}, actions = {}, addOns = []) {
  return {
    id: String(order.id || ""),
    hotelSlug: order.hotel_slug || "",
    hotelName: order.hotel_name || "",
    orderType: order.order_type || "",
    tableNumber: order.table_number || "",
    orderSource: order.order_source || "",
    status: order.status || "new",
    paymentMethod: order.payment_method || "",
    paymentStatus: order.payment_status || "",
    billingStatus: order.billing_status || "",
    billNumber: order.bill_number || "",
    roomService: {
      roomNumber: order.room_number || "",
      guestName: order.room_service_guest_name || "",
      chargeToRoom: !!order.room_service_charge_to_room
    },
    items: getSafePublicOrderItems(order.items),
    totals: getSafePublicTotals(order.totals),
    createdAt: order.created_at || "",
    addOns: Array.isArray(addOns) ? addOns.map(buildPublicAddonOrder) : [],
    actions
  };
}

async function fetchTrackedOrder({ hotelSlug, orderId, token, selectColumns }) {
  return supabase
    .from("orders")
    .select(selectColumns)
    .eq("hotel_slug", hotelSlug)
    .eq("id", orderId)
    .eq("tracking_token", token)
    .maybeSingle();
}

async function fetchPublicAddonOrders(baseOrder = {}) {
  const hotelSlug = normalizePublicText(baseOrder.hotel_slug, 120);
  const parentOrderId = String(baseOrder.id || "").trim();

  if (!hotelSlug || !parentOrderId || !hasDineInTrackingContext(baseOrder)) {
    return [];
  }

  const { data, error } = await supabase
    .from("orders")
    .select(ADDON_PUBLIC_SELECT)
    .eq("hotel_slug", hotelSlug)
    .eq("parent_order_id", parentOrderId)
    .order("addon_sequence", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) {
    if (isMissingAddonMetadataColumnsError(error)) {
      return [];
    }

    throw error;
  }

  return data || [];
}

router.post("/:hotelSlug/:orderId/support-requests", trackingSupportLimiter, requirePublicFoodModule, async (req, res) => {
  try {
    const hotelSlug = normalizePublicText(req.params.hotelSlug, 120);
    const orderId = normalizePublicText(req.params.orderId, 120);
    const token = normalizePublicText(req.body?.token || req.query.token, 200);
    const requestType = getSupportRequestType(req.body?.requestType || req.body?.action);

    if (!hotelSlug || !orderId || !token) {
      return res.status(400).json({
        success: false,
        message: "Hotel, order id, and tracking token are required"
      });
    }

    if (!requestType) {
      return res.status(400).json({
        success: false,
        message: "Support request type must be bill or help"
      });
    }

    let { data, error } = await fetchTrackedOrder({
      hotelSlug,
      orderId,
      token,
      selectColumns: TRACKING_SELECT_FULL
    });

    if (error && isMissingPublicOptionalColumnError(error) && !isMissingOrderTrackingColumnsError(error)) {
      const fallbackResult = await fetchTrackedOrder({
        hotelSlug,
        orderId,
        token,
        selectColumns: TRACKING_SELECT_CORE
      });

      data = fallbackResult.data;
      error = fallbackResult.error;
    }

    if (error) {
      if (isMissingOrderTrackingColumnsError(error)) {
        return res.status(503).json({
          success: false,
          message: "Order tracking is not initialized yet"
        });
      }

      throw error;
    }

    if (!data) {
      return res.status(404).json({
        success: false,
        message: "Order tracking link is invalid or expired"
      });
    }

    const hotelAccess = await ensurePublicHotelAccess(req, res, data.hotel_slug || hotelSlug, {
      notFoundMessage: "Order tracking link is invalid or expired",
      forbiddenMessage: "This order is not available from the current origin"
    });
    if (!hotelAccess) return;

    if (!hasDineInTrackingContext(data)) {
      return res.status(400).json({
        success: false,
        message: "Table support requests are only available for QR/table orders"
      });
    }

    if (isClosedTrackingStatus(data)) {
      return res.status(409).json({
        success: false,
        message: "This table order is already closed"
      });
    }

    const ownerWhatsAppNumber = await getOwnerWhatsAppNumber(data.hotel_slug || hotelSlug);
    const whatsappLink = buildWhatsAppLink(
      ownerWhatsAppNumber,
      buildTrackingActionMessage(data, requestType === "bill" ? "bill" : "help")
    );
    const database = getTenantMutationClient(req, supabase);
    const scope = env.tenantRuntimeWritesEnabled ? getTenantRequestScope(req) : null;
    const insertPayload = {
      ...(scope ? { tenant_id: scope.tenantId, property_id: scope.propertyId } : {}),
      hotel_slug: scope?.propertySlug || data.hotel_slug || hotelSlug,
      hotel_name: data.hotel_name || "",
      order_id: String(data.id || orderId),
      table_number: data.table_number || "",
      request_type: requestType,
      status: "new",
      order_status: data.status || "new",
      message: buildSupportRequestMessage(data, requestType),
      source: "order_tracking",
      metadata: {
        orderSource: data.order_source || "",
        orderType: data.order_type || ""
      },
      updated_at: new Date().toISOString()
    };

    const { data: supportRequest, error: supportRequestError } = await database
      .from("order_support_requests")
      .insert([insertPayload])
      .select()
      .single();

    if (supportRequestError) {
      if (isMissingSupportRequestsRelationError(supportRequestError)) {
        return res.json({
          success: true,
          saved: false,
          message: "Support request storage is not initialized yet; WhatsApp fallback remains available.",
          whatsappLink
        });
      }

      throw supportRequestError;
    }

    void createNotificationEventSafely({
      databaseClient: database,
      tenantId: scope?.tenantId,
      propertyId: scope?.propertyId,
      hotelSlug: supportRequest.hotel_slug || data.hotel_slug || hotelSlug,
      sourceType: "support_request",
      sourceId: supportRequest.id,
      payload: {
        supportRequestId: supportRequest.id,
        hotelName: supportRequest.hotel_name || data.hotel_name || "",
        hotelSlug: supportRequest.hotel_slug || data.hotel_slug || hotelSlug || "",
        orderId: String(supportRequest.order_id || data.id || orderId),
        tableNumber: supportRequest.table_number || data.table_number || "",
        requestType: supportRequest.request_type || requestType,
        status: supportRequest.status || "new",
        orderStatus: supportRequest.order_status || data.status || "new",
        message: supportRequest.message || insertPayload.message,
        source: supportRequest.source || "order_tracking"
      }
    });

    res.status(201).json({
      success: true,
      saved: true,
      message: "Support request saved",
      whatsappLink,
      supportRequest: buildSupportRequestResponse(supportRequest)
    });
  } catch (error) {
    console.error("Public order support request save error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to save support request"
    });
  }
});

router.post("/:hotelSlug/:orderId/add-items", requirePublicFoodModule, async (req, res) => {
  try {
    const hotelSlug = normalizePublicText(req.params.hotelSlug, 120);
    const orderId = normalizePublicText(req.params.orderId, 120);
    const token = normalizePublicText(req.body?.token || req.query.token, 200);
    const items = getSafeAddonItems(req.body?.items);
    const note = normalizePublicText(req.body?.note, 1000);
    const paymentMethod = normalizePublicText(req.body?.paymentMethod, 30) || "COD";
    const paymentConfirmed = req.body?.paymentConfirmed === true;

    if (!hotelSlug || !orderId || !token) {
      return res.status(400).json({
        success: false,
        message: "Hotel, order id, and tracking token are required"
      });
    }

    if (!items.length) {
      return res.status(400).json({
        success: false,
        message: "At least one add-on item is required"
      });
    }

    const orderingSettings = await fetchHotelOrderingSettings(hotelSlug);

    if (orderingSettings.customerOrderingEnabled === false) {
      return res.status(403).json(buildCustomerOrderingDisabledPayload(orderingSettings));
    }

    const { data: baseOrder, error: baseOrderError } = await fetchTrackedOrder({
      hotelSlug,
      orderId,
      token,
      selectColumns: ADDON_BASE_SELECT
    });

    if (baseOrderError) {
      if (isMissingOrderTrackingColumnsError(baseOrderError)) {
        return res.status(503).json({
          success: false,
          message: "Order tracking is not initialized yet"
        });
      }

      if (isMissingAddonMetadataColumnsError(baseOrderError)) {
        return res.status(503).json({
          success: false,
          message: "Order add-on metadata is not initialized yet"
        });
      }

      throw baseOrderError;
    }

    if (!baseOrder) {
      return res.status(404).json({
        success: false,
        message: "Order tracking link is invalid or expired"
      });
    }

    const hotelAccess = await ensurePublicHotelAccess(req, res, baseOrder.hotel_slug || hotelSlug, {
      notFoundMessage: "Order tracking link is invalid or expired",
      forbiddenMessage: "This order is not available from the current origin"
    });
    if (!hotelAccess) return;

    if (!hasDineInTrackingContext(baseOrder)) {
      return res.status(400).json({
        success: false,
        message: "Add-on orders are only available for QR/table dine-in orders"
      });
    }

    if (isClosedTrackingStatus(baseOrder)) {
      return res.status(409).json({
        success: false,
        message: "This table order is already closed"
      });
    }

    if (isAddonBlockedByBillingOrPayment(baseOrder)) {
      return res.status(409).json({
        success: false,
        message: "This table order is already billed or paid"
      });
    }

    const verifiedPricing = await calculateVerifiedAddonPricing({
      hotelSlug: baseOrder.hotel_slug || hotelSlug,
      items,
      paymentMethod
    });

    if (verifiedPricing.error) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        details: [
          {
            path: ["items"],
            message: verifiedPricing.error
          }
        ]
      });
    }

    let addonSequence;

    try {
      addonSequence = await getNextAddonSequence({
        hotelSlug: baseOrder.hotel_slug || hotelSlug,
        parentOrderId: baseOrder.id
      });
    } catch (error) {
      if (isMissingAddonMetadataColumnsError(error)) {
        return res.status(503).json({
          success: false,
          message: "Order add-on metadata is not initialized yet"
        });
      }

      throw error;
    }

    const sequenceLabel = getAddonSequenceLabel(baseOrder.id, addonSequence);
    const approvedWhatsappMessage = buildAddonOrderSummary({
      baseOrder,
      sequenceLabel,
      paymentMethod,
      paymentConfirmed,
      note,
      items: verifiedPricing.items,
      totals: verifiedPricing.totals
    });
    const database = getTenantMutationClient(req, supabase);
    const scope = env.tenantRuntimeWritesEnabled ? getTenantRequestScope(req) : null;
    const insertPayload = {
      ...(scope ? { tenant_id: scope.tenantId, property_id: scope.propertyId } : {}),
      hotel_name: baseOrder.hotel_name || verifiedPricing.hotel.hotel_name || "",
      hotel_slug: scope?.propertySlug || baseOrder.hotel_slug || verifiedPricing.hotel.hotel_slug || hotelSlug,
      customer_name: baseOrder.customer_name || "Table Guest",
      customer_phone: baseOrder.customer_phone || "",
      customer_address: baseOrder.customer_address || `Dine-in table ${baseOrder.table_number || ""}`.trim(),
      payment_method: paymentMethod || "COD",
      note: note || "",
      items: verifiedPricing.items,
      totals: verifiedPricing.totals,
      whatsapp_message: approvedWhatsappMessage,
      status: "new",
      order_type: "dine-in",
      table_number: baseOrder.table_number || "",
      order_source: baseOrder.order_source || "qr",
      payment_status: isUpiPaymentMethod(paymentMethod) && paymentConfirmed
        ? "customer_confirmed"
        : "unpaid",
      billing_status: "not_billed",
      parent_order_id: String(baseOrder.id),
      order_group_id: baseOrder.order_group_id || String(baseOrder.id),
      order_entry_type: "add_on",
      order_sequence_label: sequenceLabel,
      addon_sequence: addonSequence,
      ...getOrderTrackingColumns()
    };

    const { data: addonOrder, error: addonOrderError } = await database
      .from("orders")
      .insert([insertPayload])
      .select()
      .single();

    if (addonOrderError) {
      if (isMissingAddonMetadataColumnsError(addonOrderError)) {
        return res.status(503).json({
          success: false,
          message: "Order add-on metadata is not initialized yet"
        });
      }

      if (isMissingOrderTrackingColumnsError(addonOrderError)) {
        return res.status(503).json({
          success: false,
          message: "Order tracking is not initialized yet"
        });
      }

      throw addonOrderError;
    }

    void createNotificationEventSafely({
      databaseClient: database,
      tenantId: scope?.tenantId,
      propertyId: scope?.propertyId,
      hotelSlug: addonOrder.hotel_slug || hotelSlug,
      sourceType: "order",
      sourceId: addonOrder.id,
      payload: {
        orderId: addonOrder.id,
        parentOrderId: String(baseOrder.id),
        orderEntryType: "add_on",
        orderSequenceLabel: sequenceLabel,
        hotelName: addonOrder.hotel_name || baseOrder.hotel_name || "",
        customerName: addonOrder.customer_name || baseOrder.customer_name || "",
        customerPhone: addonOrder.customer_phone || baseOrder.customer_phone || "",
        paymentMethod: addonOrder.payment_method || paymentMethod || "COD",
        paymentStatus: addonOrder.payment_status || insertPayload.payment_status,
        billingStatus: addonOrder.billing_status || "not_billed",
        note: addonOrder.note || note || "",
        items: Array.isArray(addonOrder.items) ? addonOrder.items : verifiedPricing.items,
        totals: addonOrder.totals || verifiedPricing.totals,
        whatsappMessage: addonOrder.whatsapp_message || approvedWhatsappMessage,
        orderContext: {
          orderType: "dine-in",
          tableNumber: addonOrder.table_number || baseOrder.table_number || "",
          orderSource: addonOrder.order_source || baseOrder.order_source || "qr"
        },
        status: addonOrder.status || "new"
      }
    });

    const ownerWhatsAppNumber = await getOwnerWhatsAppNumber(addonOrder.hotel_slug || hotelSlug);
    const ownerWhatsappLink = buildWhatsAppLink(ownerWhatsAppNumber, approvedWhatsappMessage);
    const tracking = buildOrderTrackingReference(addonOrder);

    res.status(201).json({
      success: true,
      message: "Add-on order saved",
      order: buildPublicTrackingOrder(addonOrder),
      tracking,
      trackingReady: !!tracking,
      preview: approvedWhatsappMessage,
      ownerWhatsappLink,
      whatsappLinkReady: !!ownerWhatsappLink,
      addon: {
        parentOrderId: String(baseOrder.id),
        sequence: addonSequence,
        label: sequenceLabel
      }
    });
  } catch (error) {
    console.error("Public add-on order save error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to save add-on order"
    });
  }
});

router.get("/:hotelSlug/:orderId", trackingViewLimiter, requirePublicFoodTrackingRead, async (req, res) => {
  try {
    const hotelSlug = normalizePublicText(req.params.hotelSlug, 120);
    const orderId = normalizePublicText(req.params.orderId, 120);
    const token = normalizePublicText(
      req.get("X-Order-Tracking-Token") || req.query.token,
      200
    );

    if (!hotelSlug || !orderId || !token) {
      return res.status(400).json({
        success: false,
        message: "Hotel, order id, and tracking token are required"
      });
    }

    let data;
    let error;
    let ownerWhatsAppNumber;
    let addOns;

    if (env.tenantRuntimePublicOrderTrackingEnabled) {
      const hotelAccess = await ensurePublicHotelAccess(
        req,
        res,
        hotelSlug,
        {
          notFoundMessage: "Order tracking link is invalid or expired",
          forbiddenMessage: "Order tracking is not available for the current origin"
        }
      );
      if (!hotelAccess) return;

      const canonicalSlug = normalizeHotelSlug(hotelAccess.slug);
      const bundle = await fetchTenantPublicOrderTrackingBundle(
        getTenantRequestScope(req),
        canonicalSlug,
        {
          orderId,
          trackingToken: token
        }
      );
      if (!isHotelFeatureEnabled(bundle.featureConfig, "food")) {
        return res.status(403).json(buildFeatureDisabledPayload("food"));
      }

      data = bundle.order;
      ownerWhatsAppNumber = cleanPhone(
        bundle.ownerWhatsAppNumber ||
        process.env.OWNER_WHATSAPP_NUMBER ||
        ""
      );
      addOns = data && hasDineInTrackingContext(data)
        ? bundle.addOns
        : [];
    } else {
      const trackedResult = await fetchTrackedOrder({
        hotelSlug,
        orderId,
        token,
        selectColumns: TRACKING_SELECT_FULL
      });
      data = trackedResult.data;
      error = trackedResult.error;

      if (error && isMissingPublicOptionalColumnError(error) && !isMissingOrderTrackingColumnsError(error)) {
        const fallbackResult = await fetchTrackedOrder({
          hotelSlug,
          orderId,
          token,
          selectColumns: TRACKING_SELECT_CORE
        });

        data = fallbackResult.data;
        error = fallbackResult.error;
      }
    }

    if (error) {
      if (isMissingOrderTrackingColumnsError(error)) {
        return res.status(503).json({
          success: false,
          message: "Order tracking is not initialized yet"
        });
      }

      throw error;
    }

    if (!data) {
      return res.status(404).json({
        success: false,
        message: "Order tracking link is invalid or expired"
      });
    }

    if (!env.tenantRuntimePublicOrderTrackingEnabled) {
      ownerWhatsAppNumber = await getOwnerWhatsAppNumber(data.hotel_slug || hotelSlug);
      addOns = await fetchPublicAddonOrders(data);
    }

    res.json({
      success: true,
      order: buildPublicTrackingOrder(
        data,
        buildTrackingActions(data, ownerWhatsAppNumber),
        addOns
      )
    });
  } catch (error) {
    console.error("Public order tracking fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load order tracking"
    });
  }
});

module.exports = router;
