const express = require("express");
const { supabase } = require("../utils/supabase");
const { env } = require("../config/env");
const { getTenantMutationClient } = require("../utils/tenant-route-database");
const { getTenantRequestScope } = require("../utils/tenant-request-context");
const logger = require("../utils/logger");
const { createNotificationEventSafely } = require("../utils/notifications");
const {
  buildOrderTrackingReference,
  getOrderTrackingColumns
} = require("../utils/order-tracking");
const { publicOrderLimiter } = require("../middleware/public-rate-limiters");
const { ensurePublicHotelAccess } = require("../utils/public-hotel-access");
const { ensureHotelFeatureEnabled } = require("../middleware/require-hotel-feature");
const { resolveVerifiedQrOrderContext } = require("../utils/qr-context");
const {
  buildCustomerOrderingDisabledPayload,
  buildPaymentMethodDisabledPayload,
  fetchHotelOrderingSettings,
  isHotelPaymentMethodEnabled,
  normalizePaymentMethod
} = require("../utils/hotel-ordering-settings");
const {
  buildOrderItemSnapshots,
  buildComboSummaryLine
} = require("../utils/order-item-snapshots");
const { validateRequestedMenuCombos } = require("../utils/menu-combos");
const { filterEligibleMenuItems } = require("../utils/menu-categories");
const { resolveTableForOrder } = require("../utils/restaurant-tables");

// ✅ Added imports
const { validateBody } = require("../validators/common");
const { orderSchema } = require("../validators/public");

const router = express.Router();

function normalizeOptionalText(value, maxLength = 80) {
  const text = typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim()
    : "";
  return text.slice(0, maxLength);
}

function cleanPhone(value = "") {
  return String(value || "").replace(/\D/g, "");
}

function getOrderLogMeta({ requestId = "", hotelSlug = "", orderContext = null, itemCount = 0 } = {}) {
  const safeOrderContext =
    orderContext && typeof orderContext === "object" && !Array.isArray(orderContext)
      ? orderContext
      : {};

  return {
    requestId: String(requestId || "").trim(),
    hotelSlug: normalizeOptionalText(hotelSlug, 120),
    orderType: normalizeOptionalText(safeOrderContext.orderType, 40),
    tableNumber: normalizeOptionalText(safeOrderContext.tableNumber, 80),
    orderSource: normalizeOptionalText(safeOrderContext.orderSource, 40),
    itemCount: Number.isFinite(Number(itemCount)) ? Number(itemCount) : 0
  };
}

async function getOwnerWhatsAppNumber(hotelSlug, logMeta = {}) {
  const normalizedHotelSlug = normalizeOptionalText(hotelSlug, 120);
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
      logger.warn("Hotel owner WhatsApp lookup failed", {
        ...logMeta,
        lookupStage: "hotel_profiles",
        message: error.message
      });
    }

    const profileWhatsAppNumber = cleanPhone(data?.owner_whatsapp_number || "");
    if (profileWhatsAppNumber) {
      return profileWhatsAppNumber;
    }
  } catch (error) {
    logger.warn("Hotel owner WhatsApp lookup failed", {
      ...logMeta,
      lookupStage: "hotel_profiles",
      message: error.message
    });
  }

  try {
    const { data, error } = await supabase
      .from("hotels")
      .select("whatsapp_number")
      .eq("slug", normalizedHotelSlug)
      .maybeSingle();

    if (error) {
      logger.warn("Hotel WhatsApp lookup failed", {
        ...logMeta,
        lookupStage: "hotels",
        message: error.message
      });
    }

    const hotelWhatsAppNumber = cleanPhone(data?.whatsapp_number || "");
    if (hotelWhatsAppNumber) {
      return hotelWhatsAppNumber;
    }
  } catch (error) {
    logger.warn("Hotel WhatsApp lookup failed", {
      ...logMeta,
      lookupStage: "hotels",
      message: error.message
    });
  }

  return cleanPhone(process.env.OWNER_WHATSAPP_NUMBER || "");
}

function getNormalizedOrderContext(orderContext) {
  if (!orderContext || typeof orderContext !== "object" || Array.isArray(orderContext)) {
    return null;
  }

  const orderType = normalizeOptionalText(orderContext.orderType, 40);
  const tableNumber = normalizeOptionalText(orderContext.tableNumber, 80);
  const orderSource = normalizeOptionalText(orderContext.orderSource, 40);

  if (!orderType && !tableNumber && !orderSource) {
    return null;
  }

  return {
    orderType: orderType || null,
    tableNumber: tableNumber || null,
    orderSource: orderSource || null
  };
}

function getOrderContextColumns(orderContext) {
  const normalizedOrderContext = getNormalizedOrderContext(orderContext);

  if (!normalizedOrderContext) {
    return {};
  }

  return {
    order_type: normalizedOrderContext.orderType,
    table_number: normalizedOrderContext.tableNumber,
    order_source: normalizedOrderContext.orderSource
  };
}

function hasDineInTableContext(orderContext) {
  return orderContext?.orderType === "dine-in" && !!orderContext.tableNumber;
}

function getDeliveryCharge(hotel = {}, orderContext = null) {
  if (hasDineInTableContext(orderContext)) {
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

function getBillingMetadataColumns({ orderContext, paymentMethod, paymentConfirmed }) {
  if (!hasDineInTableContext(orderContext)) {
    return {};
  }

  const normalizedPaymentMethod = normalizeOptionalText(paymentMethod, 60).toLowerCase();
  const isUpiPayment =
    normalizedPaymentMethod.includes("upi") ||
    normalizedPaymentMethod.includes("gpay") ||
    normalizedPaymentMethod.includes("google pay");

  return {
    payment_status: isUpiPayment && paymentConfirmed
      ? "customer_confirmed"
      : "unpaid",
    billing_status: "not_billed"
  };
}

function isUpiPaymentMethod(paymentMethod = "") {
  const normalizedPaymentMethod = normalizeOptionalText(paymentMethod, 60).toLowerCase();

  return (
    normalizedPaymentMethod.includes("upi") ||
    normalizedPaymentMethod.includes("gpay") ||
    normalizedPaymentMethod.includes("google pay")
  );
}

function formatMoney(amount = 0) {
  return `Rs. ${Number(amount || 0).toFixed(2)}`;
}

function getUpiDiscountPercent(hotel = {}) {
  const candidate = Number(hotel?.theme?.payment?.upiDiscountPercent);

  if (Number.isFinite(candidate)) {
    return Math.min(Math.max(candidate, 0), 100);
  }

  return 10;
}

function formatDiscountPercent(percent = 0) {
  const safePercent = Number.isFinite(Number(percent)) ? Number(percent) : 0;
  return Number.isInteger(safePercent)
    ? `${safePercent}%`
    : `${safePercent.toFixed(2).replace(/\.?0+$/, "")}%`;
}

async function getHotelPricingContext(hotelSlug) {
  const normalizedHotelSlug = normalizeOptionalText(hotelSlug, 120);

  if (!normalizedHotelSlug) {
    return {
      error: "Hotel slug is required for order pricing"
    };
  }

  const { data, error } = await supabase
    .from("hotel_profiles")
    .select("hotel_slug,hotel_name,gst_percent,theme,owner_upi_id")
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

async function getAvailableMenuItemsById(hotelSlug, itemIds = [], consumer = "website") {
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

async function calculateVerifiedOrderPricing({ hotelSlug, items, paymentMethod, orderContext }) {
  const pricingContext = await getHotelPricingContext(hotelSlug);

  if (pricingContext.error) {
    return pricingContext;
  }

  const hotel = pricingContext.hotel;
  const uniqueItemIds = [...new Set((items || []).map((item) => String(item.id || "")))].filter(Boolean);
  const menuItemsById = await getAvailableMenuItemsById(
    hotel.hotel_slug,
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
  const deliveryCharge = getDeliveryCharge(hotel, orderContext);
  const normalTotal = subtotal + gst + deliveryCharge;
  const upiDiscountPercent = getUpiDiscountPercent(hotel);
  const gpayDiscount = Math.round((normalTotal * upiDiscountPercent) / 100);
  const gpayFinalTotal = Math.max(0, normalTotal - gpayDiscount);
  const isUpi = isUpiPaymentMethod(paymentMethod);
  const verifiedTotals = {
    subtotal,
    gst,
    deliveryCharge,
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

function buildVerifiedOrderSummary({
  hotelName,
  customerName,
  customerPhone,
  customerAddress,
  paymentMethod,
  paymentConfirmed,
  note,
  items,
  totals,
  orderContext
}) {
  const isUpi = isUpiPaymentMethod(paymentMethod);
  const lines = [
    `Order Summary - ${hotelName || "Hotel"}`,
    "----------------------",
    `Name: ${customerName}`,
    `Phone: ${customerPhone}`
  ];

  if (hasDineInTableContext(orderContext)) {
    lines.push("Order Type: Dine-in");
    lines.push(`Table: ${orderContext.tableNumber}`);
    lines.push(`Source: ${orderContext.orderSource === "qr" ? "QR code" : orderContext.orderSource || "website"}`);
  } else {
    lines.push(`Address: ${customerAddress || "Not provided"}`);
  }

  lines.push("");
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
  if (Number(totals.deliveryCharge || 0) > 0) {
    lines.push(`Delivery Charge = ${formatMoney(totals.deliveryCharge)}`);
  }

  if (isUpi) {
    lines.push(`Original Total = ${formatMoney(totals.normalTotal)}`);
    lines.push(`Google Pay Discount (${formatDiscountPercent(totals.upiDiscountPercent)}) = -${formatMoney(totals.gpayDiscount)}`);
    lines.push(`Final Paid Amount = ${formatMoney(totals.gpayFinalTotal)}`);
    lines.push("Payment Method = Google Pay / UPI");
    lines.push(`Payment Status = ${paymentConfirmed ? "Confirmed" : "Pending"}`);
  } else {
    lines.push(`Total = ${formatMoney(totals.normalTotal)}`);
    lines.push("Payment Method = COD");
  }

  if (note) {
    lines.push("");
    lines.push(`Note = ${note}`);
  }

  return lines.join("\n");
}

function shouldRetryWithoutOptionalOrderColumns(error, optionalOrderColumns) {
  const optionalColumnNames = Object.keys(optionalOrderColumns);
  if (!optionalColumnNames.length || !error) return false;

  const message = [
    error.code,
    error.message,
    error.details,
    error.hint
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    message.includes("pgrst204") ||
    (
      message.includes("could not find") &&
      optionalColumnNames.some((columnName) => message.includes(columnName.toLowerCase()))
    )
  );
}

function getMissingOptionalOrderColumnNames(error, optionalOrderColumns) {
  const optionalColumnNames = Object.keys(optionalOrderColumns);
  if (!optionalColumnNames.length || !error) return [];

  const message = [
    error.code,
    error.message,
    error.details,
    error.hint
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return optionalColumnNames.filter((columnName) => (
    message.includes(columnName.toLowerCase())
  ));
}

function omitOrderColumns(columns = {}, columnNamesToOmit = []) {
  const omittedColumnNames = new Set(columnNamesToOmit);

  return Object.fromEntries(
    Object.entries(columns).filter(([columnName]) => !omittedColumnNames.has(columnName))
  );
}

async function insertOrderRow(baseOrderRow, optionalOrderColumns = {}, logMeta = {}, databaseClient = supabase) {
  const hasOptionalOrderColumns = Object.keys(optionalOrderColumns).length > 0;
  const firstAttemptRow = hasOptionalOrderColumns
    ? { ...baseOrderRow, ...optionalOrderColumns }
    : baseOrderRow;

  const firstAttempt = await databaseClient
    .from("orders")
    .insert([firstAttemptRow])
    .select()
    .single();

  if (!firstAttempt.error || !hasOptionalOrderColumns) {
    return firstAttempt;
  }

  if (!shouldRetryWithoutOptionalOrderColumns(firstAttempt.error, optionalOrderColumns)) {
    return firstAttempt;
  }

  const missingOptionalColumnNames = getMissingOptionalOrderColumnNames(
    firstAttempt.error,
    optionalOrderColumns
  );
  const retryOptionalColumns = missingOptionalColumnNames.length
    ? omitOrderColumns(optionalOrderColumns, missingOptionalColumnNames)
    : {};
  const retryOrderRow = Object.keys(retryOptionalColumns).length
    ? { ...baseOrderRow, ...retryOptionalColumns }
    : baseOrderRow;

  logger.warn(
    "Optional order columns are not available yet. Retrying order save without missing optional columns.",
    {
      ...logMeta,
      missingOptionalColumnNames
    }
  );

  return databaseClient
    .from("orders")
    .insert([retryOrderRow])
    .select()
    .single();
}

function isActiveTableOrderUniqueConflict(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();

  return (
    code === "23505" &&
    (
      details.includes("uq_orders_one_active_root_dine_in_table") ||
      details.includes("orders_one_active_root_dine_in_table_guard") ||
      details.includes("lower(btrim(hotel_slug))") ||
      details.includes("lower(btrim(table_number))")
    )
  );
}

// ✅ Middleware added here
router.post("/", publicOrderLimiter, validateBody(orderSchema), async (req, res) => {
  let requestHotelSlug = "";
  let requestOrderContext = null;
  let requestItemCount = 0;

  try {
    // ✅ Switched to validatedBody
    const {
      hotelName,
      hotelSlug,
      customerName,
      customerPhone,
      customerAddress,
      paymentMethod,
      paymentConfirmed,
      note,
      items,
      totals,
      whatsappMessage,
      orderContext
    } = req.validatedBody;

    requestHotelSlug = hotelSlug;
    requestItemCount = Array.isArray(items) ? items.length : 0;

    const hotelAccess = await ensurePublicHotelAccess(req, res, hotelSlug, {
      notFoundMessage: "Hotel is not available for new orders",
      forbiddenMessage: "This hotel cannot accept orders from the current origin"
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
    if (!isHotelPaymentMethodEnabled(orderingSettings, paymentMethod)) {
      return res.status(409).json(buildPaymentMethodDisabledPayload(orderingSettings, paymentMethod));
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

    const tableResolution = hasDineInTableContext(resolvedOrderContext.orderContext)
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

    requestOrderContext = tableResolution
      ? { ...resolvedOrderContext.orderContext, tableNumber: tableResolution.tableNumber }
      : resolvedOrderContext.orderContext;

    const requestLogMeta = getOrderLogMeta({
      requestId: req.requestId,
      hotelSlug,
      orderContext: requestOrderContext,
      itemCount: requestItemCount
    });

    const verifiedPricing = await calculateVerifiedOrderPricing({
      hotelSlug,
      items,
      paymentMethod,
      orderContext: requestOrderContext
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

    if (
      normalizePaymentMethod(paymentMethod) === "manual_upi" &&
      !String(verifiedPricing.hotel?.owner_upi_id || "").trim()
    ) {
      return res.status(409).json({
        success: false,
        code: "PAYMENT_METHOD_NOT_CONFIGURED",
        message: "Google Pay / UPI is not configured for this hotel. Please choose another payment method."
      });
    }

    const safeOrderContext = requestOrderContext;
    const approvedHotelName = verifiedPricing.hotel.hotel_name || hotelName || "Unknown Hotel";
    const approvedWhatsappMessage = buildVerifiedOrderSummary({
      hotelName: approvedHotelName,
      customerName,
      customerPhone,
      customerAddress,
      paymentMethod,
      paymentConfirmed,
      note,
      items: verifiedPricing.items,
      totals: verifiedPricing.totals,
      orderContext: safeOrderContext
    });

    // (Optional: You can now remove manual validation since schema handles it)

    // ✅ Insert into Supabase
    const database = getTenantMutationClient(req, supabase);
    const scope = env.tenantRuntimeWritesEnabled ? getTenantRequestScope(req) : null;
    const baseOrderRow = {
      ...(scope ? { tenant_id: scope.tenantId, property_id: scope.propertyId } : {}),
      hotel_name: approvedHotelName,
      hotel_slug: scope?.propertySlug || verifiedPricing.hotel.hotel_slug || hotelSlug || null,
      customer_name: customerName,
      customer_phone: customerPhone,
      customer_address: customerAddress || "",
      payment_method: paymentMethod || "COD",
      note: note || "",
      items: verifiedPricing.items,
      totals: verifiedPricing.totals || totals || {},
      whatsapp_message: approvedWhatsappMessage || whatsappMessage || "",
      status: "new"
    };
    const orderContextColumns = getOrderContextColumns(safeOrderContext);
    const billingMetadataColumns = getBillingMetadataColumns({
      orderContext: safeOrderContext,
      paymentMethod,
      paymentConfirmed
    });
    const optionalOrderColumns = {
      ...orderContextColumns,
      ...billingMetadataColumns,
      ...(tableResolution?.restaurantTableId
        ? { restaurant_table_id: tableResolution.restaurantTableId }
        : {}),
      ...getOrderTrackingColumns()
    };
    const { data, error } = await insertOrderRow(
      baseOrderRow,
      optionalOrderColumns,
      requestLogMeta,
      database
    );

    if (error) throw error;

    void createNotificationEventSafely({
      databaseClient: database,
      tenantId: scope?.tenantId,
      propertyId: scope?.propertyId,
      hotelSlug: data.hotel_slug || hotelSlug || null,
      sourceType: "order",
      sourceId: data.id,
      payload: {
        orderId: data.id,
        hotelName: data.hotel_name || hotelName || "",
        customerName: data.customer_name || customerName,
        customerPhone: data.customer_phone || customerPhone,
        customerAddress: data.customer_address || customerAddress || "",
        paymentMethod: data.payment_method || paymentMethod || "COD",
        paymentStatus: data.payment_status || billingMetadataColumns.payment_status || null,
        billingStatus: data.billing_status || billingMetadataColumns.billing_status || null,
        note: data.note || note || "",
        items: Array.isArray(data.items) ? data.items : items || [],
        totals:
          data.totals && typeof data.totals === "object" && !Array.isArray(data.totals)
            ? data.totals
            : totals || {},
        whatsappMessage: data.whatsapp_message || whatsappMessage || "",
        orderContext: safeOrderContext,
        status: data.status || "new"
      }
    });

    // ✅ Generate WhatsApp link
    const ownerWhatsAppNumber = await getOwnerWhatsAppNumber(
      data.hotel_slug || hotelSlug,
      requestLogMeta
    );
    const ownerWhatsappLink = approvedWhatsappMessage && ownerWhatsAppNumber
      ? `https://wa.me/${ownerWhatsAppNumber}?text=${encodeURIComponent(approvedWhatsappMessage)}`
      : "";
    const tracking = buildOrderTrackingReference(data);

    // ✅ Final response
    res.status(201).json({
      success: true,
      message: "Order saved successfully",
      order: data,
      tracking,
      trackingReady: !!tracking,
      preview: approvedWhatsappMessage,
      orderContext: safeOrderContext,
      ownerWhatsappLink,
      whatsappLinkReady: !!ownerWhatsappLink
    });

  } catch (error) {
    if (hasDineInTableContext(requestOrderContext) && isActiveTableOrderUniqueConflict(error)) {
      return res.status(409).json({
        success: false,
        code: "TABLE_HAS_ACTIVE_ORDER",
        message: "This table already has an active order. Open the existing order instead."
      });
    }

    logger.error("Order save error", {
      ...getOrderLogMeta({
        requestId: req.requestId,
        hotelSlug: requestHotelSlug,
        orderContext: requestOrderContext,
        itemCount: requestItemCount
      }),
      message: error.message
    });
    res.status(500).json({
      success: false,
      message: "Failed to save order"
    });
  }
});

router.calculateVerifiedOrderPricing = calculateVerifiedOrderPricing;
router.buildVerifiedOrderSummary = buildVerifiedOrderSummary;
router.isActiveTableOrderUniqueConflict = isActiveTableOrderUniqueConflict;
module.exports = router;
