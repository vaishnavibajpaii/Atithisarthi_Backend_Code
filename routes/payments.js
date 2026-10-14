const express = require("express");
const { env } = require("../config/env");
const { supabase } = require("../utils/supabase");
const { filterEligibleMenuItems } = require("../utils/menu-categories");
const logger = require("../utils/logger");
const { createNotificationEventSafely } = require("../utils/notifications");
const { validateBody } = require("../validators/common");
const {
  paymentFailureSchema,
  paymentInitSchema,
  paymentReconcileSchema,
  paymentVerifySchema
} = require("../validators/payments");
const {
  getPaymentGatewayConfig,
  getPaymentGatewaySafetyIssue,
  isPaymentGatewayConfigured,
  toGatewayMinorAmount
} = require("../utils/payment-gateway");
const {
  PaymentIntegrityError,
  digestJson,
  parseIdempotencyKey
} = require("../payments/payment-domain");
const { PaymentIntentStore, isMissingTask2ASchema } = require("../payments/payment-intent-store");
const { finalizeProviderPayment } = require("../payments/payment-finalizer");
const {
  GatewayResolutionError,
  PURPOSES,
  resolvePaymentGateway
} = require("../payments/payment-gateway-resolver");
const { getTenantRequestScope } = require("../utils/tenant-request-context");
const { notifyPaidOrderAfterFinalization } = require("../payments/paid-order-notification");
const { publicPaymentInitLimiter } = require("../middleware/public-rate-limiters");
const {
  buildOrderTrackingReference,
  getOrderTrackingColumns,
  isMissingOrderTrackingColumnsError
} = require("../utils/order-tracking");
const { ensurePublicHotelAccess } = require("../utils/public-hotel-access");
const { ensureHotelFeatureEnabled } = require("../middleware/require-hotel-feature");
const { resolveVerifiedQrOrderContext } = require("../utils/qr-context");
const {
  buildCustomerOrderingDisabledPayload,
  buildPaymentMethodDisabledPayload,
  fetchHotelOrderingSettings,
  isHotelPaymentMethodEnabled
} = require("../utils/hotel-ordering-settings");
const { buildOrderItemSnapshots } = require("../utils/order-item-snapshots");
const { validateRequestedMenuCombos } = require("../utils/menu-combos");
const { resolveTableForOrder } = require("../utils/restaurant-tables");

const router = express.Router();
const PAYMENT_OPERATION = "FOOD_ORDER_PAYMENT";
const PAYMENT_HARDENING_RELEASE = "TASK_2A_PAYMENT_INTENT_V1";
const paymentIntentStore = new PaymentIntentStore(supabase);
const PAYMENT_GATEWAY_ORDER_COLUMNS = [
  "payment_gateway",
  "gateway_order_id",
  "gateway_payment_id",
  "gateway_signature",
  "gateway_status",
  "payment_verified_at",
  "payment_amount",
  "payment_currency",
  "payment_error",
  "payment_metadata",
  "billing_status",
  "order_type",
  "table_number",
  "order_source",
  "paid_at",
  "payment_status"
];

function normalizeOptionalText(value, maxLength = 80) {
  const text = typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim()
    : "";
  return text.slice(0, maxLength);
}

function getGatewayPaymentAmount(totals, paymentMethod = "") {
  const normalizedPaymentMethod = normalizeOptionalText(paymentMethod, 40).toLowerCase();
  const shouldApplyUpiDiscount =
    normalizedPaymentMethod.includes("upi") ||
    normalizedPaymentMethod.includes("gpay") ||
    normalizedPaymentMethod.includes("google pay");

  return shouldApplyUpiDiscount ? totals.gpayFinalTotal : totals.normalTotal;
}

function hasGatewayDineInTableContext(orderContext = null) {
  return orderContext?.orderType === "dine-in" && !!orderContext.tableNumber;
}

function getGatewayDeliveryCharge(hotel = {}, orderContext = null) {
  if (hasGatewayDineInTableContext(orderContext)) {
    return 0;
  }

  const theme =
    hotel?.theme && typeof hotel.theme === "object" && !Array.isArray(hotel.theme)
      ? hotel.theme
      : {};
  const payment =
    theme.payment && typeof theme.payment === "object" && !Array.isArray(theme.payment)
      ? theme.payment
      : {};
  const candidate = Number(payment.deliveryCharge);

  return Number.isFinite(candidate) && candidate > 0 ? candidate : 0;
}

function buildReceipt(hotelSlug = "") {
  const normalizedSlug = normalizeOptionalText(hotelSlug, 28)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "HOTEL";
  const timestamp = Date.now().toString(36).toUpperCase();

  return `ORD-${normalizedSlug}-${timestamp}`.slice(0, 40);
}

function buildPaymentNotes({ hotelSlug, orderContext, itemCount, paymentRouteSettings }) {
  const safeOrderContext = orderContext && typeof orderContext === "object"
    ? orderContext
    : {};
  const safePaymentRouteSettings =
    paymentRouteSettings && typeof paymentRouteSettings === "object"
      ? paymentRouteSettings
      : {};

  return {
    hotelSlug: normalizeOptionalText(hotelSlug, 120),
    orderType: normalizeOptionalText(safeOrderContext.orderType, 40),
    tableNumber: normalizeOptionalText(safeOrderContext.tableNumber, 80),
    orderSource: normalizeOptionalText(safeOrderContext.orderSource, 40),
    itemCount: String(itemCount || 0),
    routeProvider: normalizeOptionalText(safePaymentRouteSettings.provider, 40),
    routeStatus: normalizeOptionalText(safePaymentRouteSettings.routeStatus, 40)
  };
}

function getPaymentLogMeta({
  requestId = "",
  hotelSlug = "",
  orderId = "",
  gatewayOrderId = "",
  gatewayPaymentId = "",
  paymentMethod = "",
  orderContext = null,
  itemCount = null,
  amount = null,
  provider = "",
  routeStatus = ""
} = {}) {
  const safeOrderContext = orderContext && typeof orderContext === "object"
    ? orderContext
    : {};
  const meta = {};
  const normalizedRequestId = normalizeOptionalText(requestId, 120);
  const normalizedHotelSlug = normalizeOptionalText(hotelSlug, 120);
  const normalizedOrderId = normalizeOptionalText(orderId, 80);
  const normalizedGatewayOrderId = normalizeOptionalText(gatewayOrderId, 120);
  const normalizedGatewayPaymentId = normalizeOptionalText(gatewayPaymentId, 120);
  const normalizedPaymentMethod = normalizeOptionalText(paymentMethod, 60);
  const normalizedProvider = normalizeOptionalText(provider, 40);
  const normalizedRouteStatus = normalizeOptionalText(routeStatus, 40);
  const normalizedOrderType = normalizeOptionalText(safeOrderContext.orderType, 40);
  const normalizedTableNumber = normalizeOptionalText(safeOrderContext.tableNumber, 80);
  const normalizedOrderSource = normalizeOptionalText(safeOrderContext.orderSource, 40);
  const numericItemCount = Number(itemCount);
  const numericAmount = Number(amount);

  if (normalizedRequestId) {
    meta.requestId = normalizedRequestId;
  }

  if (normalizedHotelSlug) {
    meta.hotelSlug = normalizedHotelSlug;
  }

  if (normalizedOrderId) {
    meta.orderId = normalizedOrderId;
  }

  if (normalizedGatewayOrderId) {
    meta.gatewayOrderId = normalizedGatewayOrderId;
  }

  if (normalizedGatewayPaymentId) {
    meta.gatewayPaymentId = normalizedGatewayPaymentId;
  }

  if (normalizedPaymentMethod) {
    meta.paymentMethod = normalizedPaymentMethod;
  }

  if (normalizedOrderType) {
    meta.orderType = normalizedOrderType;
  }

  if (normalizedTableNumber) {
    meta.tableNumber = normalizedTableNumber;
  }

  if (normalizedOrderSource) {
    meta.orderSource = normalizedOrderSource;
  }

  if (Number.isFinite(numericItemCount)) {
    meta.itemCount = numericItemCount;
  }

  if (Number.isFinite(numericAmount)) {
    meta.amount = numericAmount;
  }

  if (normalizedProvider) {
    meta.provider = normalizedProvider;
  }

  if (normalizedRouteStatus) {
    meta.routeStatus = normalizedRouteStatus;
  }

  return meta;
}

function getGatewayOrderContextColumns(orderContext) {
  const safeOrderContext = orderContext && typeof orderContext === "object"
    ? orderContext
    : {};
  const orderType = normalizeOptionalText(safeOrderContext.orderType, 40);
  const tableNumber = normalizeOptionalText(safeOrderContext.tableNumber, 80);
  const orderSource = normalizeOptionalText(safeOrderContext.orderSource, 40);

  if (!orderType && !tableNumber && !orderSource) {
    return {};
  }

  return {
    order_type: orderType || null,
    table_number: tableNumber || null,
    order_source: orderSource || null
  };
}

function isMissingPaymentGatewayColumnsError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();

  return (
    code === "PGRST204" ||
    (
      details.includes("could not find") &&
      PAYMENT_GATEWAY_ORDER_COLUMNS.some((columnName) => details.includes(columnName))
    )
  );
}

function isActiveTableOrderConflict(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = (
    String(error?.message || "") + " " +
    String(error?.details || "") + " " +
    String(error?.hint || "")
  ).toLowerCase();
  return code === "23505" && (
    details.includes("active table order") ||
    details.includes("orders_one_active_root_dine_in_table_guard") ||
    details.includes("uq_orders_one_active_root_dine_in_table")
  );
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

function normalizePaymentRouteSettings(row, hotelSlug = "") {
  const provider = normalizeOptionalText(row?.provider || "razorpay", 40) || "razorpay";
  const linkedAccountId = normalizeOptionalText(row?.razorpay_linked_account_id, 120);
  const routeEnabled = !!row?.route_enabled;
  const routeReady =
    provider === "razorpay" &&
    routeEnabled &&
    /^acc_[A-Za-z0-9]+$/.test(linkedAccountId);

  return {
    hotelSlug: normalizeOptionalText(row?.hotel_slug || hotelSlug, 120),
    provider,
    routeEnabled,
    linkedAccountId,
    routeReady,
    routeStatus: routeReady
      ? "ready"
      : routeEnabled
        ? "missing_linked_account"
        : "disabled"
  };
}

function buildRouteTransferNotes({ hotelSlug, hotelName, orderContext }) {
  const safeOrderContext = orderContext && typeof orderContext === "object"
    ? orderContext
    : {};

  return {
    hotelSlug: normalizeOptionalText(hotelSlug, 120),
    hotelName: normalizeOptionalText(hotelName, 120),
    orderSource: normalizeOptionalText(safeOrderContext.orderSource, 40) || "website",
    orderType: normalizeOptionalText(safeOrderContext.orderType, 40) || "online",
    tableNumber: normalizeOptionalText(safeOrderContext.tableNumber, 80)
  };
}

function getRouteTransferDecision({
  config,
  paymentRouteSettings,
  amountMinor,
  currency
}) {
  const gatewayCurrency = String(currency || config.currency || "INR").trim().toUpperCase();

  if (!config.routeTransfersEnabled) {
    return {
      transferAllowed: false,
      transferStatus: "global_disabled"
    };
  }

  if (!paymentRouteSettings?.routeReady) {
    return {
      transferAllowed: false,
      transferStatus: paymentRouteSettings?.routeStatus || "not_configured"
    };
  }

  if (gatewayCurrency !== "INR") {
    return {
      transferAllowed: false,
      transferStatus: "currency_not_supported"
    };
  }

  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    return {
      transferAllowed: false,
      transferStatus: "invalid_amount"
    };
  }

  return {
    transferAllowed: true,
    transferStatus: "transfer_requested"
  };
}

function buildGatewayRouteTransfers({
  config,
  hotelSlug,
  orderContext,
  paymentContext,
  paymentRouteSettings,
  amountMinor,
  currency
}) {
  const decision = getRouteTransferDecision({
    config,
    paymentRouteSettings,
    amountMinor,
    currency
  });

  if (!decision.transferAllowed) {
    return {
      ...decision,
      transfers: []
    };
  }

  const notes = buildRouteTransferNotes({
    hotelSlug,
    hotelName: paymentContext?.hotel?.hotel_name || "",
    orderContext
  });

  return {
    ...decision,
    transfers: [
      {
        account: paymentRouteSettings.linkedAccountId,
        amount: amountMinor,
        currency: "INR",
        notes,
        linked_account_notes: ["hotelSlug", "hotelName", "orderSource", "orderType"],
        on_hold: false
      }
    ]
  };
}

async function getHotelPaymentRouteSettings(hotelSlug = "") {
  const safeHotelSlug = normalizeOptionalText(hotelSlug, 120);

  if (!safeHotelSlug) {
    return normalizePaymentRouteSettings(null, "");
  }

  const { data, error } = await supabase
    .from("hotel_payment_route_settings")
    .select("hotel_slug,provider,route_enabled,razorpay_linked_account_id")
    .eq("hotel_slug", safeHotelSlug)
    .maybeSingle();

  if (error) {
    if (isMissingPaymentRouteSettingsTableError(error)) {
      return {
        ...normalizePaymentRouteSettings(null, safeHotelSlug),
        routeStatus: "schema_missing"
      };
    }

    throw error;
  }

  if (!data) {
    return {
      ...normalizePaymentRouteSettings(null, safeHotelSlug),
      routeStatus: "not_configured"
    };
  }

  return normalizePaymentRouteSettings(data, safeHotelSlug);
}

function getUpiDiscountPercent(hotel = {}) {
  const candidate = Number(hotel?.theme?.payment?.upiDiscountPercent);

  if (Number.isFinite(candidate)) {
    return Math.min(Math.max(candidate, 0), 100);
  }

  return 10;
}

async function getHotelPaymentContext(hotelSlug) {
  const { data, error } = await supabase
    .from("hotel_profiles")
    .select("hotel_slug,hotel_name,gst_percent,theme")
    .eq("hotel_slug", hotelSlug)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getHotelMenuItemsById(hotelSlug, itemIds = [], consumer = "website") {
  const { data, error } = await supabase
    .from("menu_items")
    .select("hotel_slug,item_id,name,price,item_type,category")
    .eq("hotel_slug", hotelSlug)
    .eq("is_available", true)
    .eq("is_archived", false)
    .in("item_id", itemIds);

  if (error) throw error;

  const eligibleItems = await filterEligibleMenuItems({ supabase, hotelSlug, consumer, menuItems: data || [] });
  return new Map(eligibleItems.map((item) => [String(item.item_id), item]));
}

async function calculateGatewayTotals({ hotelSlug, items, paymentMethod, orderContext }) {
  const hotel = await getHotelPaymentContext(hotelSlug);

  if (!hotel) {
    return {
      error: "Hotel profile not found"
    };
  }

  const uniqueItemIds = [...new Set(items.map((item) => item.id))];
  const menuItemsById = await getHotelMenuItemsById(
    hotelSlug,
    uniqueItemIds,
    String(orderContext?.orderSource || "").toLowerCase() === "qr" ? "qr" : "website"
  );
  const missingItems = uniqueItemIds.filter((itemId) => !menuItemsById.has(itemId));

  if (missingItems.length) {
    return {
      error: `Some menu items are unavailable: ${missingItems.join(", ")}`
    };
  }

  const comboValidation = await validateRequestedMenuCombos({
    hotelSlug,
    requestedItems: items,
    menuItemRows: Array.from(menuItemsById.values())
  });

  if (!comboValidation.ok) {
    return {
      error: comboValidation.error || "Some combo items are unavailable right now"
    };
  }

  const normalizedItems = await buildOrderItemSnapshots({
    hotelSlug,
    requestedItems: items,
    menuItemRows: Array.from(menuItemsById.values())
  });
  const subtotal = normalizedItems.reduce((sum, item) => sum + item.lineTotal, 0);
  const gstPercent = Number(hotel.gst_percent || 5);
  const gst = Math.round((subtotal * gstPercent) / 100);
  const deliveryCharge = getGatewayDeliveryCharge(hotel, orderContext);
  const normalTotal = subtotal + gst + deliveryCharge;
  const upiDiscountPercent = getUpiDiscountPercent(hotel);
  const gpayDiscount = Math.round((normalTotal * upiDiscountPercent) / 100);
  const gpayFinalTotal = Math.max(0, normalTotal - gpayDiscount);
  const gatewayAmount = getGatewayPaymentAmount(
    { normalTotal, gpayFinalTotal },
    paymentMethod
  );

  return {
    hotel,
    items: normalizedItems,
    totals: {
      subtotal,
      gst,
      deliveryCharge,
      gstPercent,
      normalTotal,
      upiDiscountPercent,
      gpayDiscount,
      gpayFinalTotal,
      gatewayAmount
    }
  };
}

function getGatewayPaymentMethodLabel(paymentMethod = "") {
  const normalizedPaymentMethod = normalizeOptionalText(paymentMethod, 60).toLowerCase();

  if (
    normalizedPaymentMethod.includes("upi") ||
    normalizedPaymentMethod.includes("gpay") ||
    normalizedPaymentMethod.includes("google pay")
  ) {
    return "Google Pay / UPI";
  }

  return normalizeOptionalText(paymentMethod, 60) || "Online Payment";
}

function buildPendingGatewayOrderTotals(totals = {}) {
  return {
    subtotal: totals.subtotal || 0,
    gst: totals.gst || 0,
    deliveryCharge: totals.deliveryCharge || 0,
    gstPercent: totals.gstPercent || 0,
    total: totals.gatewayAmount || totals.normalTotal || 0,
    normalTotal: totals.normalTotal || 0,
    upiDiscountPercent: totals.upiDiscountPercent || 0,
    gpayDiscount: totals.gpayDiscount || 0,
    gpayFinalTotal: totals.gpayFinalTotal || 0,
    gatewayAmount: totals.gatewayAmount || totals.normalTotal || 0
  };
}

function getSafePaymentMetadata(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function buildPaymentFailureMetadata({
  existingMetadata,
  gatewayPaymentId,
  reason,
  errorCode,
  errorSource,
  errorStep
}) {
  return {
    ...getSafePaymentMetadata(existingMetadata),
    failure: {
      gatewayPaymentId: normalizeOptionalText(gatewayPaymentId, 200),
      reason: normalizeOptionalText(reason, 500) || "Payment failed or was cancelled",
      errorCode: normalizeOptionalText(errorCode, 120),
      errorSource: normalizeOptionalText(errorSource, 120),
      errorStep: normalizeOptionalText(errorStep, 120),
      recordedAt: new Date().toISOString()
    }
  };
}

function omitTrackingColumns(columns = {}) {
  const {
    tracking_token,
    tracking_token_created_at,
    ...remainingColumns
  } = columns;

  return remainingColumns;
}

function applyOrderNotYetPaidFilter(query) {
  return query.or("payment_status.is.null,payment_status.neq.paid");
}

function getPaymentGatewayReadiness() {
  const config = getPaymentGatewayConfig();
  const safetyIssue = getPaymentGatewaySafetyIssue(config);
  const hasCredentials = Boolean(
    config.provider === "razorpay" &&
    config.razorpay.keyId &&
    config.razorpay.keySecret
  );
  const hasWebhookSecret = Boolean(
    config.provider === "razorpay" &&
    config.razorpay.webhookSecret
  );
  const requiresWebhookSecret = Boolean(config.isProduction && config.provider === "razorpay");
  const webhookReady = !requiresWebhookSecret || hasWebhookSecret;
  const configured = isPaymentGatewayConfigured();
  const reason = !config.enabled
    ? "disabled"
    : safetyIssue || (
        !hasCredentials
          ? "missing_credentials"
          : !webhookReady
            ? "missing_webhook_secret"
            : "ready"
      );

  return {
    enabled: config.enabled,
    configured,
    checkoutAvailable: configured && webhookReady,
    provider: config.provider,
    currency: config.currency,
    mode: config.isProduction ? "production" : "test",
    perHotelGateway: {
      enabled: !!env.perHotelPaymentGatewayEnabled,
      policyControlled: true,
      failClosed: true,
      explicitPolicyRequired:
        !!env.perHotelPaymentGatewayRequireExplicitPolicy
    },
    reason,
    hardening: {
      release: PAYMENT_HARDENING_RELEASE,
      paymentIntentRequired: true,
      intentBeforeProviderOrder: true,
      idempotencyKeyRequired: true,
      finality: "CAPTURED_PROVIDER_EVIDENCE",
      webhookInbox: "DURABLE_LEASED"
    },
    webhook: {
      required: requiresWebhookSecret,
      configured: hasWebhookSecret,
      endpoint: "/api/payments/webhook",
      perPropertyEndpointTemplate: "/api/payments/webhook/razorpay/{webhookRef}",
      worker: {
        enabled: !!env.paymentWebhookWorkerEnabled,
        intervalMs: env.paymentWebhookWorkerIntervalMs
      }
    },
    route: {
      transferCreationEnabled: !!config.routeTransfersEnabled,
      transferCreationGate:
        "Requires PAYMENT_ROUTE_TRANSFERS_ENABLED=true and per-hotel routeEnabled=true with acc_ linked account"
    }
  };
}

async function getIntentLinkedOrder(intent) {
  if (!intent?.business_order_id) return null;
  const { data, error } = await supabase.from("orders")
    .select("id,hotel_slug,status,payment_status,gateway_status,gateway_order_id,payment_amount,payment_currency,tracking_token")
    .eq("id", intent.business_order_id).eq("hotel_slug", intent.hotel_slug).maybeSingle();
  if (error) throw error;
  return data || null;
}

function buildIdempotentPaymentResponse(intent, order, fallbackContext = {}) {
  const context = intent?.context && typeof intent.context === "object" ? intent.context : fallbackContext;
  return {
    success: true,
    idempotent: true,
    message: "Existing payment initiation returned",
    paymentIntentId: intent.id,
    payment: {
      provider: intent.provider,
      keyId: getPaymentGatewayConfig().razorpay.keyId,
      gatewayOrderId: intent.provider_order_id,
      gatewayStatus: intent.provider_status || String(intent.status || "").toLowerCase(),
      amount: Number(intent.expected_amount_minor) / 100,
      amountMinor: Number(intent.expected_amount_minor),
      currency: intent.currency,
      receipt: context.receipt || ""
    },
    order,
    tracking: buildOrderTrackingReference(order),
    trackingReady: !!order?.tracking_token,
    orderLinked: !!order,
    orderLinkReason: order ? "existing" : "pending_reconciliation",
    hotel: context.hotel || { slug: intent.hotel_slug, name: "" },
    paymentRoute: context.paymentRoute || null,
    totals: context.totals || null,
    items: context.items || null,
    requiresReconciliation: !!intent.requires_reconciliation
  };
}

function findCapturedGatewayPayment(payments = []) {
  return payments.find((payment) => (
    payment &&
    (
      payment.captured === true ||
      String(payment.status || "").trim().toLowerCase() === "captured"
    )
  )) || null;
}

function findFailedGatewayPayment(payments = []) {
  return payments.find((payment) => (
    payment &&
    String(payment.status || "").trim().toLowerCase() === "failed"
  )) || null;
}

function getGatewayPaymentFailureReason(payment = {}) {
  return (
    normalizeOptionalText(payment.error_description, 500) ||
    normalizeOptionalText(payment.error_reason, 500) ||
    normalizeOptionalText(payment.error_code, 500) ||
    "Payment failed or was cancelled"
  );
}

async function createPendingGatewayLinkedOrder({
  hotelSlug,
  paymentMethod,
  orderContext,
  restaurantTableId,
  orderDraft,
  paymentContext,
  gatewayOrder,
  paymentRouteSettings,
  paymentRouteTransfer,
  logMeta = {}
}) {
  if (!orderDraft) {
    return {
      created: false,
      reason: "order_draft_not_provided"
    };
  }

  const config = getPaymentGatewayConfig();
  const gatewayAmount = gatewayOrder.amount || paymentContext.totals.gatewayAmount || 0;
  const gatewayCurrency = gatewayOrder.currency || config.currency;
  const baseOrderRow = {
    hotel_name:
      paymentContext.hotel.hotel_name ||
      orderDraft.hotelName ||
      "Unknown Hotel",
    hotel_slug: hotelSlug,
    customer_name: orderDraft.customerName,
    customer_phone: orderDraft.customerPhone,
    customer_address: orderDraft.customerAddress,
    payment_method: getGatewayPaymentMethodLabel(paymentMethod),
    note: orderDraft.note || "",
    items: paymentContext.items,
    totals: buildPendingGatewayOrderTotals(paymentContext.totals),
    whatsapp_message: orderDraft.whatsappMessage || "",
    status: "payment_pending"
  };
  const optionalOrderColumns = {
    ...getGatewayOrderContextColumns(orderContext),
    ...(restaurantTableId ? { restaurant_table_id: restaurantTableId } : {}),
    billing_status: "not_billed",
    payment_status: "unpaid",
    payment_gateway: config.provider,
    gateway_order_id: gatewayOrder.gatewayOrderId,
    gateway_status: gatewayOrder.gatewayStatus || "created",
    payment_amount: gatewayAmount,
    payment_currency: gatewayCurrency,
    payment_metadata: {
      receipt: gatewayOrder.receipt || "",
      amountMinor: gatewayOrder.amountMinor || 0,
      keyId: gatewayOrder.keyId || "",
      paymentMethod: getGatewayPaymentMethodLabel(paymentMethod),
      route: paymentRouteSettings
        ? {
            provider: paymentRouteSettings.provider || "razorpay",
            routeEnabled: !!paymentRouteSettings.routeEnabled,
            routeReady: !!paymentRouteSettings.routeReady,
            routeStatus: paymentRouteSettings.routeStatus || "disabled",
            transferStatus:
              paymentRouteTransfer?.transferStatus ||
              paymentRouteSettings.routeStatus ||
              "disabled",
            transferRequested: !!paymentRouteTransfer?.transferAllowed,
            linkedAccountId: paymentRouteSettings.linkedAccountId || "",
            gatewayTransfers: Array.isArray(gatewayOrder.transfers)
              ? gatewayOrder.transfers.map((transfer) => ({
                  id: transfer.id || "",
                  status: transfer.status || transfer.transfer_status || "",
                  recipient: transfer.recipient || transfer.account || "",
                  amount: transfer.amount || 0,
                  currency: transfer.currency || ""
                }))
              : []
          }
        : {
            provider: "razorpay",
            routeEnabled: false,
            routeReady: false,
            routeStatus: "not_checked",
            transferStatus: "not_checked",
            transferRequested: false,
            linkedAccountId: ""
          },
      createdBy: "payment_init"
    },
    ...getOrderTrackingColumns()
  };

  let insertAttempt = await supabase
    .from("orders")
    .insert([{ ...baseOrderRow, ...optionalOrderColumns }])
    .select("id,hotel_slug,status,payment_status,gateway_status,gateway_order_id,payment_amount,payment_currency,tracking_token")
    .single();

  if (insertAttempt.error && isMissingOrderTrackingColumnsError(insertAttempt.error)) {
    logger.warn(
      "Order tracking columns are not available yet. Retrying payment-linked order save without tracking columns.",
      {
        ...logMeta,
        paymentStage: "init",
        insertStage: "pending_order_insert",
        fallback: "omit_tracking_columns"
      }
    );

    insertAttempt = await supabase
      .from("orders")
      .insert([{ ...baseOrderRow, ...omitTrackingColumns(optionalOrderColumns) }])
      .select("id,hotel_slug,status,payment_status,gateway_status,gateway_order_id,payment_amount,payment_currency")
      .single();
  }

  const { data, error } = insertAttempt;

  if (error) {
    if (isMissingPaymentGatewayColumnsError(error)) {
      return {
        created: false,
        reason: "payment_gateway_schema_missing"
      };
    }

    throw error;
  }

  return {
    created: true,
    reason: "created",
    order: data,
    tracking: buildOrderTrackingReference(data)
  };
}

async function markLinkedOrderPaidFromVerifiedGateway({
  hotelSlug,
  orderId,
  gatewayOrderId,
  gatewayPaymentId,
  gatewaySignature
}) {
  if (!hotelSlug || !orderId) {
    return {
      updated: false,
      reason: "order_link_not_provided"
    };
  }

  const { data: existingOrder, error: existingOrderError } = await supabase
    .from("orders")
    .select("id,hotel_slug,status,gateway_order_id,payment_status")
    .eq("id", orderId)
    .eq("hotel_slug", hotelSlug)
    .maybeSingle();

  if (existingOrderError) {
    if (isMissingPaymentGatewayColumnsError(existingOrderError)) {
      return {
        updated: false,
        reason: "payment_gateway_schema_missing"
      };
    }

    throw existingOrderError;
  }

  if (!existingOrder) {
    return {
      updated: false,
      reason: "order_not_found_for_hotel"
    };
  }

  if (!existingOrder.gateway_order_id) {
    return {
      updated: false,
      reason: "gateway_order_not_linked"
    };
  }

  if (existingOrder.gateway_order_id !== gatewayOrderId) {
    return {
      updated: false,
      reason: "gateway_order_mismatch"
    };
  }

  const shouldCreateOperationalNotification =
    existingOrder.status === "payment_pending" &&
    existingOrder.payment_status !== "paid";

  const verifiedAt = new Date().toISOString();
  const config = getPaymentGatewayConfig();
  const updatePayload = {
    payment_gateway: config.provider,
    gateway_payment_id: gatewayPaymentId,
    gateway_status: "paid",
    payment_status: "paid",
    payment_verified_at: verifiedAt,
    paid_at: verifiedAt
  };

  if (gatewaySignature) {
    updatePayload.gateway_signature = gatewaySignature;
  }

  if (existingOrder.status === "payment_pending") {
    updatePayload.status = "new";
  }

  const paidOrderUpdateQuery = applyOrderNotYetPaidFilter(
    supabase
      .from("orders")
      .update(updatePayload)
      .eq("id", orderId)
      .eq("hotel_slug", hotelSlug)
      .eq("gateway_order_id", gatewayOrderId)
  );

  const { data, error } = await paidOrderUpdateQuery
    .select("id,hotel_slug,hotel_name,customer_name,customer_phone,customer_address,payment_method,payment_status,billing_status,note,items,totals,whatsapp_message,status,table_number,order_type,order_source,gateway_status,gateway_order_id,gateway_payment_id,payment_verified_at,paid_at")
    .maybeSingle();

  if (error) {
    if (isMissingPaymentGatewayColumnsError(error)) {
      return {
        updated: false,
        reason: "payment_gateway_schema_missing"
      };
    }

    throw error;
  }

  if (data && shouldCreateOperationalNotification) {
    void createNotificationEventSafely({
      hotelSlug: data.hotel_slug || hotelSlug || null,
      sourceType: "order",
      sourceId: data.id,
      payload: {
        orderId: data.id,
        hotelName: data.hotel_name || "",
        customerName: data.customer_name || "",
        customerPhone: data.customer_phone || "",
        customerAddress: data.customer_address || "",
        paymentMethod: data.payment_method || "Online Payment",
        paymentStatus: data.payment_status || "paid",
        billingStatus: data.billing_status || null,
        note: data.note || "",
        items: Array.isArray(data.items) ? data.items : [],
        totals:
          data.totals && typeof data.totals === "object" && !Array.isArray(data.totals)
            ? data.totals
            : {},
        whatsappMessage: data.whatsapp_message || "",
        orderContext: {
          orderType: data.order_type || "",
          tableNumber: data.table_number || "",
          orderSource: data.order_source || ""
        },
        status: data.status || "new"
      }
    });
  }

  return {
    updated: !!data,
    reason: data ? "updated" : "already_paid_by_other_request",
    order: data || null
  };
}

async function markLinkedOrderPaymentFailed({
  hotelSlug,
  orderId,
  gatewayOrderId,
  gatewayPaymentId,
  reason,
  errorCode,
  errorSource,
  errorStep
}) {
  const { data: existingOrder, error: existingOrderError } = await supabase
    .from("orders")
    .select("id,hotel_slug,status,gateway_order_id,gateway_payment_id,payment_status,gateway_status,payment_metadata")
    .eq("id", orderId)
    .eq("hotel_slug", hotelSlug)
    .maybeSingle();

  if (existingOrderError) {
    if (isMissingPaymentGatewayColumnsError(existingOrderError)) {
      return {
        updated: false,
        reason: "payment_gateway_schema_missing"
      };
    }

    throw existingOrderError;
  }

  if (!existingOrder) {
    return {
      updated: false,
      reason: "order_not_found_for_hotel"
    };
  }

  if (!existingOrder.gateway_order_id) {
    return {
      updated: false,
      reason: "gateway_order_not_linked"
    };
  }

  if (existingOrder.gateway_order_id !== gatewayOrderId) {
    return {
      updated: false,
      reason: "gateway_order_mismatch"
    };
  }

  if (
    existingOrder.payment_status === "paid" ||
    existingOrder.gateway_status === "paid"
  ) {
    return {
      updated: false,
      reason: "already_paid_not_updated"
    };
  }

  if (!["payment_pending", "payment_failed"].includes(existingOrder.status)) {
    return {
      updated: false,
      reason: "order_not_pending"
    };
  }

  const normalizedGatewayPaymentId = normalizeOptionalText(gatewayPaymentId, 200);
  const hasConfirmedGatewayPaymentFailure = !!normalizedGatewayPaymentId;

  const updatePayload = {
    payment_error: normalizeOptionalText(reason, 500) || "Payment failed or was cancelled",
    payment_metadata: buildPaymentFailureMetadata({
      existingMetadata: existingOrder.payment_metadata,
      gatewayPaymentId: normalizedGatewayPaymentId,
      reason,
      errorCode,
      errorSource,
      errorStep
    })
  };

  if (hasConfirmedGatewayPaymentFailure) {
    updatePayload.gateway_status = "failed";
    updatePayload.payment_status = "unpaid";
    updatePayload.gateway_payment_id = normalizedGatewayPaymentId;
  }

  if (hasConfirmedGatewayPaymentFailure && existingOrder.status === "payment_pending") {
    updatePayload.status = "payment_failed";
  }

  const failedOrderUpdateQuery = applyOrderNotYetPaidFilter(
    supabase
      .from("orders")
      .update(updatePayload)
      .eq("id", orderId)
      .eq("hotel_slug", hotelSlug)
      .eq("gateway_order_id", gatewayOrderId)
  );

  const { data, error } = await failedOrderUpdateQuery
    .select("id,hotel_slug,status,payment_status,gateway_status,gateway_order_id,gateway_payment_id,payment_error,payment_metadata")
    .maybeSingle();

  if (error) {
    if (isMissingPaymentGatewayColumnsError(error)) {
      return {
        updated: false,
        reason: "payment_gateway_schema_missing"
      };
    }

    throw error;
  }

  return {
    updated: !!data,
    reason: data
      ? (
          hasConfirmedGatewayPaymentFailure
            ? "updated"
            : "failure_recorded_without_gateway_payment"
        )
      : "already_paid_by_other_request",
    order: data || null
  };
}

router.get("/readiness", (req, res) => {
  res.json({
    success: true,
    paymentGateway: getPaymentGatewayReadiness()
  });
});

router.post("/init", publicPaymentInitLimiter, validateBody(paymentInitSchema), async (req, res) => {
  let paymentLogMeta = getPaymentLogMeta({
    requestId: req.requestId || ""
  });

  try {
    const {
      hotelSlug,
      paymentMethod = "UPI",
      items,
      orderContext,
      orderDraft
    } = req.validatedBody;
    const idempotencyKey = parseIdempotencyKey(req.get("Idempotency-Key"));

    if (!orderDraft) {
      throw new PaymentIntegrityError(
        "PAYMENT_ORDER_DRAFT_REQUIRED",
        "Order details are required before online payment can be initiated.",
        400
      );
    }

    const hotelAccess = await ensurePublicHotelAccess(req, res, hotelSlug, {
      notFoundMessage: "Hotel is not available for online payment",
      forbiddenMessage: "This hotel cannot accept payment requests from the current origin"
    });

    if (!hotelAccess) {
      return;
    }

    if (!(await ensureHotelFeatureEnabled(res, { featureKey: "food", hotelSlug }))) {
      return;
    }

    const orderingSettings = await fetchHotelOrderingSettings(hotelSlug);

    if (orderingSettings.customerOrderingEnabled === false) {
      return res.status(403).json(buildCustomerOrderingDisabledPayload(orderingSettings));
    }
    if (!isHotelPaymentMethodEnabled(orderingSettings, "ONLINE_GATEWAY")) {
      return res.status(409).json(
        buildPaymentMethodDisabledPayload(orderingSettings, "ONLINE_GATEWAY")
      );
    }

    const resolvedOrderContext = resolveVerifiedQrOrderContext({
      hotelSlug,
      orderContext
    });

    if (!resolvedOrderContext.ok) {
      return res.status(400).json({
        success: false,
        message: resolvedOrderContext.message
      });
    }

    const tableResolution = hasGatewayDineInTableContext(resolvedOrderContext.orderContext)
      ? await resolveTableForOrder({
          hotelSlug,
          tableNumber: resolvedOrderContext.orderContext.tableNumber,
          enforceTableMaster: orderingSettings.enforceTableMaster
        })
      : null;

    if (tableResolution && !tableResolution.ok) {
      return res.status(tableResolution.status || 400).json({
        success: false,
        code: tableResolution.code,
        message: tableResolution.message
      });
    }

    const safeOrderContext = tableResolution
      ? { ...resolvedOrderContext.orderContext, tableNumber: tableResolution.tableNumber }
      : resolvedOrderContext.orderContext;
    paymentLogMeta = getPaymentLogMeta({
      requestId: req.requestId || "",
      hotelSlug,
      paymentMethod,
      orderContext: safeOrderContext,
      itemCount: Array.isArray(items) ? items.length : 0
    });
    const paymentContext = await calculateGatewayTotals({
      hotelSlug,
      items,
      paymentMethod,
      orderContext: safeOrderContext
    });

    if (paymentContext.error) {
      return res.status(400).json({
        success: false,
        message: paymentContext.error
      });
    }

    const config = getPaymentGatewayConfig();
    const tenantScope = getTenantRequestScope(req);
    let gatewayResolution = await resolvePaymentGateway({
      tenantId: tenantScope.tenantId,
      propertyId: tenantScope.propertyId,
      provider: config.provider,
      purpose: PURPOSES.NEW_PAYMENT
    });
    let adapter = gatewayResolution.adapter;
    const receipt = buildReceipt(hotelSlug);
    const paymentRouteSettings = await getHotelPaymentRouteSettings(hotelSlug);
    paymentLogMeta = getPaymentLogMeta({
      ...paymentLogMeta,
      amount: paymentContext?.totals?.gatewayAmount,
      provider: config.provider,
      routeStatus: paymentRouteSettings.routeStatus
    });
    const amountMinor = toGatewayMinorAmount(paymentContext.totals.gatewayAmount);
    const paymentRouteTransfer = buildGatewayRouteTransfers({
      config: {
        ...config,
        routeTransfersEnabled: gatewayResolution.kind === "LEGACY_GLOBAL" && config.routeTransfersEnabled
      },
      hotelSlug,
      orderContext: safeOrderContext,
      paymentContext,
      paymentRouteSettings,
      amountMinor,
      currency: config.currency
    });
    const paymentNotes = buildPaymentNotes({
        hotelSlug,
        orderContext: safeOrderContext,
        itemCount: paymentContext.items.length,
        paymentRouteSettings
      });
    const intentContext = {
      receipt,
      hotel: { slug: paymentContext.hotel.hotel_slug, name: paymentContext.hotel.hotel_name || "" },
      totals: paymentContext.totals,
      items: paymentContext.items,
      paymentMethod: getGatewayPaymentMethodLabel(paymentMethod),
      orderContext: safeOrderContext,
      paymentRoute: {
        provider: paymentRouteSettings.provider,
        routeEnabled: paymentRouteSettings.routeEnabled,
        routeReady: paymentRouteSettings.routeReady,
        routeStatus: paymentRouteSettings.routeStatus,
        transferStatus: paymentRouteTransfer.transferStatus,
        transferRequested: paymentRouteTransfer.transferAllowed
      }
    };
    const requestDigest = digestJson({
      hotelSlug, operation: PAYMENT_OPERATION, paymentMethod,
      amountMinor, currency: config.currency, items: paymentContext.items,
      orderContext: safeOrderContext, orderDraft
    });
    const intentResult = await paymentIntentStore.createOrReuse({
      tenantId: tenantScope.tenantId, propertyId: tenantScope.propertyId,
      hotelSlug, operation: PAYMENT_OPERATION, provider: adapter.provider,
      merchantRef: adapter.merchantRef, credentialRef: adapter.credentialRef,
      gatewayAccountId: gatewayResolution.gatewayAccountId,
      expectedAmountMinor: amountMinor, currency: config.currency,
      idempotencyKey, requestDigest, context: intentContext
    });
    let paymentIntent = intentResult.intent;

    if (intentResult.reused) {
      gatewayResolution = await resolvePaymentGateway({
        tenantId: paymentIntent.tenant_id,
        propertyId: paymentIntent.property_id,
        provider: paymentIntent.provider,
        purpose: PURPOSES.VERIFY,
        paymentIntent
      });
      adapter = gatewayResolution.adapter;
      const existingOrder = await getIntentLinkedOrder(paymentIntent);
      if (paymentIntent.provider_order_id || paymentIntent.provider_creation_started_at) {
        return res.status(paymentIntent.provider_order_id ? 200 : 202)
          .json(buildIdempotentPaymentResponse(paymentIntent, existingOrder, intentContext));
      }
    }

    paymentIntent = await paymentIntentStore.claimProviderCreation(paymentIntent.id);
    if (paymentIntent.provider_order_id || paymentIntent.requires_reconciliation) {
      const existingOrder = await getIntentLinkedOrder(paymentIntent);
      return res.status(paymentIntent.provider_order_id ? 200 : 202)
        .json(buildIdempotentPaymentResponse(paymentIntent, existingOrder, intentContext));
    }

    let gatewayOrder;
    try {
      gatewayOrder = await adapter.createPaymentOrder({
        amountMinor, currency: config.currency, receipt, notes: paymentNotes,
        transfers: paymentRouteTransfer.transfers
      });
      if (gatewayOrder.merchantRef !== paymentIntent.merchant_ref ||
          gatewayOrder.credentialRef !== paymentIntent.credential_ref) {
        throw new PaymentIntegrityError(
          "PAYMENT_GATEWAY_BINDING_MISMATCH",
          "Provider order credential does not match the PaymentIntent",
          409
        );
      }
    } catch (providerError) {
      if (providerError?.uncertain || providerError?.code === "PROVIDER_TIMEOUT") {
        paymentIntent = await paymentIntentStore.markReconciliationRequired(
          paymentIntent.id, providerError.code, providerError.message
        );
        return res.status(202).json({
          success: true,
          pending: true,
          paymentIntentId: paymentIntent.id,
          requiresReconciliation: true,
          message: "Payment initiation outcome is being reconciled. Do not submit another payment."
        });
      }
      throw providerError;
    }
    try {
      paymentIntent = await paymentIntentStore.attachProviderOrder(
        paymentIntent.id, gatewayOrder.gatewayOrderId, null
      );
    } catch (attachError) {
      logger.error("Provider order created but local intent attachment failed", {
        ...paymentLogMeta,
        paymentIntentId: paymentIntent.id,
        gatewayOrderId: gatewayOrder.gatewayOrderId,
        paymentStage: "provider_order_attach",
        errorCode: attachError.code || "PROVIDER_ORDER_ATTACH_FAILED"
      });
      try {
        await paymentIntentStore.markReconciliationRequired(
          paymentIntent.id, "PROVIDER_ORDER_ATTACH_FAILED", attachError.message
        );
      } catch {
        // provider_creation_started_at remains the durable no-retry guard even
        // when the database cannot accept the reconciliation marker.
      }
      return res.status(202).json({
        success: true,
        pending: true,
        paymentIntentId: paymentIntent.id,
        gatewayOrderId: gatewayOrder.gatewayOrderId,
        requiresReconciliation: true,
        message: "Payment order creation requires reconciliation. Do not retry payment."
      });
    }
    const pendingOrder = await createPendingGatewayLinkedOrder({
      hotelSlug,
      paymentMethod,
      orderContext: safeOrderContext,
      restaurantTableId: tableResolution?.restaurantTableId || null,
      orderDraft,
      paymentContext,
      gatewayOrder,
      paymentRouteSettings,
      paymentRouteTransfer,
      logMeta: getPaymentLogMeta({
        ...paymentLogMeta,
        gatewayOrderId: gatewayOrder.gatewayOrderId
      })
    });
    if (!pendingOrder.created || !pendingOrder.order?.id) {
      await paymentIntentStore.markReconciliationRequired(
        paymentIntent.id, "LOCAL_ORDER_LINK_FAILED", pendingOrder.reason
      );
      return res.status(202).json({
        success: true, pending: true, paymentIntentId: paymentIntent.id,
        gatewayOrderId: gatewayOrder.gatewayOrderId, requiresReconciliation: true,
        message: "Payment order was created and is awaiting safe local reconciliation. Do not retry payment."
      });
    }
    paymentIntent = await paymentIntentStore.attachProviderOrder(
      paymentIntent.id, gatewayOrder.gatewayOrderId, String(pendingOrder.order.id)
    );

    res.status(201).json({
      success: true,
      message: "Payment order created",
      paymentIntentId: paymentIntent.id,
      payment: {
        provider: gatewayOrder.provider,
        keyId: gatewayOrder.keyId,
        gatewayOrderId: gatewayOrder.gatewayOrderId,
        gatewayStatus: gatewayOrder.gatewayStatus,
        amount: gatewayOrder.amount,
        amountMinor: gatewayOrder.amountMinor,
        currency: gatewayOrder.currency,
        receipt: gatewayOrder.receipt
      },
      order: pendingOrder.order || null,
      tracking: pendingOrder.tracking || null,
      trackingReady: !!pendingOrder.tracking,
      orderLinked: pendingOrder.created,
      orderLinkReason: pendingOrder.reason,
      hotel: {
        slug: paymentContext.hotel.hotel_slug,
        name: paymentContext.hotel.hotel_name || ""
      },
      paymentRoute: {
        provider: paymentRouteSettings.provider,
        routeEnabled: paymentRouteSettings.routeEnabled,
        routeReady: paymentRouteSettings.routeReady,
        routeStatus: paymentRouteSettings.routeStatus,
        transferStatus: paymentRouteTransfer.transferStatus,
        transferRequested: paymentRouteTransfer.transferAllowed
      },
      totals: paymentContext.totals,
      items: paymentContext.items
    });
  } catch (error) {
    if (error instanceof PaymentIntegrityError || error instanceof GatewayResolutionError) {
      return res.status(error.httpStatus).json({ success: false, code: error.code, message: error.message });
    }
    if (isMissingTask2ASchema(error)) {
      return res.status(503).json({
        success: false,
        code: "PAYMENT_HARDENING_SCHEMA_NOT_READY",
        message: "Online payment hardening schema is not ready. Payment was not initiated."
      });
    }
    if (isActiveTableOrderConflict(error)) {
      return res.status(409).json({
        success: false,
        code: "TABLE_HAS_ACTIVE_ORDER",
        message: "This table already has an active order. Open the existing order instead."
      });
    }

    logger.error("Payment init error", {
      ...paymentLogMeta,
      paymentStage: "init",
      errorMessage: error.message
    });
    res.status(500).json({
      success: false,
      message: "Failed to create payment order"
    });
  }
});

router.post("/verify", validateBody(paymentVerifySchema), async (req, res) => {
  let paymentLogMeta = getPaymentLogMeta({
    requestId: req.requestId || ""
  });

  try {
    const {
      paymentIntentId = "",
      hotelSlug = "",
      orderId = "",
      gatewayOrderId,
      gatewayPaymentId,
      gatewaySignature
    } = req.validatedBody;
    paymentLogMeta = getPaymentLogMeta({
      requestId: req.requestId || "",
      hotelSlug,
      orderId,
      gatewayOrderId,
      gatewayPaymentId,
      provider: getPaymentGatewayConfig().provider
    });

    if (hotelSlug) {
      const hotelAccess = await ensurePublicHotelAccess(req, res, hotelSlug, {
        notFoundMessage: "Hotel is not available for payment verification",
        forbiddenMessage: "This hotel cannot verify payments from the current origin"
      });

      if (!hotelAccess) {
        return;
      }
    }

    const paymentIntent = await paymentIntentStore.findForVerification({
      intentId: paymentIntentId,
      hotelSlug,
      businessOrderId: orderId,
      providerOrderId: gatewayOrderId
    });
    if (!paymentIntent) {
      throw new PaymentIntegrityError(
        "PAYMENT_INTENT_NOT_FOUND",
        "A durable payment intent is required before payment can be finalized.",
        409
      );
    }
    const gatewayResolution = await resolvePaymentGateway({
      tenantId: paymentIntent.tenant_id,
      propertyId: paymentIntent.property_id,
      provider: paymentIntent.provider,
      purpose: PURPOSES.VERIFY,
      paymentIntent
    });
    const adapter = gatewayResolution.adapter;
    const isVerified = adapter.verifyCheckoutEvidence({
      gatewayOrderId,
      gatewayPaymentId,
      gatewaySignature
    });

    if (!isVerified) {
      logger.warn("Payment verification failed", {
        ...paymentLogMeta,
        paymentStage: "verify",
        verifyResult: "signature_mismatch"
      });
      return res.status(400).json({
        success: false,
        message: "Payment verification failed"
      });
    }
    const { evidence: providerEvidence, finalization } = await finalizeProviderPayment({
      intent: paymentIntent, paymentId: gatewayPaymentId, adapter,
      store: paymentIntentStore, source: "CHECKOUT_VERIFY",
      evidenceContext: { gatewayOrderId, gatewayPaymentId }
    });
    const finalizedOrder = await getIntentLinkedOrder(paymentIntent);
    if (finalization?.orderUpdated) {
      void notifyPaidOrderAfterFinalization({ db: supabase, intent: paymentIntent });
    }

    res.json({
      success: true,
      message: finalization?.orderUpdated
        ? "Payment verified and order marked paid"
        : "Payment verified",
      paymentIntentId: paymentIntent.id,
      payment: {
        provider: adapter.provider,
        gatewayOrderId,
        gatewayPaymentId,
        verified: true,
        captured: true,
        status: providerEvidence.status,
        amountMinor: providerEvidence.amountMinor,
        currency: providerEvidence.currency
      },
      orderUpdated: !!finalization?.orderUpdated,
      orderUpdateReason: finalization?.idempotent ? "already_paid_same_payment" : "captured_and_bound",
      order: finalizedOrder
    });
  } catch (error) {
    if (error instanceof PaymentIntegrityError || error instanceof GatewayResolutionError) {
      logger.warn("Payment finality validation rejected", {
        ...paymentLogMeta, paymentStage: "verify", verifyResult: error.code
      });
      return res.status(error.httpStatus).json({
        success: false, code: error.code, message: error.message
      });
    }
    if (isMissingTask2ASchema(error)) {
      return res.status(503).json({
        success: false, code: "PAYMENT_HARDENING_SCHEMA_NOT_READY",
        message: "Payment verification is unavailable until the hardening schema is ready."
      });
    }
    if (error?.code === "PROVIDER_TIMEOUT") {
      return res.status(503).json({
        success: false, code: "PROVIDER_STATUS_UNKNOWN",
        message: "Payment status could not be confirmed. It remains pending reconciliation."
      });
    }
    logger.error("Payment verify error", {
      ...paymentLogMeta,
      paymentStage: "verify",
      errorMessage: error.message
    });
    res.status(500).json({
      success: false,
      message: "Failed to verify payment"
    });
  }
});

router.post("/reconcile", validateBody(paymentReconcileSchema), async (req, res) => {
  let paymentLogMeta = getPaymentLogMeta({
    requestId: req.requestId || ""
  });

  try {
    const {
      paymentIntentId = "",
      hotelSlug,
      orderId,
      gatewayOrderId
    } = req.validatedBody;
    paymentLogMeta = getPaymentLogMeta({
      requestId: req.requestId || "",
      hotelSlug,
      orderId,
      gatewayOrderId,
      provider: getPaymentGatewayConfig().provider
    });

    const hotelAccess = await ensurePublicHotelAccess(req, res, hotelSlug, {
      notFoundMessage: "Hotel is not available for payment reconciliation",
      forbiddenMessage: "This hotel cannot reconcile payments from the current origin"
    });

    if (!hotelAccess) {
      return;
    }

    const paymentIntent = await paymentIntentStore.findForVerification({
      intentId: paymentIntentId, hotelSlug, businessOrderId: orderId, providerOrderId: gatewayOrderId
    });
    if (!paymentIntent) {
      throw new PaymentIntegrityError(
        "PAYMENT_INTENT_NOT_FOUND",
        "A durable payment intent is required for reconciliation.",
        409
      );
    }
    const gatewayResolution = await resolvePaymentGateway({
      tenantId: paymentIntent.tenant_id,
      propertyId: paymentIntent.property_id,
      provider: paymentIntent.provider,
      purpose: PURPOSES.RECONCILE,
      paymentIntent
    });
    const adapter = gatewayResolution.adapter;
    const providerPayments = await adapter.getOrderPayments(gatewayOrderId);
    const capturedPayment = findCapturedGatewayPayment(providerPayments);

    if (capturedPayment) {
      const { evidence: providerEvidence, finalization } = await finalizeProviderPayment({
        intent: paymentIntent, paymentId: capturedPayment.id || "", adapter,
        store: paymentIntentStore, source: "RECONCILIATION",
        evidenceContext: { gatewayOrderId }
      });
      const order = await getIntentLinkedOrder(paymentIntent);
      if (finalization?.orderUpdated) {
        void notifyPaidOrderAfterFinalization({ db: supabase, intent: paymentIntent });
      }

      return res.json({
        success: true,
        message: finalization?.orderUpdated
          ? "Payment reconciled and order marked paid"
          : "Payment reconciled",
        paymentIntentId: paymentIntent.id,
        payment: {
          provider: adapter.provider,
          gatewayOrderId,
          gatewayPaymentId: providerEvidence.providerPaymentId,
          status: providerEvidence.status,
          captured: true,
          reconciled: true
        },
        orderUpdated: !!finalization?.orderUpdated,
        orderUpdateReason: finalization?.idempotent ? "already_paid_same_payment" : "captured_and_bound",
        order
      });
    }

    const failedPayment = findFailedGatewayPayment(providerPayments);

    if (failedPayment) {
      const orderUpdate = await markLinkedOrderPaymentFailed({
        hotelSlug,
        orderId,
        gatewayOrderId,
        gatewayPaymentId: failedPayment.id || "",
        reason: getGatewayPaymentFailureReason(failedPayment),
        errorCode: failedPayment.error_code || "",
        errorSource: failedPayment.error_source || "",
        errorStep: failedPayment.error_step || ""
      });

      return res.json({
        success: true,
        message: orderUpdate.updated
          ? "Payment failure reconciled"
          : "Payment status reconciled",
        payment: {
          provider: adapter.provider,
          gatewayOrderId,
          gatewayPaymentId: failedPayment.id || "",
          status: failedPayment.status || "failed",
          captured: false,
          reconciled: true
        },
        orderUpdated: orderUpdate.updated,
        orderUpdateReason: orderUpdate.reason,
        order: orderUpdate.order || null
      });
    }

    res.json({
      success: true,
      message: "Payment is not captured yet",
      payment: {
        provider: adapter.provider,
        gatewayOrderId,
        status: "pending",
        captured: false,
        reconciled: true
      },
      orderUpdated: false,
      orderUpdateReason: "payment_not_captured_yet",
      order: null
    });
  } catch (error) {
    if (error instanceof PaymentIntegrityError || error instanceof GatewayResolutionError) {
      return res.status(error.httpStatus).json({ success: false, code: error.code, message: error.message });
    }
    if (error?.code === "PROVIDER_TIMEOUT") {
      return res.status(503).json({
        success: false, code: "PROVIDER_STATUS_UNKNOWN",
        message: "Payment status remains pending reconciliation."
      });
    }
    logger.error("Payment reconcile error", {
      ...paymentLogMeta,
      paymentStage: "reconcile",
      errorMessage: error.message
    });
    res.status(500).json({
      success: false,
      message: "Failed to reconcile payment"
    });
  }
});

router.post("/fail", validateBody(paymentFailureSchema), async (req, res) => {
  let paymentLogMeta = getPaymentLogMeta({
    requestId: req.requestId || ""
  });

  try {
    const {
      hotelSlug,
      orderId,
      gatewayOrderId,
      gatewayPaymentId = "",
      reason = "",
      errorCode = "",
      errorSource = "",
      errorStep = ""
    } = req.validatedBody;
    paymentLogMeta = getPaymentLogMeta({
      requestId: req.requestId || "",
      hotelSlug,
      orderId,
      gatewayOrderId,
      gatewayPaymentId,
      provider: getPaymentGatewayConfig().provider
    });

    const hotelAccess = await ensurePublicHotelAccess(req, res, hotelSlug, {
      notFoundMessage: "Hotel is not available for payment failure updates",
      forbiddenMessage: "This hotel cannot update payment failures from the current origin"
    });

    if (!hotelAccess) {
      return;
    }

    const orderUpdate = await markLinkedOrderPaymentFailed({
      hotelSlug,
      orderId,
      gatewayOrderId,
      gatewayPaymentId,
      reason,
      errorCode,
      errorSource,
      errorStep
    });

    res.json({
      success: true,
      message: orderUpdate.updated
        ? "Payment failure recorded"
        : "Payment failure received",
      orderUpdated: orderUpdate.updated,
      orderUpdateReason: orderUpdate.reason,
      order: orderUpdate.order || null
    });
  } catch (error) {
    logger.error("Payment failure record error", {
      ...paymentLogMeta,
      paymentStage: "fail",
      errorMessage: error.message
    });
    res.status(500).json({
      success: false,
      message: "Failed to record payment failure"
    });
  }
});

module.exports = router;
