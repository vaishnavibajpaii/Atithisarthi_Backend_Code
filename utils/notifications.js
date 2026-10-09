const { supabase } = require("./supabase");
const { env } = require("../config/env");
const { publishNotificationEvent } = require("./notification-live");
const nodemailer = require("nodemailer");
const {
  buildNotificationDedupeKey,
  isMissingNotificationDedupeColumnError,
  isNotificationDedupeConflict
} = require("./notification-dedupe");

const NOTIFICATION_SOURCE_EVENT_TYPES = {
  order: "order_created",
  reservation: "reservation_created",
  inquiry: "inquiry_created",
  contact_submission: "contact_submission_created",
  testimonial: "testimonial_submitted",
  support_request: "support_request_created"
};
const NOTIFICATION_SOURCE_SETTING_KEYS = {
  order: "notifyOnNewOrder",
  reservation: "notifyOnNewReservation",
  inquiry: "notifyOnNewInquiry"
};

const NOTIFICATION_DELIVERY_CHANNEL = "internal";
const NOTIFICATION_PENDING_STATUS = "pending";
const NOTIFICATION_SKIPPED_STATUS = "skipped";
const NOTIFICATION_SENT_STATUS = "sent";
const NOTIFICATION_FAILED_STATUS = "failed";

let notificationEmailTransporter = null;

function normalizeSourceType(value = "") {
  const candidate = String(value || "").trim().toLowerCase();

  if (!NOTIFICATION_SOURCE_EVENT_TYPES[candidate]) {
    throw new Error(`Unsupported notification source type: ${value}`);
  }

  return candidate;
}

function normalizeEventType(sourceType, eventType) {
  const fallbackEventType = NOTIFICATION_SOURCE_EVENT_TYPES[sourceType];
  const candidate = String(eventType || fallbackEventType).trim().toLowerCase();

  if (candidate !== fallbackEventType) {
    throw new Error(`Unsupported notification event type: ${eventType}`);
  }

  return candidate;
}

function buildNotificationEventRecord({
  tenantId,
  propertyId,
  hotelSlug,
  sourceType,
  sourceId,
  eventType,
  payload
}) {
  const normalizedSourceType = normalizeSourceType(sourceType);
  const normalizedSourceId = String(sourceId || "").trim();

  if (!normalizedSourceId) {
    throw new Error("Notification sourceId is required");
  }

  const normalizedPayload =
    payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const normalizedEventType = normalizeEventType(normalizedSourceType, eventType);

  return {
    ...(tenantId ? { tenant_id: String(tenantId).trim() } : {}),
    ...(propertyId ? { property_id: String(propertyId).trim() } : {}),
    hotel_slug: hotelSlug ? String(hotelSlug).trim() : null,
    source_type: normalizedSourceType,
    source_id: normalizedSourceId,
    event_type: normalizedEventType,
    dedupe_key: buildNotificationDedupeKey({
      sourceType: normalizedSourceType,
      sourceId: normalizedSourceId,
      eventType: normalizedEventType,
      payload: normalizedPayload
    }),
    delivery_channel: NOTIFICATION_DELIVERY_CHANNEL,
    status: NOTIFICATION_PENDING_STATUS,
    payload: normalizedPayload,
    error_message: null,
    processed_at: null,
    updated_at: new Date().toISOString()
  };
}

async function createNotificationEvent(input = {}) {
  const record = buildNotificationEventRecord(input);
  const databaseClient = input.databaseClient || supabase;
  let result = await databaseClient
    .from("notification_events")
    .insert([record])
    .select()
    .single();

  if (result.error && isMissingNotificationDedupeColumnError(result.error)) {
    const compatibilityRecord = { ...record };
    delete compatibilityRecord.dedupe_key;
    result = await databaseClient
      .from("notification_events")
      .insert([compatibilityRecord])
      .select()
      .single();
  }

  if (result.error && isNotificationDedupeConflict(result.error) && record.dedupe_key) {
    const existing = await databaseClient
      .from("notification_events")
      .select("*")
      .eq("hotel_slug", record.hotel_slug)
      .eq("dedupe_key", record.dedupe_key)
      .maybeSingle();

    if (!existing.error && existing.data) {
      return existing.data;
    }
  }

  if (result.error) {
    throw result.error;
  }

  return result.data;
}

function buildHotelNotificationSettings(settingsRow, hotelSlug = "") {
  return {
    exists: !!settingsRow,
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

async function fetchHotelNotificationSettings(hotelSlug = "", databaseClient = supabase) {
  const normalizedHotelSlug = String(hotelSlug || "").trim();

  if (!normalizedHotelSlug) {
    return buildHotelNotificationSettings(null, "");
  }

  const { data, error } = await databaseClient
    .from("hotel_notification_settings")
    .select("*")
    .eq("hotel_slug", normalizedHotelSlug)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return buildHotelNotificationSettings(data, normalizedHotelSlug);
}

async function updateNotificationEventStatus(
  notificationEventId,
  { status, errorMessage = null, processedAt = null } = {},
  databaseClient = supabase
) {
  const normalizedId = String(notificationEventId || "").trim();

  if (!normalizedId) {
    throw new Error("Notification event id is required");
  }

  const updatePayload = {
    updated_at: new Date().toISOString()
  };

  if (status) {
    updatePayload.status = String(status).trim().toLowerCase();
  }

  if (errorMessage !== undefined) {
    updatePayload.error_message = errorMessage ? String(errorMessage) : null;
  }

  if (processedAt !== undefined) {
    updatePayload.processed_at = processedAt || null;
  }

  const { data, error } = await databaseClient
    .from("notification_events")
    .update(updatePayload)
    .eq("id", normalizedId)
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

function isNotificationEnabledForSourceType(sourceType, hotelSettings) {
  const normalizedSourceType = normalizeSourceType(sourceType);
  const settingsKey = NOTIFICATION_SOURCE_SETTING_KEYS[normalizedSourceType];

  if (!settingsKey) {
    return true;
  }

  return !!hotelSettings?.[settingsKey];
}

function isNotificationSmtpConfigured() {
  return (
    !!String(env.notificationSmtpHost || "").trim() &&
    Number.isFinite(Number(env.notificationSmtpPort || 0)) &&
    Number(env.notificationSmtpPort || 0) > 0 &&
    !!String(env.notificationSmtpUser || "").trim() &&
    !!String(env.notificationSmtpPass || "").trim() &&
    !!String(env.notificationEmailFrom || "").trim()
  );
}

function getNotificationEmailTransporter() {
  if (notificationEmailTransporter) {
    return notificationEmailTransporter;
  }

  notificationEmailTransporter = nodemailer.createTransport({
    host: String(env.notificationSmtpHost || "").trim(),
    port: Number(env.notificationSmtpPort || 587),
    secure: !!env.notificationSmtpSecure,
    auth: {
      user: String(env.notificationSmtpUser || "").trim(),
      pass: String(env.notificationSmtpPass || "")
    }
  });

  return notificationEmailTransporter;
}

function buildNotificationEmailSubject(notificationEvent = {}) {
  const sourceType = String(notificationEvent.source_type || "event")
    .trim()
    .toLowerCase();
  const hotelSlug = String(notificationEvent.hotel_slug || "unknown-hotel").trim();
  const sourceId = String(notificationEvent.source_id || "").trim();
  const payload =
    notificationEvent.payload &&
    typeof notificationEvent.payload === "object" &&
    !Array.isArray(notificationEvent.payload)
      ? notificationEvent.payload
      : {};
  const tableNumber = String(payload.orderContext?.tableNumber || "").trim();

  if (sourceType === "order") {
    return `New order received (${hotelSlug})${tableNumber ? ` Table ${tableNumber}` : ""}${sourceId ? ` #${sourceId}` : ""}`;
  }

  if (sourceType === "reservation") {
    return `New reservation received (${hotelSlug})${
      sourceId ? ` #${sourceId}` : ""
    }`;
  }

  if (sourceType === "inquiry") {
    return `New inquiry received (${hotelSlug})${sourceId ? ` #${sourceId}` : ""}`;
  }

  if (sourceType === "contact_submission") {
    return `New contact message received (${hotelSlug})${sourceId ? ` #${sourceId}` : ""}`;
  }

  if (sourceType === "testimonial") {
    return `New testimonial submitted (${hotelSlug})${sourceId ? ` #${sourceId}` : ""}`;
  }

  if (sourceType === "support_request") {
    return `New support request received (${hotelSlug})${sourceId ? ` #${sourceId}` : ""}`;
  }

  return `New notification event (${hotelSlug})${sourceId ? ` #${sourceId}` : ""}`;
}

function buildNotificationEmailText(notificationEvent = {}) {
  const payload =
    notificationEvent.payload &&
    typeof notificationEvent.payload === "object" &&
    !Array.isArray(notificationEvent.payload)
      ? notificationEvent.payload
      : {};

  const payloadText = JSON.stringify(payload, null, 2);

  return [
    "A new notification event was recorded.",
    "",
    `Hotel: ${String(notificationEvent.hotel_slug || "")}`,
    `Source type: ${String(notificationEvent.source_type || "")}`,
    `Event type: ${String(notificationEvent.event_type || "")}`,
    `Source id: ${String(notificationEvent.source_id || "")}`,
    `Created at: ${String(notificationEvent.created_at || "")}`,
    "",
    "Payload:",
    payloadText
  ].join("\n");
}

function getNotificationPayload(notificationEvent = {}) {
  return notificationEvent.payload &&
    typeof notificationEvent.payload === "object" &&
    !Array.isArray(notificationEvent.payload)
    ? notificationEvent.payload
    : {};
}

function escapeEmailHtml(value = "") {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatNotificationMoney(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `Rs. ${amount.toFixed(2)}` : "Rs. 0.00";
}

function formatNotificationDateTime(value = "") {
  const candidate = String(value || "").trim();

  if (!candidate) return "";

  const date = new Date(candidate);

  if (Number.isNaN(date.getTime())) {
    return candidate;
  }

  return date.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function buildNotificationBadge(label = "", tone = "default") {
  const tones = {
    default: {
      background: "#f5efe1",
      text: "#6a4b14"
    },
    success: {
      background: "#e8f7ef",
      text: "#136a3f"
    },
    info: {
      background: "#e9f2ff",
      text: "#1a4fa3"
    }
  };
  const palette = tones[tone] || tones.default;

  return `<span style="display:inline-block;padding:6px 10px;border-radius:999px;background:${palette.background};color:${palette.text};font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;">${escapeEmailHtml(label)}</span>`;
}

function buildNotificationInfoRows(rows = []) {
  const safeRows = rows.filter((row) => row && row.value !== undefined && row.value !== null && String(row.value).trim() !== "");

  if (!safeRows.length) {
    return "";
  }

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
      ${safeRows
        .map(
          (row) => `
            <tr>
              <td style="padding:10px 0;border-bottom:1px solid #ece4d7;width:36%;font-size:13px;color:#7a6b5a;font-weight:600;">${escapeEmailHtml(row.label)}</td>
              <td style="padding:10px 0;border-bottom:1px solid #ece4d7;font-size:14px;color:#24190f;">${escapeEmailHtml(row.value)}</td>
            </tr>
          `
        )
        .join("")}
    </table>
  `;
}

function buildNotificationItemsTable(items = []) {
  const safeItems = Array.isArray(items) ? items : [];

  if (!safeItems.length) {
    return "";
  }

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #ece4d7;border-radius:16px;overflow:hidden;">
      <thead>
        <tr style="background:#f8f3ea;">
          <th align="left" style="padding:12px 14px;font-size:12px;color:#7a6b5a;text-transform:uppercase;letter-spacing:0.05em;">Item</th>
          <th align="center" style="padding:12px 14px;font-size:12px;color:#7a6b5a;text-transform:uppercase;letter-spacing:0.05em;">Qty</th>
          <th align="right" style="padding:12px 14px;font-size:12px;color:#7a6b5a;text-transform:uppercase;letter-spacing:0.05em;">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${safeItems
          .map((item) => {
            const qty = Number(item?.qty || 0);
            const price = Number(item?.price || 0);
            const lineTotal = Number.isFinite(Number(item?.lineTotal))
              ? Number(item.lineTotal)
              : qty * price;

            return `
              <tr>
                <td style="padding:12px 14px;border-top:1px solid #ece4d7;font-size:14px;color:#24190f;">${escapeEmailHtml(item?.name || item?.id || "Item")}</td>
                <td align="center" style="padding:12px 14px;border-top:1px solid #ece4d7;font-size:14px;color:#5a4b3b;">${escapeEmailHtml(qty)}</td>
                <td align="right" style="padding:12px 14px;border-top:1px solid #ece4d7;font-size:14px;color:#24190f;font-weight:600;">${escapeEmailHtml(formatNotificationMoney(lineTotal))}</td>
              </tr>
            `;
          })
          .join("")}
      </tbody>
    </table>
  `;
}

function buildNotificationTotalsTable(totals = {}, sourceType = "") {
  const safeTotals =
    totals && typeof totals === "object" && !Array.isArray(totals) ? totals : {};
  const rows = [];
  const subtotal = Number(safeTotals.subtotal);
  const gst = Number(safeTotals.gst);
  const deliveryCharge = Number(safeTotals.deliveryCharge);
  const normalTotal = Number(safeTotals.normalTotal);
  const gpayDiscount = Number(safeTotals.gpayDiscount);
  const gpayFinalTotal = Number(safeTotals.gpayFinalTotal);
  const total = Number(safeTotals.total);

  if (Number.isFinite(subtotal)) {
    rows.push({ label: "Subtotal", value: formatNotificationMoney(subtotal) });
  }

  if (Number.isFinite(gst)) {
    rows.push({ label: "GST", value: formatNotificationMoney(gst) });
  }

  if (Number.isFinite(deliveryCharge) && deliveryCharge > 0) {
    rows.push({ label: "Delivery Charge", value: formatNotificationMoney(deliveryCharge) });
  }

  if (Number.isFinite(normalTotal)) {
    rows.push({
      label: sourceType === "order" && Number.isFinite(gpayDiscount) && gpayDiscount > 0 ? "Original Total" : "Total",
      value: formatNotificationMoney(normalTotal)
    });
  }

  if (Number.isFinite(gpayDiscount) && gpayDiscount > 0) {
    rows.push({ label: "UPI Discount", value: `-${formatNotificationMoney(gpayDiscount)}` });
  }

  if (Number.isFinite(gpayFinalTotal) && gpayFinalTotal >= 0 && gpayFinalTotal !== normalTotal) {
    rows.push({ label: "Final Paid Amount", value: formatNotificationMoney(gpayFinalTotal) });
  } else if (!Number.isFinite(normalTotal) && Number.isFinite(total)) {
    rows.push({ label: "Total", value: formatNotificationMoney(total) });
  }

  if (!rows.length) {
    return "";
  }

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
      ${rows
        .map(
          (row, index) => `
            <tr>
              <td style="padding:${index === 0 ? "0" : "10px 0 0"} 0;font-size:13px;color:#7a6b5a;">${escapeEmailHtml(row.label)}</td>
              <td align="right" style="padding:${index === 0 ? "0" : "10px 0 0"} 0;font-size:14px;color:#24190f;font-weight:700;">${escapeEmailHtml(row.value)}</td>
            </tr>
          `
        )
        .join("")}
    </table>
  `;
}

function buildNotificationEmailHtml(notificationEvent = {}) {
  const payload = getNotificationPayload(notificationEvent);
  const sourceType = String(notificationEvent.source_type || "").trim().toLowerCase();
  const hotelName = String(payload.hotelName || notificationEvent.hotel_slug || "Hotel").trim();
  const eventTitleMap = {
    order: "New order received",
    reservation: "New reservation received",
    inquiry: "New inquiry received",
    contact_submission: "New contact message received",
    testimonial: "New testimonial submitted",
    support_request: "New support request received"
  };
  const eventTitle = eventTitleMap[sourceType] || "New notification received";
  let primaryBadge = buildNotificationBadge(String(sourceType || "event"), "default");
  let secondaryBadge = "";
  let overviewRows = [];
  let detailsSection = "";
  let itemsSection = "";
  let totalsSection = "";
  const note = String(
    payload.note ||
      payload.specialRequirements ||
      ""
  ).trim();

  if (sourceType === "order") {
    const orderContext =
      payload.orderContext && typeof payload.orderContext === "object" && !Array.isArray(payload.orderContext)
        ? payload.orderContext
        : {};
    overviewRows = [
      { label: "Order ID", value: payload.orderId || notificationEvent.source_id || "" },
      { label: "Customer", value: payload.customerName || "" },
      { label: "Phone", value: payload.customerPhone || "" },
      { label: "Address", value: payload.customerAddress || "" },
      { label: "Payment Method", value: payload.paymentMethod || "" },
      { label: "Payment Status", value: payload.paymentStatus || "" },
      { label: "Billing Status", value: payload.billingStatus || "" },
      { label: "Order Type", value: orderContext.orderType || "" },
      { label: "Table", value: orderContext.tableNumber || "" },
      { label: "Source", value: orderContext.orderSource || "" }
    ];
    primaryBadge = buildNotificationBadge(payload.paymentMethod || "order", "info");
    secondaryBadge = payload.status
      ? buildNotificationBadge(payload.status, payload.status === "new" ? "default" : "success")
      : "";
    itemsSection = Array.isArray(payload.items) && payload.items.length
      ? `
        <div style="margin-top:28px;">
          <h3 style="margin:0 0 12px;font-size:16px;line-height:1.4;color:#24190f;">Items</h3>
          ${buildNotificationItemsTable(payload.items)}
        </div>
      `
      : "";
    totalsSection = buildNotificationTotalsTable(payload.totals, sourceType)
      ? `
        <div style="margin-top:28px;padding:18px 20px;border-radius:18px;background:#f8f3ea;border:1px solid #ece4d7;">
          <h3 style="margin:0 0 12px;font-size:16px;line-height:1.4;color:#24190f;">Payment summary</h3>
          ${buildNotificationTotalsTable(payload.totals, sourceType)}
        </div>
      `
      : "";
  } else if (sourceType === "reservation") {
    overviewRows = [
      { label: "Reservation ID", value: payload.reservationId || notificationEvent.source_id || "" },
      { label: "Guest", value: payload.name || "" },
      { label: "Phone", value: payload.phone || "" },
      { label: "Date", value: payload.date || "" },
      { label: "Time", value: payload.time || "" },
      { label: "Guests", value: payload.guests || "" },
      { label: "Status", value: payload.status || "" }
    ];
    primaryBadge = buildNotificationBadge("reservation", "info");
  } else if (sourceType === "inquiry") {
    overviewRows = [
      { label: "Inquiry ID", value: payload.inquiryId || notificationEvent.source_id || "" },
      { label: "Guest", value: payload.name || "" },
      { label: "Phone", value: payload.phone || "" },
      { label: "Event Type", value: payload.eventType || "" },
      { label: "Date", value: payload.date || "" },
      { label: "Guests", value: payload.guests || "" },
      { label: "Status", value: payload.status || "" }
    ];
    primaryBadge = buildNotificationBadge("inquiry", "info");
  } else if (sourceType === "contact_submission") {
    overviewRows = [
      { label: "Contact ID", value: payload.contactSubmissionId || notificationEvent.source_id || "" },
      { label: "Name", value: payload.name || "" },
      { label: "Email", value: payload.email || "" },
      { label: "Subject", value: payload.subject || "" },
      { label: "Status", value: payload.status || "new" },
      { label: "Source", value: payload.source || "" }
    ];
    primaryBadge = buildNotificationBadge("contact", "info");
  } else if (sourceType === "testimonial") {
    overviewRows = [
      { label: "Review ID", value: payload.testimonialId || notificationEvent.source_id || "" },
      { label: "Guest", value: payload.name || "" },
      { label: "Role", value: payload.role || "" },
      { label: "Stars", value: payload.stars || "" },
      { label: "Approval", value: payload.approvalStatus || "pending" }
    ];
    primaryBadge = buildNotificationBadge("testimonial", "info");
  } else if (sourceType === "support_request") {
    overviewRows = [
      { label: "Support ID", value: payload.supportRequestId || notificationEvent.source_id || "" },
      { label: "Order ID", value: payload.orderId || "" },
      { label: "Hotel", value: payload.hotelName || "" },
      { label: "Table", value: payload.tableNumber || "" },
      { label: "Request Type", value: payload.requestType || "" },
      { label: "Order Status", value: payload.orderStatus || "" },
      { label: "Source", value: payload.source || "" }
    ];
    primaryBadge = buildNotificationBadge("support", "info");
  } else {
    detailsSection = buildNotificationInfoRows([
      { label: "Hotel", value: notificationEvent.hotel_slug || "" },
      { label: "Source", value: notificationEvent.source_type || "" },
      { label: "Event", value: notificationEvent.event_type || "" },
      { label: "Reference", value: notificationEvent.source_id || "" }
    ]);
  }

  if (!detailsSection) {
    detailsSection = buildNotificationInfoRows(overviewRows);
  }

  const noteSection = note
    ? `
      <div style="margin-top:28px;padding:18px 20px;border-radius:18px;background:#fffaf0;border:1px solid #f0dfb2;">
        <h3 style="margin:0 0 10px;font-size:16px;line-height:1.4;color:#24190f;">Special note</h3>
        <p style="margin:0;font-size:14px;line-height:1.7;color:#4f4133;white-space:pre-line;">${escapeEmailHtml(note)}</p>
      </div>
    `
    : "";

  const createdAtLabel = formatNotificationDateTime(notificationEvent.created_at || "");

  return `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeEmailHtml(eventTitle)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4efe7;font-family:Arial,'Helvetica Neue',sans-serif;color:#24190f;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#f4efe7;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;max-width:680px;background:#ffffff;border-radius:24px;overflow:hidden;box-shadow:0 24px 70px rgba(68,44,18,0.12);">
            <tr>
              <td style="padding:36px 34px;background:linear-gradient(135deg,#1f150e 0%,#5c3a1c 52%,#b88a45 100%);">
                <div style="font-size:12px;letter-spacing:0.14em;text-transform:uppercase;color:#f2dec0;font-weight:700;">Hotel Operations</div>
                <h1 style="margin:14px 0 10px;font-size:30px;line-height:1.2;color:#ffffff;font-family:Georgia,'Times New Roman',serif;">${escapeEmailHtml(eventTitle)}</h1>
                <p style="margin:0;font-size:15px;line-height:1.7;color:#f7ead7;">${escapeEmailHtml(hotelName)}</p>
                <div style="margin-top:20px;">${primaryBadge}${secondaryBadge ? `&nbsp;${secondaryBadge}` : ""}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:30px 34px;">
                <div style="padding:20px 22px;border-radius:20px;background:#fcfaf7;border:1px solid #ece4d7;">
                  <h2 style="margin:0 0 14px;font-size:17px;line-height:1.4;color:#24190f;">Operational details</h2>
                  ${detailsSection}
                </div>
                ${itemsSection}
                ${totalsSection}
                ${noteSection}
                <div style="margin-top:30px;padding-top:18px;border-top:1px solid #ece4d7;font-size:12px;line-height:1.7;color:#7a6b5a;">
                  <div><strong style="color:#4f4133;">Hotel slug:</strong> ${escapeEmailHtml(notificationEvent.hotel_slug || "")}</div>
                  <div><strong style="color:#4f4133;">Event type:</strong> ${escapeEmailHtml(notificationEvent.event_type || "")}</div>
                  <div><strong style="color:#4f4133;">Reference:</strong> ${escapeEmailHtml(notificationEvent.source_id || "")}</div>
                  ${createdAtLabel ? `<div><strong style="color:#4f4133;">Recorded at:</strong> ${escapeEmailHtml(createdAtLabel)}</div>` : ""}
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function sendNotificationEventEmail(notificationEvent = {}, hotelSettings = {}) {
  const transporter = getNotificationEmailTransporter();

  return transporter.sendMail({
    from: String(env.notificationEmailFrom || "").trim(),
    to: String(hotelSettings.ownerEmail || "").trim(),
    subject: buildNotificationEmailSubject(notificationEvent),
    text: buildNotificationEmailText(notificationEvent),
    html: buildNotificationEmailHtml(notificationEvent)
  });
}

function getNotificationDeliverySkipReason(notificationEvent = {}, hotelSettings = null) {
  const configuredChannel = String(
    env.notificationDeliveryChannel || NOTIFICATION_DELIVERY_CHANNEL
  )
    .trim()
    .toLowerCase();
  const hotelSlug = String(notificationEvent.hotel_slug || "").trim();
  const sourceType = String(notificationEvent.source_type || "").trim().toLowerCase();

  if (!hotelSlug) {
    return "Notification event missing hotel slug";
  }

  if (!hotelSettings?.exists) {
    return "Notification settings not configured for hotel";
  }

  if (!hotelSettings.emailEnabled) {
    return "Hotel email notifications disabled";
  }

  if (!isNotificationEnabledForSourceType(sourceType, hotelSettings)) {
    return `Notification type "${sourceType}" disabled for hotel`;
  }

  if (!hotelSettings.ownerEmail) {
    return "Hotel notification email not configured";
  }

  if (!env.notificationDeliveryEnabled) {
    return "Notification delivery disabled by config";
  }

  if (configuredChannel === "internal") {
    return "Notification delivery channel is internal only";
  }

  if (configuredChannel === "email") {
    if (!isNotificationSmtpConfigured()) {
      return "Notification SMTP/email configuration is incomplete";
    }

    return "";
  }

  return `Notification delivery channel "${configuredChannel}" is not implemented yet`;
}

async function processNotificationEventDelivery(notificationEvent = {}, options = {}) {
  const databaseClient = options.databaseClient || supabase;
  const processedAt = new Date().toISOString();
  const hotelSettings = await fetchHotelNotificationSettings(
    notificationEvent.hotel_slug || "",
    databaseClient
  );
  const skipReason = getNotificationDeliverySkipReason(
    notificationEvent,
    hotelSettings
  );

  if (skipReason) {
    return updateNotificationEventStatus(notificationEvent.id, {
      status: NOTIFICATION_SKIPPED_STATUS,
      errorMessage: skipReason,
      processedAt
    }, databaseClient);
  }

  try {
    await sendNotificationEventEmail(notificationEvent, hotelSettings);

    return updateNotificationEventStatus(notificationEvent.id, {
      status: NOTIFICATION_SENT_STATUS,
      errorMessage: null,
      processedAt
    }, databaseClient);
  } catch (error) {
    return updateNotificationEventStatus(notificationEvent.id, {
      status: NOTIFICATION_FAILED_STATUS,
      errorMessage: error.message || "Notification delivery failed",
      processedAt
    }, databaseClient);
  }
}

async function processNotificationEventDeliverySafely(notificationEvent = {}, options = {}) {
  try {
    return await processNotificationEventDelivery(notificationEvent, options);
  } catch (error) {
    console.error("Notification delivery process failed:", {
      notificationEventId: notificationEvent.id || null,
      sourceType: notificationEvent.source_type || null,
      sourceId: notificationEvent.source_id || null,
      message: error.message
    });

    return null;
  }
}

async function createNotificationEventSafely(input = {}) {
  try {
    const notificationEvent = await createNotificationEvent(input);
    // The event is persisted before it is published to live dashboard sessions.
    publishNotificationEvent(notificationEvent);
    const processedEvent = await processNotificationEventDeliverySafely(
      notificationEvent,
      { databaseClient: input.databaseClient || supabase }
    );

    return processedEvent || notificationEvent;
  } catch (error) {
    console.error("Notification event log failed:", {
      hotelSlug: input.hotelSlug || null,
      sourceType: input.sourceType || null,
      sourceId: input.sourceId || null,
      message: error.message
    });

    return null;
  }
}

module.exports = {
  buildHotelNotificationSettings,
  buildNotificationDedupeKey,
  buildNotificationEventRecord,
  createNotificationEvent,
  createNotificationEventSafely,
  fetchHotelNotificationSettings,
  getNotificationEmailTransporter,
  processNotificationEventDelivery,
  processNotificationEventDeliverySafely,
  sendNotificationEventEmail,
  updateNotificationEventStatus
};
