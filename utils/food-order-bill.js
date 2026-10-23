"use strict";

const crypto = require("crypto");
const QRCode = require("qrcode");



const FOOD_BILL_SCHEMA_TABLES = Object.freeze([
  "food_order_bill_formats",
  "food_order_bill_snapshots",
  "food_order_bill_audit"
]);
const NON_BILLABLE_ORDER_STATUSES = Object.freeze(["cancelled", "payment_failed"]);

const DEFAULT_LABELS = Object.freeze({
  invoice: "Invoice",
  order: "Order",
  source: "Source",
  paymentStatus: "Payment",
  grandTotal: "GRAND TOTAL",
  paid: "Paid",
  refund: "Refund",
  balance: "Balance"
});

const DEFAULT_PRIVACY = Object.freeze({
  showCustomerName: true,
  maskCustomerPhone: true,
  showDeliveryAddress: false,
  showRoomGuestName: true
});

const DEFAULT_DISPLAY = Object.freeze({
  showHotelLogo: true,
  showRestaurantName: true,
  showOrderSource: true,
  showTableNumber: true,
  showRoomNumber: true,
  showCustomerName: true,
  showItemNotes: false,
  showVariants: true,
  showAddons: true,
  showItemTax: false,
  showDiscount: true,
  showCoupon: true,
  showServiceCharge: true,
  showDeliveryCharge: true,
  showPackagingCharge: true,
  showRounding: true,
  showPaymentBreakdown: true,
  showCashier: true,
  showQrCode: true,
  hideZeroTotals: true
});

const DEFAULT_QR = Object.freeze({
  enabled: false,
  type: "website",
  value: "",
  caption: "Scan to visit our website",
  size: 112,
  alignment: "center"
});

const DEFAULT_PRINT = Object.freeze({
  fontScale: 1,
  logoWidthMm: 22,
  marginMm: 2,
  lineSpacing: 1.15,
  separatorStyle: "dashed",
  printCopies: 1,
  autoPrintAfterPayment: false
});

const DEFAULT_MESSAGES = Object.freeze({
  thankYou: "Thank you for dining with us.",
  feedback: "",
  support: "",
  footer: "",
  legalNote: "This is a computer-generated food bill.",
  refundNote: "",
  taxNote: ""
});

function sanitizeText(value = "", maxLength = 1000) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeStatus(value = "") {
  return sanitizeText(value, 80).toLowerCase();
}

function isMissingFoodBillSchemaError(error = {}) {
  const code = String(error.code || "").trim().toUpperCase();
  const details = `${error.message || ""} ${error.details || ""} ${error.hint || ""}`
    .toLowerCase();

  return (
    ["42P01", "42703", "PGRST204", "PGRST205"].includes(code) ||
    FOOD_BILL_SCHEMA_TABLES.some((table) => details.includes(table))
  );
}

function isMissingOptionalRelation(error = {}, names = []) {
  const code = String(error.code || "").trim().toUpperCase();
  const details = `${error.message || ""} ${error.details || ""} ${error.hint || ""}`
    .toLowerCase();
  return (
    ["42P01", "42703", "PGRST204", "PGRST205"].includes(code) &&
    names.some((name) => details.includes(name))
  );
}

function normalizeOrderCreatedByStaffId(value) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function getOrderCreatedByStaffMap(supabaseClient, orders = []) {
  const staffIds = [...new Set((orders || [])
    .map((order) => normalizeOrderCreatedByStaffId(order?.created_by_staff_id))
    .filter(Boolean))];
  if (!staffIds.length) return new Map();
  const { data, error } = await supabaseClient
    .from("hotel_staff_access")
    .select("id,hotel_slug,display_name,role")
    .in("id", staffIds);
  if (error) {
    if (isMissingOptionalRelation(error, ["hotel_staff_access"])) return new Map();
    throw error;
  }
  return new Map((data || []).map((entry) => [String(entry.id), {
    id: String(entry.id),
    hotelSlug: entry.hotel_slug || "",
    displayName: sanitizeText(entry.display_name || "Staff", 180),
    role: sanitizeText(entry.role || "", 40)
  }]));
}

function getOrderCreatedByStaffResponse(order = {}, staffById = new Map()) {
  const staffId = normalizeOrderCreatedByStaffId(order.created_by_staff_id);
  if (!staffId) return null;
  return staffById.get(String(staffId)) || {
    id: String(staffId),
    hotelSlug: order.hotel_slug || "",
    displayName: "",
    role: ""
  };
}
function getNumber(value) {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toMinor(value = 0) {
  const number = getNumber(value);
  return number === null ? 0 : Math.round(number * 100);
}

function fromMinor(value = 0) {
  return Math.round(Number(value || 0)) / 100;
}

function money(value) {
  const number = getNumber(value);
  return number === null ? null : fromMinor(toMinor(number));
}

function mergeObject(defaults, value) {
  return {
    ...defaults,
    ...(value && typeof value === "object" && !Array.isArray(value) ? value : {})
  };
}

function getNestedText(source, paths = []) {
  for (const path of paths) {
    const value = path.reduce((current, key) => current?.[key], source);
    const normalized = sanitizeText(value, 500);
    if (normalized) return normalized;
  }
  return "";
}

function buildProfileDefaults(profile = {}, sharedFormat = {}, hotelSlug = "") {
  const contact = profile.contact || {};
  const location = profile.location || {};
  const branding = profile.branding || {};
  const companyName = sanitizeText(
    sharedFormat.company_name || profile.hotel_name || hotelSlug || "Hotel",
    180
  );

  return {
    companyName,
    restaurantName: sanitizeText(profile.restaurant_name || companyName, 180),
    propertySubtitle: sanitizeText(
      sharedFormat.property_subtitle || profile.tagline || "",
      180
    ),
    logoUrl: sanitizeText(
      sharedFormat.logo_url ||
      getNestedText({ profile, branding }, [
        ["branding", "logoUrl"],
        ["branding", "logo"],
        ["profile", "logo_url"]
      ]),
      2000
    ),
    addressLine1: sanitizeText(
      sharedFormat.address_line_1 ||
      getNestedText({ contact, location }, [
        ["contact", "address"],
        ["location", "address"],
        ["location", "addressLine1"]
      ]),
      240
    ),
    addressLine2: sanitizeText(
      sharedFormat.address_line_2 ||
      getNestedText({ location }, [["location", "addressLine2"]]),
      240
    ),
    city: sanitizeText(
      sharedFormat.city || getNestedText({ location }, [["location", "city"]]),
      120
    ),
    state: sanitizeText(
      sharedFormat.state || getNestedText({ location }, [["location", "state"]]),
      120
    ),
    postalCode: sanitizeText(
      sharedFormat.postal_code ||
      getNestedText({ location }, [
        ["location", "postalCode"],
        ["location", "pincode"]
      ]),
      40
    ),
    country: sanitizeText(
      sharedFormat.country || getNestedText({ location }, [["location", "country"]]),
      120
    ),
    phone: sanitizeText(
      sharedFormat.phone ||
      getNestedText({ contact }, [
        ["contact", "phone"],
        ["contact", "mobile"],
        ["contact", "whatsapp"]
      ]),
      60
    ),
    alternatePhone: sanitizeText(sharedFormat.alternate_phone || "", 60),
    email: sanitizeText(
      sharedFormat.email || getNestedText({ contact }, [["contact", "email"]]),
      320
    ),
    websiteUrl: sanitizeText(
      sharedFormat.website_url ||
      getNestedText({ contact }, [
        ["contact", "website"],
        ["contact", "websiteUrl"]
      ]),
      2000
    ),
    taxId: sanitizeText(sharedFormat.tax_id || "", 120),
    licenceNumber: sanitizeText(sharedFormat.licence_number || "", 120),
    registrationNumber: sanitizeText(sharedFormat.registration_number || "", 120)
  };
}

function buildDefaultFoodBillFormat(
  profile = {},
  sharedFormat = {},
  hotelSlug = ""
) {
  const defaults = buildProfileDefaults(profile, sharedFormat, hotelSlug);
  return {
    id: null,
    hotelSlug,
    templateName: "Default thermal food receipt",
    paperWidth: "80",
    ...defaults,
    logoStoragePath: "",
    logoAltText: `${defaults.companyName || "Hotel"} logo`,
    fssaiNumber: "",
    billTitle: "FOOD ORDER BILL",
    labels: { ...DEFAULT_LABELS },
    privacy: { ...DEFAULT_PRIVACY },
    display: { ...DEFAULT_DISPLAY },
    qr: { ...DEFAULT_QR, value: defaults.websiteUrl },
    print: { ...DEFAULT_PRINT },
    messages: { ...DEFAULT_MESSAGES },
    isActive: true,
    version: 1,
    createdAt: null,
    updatedAt: null
  };
}

function mapFoodBillFormatRow(
  row = null,
  profile = {},
  sharedFormat = {},
  hotelSlug = ""
) {
  const defaults = buildDefaultFoodBillFormat(profile, sharedFormat, hotelSlug);
  if (!row) return defaults;

  return {
    ...defaults,
    id: row.id || null,
    hotelSlug: row.hotel_slug || hotelSlug,
    templateName: row.template_name || defaults.templateName,
    paperWidth: String(row.paper_width || defaults.paperWidth),
    companyName: row.company_name || defaults.companyName,
    restaurantName: row.restaurant_name || "",
    propertySubtitle: row.property_subtitle || "",
    logoUrl: row.logo_url || "",
    logoStoragePath: row.logo_storage_path || "",
    logoAltText: row.logo_alt_text || defaults.logoAltText,
    addressLine1: row.address_line_1 || "",
    addressLine2: row.address_line_2 || "",
    city: row.city || "",
    state: row.state || "",
    postalCode: row.postal_code || "",
    country: row.country || "",
    phone: row.phone || "",
    alternatePhone: row.alternate_phone || "",
    email: row.email || "",
    websiteUrl: row.website_url || "",
    taxId: row.tax_id || "",
    fssaiNumber: row.fssai_number || "",
    licenceNumber: row.licence_number || "",
    registrationNumber: row.registration_number || "",
    billTitle: row.bill_title || defaults.billTitle,
    labels: mergeObject(DEFAULT_LABELS, row.labels_json),
    privacy: mergeObject(DEFAULT_PRIVACY, row.privacy_json),
    display: mergeObject(DEFAULT_DISPLAY, row.display_json),
    qr: mergeObject(DEFAULT_QR, row.qr_json),
    print: mergeObject(DEFAULT_PRINT, row.print_json),
    messages: mergeObject(DEFAULT_MESSAGES, row.messages_json),
    isActive: row.is_active !== false,
    version: Math.max(1, Number(row.version || 1)),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
}

function buildFoodBillFormatRow(hotelSlug, input = {}, existing = null, actorId = null) {
  const current = mapFoodBillFormatRow(existing, {}, {}, hotelSlug);
  const next = {
    ...current,
    ...input,
    labels: mergeObject(current.labels, input.labels),
    privacy: mergeObject(current.privacy, input.privacy),
    display: mergeObject(current.display, input.display),
    qr: mergeObject(current.qr, input.qr),
    print: mergeObject(current.print, input.print),
    messages: mergeObject(current.messages, input.messages)
  };

  return {
    hotel_slug: hotelSlug,
    template_name: sanitizeText(next.templateName, 120) || "Default thermal food receipt",
    paper_width: String(next.paperWidth) === "58" ? "58" : "80",
    company_name: sanitizeText(next.companyName, 180),
    restaurant_name: sanitizeText(next.restaurantName, 180),
    property_subtitle: sanitizeText(next.propertySubtitle, 180),
    logo_url: sanitizeText(next.logoUrl, 2000),
    logo_storage_path: sanitizeText(next.logoStoragePath, 500),
    logo_alt_text: sanitizeText(next.logoAltText, 240),
    address_line_1: sanitizeText(next.addressLine1, 240),
    address_line_2: sanitizeText(next.addressLine2, 240),
    city: sanitizeText(next.city, 120),
    state: sanitizeText(next.state, 120),
    postal_code: sanitizeText(next.postalCode, 40),
    country: sanitizeText(next.country, 120),
    phone: sanitizeText(next.phone, 60),
    alternate_phone: sanitizeText(next.alternatePhone, 60),
    email: sanitizeText(next.email, 320),
    website_url: sanitizeText(next.websiteUrl, 2000),
    tax_id: sanitizeText(next.taxId, 120),
    fssai_number: sanitizeText(next.fssaiNumber, 120),
    licence_number: sanitizeText(next.licenceNumber, 120),
    registration_number: sanitizeText(next.registrationNumber, 120),
    bill_title: sanitizeText(next.billTitle, 180) || "FOOD ORDER BILL",
    labels_json: next.labels,
    privacy_json: next.privacy,
    display_json: next.display,
    qr_json: next.qr,
    print_json: next.print,
    messages_json: next.messages,
    is_active: true,
    version: existing ? Math.max(1, Number(existing.version || 1)) + 1 : 1,
    updated_by: actorId,
    updated_at: new Date().toISOString()
  };
}

async function fetchHotelProfile(supabaseClient, hotelSlug) {
  const { data, error } = await supabaseClient
    .from("hotel_profiles")
    .select("*")
    .eq("hotel_slug", hotelSlug)
    .maybeSingle();
  if (error) throw error;
  return data || {};
}

async function fetchSharedRoomFormat(supabaseClient, hotelSlug) {
  const { data, error } = await supabaseClient
    .from("room_checkout_bill_formats")
    .select("*")
    .eq("hotel_slug", hotelSlug)
    .eq("is_active", true)
    .maybeSingle();
  if (error) {
    if (isMissingOptionalRelation(error, ["room_checkout_bill_formats"])) return {};
    throw error;
  }
  return data || {};
}

async function fetchFoodBillFormatRow(supabaseClient, hotelSlug) {
  const { data, error } = await supabaseClient
    .from("food_order_bill_formats")
    .select("*")
    .eq("hotel_slug", hotelSlug)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function getFoodBillFormat({ supabaseClient, hotelSlug }) {
  const [profile, sharedFormat, row] = await Promise.all([
    fetchHotelProfile(supabaseClient, hotelSlug),
    fetchSharedRoomFormat(supabaseClient, hotelSlug),
    fetchFoodBillFormatRow(supabaseClient, hotelSlug)
  ]);
  return mapFoodBillFormatRow(row, profile, sharedFormat, hotelSlug);
}

async function writeFoodBillAudit({
  supabaseClient,
  hotelSlug,
  action,
  actorId = null,
  actorRole = "",
  orderId = null,
  invoiceNumber = null,
  snapshotId = null,
  formatVersion = null,
  details = {}
}) {
  const { error } = await supabaseClient
    .from("food_order_bill_audit")
    .insert({
      hotel_slug: hotelSlug,
      action: sanitizeText(action, 80),
      actor_id: actorId,
      actor_role: sanitizeText(actorRole, 80),
      order_id: orderId === null ? null : sanitizeText(orderId, 160),
      invoice_number: invoiceNumber ? sanitizeText(invoiceNumber, 200) : null,
      snapshot_id: snapshotId,
      format_version: formatVersion,
      details_json: details && typeof details === "object" && !Array.isArray(details)
        ? details
        : {}
    });
  if (error && !isMissingFoodBillSchemaError(error)) throw error;
}

async function saveFoodBillFormat({
  supabaseClient,
  hotelSlug,
  input,
  actorId = null,
  actorRole = "owner"
}) {
  const [profile, sharedFormat, existing] = await Promise.all([
    fetchHotelProfile(supabaseClient, hotelSlug),
    fetchSharedRoomFormat(supabaseClient, hotelSlug),
    fetchFoodBillFormatRow(supabaseClient, hotelSlug)
  ]);
  const row = buildFoodBillFormatRow(hotelSlug, input, existing, actorId);
  const { data, error } = await supabaseClient
    .from("food_order_bill_formats")
    .upsert(
      { ...row, created_by: existing?.created_by || actorId },
      { onConflict: "hotel_slug" }
    )
    .select()
    .single();
  if (error) throw error;

  await writeFoodBillAudit({
    supabaseClient,
    hotelSlug,
    action: existing ? "food_bill_format_updated" : "food_bill_format_created",
    actorId,
    actorRole,
    formatVersion: data.version,
    details: { changedFields: Object.keys(input || {}).sort() }
  });
  await writeFoodBillAudit({
    supabaseClient,
    hotelSlug,
    action: "food_bill_template_activated",
    actorId,
    actorRole,
    formatVersion: data.version
  });
  if (input?.qr) {
    await writeFoodBillAudit({
      supabaseClient,
      hotelSlug,
      action: "food_bill_qr_changed",
      actorId,
      actorRole,
      formatVersion: data.version,
      details: { type: sanitizeText(input.qr.type || "", 40), enabled: input.qr.enabled === true }
    });
  }
  if (input?.messages && Object.prototype.hasOwnProperty.call(input.messages, "footer")) {
    await writeFoodBillAudit({
      supabaseClient,
      hotelSlug,
      action: "food_bill_footer_changed",
      actorId,
      actorRole,
      formatVersion: data.version
    });
  }
  return mapFoodBillFormatRow(data, profile, sharedFormat, hotelSlug);
}

async function resetFoodBillFormat({
  supabaseClient,
  hotelSlug,
  actorId = null,
  actorRole = "owner"
}) {
  const [profile, sharedFormat] = await Promise.all([
    fetchHotelProfile(supabaseClient, hotelSlug),
    fetchSharedRoomFormat(supabaseClient, hotelSlug)
  ]);
  const defaults = buildDefaultFoodBillFormat(profile, sharedFormat, hotelSlug);
  const format = await saveFoodBillFormat({
    supabaseClient,
    hotelSlug,
    input: defaults,
    actorId,
    actorRole
  });
  await writeFoodBillAudit({
    supabaseClient,
    hotelSlug,
    action: "food_bill_format_reset",
    actorId,
    actorRole,
    formatVersion: format.version
  });
  return format;
}

function maskPhone(value = "") {
  const text = sanitizeText(value, 60);
  if (!text) return "";
  const digits = text.replace(/\D/g, "");
  const visible = digits.slice(-4);
  return `${text.startsWith("+") ? "+" : ""}${"*".repeat(Math.max(4, digits.length - visible.length))}${visible}`;
}

function maskReference(value = "") {
  const text = sanitizeText(value, 240);
  if (!text) return "";
  return `${"*".repeat(Math.max(4, text.length - 4))}${text.slice(-4)}`;
}

function buildHotelAddress(format = {}) {
  return [
    format.addressLine1,
    format.addressLine2,
    [format.city, format.state, format.postalCode].filter(Boolean).join(", "),
    format.country
  ].map((value) => sanitizeText(value, 240)).filter(Boolean);
}

function getTrustedOrderTotal(totals = {}) {
  const source = totals && typeof totals === "object" && !Array.isArray(totals)
    ? totals
    : {};
  for (const key of ["gpayFinalTotal", "final", "grandTotal", "total", "normalTotal"]) {
    const value = money(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function getSourceMeta(order = {}) {
  const source = normalizeStatus(order.order_source);
  const orderType = normalizeStatus(order.order_type);
  const tableNumber = sanitizeText(order.table_number, 80);
  const totals = order.totals || {};

  if (source === "room_service" || orderType === "room_service") {
    return { key: "room_service", label: "Room Service" };
  }
  if (source === "staff") {
    return { key: "staff_table", label: "Staff Table Order" };
  }
  if (source === "qr" || source === "table" || source === "dine-in" || tableNumber) {
    return { key: "qr_table", label: "QR Table Order" };
  }
  if (source === "takeaway" || orderType === "takeaway" || orderType === "pickup") {
    return { key: "takeaway", label: "Takeaway Order" };
  }
  if (
    source === "delivery" ||
    orderType === "delivery" ||
    (getNumber(totals.deliveryCharge) || 0) > 0
  ) {
    return { key: "delivery", label: "Delivery Order" };
  }
  return { key: "website", label: "Website Order" };
}

function getDocumentTitle(order = {}, format = {}, provisional = true) {
  if (provisional) {
    return getSourceMeta(order).key === "room_service"
      ? "PROVISIONAL ROOM SERVICE BILL"
      : "PROVISIONAL FOOD BILL";
  }
  const configured = sanitizeText(format.billTitle, 180);
  if (configured && configured !== "FOOD ORDER BILL") return configured;
  const source = getSourceMeta(order).key;
  if (source === "room_service") return "ROOM SERVICE BILL";
  if (source === "takeaway") return "TAKEAWAY BILL";
  if (source === "delivery") return "DELIVERY BILL";
  return configured || "FOOD ORDER BILL";
}

function mapItem(item = {}, index = 0) {
  const quantity = getNumber(item.qty ?? item.quantity) || 0;
  const unitRate = money(item.price ?? item.rate) ?? 0;
  const storedAmount = money(item.lineTotal ?? item.line_total ?? item.amount);
  const amount = storedAmount === null
    ? fromMinor(Math.round(quantity * toMinor(unitRate)))
    : storedAmount;
  const variant = item.variant && typeof item.variant === "object"
    ? item.variant.name || item.variant.label
    : item.variantName || item.variant || "";
  const addons = Array.isArray(item.addons)
    ? item.addons
    : Array.isArray(item.addOns)
      ? item.addOns
      : [];

  return {
    line: index + 1,
    id: sanitizeText(item.id || item.itemId, 120),
    name: sanitizeText(item.name || item.itemName || item.title || item.id || "Item", 240),
    quantity,
    unitRate,
    amount,
    variant: sanitizeText(variant, 180),
    addons: addons.map((entry) =>
      sanitizeText(
        typeof entry === "string" ? entry : entry?.name || entry?.label || "",
        180
      )
    ).filter(Boolean),
    notes: sanitizeText(item.notes || item.note || "", 500),
    itemDiscount: money(item.discount ?? item.itemDiscount),
    itemTax: money(item.tax ?? item.itemTax),
    itemType: sanitizeText(item.itemType || item.item_type || "single", 40),
    comboItems: (Array.isArray(item.comboItems) ? item.comboItems : []).map((entry) => ({
      name: sanitizeText(entry?.name || entry?.itemId, 180),
      quantity: getNumber(entry?.quantity) || 1
    }))
  };
}

function readTotal(totals = {}, keys = []) {
  for (const key of keys) {
    const value = money(totals[key]);
    if (value !== null) return value;
  }
  return null;
}

function buildTaxLines(totals = {}) {
  const lines = [
    ["CGST", ["cgst", "cgstAmount"]],
    ["SGST", ["sgst", "sgstAmount"]],
    ["IGST", ["igst", "igstAmount"]],
    ["Other Tax", ["otherTax", "otherTaxAmount"]]
  ].map(([label, keys]) => ({ label, amount: readTotal(totals, keys) }))
    .filter((entry) => entry.amount !== null);

  if (!lines.length) {
    const gst = readTotal(totals, ["gst", "tax", "taxAmount"]);
    if (gst !== null) {
      lines.push({
        label: getNumber(totals.gstPercent) !== null
          ? `GST (${getNumber(totals.gstPercent)}%)`
          : "GST",
        amount: gst
      });
    }
  }
  return lines;
}

function buildTotals(order = {}) {
  const totals = order.totals && typeof order.totals === "object" && !Array.isArray(order.totals)
    ? order.totals
    : {};
  const grandTotal = getTrustedOrderTotal(totals);
  if (grandTotal === null) {
    const error = new Error("Order has no verified stored total");
    error.code = "FOOD_BILL_TOTAL_UNAVAILABLE";
    throw error;
  }
  const status = normalizeStatus(order.payment_status);
  const explicitPaid = readTotal(totals, ["paid", "amountPaid", "paidAmount"]);
  const gatewayPaid = money(order.payment_amount);
  let paid = explicitPaid ?? gatewayPaid;
  let refund = readTotal(totals, ["refund", "refundAmount"]) ?? 0;

  if (
    status === "paid" &&
    (paid === null || toMinor(paid) < toMinor(grandTotal))
  ) {
    paid = grandTotal;
  }
  if (status === "refunded") {
    if (paid === null || toMinor(paid) < toMinor(grandTotal)) paid = grandTotal;
    if (!refund) refund = grandTotal;
  }
  if (paid === null) paid = 0;

  const explicitBalance = readTotal(totals, ["balance", "balanceDue"]);
  const balance =
    status === "paid" || status === "refunded"
      ? 0
      : explicitBalance !== null
        ? explicitBalance
        : fromMinor(Math.max(0, toMinor(grandTotal) - toMinor(paid) + toMinor(refund)));

  return {
    itemSubtotal: readTotal(totals, ["subtotal", "itemSubtotal"]),
    addonTotal: readTotal(totals, ["addonTotal"]),
    variantAdjustment: readTotal(totals, ["variantAdjustment"]),
    discount: readTotal(totals, ["discount", "orderDiscount"]),
    couponDiscount: readTotal(totals, ["couponDiscount"]),
    packagingCharge: readTotal(totals, ["packagingCharge"]),
    deliveryCharge: readTotal(totals, ["deliveryCharge"]),
    serviceCharge: readTotal(totals, ["serviceCharge"]),
    taxableAmount: readTotal(totals, ["taxableAmount"]),
    taxes: buildTaxLines(totals),
    normalTotal: readTotal(totals, ["normalTotal"]),
    upiDiscountPercent: getNumber(totals.upiDiscountPercent),
    upiDiscount: readTotal(totals, ["gpayDiscount", "upiDiscount"]),
    roundOff: readTotal(totals, ["roundOff", "rounding"]),
    grandTotal,
    paid,
    refund,
    balance
  };
}

function getFoodBillDocumentStatus(order = {}) {
  const operationalStatus = normalizeStatus(order.status) || "new";
  const paymentStatus = normalizeStatus(order.payment_status);
  const billingStatus = normalizeStatus(order.billing_status);

  if (NON_BILLABLE_ORDER_STATUSES.includes(operationalStatus)) {
    return operationalStatus;
  }
  if (paymentStatus === "refunded") return "refunded";
  if (paymentStatus === "paid") return "paid";
  if (paymentStatus === "partial") return "partially_paid";
  if (billingStatus === "billed") return "billed";
  return operationalStatus;
}

function buildPayments(order = {}, totals = {}) {
  const rawTotals = order.totals && typeof order.totals === "object" ? order.totals : {};
  const rawPayments = Array.isArray(rawTotals.payments) ? rawTotals.payments : [];
  if (rawPayments.length) {
    return rawPayments.map((payment) => ({
      method: sanitizeText(payment.method || payment.paymentMethod || "Payment", 80),
      maskedReference: maskReference(payment.reference || payment.transactionId || ""),
      amount: money(payment.amount) ?? 0,
      status: sanitizeText(payment.status || order.payment_status, 40)
    }));
  }

  const status = normalizeStatus(order.payment_status);
  if (!["paid", "partial", "refunded"].includes(status)) return [];
  return [{
    method: sanitizeText(order.payment_method || "Payment", 80),
    maskedReference: maskReference(order.gateway_payment_id || ""),
    amount: status === "refunded" ? totals.refund : totals.paid,
    status
  }];
}

function overlayFoodBillLifecycle(bill = {}, source = null) {
  const order = source?.order;
  if (!order) return bill;

  const currentTotals = buildTotals(order);
  const relatedById = new Map(
    (Array.isArray(source.relatedOrders) ? source.relatedOrders : []).map((relatedOrder) => [
      String(relatedOrder.id || ""),
      relatedOrder
    ])
  );
  const relatedOrders = (Array.isArray(bill.relatedOrders) ? bill.relatedOrders : []).map(
    (snapshotOrder) => {
      const currentOrder = relatedById.get(String(snapshotOrder.orderId || ""));
      if (!currentOrder) return snapshotOrder;
      return {
        ...snapshotOrder,
        billingStatus: sanitizeText(currentOrder.billing_status || "not_billed", 40),
        paymentStatus: sanitizeText(currentOrder.payment_status || "unpaid", 40)
      };
    }
  );

  return {
    ...bill,
    orderStatus: getFoodBillDocumentStatus(order),
    operationalOrderStatus: sanitizeText(order.status || "new", 40),
    paymentStatus: sanitizeText(order.payment_status || "unpaid", 40),
    billingStatus: sanitizeText(order.billing_status || "not_billed", 40),
    settlementUpdatedAt: order.paid_at || order.billed_at || "",
    totals: {
      ...(bill.totals && typeof bill.totals === "object" ? bill.totals : {}),
      paid: currentTotals.paid,
      refund: currentTotals.refund,
      balance: currentTotals.balance
    },
    payments: buildPayments(order, currentTotals),
    relatedOrders,
    lifecycleLive: true
  };
}

async function buildQrDataUrl(format = {}) {
  const config = format.qr || {};
  const value = sanitizeText(
    config.value || (config.type === "website" ? format.websiteUrl : ""),
    2000
  );
  if (!config.enabled || !format.display?.showQrCode || !value) return "";
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:") return "";

  return QRCode.toDataURL(parsed.toString(), {
    errorCorrectionLevel: "M",
    margin: 1,
    width: Math.min(320, Math.max(64, Number(config.size || 112))),
    color: { dark: "#000000", light: "#ffffff" }
  });
}

async function fetchRoomTransfer(supabaseClient, order = {}) {
  if (!order.room_service_charge_to_room || !order.room_booking_id) return null;
  const { data, error } = await supabaseClient
    .from("room_checkout_receipts")
    .select("id,hotel_slug,booking_id,settled_order_ids,paid_at,payment_status")
    .eq("hotel_slug", order.hotel_slug)
    .eq("booking_id", order.room_booking_id)
    .contains("settled_order_ids", [String(order.id)])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingOptionalRelation(error, ["room_checkout_receipts"])) return null;
    throw error;
  }
  return data || null;
}

const FOOD_BILL_LIFECYCLE_FIELDS = [
  "id",
  "hotel_slug",
  "parent_order_id",
  "status",
  "payment_status",
  "billing_status",
  "billed_at",
  "paid_at",
  "payment_method",
  "totals"
].join(",");

async function fetchFoodBillLifecycleSource({ supabaseClient, hotelSlug, orderId }) {
  const { data: order, error } = await supabaseClient
    .from("orders")
    .select(FOOD_BILL_LIFECYCLE_FIELDS)
    .eq("id", orderId)
    .eq("hotel_slug", hotelSlug)
    .maybeSingle();
  if (error) throw error;
  if (!order) return null;

  let relatedOrders = [];
  if (!order.parent_order_id) {
    const relatedResult = await supabaseClient
      .from("orders")
      .select(FOOD_BILL_LIFECYCLE_FIELDS)
      .eq("hotel_slug", hotelSlug)
      .eq("parent_order_id", String(order.id));
    if (relatedResult.error) {
      if (!isMissingOptionalRelation(relatedResult.error, ["parent_order_id"])) {
        throw relatedResult.error;
      }
    } else {
      relatedOrders = relatedResult.data || [];
    }
  }

  return { order, relatedOrders };
}

async function fetchOrderSource({ supabaseClient, hotelSlug, orderId }) {
  const { data: order, error } = await supabaseClient
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .eq("hotel_slug", hotelSlug)
    .maybeSingle();
  if (error) throw error;
  if (!order) return null;

  let relatedOrders = [];
  if (!order.parent_order_id) {
    const relatedResult = await supabaseClient
      .from("orders")
      .select("*")
      .eq("hotel_slug", hotelSlug)
      .eq("parent_order_id", String(order.id))
      .order("addon_sequence", { ascending: true })
      .order("created_at", { ascending: true });
    if (relatedResult.error) {
      if (!isMissingOptionalRelation(relatedResult.error, ["parent_order_id", "addon_sequence"])) {
        throw relatedResult.error;
      }
    } else {
      relatedOrders = relatedResult.data || [];
    }
  }

  const [format, staffMap, roomTransfer] = await Promise.all([
    getFoodBillFormat({ supabaseClient, hotelSlug }),
    getOrderCreatedByStaffMap(supabaseClient, [order, ...relatedOrders]),
    fetchRoomTransfer(supabaseClient, order)
  ]);
  return { order, relatedOrders, format, staffMap, roomTransfer };
}

function buildRelatedOrders(orders = []) {
  return orders.map((order) => {
    const totals = buildTotals(order);
    return {
      orderId: String(order.id || ""),
      label: sanitizeText(order.order_sequence_label || `Add-on Order ${order.id || ""}`, 180),
      createdAt: order.created_at || "",
      billingStatus: sanitizeText(order.billing_status || "not_billed", 40),
      paymentStatus: sanitizeText(order.payment_status || "unpaid", 40),
      items: (Array.isArray(order.items) ? order.items : []).map(mapItem),
      grandTotal: totals.grandTotal
    };
  });
}

async function buildLiveFoodBill(source, actor = {}, formatOverride = null) {
  const order = source.order;
  const format = formatOverride
    ? {
      ...source.format,
      ...formatOverride,
      labels: mergeObject(source.format.labels, formatOverride.labels),
      privacy: mergeObject(source.format.privacy, formatOverride.privacy),
      display: mergeObject(source.format.display, formatOverride.display),
      qr: mergeObject(source.format.qr, formatOverride.qr),
      print: mergeObject(source.format.print, formatOverride.print),
      messages: mergeObject(source.format.messages, formatOverride.messages)
    }
    : source.format;
  const billingStatus = normalizeStatus(order.billing_status);
  const provisional = billingStatus !== "billed" || !sanitizeText(order.bill_number, 200);
  const totals = buildTotals(order);
  const sourceMeta = getSourceMeta(order);
  const roomTransfer = source.roomTransfer;
  const chargeToRoom = order.room_service_charge_to_room === true;
  const paymentStatus = sanitizeText(order.payment_status || "unpaid", 40);
  const createdByStaffId = normalizeOrderCreatedByStaffId(order.created_by_staff_id);
  const createdBy = getOrderCreatedByStaffResponse(order, source.staffMap);
  const qrDataUrl = await buildQrDataUrl(format);
  const roomBillingMode = sourceMeta.key !== "room_service"
    ? null
    : chargeToRoom
      ? "add_to_room_bill"
      : "separate_food_bill";
  const transferState = NON_BILLABLE_ORDER_STATUSES.includes(normalizeStatus(order.status))
    ? "not_billable"
    : !chargeToRoom
      ? null
    : roomTransfer
      ? "transferred"
      : ["paid", "refunded"].includes(normalizeStatus(paymentStatus))
        ? "settled"
        : "pending_room_charge";

  return {
    documentType: provisional ? "provisional_food_bill" : "food_order_bill",
    title: getDocumentTitle(order, format, provisional),
    provisional,
    cancelled: NON_BILLABLE_ORDER_STATUSES.includes(normalizeStatus(order.status)),
    invoiceNumber: sanitizeText(order.bill_number, 200),
    orderReference: String(order.id || ""),
    issuedAt: order.billed_at || order.paid_at || order.created_at || new Date().toISOString(),
    orderCreatedAt: order.created_at || "",
    orderStatus: getFoodBillDocumentStatus(order),
    operationalOrderStatus: sanitizeText(order.status || "new", 40),
    orderSource: sourceMeta,
    orderType: sanitizeText(order.order_type || "", 80),
    paymentStatus,
    billingStatus: sanitizeText(order.billing_status || "not_billed", 40),
    currency: sanitizeText(order.payment_currency || "INR", 8).toUpperCase(),
    hotel: {
      name: format.companyName,
      restaurantName: format.restaurantName,
      propertySubtitle: format.propertySubtitle,
      addressLines: buildHotelAddress(format),
      phone: format.phone,
      alternatePhone: format.alternatePhone,
      email: format.email,
      websiteUrl: format.websiteUrl,
      taxId: format.taxId,
      fssaiNumber: format.fssaiNumber,
      licenceNumber: format.licenceNumber,
      registrationNumber: format.registrationNumber,
      logoUrl: format.logoUrl,
      logoAltText: format.logoAltText
    },
    orderContext: {
      tableNumber: sanitizeText(order.table_number, 80),
      roomNumber: sanitizeText(order.room_number, 80),
      roomBookingReference: order.room_booking_id ? String(order.room_booking_id) : "",
      customerName:
        format.privacy.showCustomerName && format.display.showCustomerName !== false
          ? sanitizeText(order.customer_name, 180)
          : "",
      customerPhone: format.privacy.maskCustomerPhone
        ? maskPhone(order.customer_phone)
        : sanitizeText(order.customer_phone, 60),
      customerAddress:
        format.privacy.showDeliveryAddress && sourceMeta.key === "delivery"
          ? sanitizeText(order.customer_address, 500)
          : "",
      roomGuestName:
        format.privacy.showRoomGuestName
          ? sanitizeText(order.room_service_guest_name, 180)
          : "",
      cashier: sanitizeText(
        actor.displayName ||
        createdBy?.displayName ||
        (createdByStaffId ? `Staff ${createdByStaffId}` : ""),
        180
      )
    },
    items: (Array.isArray(order.items) ? order.items : []).map(mapItem),
    orderNote: sanitizeText(order.note, 1000),
    relatedOrders: buildRelatedOrders(source.relatedOrders),
    totals,
    payments: buildPayments(order, totals),
    roomService: {
      linked: sourceMeta.key === "room_service",
      billingMode: roomBillingMode,
      transferState,
      folioReference: roomTransfer ? `RCPT-${roomTransfer.id}` : "",
      chargeToRoom
    },
    format: { ...format, qrDataUrl },
    snapshotVersion: 1,
    templateVersion: format.version,
    reprintCount: 0,
    immutable: false,
    original: !provisional,
    generatedFromStoredBackendTotals: true,
    roundingRule: "Existing order totals are displayed at two decimal places; stored whole-rupee GST and UPI discount rounding remain authoritative."
  };
}

function buildPayloadHash(payload = {}) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function fetchFoodBillSnapshot(supabaseClient, hotelSlug, orderId) {
  const { data, error } = await supabaseClient
    .from("food_order_bill_snapshots")
    .select("*")
    .eq("hotel_slug", hotelSlug)
    .eq("order_id", String(orderId))
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function mapFoodBillSnapshot(row) {
  return {
    ...(row.snapshot_json || {}),
    snapshotId: row.id,
    reprintCount: Number(row.reprint_count || 0),
    immutable: true,
    original: true,
    provisional: false
  };
}

async function persistFoodBillSnapshot({
  supabaseClient,
  source,
  bill,
  actorId = null,
  actorRole = ""
}) {
  const payloadHash = buildPayloadHash(bill);
  const insert = {
    hotel_slug: source.order.hotel_slug,
    order_id: String(source.order.id),
    invoice_number: bill.invoiceNumber || null,
    snapshot_version: bill.snapshotVersion,
    template_version: bill.templateVersion,
    snapshot_json: bill,
    payload_hash: payloadHash,
    issued_by: actorId,
    issued_by_role: sanitizeText(actorRole, 80),
    issued_at: bill.issuedAt
  };
  const { data, error } = await supabaseClient
    .from("food_order_bill_snapshots")
    .insert(insert)
    .select()
    .single();
  if (error) {
    if (String(error.code || "") === "23505") {
      const existing = await fetchFoodBillSnapshot(
        supabaseClient,
        source.order.hotel_slug,
        source.order.id
      );
      if (existing) return existing;
    }
    throw error;
  }

  await writeFoodBillAudit({
    supabaseClient,
    hotelSlug: source.order.hotel_slug,
    action: "food_bill_issued",
    actorId,
    actorRole,
    orderId: source.order.id,
    invoiceNumber: bill.invoiceNumber,
    snapshotId: data.id,
    formatVersion: bill.templateVersion,
    details: {
      payloadHash,
      roomServiceTransferState: bill.roomService?.transferState || null
    }
  });
  if (bill.roomService?.transferState === "transferred") {
    await writeFoodBillAudit({
      supabaseClient,
      hotelSlug: source.order.hotel_slug,
      action: "food_bill_room_service_transfer_recorded",
      actorId,
      actorRole,
      orderId: source.order.id,
      invoiceNumber: bill.invoiceNumber,
      snapshotId: data.id,
      formatVersion: bill.templateVersion,
      details: { folioReference: bill.roomService.folioReference || "" }
    });
  }
  return data;
}

async function getFoodOrderBill({
  supabaseClient,
  hotelSlug,
  orderId,
  actor = {},
  issueFinal = true
}) {
  const existing = await fetchFoodBillSnapshot(supabaseClient, hotelSlug, orderId);
  if (existing) {
    const lifecycleSource = await fetchFoodBillLifecycleSource({
      supabaseClient,
      hotelSlug,
      orderId
    });
    return {
      bill: overlayFoodBillLifecycle(mapFoodBillSnapshot(existing), lifecycleSource),
      snapshot: true
    };
  }
  const source = await fetchOrderSource({ supabaseClient, hotelSlug, orderId });
  if (!source) return null;
  const bill = await buildLiveFoodBill(source, actor);
  if (bill.provisional || !issueFinal) {
    return { bill, snapshot: false };
  }
  const snapshot = await persistFoodBillSnapshot({
    supabaseClient,
    source,
    bill,
    actorId: actor.id || null,
    actorRole: actor.role || ""
  });
  return { bill: mapFoodBillSnapshot(snapshot), snapshot: true };
}

async function getLatestFoodBillPreview({
  supabaseClient,
  hotelSlug,
  actor = {},
  formatOverride = null
}) {
  const { data, error } = await supabaseClient
    .from("orders")
    .select("id")
    .eq("hotel_slug", hotelSlug)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const source = await fetchOrderSource({
    supabaseClient,
    hotelSlug,
    orderId: data.id
  });
  if (!source) return null;
  return buildLiveFoodBill(source, actor, formatOverride);
}

async function reprintFoodOrderBill({
  supabaseClient,
  hotelSlug,
  orderId,
  actor = {},
  reason
}) {
  const row = await fetchFoodBillSnapshot(supabaseClient, hotelSlug, orderId);
  if (!row) return null;
  const nextCount = Number(row.reprint_count || 0) + 1;
  const { data, error } = await supabaseClient
    .from("food_order_bill_snapshots")
    .update({ reprint_count: nextCount, updated_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("hotel_slug", hotelSlug)
    .eq("order_id", String(orderId))
    .select()
    .single();
  if (error) throw error;

  await writeFoodBillAudit({
    supabaseClient,
    hotelSlug,
    action: "food_bill_reprinted",
    actorId: actor.id || null,
    actorRole: actor.role || "",
    orderId,
    invoiceNumber: row.invoice_number,
    snapshotId: row.id,
    formatVersion: row.template_version,
    details: { reason: sanitizeText(reason, 500), reprintCount: nextCount }
  });
  const lifecycleSource = await fetchFoodBillLifecycleSource({
    supabaseClient,
    hotelSlug,
    orderId
  });
  return overlayFoodBillLifecycle(mapFoodBillSnapshot(data), lifecycleSource);
}

async function issueFoodBillSnapshotIfFinal({
  supabaseClient,
  hotelSlug,
  orderId,
  actor = {}
}) {
  try {
    const result = await getFoodOrderBill({
      supabaseClient,
      hotelSlug,
      orderId,
      actor,
      issueFinal: true
    });
    return Boolean(result?.snapshot);
  } catch (error) {
    if (isMissingFoodBillSchemaError(error)) return false;
    throw error;
  }
}

function buildTask6FoodBillNumber(order = {}, issuedAt = new Date().toISOString()) {
  const hotelPart = sanitizeText(order.hotel_slug || order.hotel_name || "HOTEL", 180)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 18) || "HOTEL";
  const datePart = String(issuedAt || "").slice(0, 10).replace(/[^0-9]/g, "") || "DATE";
  const orderPart = String(order.id || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(-8) || "ORDER";

  return ["BILL", hotelPart, datePart, orderPart].join("-");
}

function buildTask6ProjectedFoodBillOrder(order = {}, issuedAt) {
  return {
    ...order,
    billing_status: "billed",
    billed_at: issuedAt,
    bill_number: buildTask6FoodBillNumber(order, issuedAt)
  };
}

async function buildTask6FoodBillFinalizationCandidates({
  supabaseClient,
  hotelSlug,
  orderId,
  finalizeScope,
  actor = {},
  issuedAt
} = {}) {
  const scope = String(finalizeScope || "").trim().toLowerCase();
  if (!supabaseClient || typeof supabaseClient.from !== "function") {
    throw new TypeError("Food bill source client is required");
  }
  if (!["single_bill", "family_bill"].includes(scope)) {
    throw new TypeError("Food bill finalization scope is invalid");
  }
  if (!String(issuedAt || "").trim()) {
    throw new TypeError("Food bill issue time is required");
  }

  const source = await fetchOrderSource({ supabaseClient, hotelSlug, orderId });
  if (!source) return null;

  const rootOrder = source.order;
  const relatedOrders = Array.isArray(source.relatedOrders) ? source.relatedOrders : [];
  if (scope === "family_bill" && rootOrder.parent_order_id) {
    const error = new Error("A table-family bill must start from its parent order");
    error.code = "TASK6_ORDER_BILL_FAMILY_ROOT_REQUIRED";
    throw error;
  }
  if (
    scope === "single_bill" &&
    (rootOrder.parent_order_id || relatedOrders.length > 0)
  ) {
    const error = new Error("Linked table orders must be billed as one family operation");
    error.code = "TASK6_ORDER_BILL_FAMILY_FINALIZATION_REQUIRED";
    throw error;
  }

  const targetOrders = scope === "family_bill"
    ? [rootOrder, ...relatedOrders]
    : [rootOrder];
  const projectedById = new Map(targetOrders.map((order) => [
    String(order.id),
    buildTask6ProjectedFoodBillOrder(order, issuedAt)
  ]));

  const candidates = [];
  for (const sourceOrder of targetOrders) {
    const projectedOrder = projectedById.get(String(sourceOrder.id));
    const projectedSource = {
      ...source,
      order: projectedOrder,
      relatedOrders: String(sourceOrder.id) === String(rootOrder.id)
        ? relatedOrders.map((order) => projectedById.get(String(order.id)))
        : [],
      roomTransfer: String(sourceOrder.id) === String(rootOrder.id)
        ? source.roomTransfer
        : null
    };
    const bill = await buildLiveFoodBill(projectedSource, actor);
    candidates.push({
      orderId: String(projectedOrder.id),
      snapshotJson: bill,
      payloadHash: buildPayloadHash(bill)
    });
  }

  return {
    anchorOrderId: String(rootOrder.id),
    finalizeScope: scope,
    candidates
  };
}

module.exports = {
  buildDefaultFoodBillFormat,
  buildFoodBillFormatRow,
  buildLiveFoodBill,
  buildTask6FoodBillFinalizationCandidates,
  buildTask6FoodBillNumber,
  buildTotals,
  getFoodBillDocumentStatus,
  getFoodBillFormat,
  getFoodOrderBill,
  getLatestFoodBillPreview,
  getSourceMeta,
  getTrustedOrderTotal,
  isMissingFoodBillSchemaError,
  issueFoodBillSnapshotIfFinal,
  mapFoodBillFormatRow,
  overlayFoodBillLifecycle,
  reprintFoodOrderBill,
  resetFoodBillFormat,
  sanitizeText,
  saveFoodBillFormat,
  writeFoodBillAudit
};
