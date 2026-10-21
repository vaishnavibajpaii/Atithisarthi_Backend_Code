"use strict";

const crypto = require("crypto");
const QRCode = require("qrcode");
const {
  buildRoomCheckoutSummary,
  getNumberValue,
  roundMoney
} = require("./room-checkout-summary");
const { taxLinesFromSnapshot } = require("./room-tax");

const BILL_SCHEMA_TABLES = Object.freeze([
  "room_checkout_bill_formats",
  "room_checkout_bill_snapshots",
  "room_checkout_bill_audit"
]);

const DEFAULT_LABELS = Object.freeze({
  folio: "Folio No.",
  invoice: "Receipt No.",
  bookingReference: "Booking Ref.",
  paymentStatus: "Payment",
  currency: "Currency",
  room: "Room",
  roomType: "Type",
  checkIn: "Check-in",
  checkOut: "Check-out",
  grandTotal: "GRAND TOTAL",
  paid: "Paid",
  balance: "Balance"
});

const DEFAULT_PRIVACY = Object.freeze({
  showGuestName: true,
  maskGuestPhone: true,
  maskGuestEmail: true,
  maskGuestId: true,
  showGuestAddress: false,
  showGuestCount: true,
  showSignatureLines: true
});

const DEFAULT_DISPLAY = Object.freeze({
  showHotelLogo: true,
  showRoomType: true,
  showPaymentMethod: true,
  showCashier: true,
  showQrCode: true,
  showDiscount: true,
  showAdvance: true,
  showBalance: true,
  showPaymentBreakdown: true,
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
  autoPrintAfterCheckout: false
});

const DEFAULT_MESSAGES = Object.freeze({
  thankYou: "Thank you for staying with us.",
  feedback: "",
  support: "",
  footer: "",
  legalNote: "This is a computer-generated guest folio."
});

function sanitizeText(value = "", maxLength = 1000) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLength);
}

function isMissingBillSchemaError(error = {}) {
  const code = String(error.code || "").trim().toUpperCase();
  const details = `${error.message || ""} ${error.details || ""} ${error.hint || ""}`
    .toLowerCase();

  return (
    ["42P01", "42703", "PGRST204", "PGRST205"].includes(code) ||
    BILL_SCHEMA_TABLES.some((table) => details.includes(table))
  );
}

function toCents(value = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

function fromCents(value = 0) {
  return roundMoney(Number(value || 0) / 100);
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

function buildProfileDefaults(profile = {}, hotelSlug = "") {
  const contact = profile.contact || {};
  const location = profile.location || {};
  const branding = profile.branding || {};

  return {
    companyName: sanitizeText(profile.hotel_name || hotelSlug || "Hotel", 180),
    propertySubtitle: sanitizeText(profile.tagline || "", 180),
    logoUrl: getNestedText({ profile, branding }, [
      ["branding", "logoUrl"],
      ["branding", "logo"],
      ["profile", "logo_url"]
    ]),
    addressLine1: getNestedText({ contact, location }, [
      ["contact", "address"],
      ["location", "address"],
      ["location", "addressLine1"]
    ]),
    addressLine2: getNestedText({ location }, [["location", "addressLine2"]]),
    city: getNestedText({ location }, [["location", "city"]]),
    state: getNestedText({ location }, [["location", "state"]]),
    postalCode: getNestedText({ location }, [
      ["location", "postalCode"],
      ["location", "pincode"]
    ]),
    country: getNestedText({ location }, [["location", "country"]]),
    phone: getNestedText({ contact }, [
      ["contact", "phone"],
      ["contact", "mobile"],
      ["contact", "whatsapp"]
    ]),
    email: getNestedText({ contact }, [["contact", "email"]]),
    websiteUrl: getNestedText({ contact }, [
      ["contact", "website"],
      ["contact", "websiteUrl"]
    ])
  };
}

function buildDefaultBillFormat(profile = {}, hotelSlug = "") {
  const profileDefaults = buildProfileDefaults(profile, hotelSlug);

  return {
    id: null,
    hotelSlug,
    templateName: "Default thermal guest folio",
    paperWidth: "80",
    companyName: profileDefaults.companyName,
    propertySubtitle: profileDefaults.propertySubtitle,
    logoUrl: profileDefaults.logoUrl,
    logoStoragePath: "",
    logoAltText: `${profileDefaults.companyName || "Hotel"} logo`,
    addressLine1: profileDefaults.addressLine1,
    addressLine2: profileDefaults.addressLine2,
    city: profileDefaults.city,
    state: profileDefaults.state,
    postalCode: profileDefaults.postalCode,
    country: profileDefaults.country,
    phone: profileDefaults.phone,
    alternatePhone: "",
    email: profileDefaults.email,
    websiteUrl: profileDefaults.websiteUrl,
    taxId: "",
    licenceNumber: "",
    registrationNumber: "",
    billTitle: "HOTEL CHECKOUT BILL / GUEST FOLIO",
    labels: { ...DEFAULT_LABELS },
    privacy: { ...DEFAULT_PRIVACY },
    display: { ...DEFAULT_DISPLAY },
    qr: {
      ...DEFAULT_QR,
      value: profileDefaults.websiteUrl
    },
    print: { ...DEFAULT_PRINT },
    messages: { ...DEFAULT_MESSAGES },
    isActive: true,
    version: 1,
    createdAt: null,
    updatedAt: null
  };
}

function mapBillFormatRow(row = null, profile = {}, hotelSlug = "") {
  const defaults = buildDefaultBillFormat(profile, hotelSlug);
  if (!row) return defaults;

  return {
    ...defaults,
    id: row.id || null,
    hotelSlug: row.hotel_slug || hotelSlug,
    templateName: row.template_name || defaults.templateName,
    paperWidth: String(row.paper_width || defaults.paperWidth),
    companyName: row.company_name || defaults.companyName,
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

function buildFormatRow(hotelSlug, input = {}, existing = null, actorId = null) {
  const current = mapBillFormatRow(existing, {}, hotelSlug);
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
    template_name: sanitizeText(next.templateName, 120) || "Default thermal guest folio",
    paper_width: String(next.paperWidth) === "58" ? "58" : "80",
    company_name: sanitizeText(next.companyName, 180),
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
    licence_number: sanitizeText(next.licenceNumber, 120),
    registration_number: sanitizeText(next.registrationNumber, 120),
    bill_title: sanitizeText(next.billTitle, 180) || "HOTEL CHECKOUT BILL / GUEST FOLIO",
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

  if (error && !["42P01", "PGRST205"].includes(String(error.code || ""))) throw error;
  return data || {};
}

async function fetchBillFormatRow(supabaseClient, hotelSlug) {
  const { data, error } = await supabaseClient
    .from("room_checkout_bill_formats")
    .select("*")
    .eq("hotel_slug", hotelSlug)
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getBillFormat({ supabaseClient, hotelSlug }) {
  const [profile, row] = await Promise.all([
    fetchHotelProfile(supabaseClient, hotelSlug),
    fetchBillFormatRow(supabaseClient, hotelSlug)
  ]);

  return mapBillFormatRow(row, profile, hotelSlug);
}

async function writeAuditEvent({
  supabaseClient,
  hotelSlug,
  action,
  actorId = null,
  actorRole = "",
  bookingId = null,
  snapshotId = null,
  formatVersion = null,
  details = {}
}) {
  const { error } = await supabaseClient
    .from("room_checkout_bill_audit")
    .insert({
      hotel_slug: hotelSlug,
      action: sanitizeText(action, 80),
      actor_id: actorId,
      actor_role: sanitizeText(actorRole, 80),
      booking_id: bookingId,
      snapshot_id: snapshotId,
      format_version: formatVersion,
      details_json: details
    });

  if (error && !isMissingBillSchemaError(error)) throw error;
}

async function saveBillFormat({
  supabaseClient,
  hotelSlug,
  input,
  actorId = null,
  actorRole = "owner"
}) {
  const [profile, existing] = await Promise.all([
    fetchHotelProfile(supabaseClient, hotelSlug),
    fetchBillFormatRow(supabaseClient, hotelSlug)
  ]);
  const row = buildFormatRow(hotelSlug, input, existing, actorId);
  const { data, error } = await supabaseClient
    .from("room_checkout_bill_formats")
    .upsert(
      {
        ...row,
        created_by: existing?.created_by || actorId
      },
      { onConflict: "hotel_slug" }
    )
    .select()
    .single();

  if (error) throw error;

  await writeAuditEvent({
    supabaseClient,
    hotelSlug,
    action: existing ? "bill_format_updated" : "bill_format_created",
    actorId,
    actorRole,
    formatVersion: data.version,
    details: { changedFields: Object.keys(input || {}).sort() }
  });

  return mapBillFormatRow(data, profile, hotelSlug);
}

async function resetBillFormat({
  supabaseClient,
  hotelSlug,
  actorId = null,
  actorRole = "owner"
}) {
  const profile = await fetchHotelProfile(supabaseClient, hotelSlug);
  const defaults = buildDefaultBillFormat(profile, hotelSlug);
  const format = await saveBillFormat({
    supabaseClient,
    hotelSlug,
    input: defaults,
    actorId,
    actorRole
  });

  await writeAuditEvent({
    supabaseClient,
    hotelSlug,
    action: "bill_format_reset",
    actorId,
    actorRole,
    formatVersion: format.version
  });
  return format;
}

function maskPhone(value = "") {
  const text = sanitizeText(value, 60);
  if (!text) return "";
  const visible = text.replace(/\D/g, "").slice(-4);
  return `${text.startsWith("+") ? "+" : ""}${"*".repeat(Math.max(4, text.length - visible.length))}${visible}`;
}

function maskEmail(value = "") {
  const text = sanitizeText(value, 320);
  const [local, domain] = text.split("@");
  if (!local || !domain) return text ? "****" : "";
  return `${local.slice(0, 1)}***@${domain}`;
}

function maskId(value = "") {
  const text = sanitizeText(value, 240);
  if (!text) return "";
  return `${"*".repeat(Math.max(4, text.length - 4))}${text.slice(-4)}`;
}

function getFoodItemName(item = {}, orderId = "") {
  return sanitizeText(
    item.name || item.itemName || item.title || item.item_name || `Room service order ${orderId}`,
    240
  );
}

function buildFoodLines(foodOrders = []) {
  const lines = [];

  foodOrders.forEach((order) => {
    if (!order.billable || !order.chargeToRoom) return;
    const source = order.source || {};
    const items = Array.isArray(source.items) ? source.items : [];
    let itemCents = 0;

    items.forEach((item) => {
      const quantity = Math.max(0, getNumberValue(item.qty ?? item.quantity) || 0);
      const rate = Math.max(0, getNumberValue(item.price ?? item.rate) || 0);
      const amountCents = Math.round(quantity * toCents(rate));
      itemCents += amountCents;
      lines.push({
        date: source.created_at || order.createdAt || "",
        description: getFoodItemName(item, order.id),
        quantity,
        rate: roundMoney(rate),
        amount: fromCents(amountCents),
        category: "room_service",
        orderId: String(order.id || "")
      });
    });

    const orderCents = toCents(order.totalAmount);
    if (!items.length) {
      lines.push({
        date: source.created_at || order.createdAt || "",
        description: `Room service order ${sanitizeText(order.id, 80)}`,
        quantity: 1,
        rate: fromCents(orderCents),
        amount: fromCents(orderCents),
        category: "room_service",
        orderId: String(order.id || "")
      });
    } else if (itemCents !== orderCents) {
      const adjustment = orderCents - itemCents;
      lines.push({
        date: source.created_at || order.createdAt || "",
        description: "Room service order adjustment",
        quantity: 1,
        rate: fromCents(adjustment),
        amount: fromCents(adjustment),
        category: "room_service_adjustment",
        orderId: String(order.id || "")
      });
    }
  });

  return lines;
}

function uniquePaymentMethods(payments = [], orders = [], receipt = null) {
  const entries = [];
  const seen = new Set();

  [
    ...payments.map((payment) => ({
      method: payment.payment_method,
      reference: payment.transaction_id,
      amount: payment.amount,
      status: payment.payment_status
    })),
    ...orders
      .filter((order) => order.billable && order.chargeToRoom && order.paymentStatus)
      .map((order) => ({
        method: order.paymentMethod,
        reference: "",
        amount: order.totalAmount,
        status: order.paymentStatus
      })),
    payments.length === 0 && orders.length === 0 && receipt
      ? {
        method: receipt.payment_method,
        reference: receipt.transaction_id,
        amount: receipt.amount,
        status: receipt.payment_status
      }
      : null
  ].filter(Boolean).forEach((entry) => {
    const key = `${entry.method || "payment"}:${entry.reference || ""}:${entry.amount || 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({
      method: sanitizeText(entry.method || "payment", 80),
      maskedReference: entry.reference ? maskId(entry.reference) : "",
      amount: roundMoney(entry.amount || 0),
      status: sanitizeText(entry.status || "", 40)
    });
  });

  return entries;
}

function buildHotelAddress(format = {}) {
  return [
    format.addressLine1,
    format.addressLine2,
    [format.city, format.state, format.postalCode].filter(Boolean).join(", "),
    format.country
  ].map((value) => sanitizeText(value, 240)).filter(Boolean);
}

function getHotelToken(hotelSlug = "") {
  return sanitizeText(hotelSlug, 120)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 16) || "HOTEL";
}

async function buildQrDataUrl(format = {}) {
  const config = format.qr || {};
  const value = sanitizeText(config.value || (config.type === "website" ? format.websiteUrl : ""), 2000);
  if (!config.enabled || !format.display?.showQrCode || !value) return "";

  const parsed = new URL(value);
  if (parsed.protocol !== "https:") return "";

  return QRCode.toDataURL(value, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: Math.min(320, Math.max(64, Number(config.size || 112))),
    color: { dark: "#000000", light: "#ffffff" }
  });
}

function buildPayloadHash(payload = {}) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

async function loadBillSource({ supabaseClient, hotelSlug, bookingId }) {
  const { data: booking, error: bookingError } = await supabaseClient
    .from("room_bookings")
    .select("*")
    .eq("id", bookingId)
    .eq("hotel_slug", hotelSlug)
    .maybeSingle();
  if (bookingError) throw bookingError;
  if (!booking) return null;

  const [roomResult, ordersResult, paymentsResult, refundsResult, receiptResult, format] = await Promise.all([
    supabaseClient
      .from("rooms")
      .select("id,hotel_slug,room_number,title,floor,room_type_id")
      .eq("id", booking.room_id)
      .eq("hotel_slug", hotelSlug)
      .maybeSingle(),
    supabaseClient
      .from("orders")
      .select("id,hotel_slug,payment_method,payment_status,billing_status,status,items,totals,created_at,room_id,room_booking_id,room_number,room_service_guest_name,room_service_charge_to_room")
      .eq("hotel_slug", hotelSlug)
      .eq("room_booking_id", booking.id)
      .order("created_at", { ascending: true }),
    supabaseClient
      .from("room_booking_payments")
      .select("id,hotel_slug,booking_id,amount,payment_method,payment_status,transaction_id,paid_at,created_at")
      .eq("hotel_slug", hotelSlug)
      .eq("booking_id", booking.id)
      .order("created_at", { ascending: true }),
    supabaseClient
      .from("room_booking_refunds")
      .select("id,hotel_slug,booking_id,amount,payment_method,status,transaction_id,reason,tax_adjustment_snapshot,created_at")
      .eq("hotel_slug", hotelSlug)
      .eq("booking_id", booking.id)
      .eq("status", "completed")
      .order("created_at", { ascending: true }),
    supabaseClient
      .from("room_checkout_receipts")
      .select("*")
      .eq("hotel_slug", hotelSlug)
      .eq("booking_id", booking.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    getBillFormat({ supabaseClient, hotelSlug })
  ]);

  for (const result of [roomResult, ordersResult, paymentsResult, refundsResult, receiptResult]) {
    if (result.error && !isMissingBillSchemaError(result.error)) throw result.error;
  }

  const room = roomResult.data || null;
  let roomType = null;
  if (room?.room_type_id) {
    const roomTypeResult = await supabaseClient
      .from("room_types")
      .select("id,hotel_slug,name")
      .eq("id", room.room_type_id)
      .eq("hotel_slug", hotelSlug)
      .maybeSingle();
    if (roomTypeResult.error) throw roomTypeResult.error;
    roomType = roomTypeResult.data || null;
  }

  const rawOrders = ordersResult.data || [];
  const summary = buildRoomCheckoutSummary({ booking, room, foodOrders: rawOrders });
  summary.foodCharges.orders = summary.foodCharges.orders.map((order, index) => ({
    ...order,
    source: rawOrders[index] || {}
  }));

  return {
    booking,
    room,
    roomType,
    orders: rawOrders,
    payments: paymentsResult.data || [],
    refunds: refundsResult.data || [],
    receipt: receiptResult.data || null,
    summary,
    format
  };
}

async function buildLiveBill(source, actor = {}) {
  const { booking, room, roomType, payments, refunds = [], receipt, summary, format } = source;
  const foodOrders = summary.foodCharges.orders;
  const foodSubtotalCents = foodOrders
    .filter((order) => order.billable && order.chargeToRoom)
    .reduce((sum, order) => sum + toCents(order.totalAmount), 0);
  const roomSubtotalCents = toCents(summary.roomCharges.roomPrice);
  const taxCents = toCents(summary.roomCharges.taxAmount);
  const discountCents = toCents(summary.roomCharges.discountAmount);
  const roomTotalCents = toCents(summary.roomCharges.totalAmount);
  const grandTotalCents = roomTotalCents + foodSubtotalCents;
  const balanceCents = toCents(summary.totals.finalPayableAmount);
  const paidCents = Math.max(0, grandTotalCents - balanceCents);
  const refundCents = refunds.reduce((sum, refund) => sum + toCents(refund.amount), 0);
  const taxSnapshot = (
    booking.tax_snapshot && Object.keys(booking.tax_snapshot).length
      ? booking.tax_snapshot
      : booking.pricing_snapshot?.taxSnapshot
  ) || {};
  const snapshotTaxLines = taxLinesFromSnapshot(taxSnapshot);
  const status = sanitizeText(booking.booking_status, 40);
  const final = status === "checked_out";
  const qrDataUrl = await buildQrDataUrl(format);
  const roomDescription = roomType?.name || room?.title || "Room accommodation";
  const lines = [
    {
      date: booking.check_in_date || "",
      description: sanitizeText(roomDescription, 240),
      quantity: 1,
      rate: fromCents(roomSubtotalCents),
      amount: fromCents(roomSubtotalCents),
      category: "room"
    },
    ...buildFoodLines(foodOrders)
  ];

  const issuedAt =
    receipt?.paid_at ||
    booking.checked_out_at ||
    new Date().toISOString();
  const hotelToken = getHotelToken(booking.hotel_slug);
  const bill = {
    documentType: final ? "guest_folio" : "provisional_folio",
    provisional: !final,
    folioNumber: `GF-${hotelToken}-${booking.id}`,
    invoiceNumber: receipt?.id ? `RCPT-${hotelToken}-${receipt.id}` : "",
    bookingReference: `RB-${hotelToken}-${booking.id}`,
    issuedAt,
    paymentStatus: sanitizeText(booking.payment_status || (balanceCents ? "unpaid" : "paid"), 40),
    checkoutStatus: status,
    currency: sanitizeText(receipt?.currency || "INR", 8).toUpperCase(),
    hotel: {
      name: format.companyName || hotelToken,
      propertySubtitle: format.propertySubtitle,
      addressLines: buildHotelAddress(format),
      phone: format.phone,
      alternatePhone: format.alternatePhone,
      email: format.email,
      websiteUrl: format.websiteUrl,
      taxId: format.taxId,
      gstin: sanitizeText(taxSnapshot.gstin || format.taxId, 32),
      legalBusinessName: sanitizeText(taxSnapshot.legalBusinessName || format.companyName, 240),
      stateCode: sanitizeText(taxSnapshot.stateCode, 12),
      placeOfSupply: sanitizeText(taxSnapshot.placeOfSupply, 160),
      accommodationSac: sanitizeText(taxSnapshot.sac, 24),
      invoiceType: sanitizeText(taxSnapshot.invoiceType || "guest_folio", 40),
      licenceNumber: format.licenceNumber,
      registrationNumber: format.registrationNumber,
      logoUrl: format.logoUrl,
      logoAltText: format.logoAltText
    },
    guest: {
      name: format.privacy.showGuestName ? sanitizeText(booking.guest_name, 240) : "",
      phone: format.privacy.maskGuestPhone
        ? maskPhone(booking.guest_phone)
        : sanitizeText(booking.guest_phone, 60),
      email: format.privacy.maskGuestEmail
        ? maskEmail(booking.guest_email)
        : sanitizeText(booking.guest_email, 320),
      maskedId: format.privacy.maskGuestId
        ? maskId(booking.guest_id_proof)
        : sanitizeText(booking.guest_id_proof, 240),
      adults: Number(booking.adults || 0),
      children: Number(booking.children || 0),
      companyName: sanitizeText(booking.guest_company_name, 240),
      gstin: sanitizeText(booking.guest_gstin, 32),
      placeOfSupply: sanitizeText(booking.guest_place_of_supply, 160)
    },
    stay: {
      roomNumber: sanitizeText(room?.room_number || summary.booking.roomNumber, 80),
      roomType: sanitizeText(roomType?.name || room?.title || "", 180),
      checkIn: booking.checked_in_at || booking.check_in_date || "",
      checkOut: booking.checked_out_at || booking.check_out_date || "",
      timeZone: sanitizeText(process.env.APP_TIMEZONE || "Asia/Kolkata", 80),
      nights: Number(booking.total_nights || 0)
    },
    lines,
    totals: {
      roomSubtotal: fromCents(roomSubtotalCents),
      foodSubtotal: fromCents(foodSubtotalCents),
      additionalCharges: 0,
      discount: fromCents(discountCents),
      serviceCharge: 0,
      taxableAmount: roundMoney(
        taxSnapshot.taxableValue ??
        fromCents(Math.max(0, roomSubtotalCents - discountCents))
      ),
      taxes: snapshotTaxLines.length
        ? snapshotTaxLines
        : taxCents
          ? [{ label: "Room tax", amount: fromCents(taxCents) }]
          : [],
      grandTotal: fromCents(grandTotalCents),
      advancePaid: roundMoney(summary.roomCharges.advancePaid || 0),
      refund: fromCents(refundCents),
      paid: fromCents(paidCents),
      balance: fromCents(balanceCents)
    },
    payment: {
      methods: uniquePaymentMethods(payments, foodOrders, receipt)
    },
    cashier: sanitizeText(actor.displayName || receipt?.created_by_role || "", 160),
    format: {
      ...format,
      qrDataUrl
    },
    snapshotVersion: 2,
    templateVersion: format.version,
    reprintCount: 0,
    original: final,
    generatedFromTrustedSummary: true
  };

  return bill;
}

function buildFinalCheckoutPreviewSource(source, {
  actor = {},
  paymentMethod,
  transactionId = null,
  currency = "INR",
  issuedAt
} = {}) {
  const originalSummary = source.summary;
  const roomDue = roundMoney(originalSummary.roomCharges.balanceAmount || 0);
  const booking = {
    ...source.booking,
    advance_paid: source.booking.total_amount,
    balance_amount: 0,
    payment_status: "paid",
    booking_status: "checked_out",
    checked_out_at: issuedAt
  };
  const orders = source.orders.map((order) => {
    const status = String(order.status || "new").trim().toLowerCase();
    const paymentStatus = String(order.payment_status || "unpaid").trim().toLowerCase();
    const settlesWithRoom = order.room_service_charge_to_room === true &&
      !["cancelled", "payment_failed"].includes(status) &&
      !["paid", "refunded"].includes(paymentStatus);

    return settlesWithRoom
      ? { ...order, payment_status: "paid", billing_status: "billed" }
      : order;
  });
  const summary = buildRoomCheckoutSummary({
    booking,
    room: source.room,
    foodOrders: orders
  });
  summary.foodCharges.orders = summary.foodCharges.orders.map((order, index) => ({
    ...order,
    source: orders[index] || {}
  }));

  const payments = [...source.payments];
  if (roomDue > 0) {
    payments.push({
      hotel_slug: source.booking.hotel_slug,
      booking_id: source.booking.id,
      amount: roomDue,
      payment_method: paymentMethod,
      payment_status: "paid",
      transaction_id: transactionId,
      paid_at: issuedAt,
      created_at: issuedAt
    });
  }

  const receipt = {
    ...(source.receipt || {}),
    hotel_slug: source.booking.hotel_slug,
    booking_id: source.booking.id,
    amount: roundMoney(originalSummary.totals.finalPayableAmount || 0),
    room_amount: roomDue,
    food_amount: roundMoney(originalSummary.foodCharges.outstandingChargeToRoomAmount || 0),
    currency: String(currency || "INR").trim().toUpperCase(),
    payment_method: String(paymentMethod || "").trim(),
    payment_status: "paid",
    transaction_id: transactionId,
    paid_at: issuedAt,
    created_by_user_id: actor.id || null,
    created_by_role: actor.role || ""
  };

  return {
    ...source,
    booking,
    orders,
    payments,
    receipt,
    summary
  };
}

async function buildFinalCheckoutSnapshotCandidate({
  supabaseClient,
  hotelSlug,
  bookingId,
  actor = {},
  paymentMethod,
  transactionId = null,
  currency = "INR",
  issuedAt = new Date().toISOString()
} = {}) {
  const source = await loadBillSource({ supabaseClient, hotelSlug, bookingId });
  if (!source) return null;

  const issuedAtIso = new Date(issuedAt).toISOString();
  const finalSource = buildFinalCheckoutPreviewSource(source, {
    actor,
    paymentMethod,
    transactionId,
    currency,
    issuedAt: issuedAtIso
  });
  const bill = await buildLiveBill(finalSource, actor);
  if (
    bill.provisional !== false ||
    bill.documentType !== "guest_folio" ||
    bill.checkoutStatus !== "checked_out" ||
    bill.paymentStatus !== "paid" ||
    !bill.folioNumber ||
    !bill.issuedAt ||
    !Number.isFinite(Number(bill.totals?.grandTotal)) ||
    Number(bill.totals?.paid) !== Number(bill.totals?.grandTotal) ||
    Number(bill.totals?.balance) !== 0
  ) {
    throw new Error("TASK6_CHECKOUT_FINAL_SNAPSHOT_INVALID");
  }

  return {
    bill,
    payloadHash: buildPayloadHash(bill),
    source: finalSource
  };
}

async function fetchSnapshot(supabaseClient, hotelSlug, bookingId) {
  const { data, error } = await supabaseClient
    .from("room_checkout_bill_snapshots")
    .select("*")
    .eq("hotel_slug", hotelSlug)
    .eq("booking_id", bookingId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function buildSnapshotReceiptNumber(row = {}) {
  const storedNumber = sanitizeText(
    row.invoice_number || row.snapshot_json?.invoiceNumber,
    160
  );
  if (storedNumber) return storedNumber;
  if (!row.id) return "";
  return `RCPT-GF-${getHotelToken(row.hotel_slug)}-${row.id}`;
}

async function loadBookingLifecycle(supabaseClient, hotelSlug, bookingId) {
  const { data, error } = await supabaseClient
    .from("room_bookings")
    .select("id,hotel_slug,check_in_date,check_out_date,checked_in_at,checked_out_at")
    .eq("hotel_slug", hotelSlug)
    .eq("id", bookingId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function mapSnapshotBill(row, booking = null) {
  const snapshot = row.snapshot_json || {};
  const snapshotStay = snapshot.stay || {};
  return {
    ...snapshot,
    invoiceNumber: buildSnapshotReceiptNumber(row),
    stay: {
      ...snapshotStay,
      checkIn:
        booking?.checked_in_at ||
        snapshotStay.checkIn ||
        booking?.check_in_date ||
        "",
      checkOut:
        booking?.checked_out_at ||
        snapshotStay.checkOut ||
        booking?.check_out_date ||
        "",
      timeZone:
        snapshotStay.timeZone ||
        sanitizeText(process.env.APP_TIMEZONE || "Asia/Kolkata", 80)
    },
    snapshotId: row.id,
    reprintCount: Number(row.reprint_count || 0),
    original: true,
    immutable: true
  };
}

async function persistSnapshot({
  supabaseClient,
  source,
  bill,
  actorId = null,
  actorRole = ""
}) {
  const payloadHash = buildPayloadHash(bill);
  const insert = {
    hotel_slug: source.booking.hotel_slug,
    booking_id: source.booking.id,
    checkout_receipt_id: source.receipt?.id || null,
    folio_number: bill.folioNumber,
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
    .from("room_checkout_bill_snapshots")
    .insert(insert)
    .select()
    .single();

  if (error) {
    if (String(error.code || "") === "23505") {
      const existing = await fetchSnapshot(
        supabaseClient,
        source.booking.hotel_slug,
        source.booking.id
      );
      if (existing) return existing;
    }
    throw error;
  }

  await writeAuditEvent({
    supabaseClient,
    hotelSlug: source.booking.hotel_slug,
    action: "bill_issued",
    actorId,
    actorRole,
    bookingId: source.booking.id,
    snapshotId: data.id,
    formatVersion: bill.templateVersion,
    details: { payloadHash }
  });
  return data;
}

async function getCheckoutBill({
  supabaseClient,
  hotelSlug,
  bookingId,
  actor = {},
  issueFinal = true
}) {
  const existing = await fetchSnapshot(supabaseClient, hotelSlug, bookingId);
  if (existing) {
    const booking = await loadBookingLifecycle(
      supabaseClient,
      hotelSlug,
      existing.booking_id
    );
    return {
      bill: mapSnapshotBill(existing, booking),
      summary: null,
      snapshot: true
    };
  }

  const source = await loadBillSource({ supabaseClient, hotelSlug, bookingId });
  if (!source) return null;

  const bill = await buildLiveBill(source, actor);
  if (bill.provisional || !issueFinal) {
    return { bill, summary: source.summary, snapshot: false };
  }

  const snapshot = await persistSnapshot({
    supabaseClient,
    source,
    bill,
    actorId: actor.id || null,
    actorRole: actor.role || ""
  });
  return {
    bill: mapSnapshotBill(snapshot, source.booking),
    summary: source.summary,
    snapshot: true
  };
}

async function reprintCheckoutBill({
  supabaseClient,
  hotelSlug,
  bookingId,
  actor = {},
  reason
}) {
  const row = await fetchSnapshot(supabaseClient, hotelSlug, bookingId);
  if (!row) return null;

  const nextCount = Number(row.reprint_count || 0) + 1;
  const { data, error } = await supabaseClient
    .from("room_checkout_bill_snapshots")
    .update({
      reprint_count: nextCount,
      updated_at: new Date().toISOString()
    })
    .eq("id", row.id)
    .eq("hotel_slug", hotelSlug)
    .select()
    .single();
  if (error) throw error;

  await writeAuditEvent({
    supabaseClient,
    hotelSlug,
    action: "bill_reprinted",
    actorId: actor.id || null,
    actorRole: actor.role || "",
    bookingId,
    snapshotId: row.id,
    formatVersion: row.template_version,
    details: { reason: sanitizeText(reason, 500), reprintCount: nextCount }
  });

  const booking = await loadBookingLifecycle(
    supabaseClient,
    hotelSlug,
    data.booking_id
  );
  return mapSnapshotBill(data, booking);
}

module.exports = {
  buildDefaultBillFormat,
  buildFinalCheckoutSnapshotCandidate,
  buildFormatRow,
  buildLiveBill,
  buildPayloadHash,
  getBillFormat,
  getCheckoutBill,
  isMissingBillSchemaError,
  mapBillFormatRow,
  mapSnapshotBill,
  reprintCheckoutBill,
  resetBillFormat,
  saveBillFormat,
  sanitizeText,
  writeAuditEvent
};
