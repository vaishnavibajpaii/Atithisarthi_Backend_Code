const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { supabase } = require("../utils/supabase");
const { env } = require("../config/env");
const { getTenantMutationClient } = require("../utils/tenant-route-database");
const { getTenantRequestScope } = require("../utils/tenant-request-context");
const logger = require("../utils/logger");
const ordersRoute = require("./orders");
const { validateBody } = require("../validators/common");
const { secureQrEditSchema, secureQrOrderSchema } = require("../validators/secure-qr");
const { ensureHotelFeatureEnabled } = require("../middleware/require-hotel-feature");
const { ensurePublicHotelAccess } = require("../utils/public-hotel-access");
const {
  buildCustomerOrderingDisabledPayload,
  buildPaymentMethodDisabledPayload,
  fetchHotelOrderingSettings,
  isHotelPaymentMethodEnabled,
  normalizePaymentMethod
} = require("../utils/hotel-ordering-settings");
const { generateOrderTrackingToken } = require("../utils/order-tracking");
const {
  QR_SESSION_COOKIE,
  QR_SESSION_TTL_MS,
  buildRequestFingerprint,
  generateCsrfToken,
  generateCustomerSessionToken,
  getQrSessionCookieOptions,
  getQrSessionToken,
  hashSecret,
  normalizeSecureQrText,
  safeSecretPrefix
} = require("../utils/secure-qr");

const router = express.Router();

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
const calculateVerifiedOrderPricing = ordersRoute.calculateVerifiedOrderPricing;
const buildVerifiedOrderSummary = ordersRoute.buildVerifiedOrderSummary;
const isActiveTableOrderUniqueConflict = ordersRoute.isActiveTableOrderUniqueConflict;

function tokenRateLimitKey(scope) {
  return (req) => {
    const ip = req.ip ? rateLimit.ipKeyGenerator(req.ip) : "unknown-ip";
    const tokenHash = hashSecret(req.params?.token || "missing").slice(0, 20);
    return `${scope}:${ip}:${tokenHash}`;
  };
}

const qrContextLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: tokenRateLimitKey("qr-context"),
  message: { success: false, message: "Too many QR requests. Please wait and scan again." }
});

const qrWriteLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: tokenRateLimitKey("qr-write"),
  message: { success: false, message: "Too many QR order attempts. Please wait and try again." }
});

function isMissingSecureQrSchema(error) {
  const code = String(error?.code || "").toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`.toLowerCase();
  return ["42P01", "42703", "PGRST202", "PGRST204", "PGRST205"].includes(code) ||
    details.includes("restaurant_table_qr_tokens") ||
    details.includes("qr_customer_sessions") ||
    details.includes("submit_secure_qr_table_order");
}

async function recordSecurityEvent({
  hotelSlug = null,
  tableId = null,
  eventType,
  requestId = "",
  actorReference = "",
  safeContext = {}
}) {
  try {
    await supabase.from("qr_security_events").insert([{
      hotel_slug: hotelSlug,
      restaurant_table_id: tableId,
      event_type: eventType,
      request_id: normalizeSecureQrText(requestId, 160) || null,
      actor_reference: normalizeSecureQrText(actorReference, 160) || null,
      safe_context: safeContext && typeof safeContext === "object" ? safeContext : {}
    }]);
  } catch {
    // Security logging must never disclose secrets or replace the safe customer response.
  }
}

async function resolveOpaqueQrContext(req, res, rawToken) {
  const token = normalizeSecureQrText(rawToken, 200);
  if (!token || !token.startsWith("q1_") || token.length < 40) {
    void recordSecurityEvent({
      eventType: "INVALID_QR_TOKEN",
      requestId: req.requestId,
      actorReference: safeSecretPrefix(token)
    });
    res.status(404).json({
      success: false,
      message: "This QR code is invalid or no longer active. Please contact restaurant staff."
    });
    return null;
  }

  const tokenHash = hashSecret(token);
  const tokenResult = await supabase
    .from("restaurant_table_qr_tokens")
    .select("id,hotel_slug,restaurant_table_id,token_version,is_active,revoked_at,last_used_at")
    .eq("token_hash", tokenHash)
    .eq("is_active", true)
    .is("revoked_at", null)
    .maybeSingle();

  if (tokenResult.error) {
    if (isMissingSecureQrSchema(tokenResult.error)) {
      res.status(503).json({ success: false, code: "SECURE_QR_NOT_INITIALIZED", message: "Secure QR ordering is not initialized yet." });
      return null;
    }
    throw tokenResult.error;
  }
  if (!tokenResult.data) {
    void recordSecurityEvent({
      eventType: "INVALID_OR_REVOKED_QR_TOKEN",
      requestId: req.requestId,
      actorReference: safeSecretPrefix(token)
    });
    res.status(404).json({
      success: false,
      message: "This QR code is invalid or no longer active. Please contact restaurant staff."
    });
    return null;
  }

  const qrToken = tokenResult.data;
  const hotelAccess = await ensurePublicHotelAccess(req, res, qrToken.hotel_slug, {
    notFoundMessage: "QR ordering is unavailable.",
    forbiddenMessage: "This QR code does not belong to this restaurant."
  });
  if (!hotelAccess) {
    void recordSecurityEvent({
      hotelSlug: qrToken.hotel_slug,
      tableId: qrToken.restaurant_table_id,
      eventType: "QR_CROSS_TENANT_ATTEMPT",
      requestId: req.requestId
    });
    return null;
  }

  if (!(await ensureHotelFeatureEnabled(res, { featureKey: "food", hotelSlug: qrToken.hotel_slug }))) {
    return null;
  }

  const tableResult = await supabase
    .from("restaurant_tables")
    .select("id,hotel_slug,table_code,table_name,is_active,operational_status")
    .eq("id", qrToken.restaurant_table_id)
    .eq("hotel_slug", qrToken.hotel_slug)
    .maybeSingle();
  if (tableResult.error) throw tableResult.error;
  const table = tableResult.data;
  if (!table || table.is_active !== true || table.operational_status !== "active") {
    res.status(409).json({
      success: false,
      message: "QR ordering is currently unavailable for this table. Please contact restaurant staff."
    });
    return null;
  }

  return { rawToken: token, tokenHash, qrToken, table };
}

async function getBoundSession(req, res, expectedContext = null) {
  const rawSessionToken = getQrSessionToken(req);
  if (!rawSessionToken) {
    res.status(401).json({ success: false, code: "QR_SESSION_REQUIRED", message: "Your QR ordering session has expired. Please scan the table QR again." });
    return null;
  }
  const sessionHash = hashSecret(rawSessionToken);
  const result = await supabase
    .from("qr_customer_sessions")
    .select("id,public_reference,hotel_slug,restaurant_table_id,qr_token_id,qr_token_version,csrf_token_hash,expires_at,revoked_at")
    .eq("session_token_hash", sessionHash)
    .maybeSingle();
  if (result.error) throw result.error;
  const session = result.data;
  const expired = !session || session.revoked_at || Date.parse(session.expires_at) <= Date.now();
  const mismatched = expectedContext && session && (
    session.hotel_slug !== expectedContext.qrToken.hotel_slug ||
    String(session.restaurant_table_id) !== String(expectedContext.qrToken.restaurant_table_id) ||
    String(session.qr_token_id) !== String(expectedContext.qrToken.id) ||
    Number(session.qr_token_version) !== Number(expectedContext.qrToken.token_version)
  );
  if (expired || mismatched) {
    res.clearCookie(QR_SESSION_COOKIE, getQrSessionCookieOptions());
    void recordSecurityEvent({
      hotelSlug: session?.hotel_slug || expectedContext?.qrToken?.hotel_slug || null,
      tableId: session?.restaurant_table_id || expectedContext?.qrToken?.restaurant_table_id || null,
      eventType: mismatched ? "QR_SESSION_OWNERSHIP_FAILURE" : "QR_SESSION_EXPIRED",
      requestId: req.requestId,
      actorReference: session?.public_reference || ""
    });
    res.status(401).json({ success: false, code: "QR_SESSION_INVALID", message: "Your QR ordering session has expired. Please scan the table QR again." });
    return null;
  }
  if (!expectedContext) {
    const hotelAccess = await ensurePublicHotelAccess(req, res, session.hotel_slug, {
      notFoundMessage: "QR ordering is unavailable.",
      forbiddenMessage: "This QR session does not belong to this restaurant."
    });
    if (!hotelAccess) return null;
  }
  return { ...session, rawSessionToken, sessionHash };
}

function requireValidCsrf(req, res, session) {
  const suppliedToken = normalizeSecureQrText(req.get("X-QR-CSRF-Token"), 200);
  if (!suppliedToken || hashSecret(suppliedToken) !== session.csrf_token_hash) {
    void recordSecurityEvent({
      hotelSlug: session.hotel_slug,
      tableId: session.restaurant_table_id,
      eventType: "QR_CSRF_REJECTED",
      requestId: req.requestId,
      actorReference: session.public_reference
    });
    res.status(403).json({ success: false, code: "QR_CSRF_REJECTED", message: "This order request could not be verified. Please refresh and try again." });
    return false;
  }
  return true;
}

router.get("/:token/context", qrContextLimiter, async (req, res) => {
  try {
    const context = await resolveOpaqueQrContext(req, res, req.params.token);
    if (!context) return;
    const orderingSettings = await fetchHotelOrderingSettings(context.qrToken.hotel_slug);
    if (orderingSettings.customerOrderingEnabled === false) {
      return res.status(403).json(buildCustomerOrderingDisabledPayload(orderingSettings));
    }
    const hotelResult = await supabase
      .from("hotel_profiles")
      .select("hotel_name,branding")
      .eq("hotel_slug", context.qrToken.hotel_slug)
      .maybeSingle();
    if (hotelResult.error) throw hotelResult.error;
    const database = getTenantMutationClient(req, supabase);
    void database.from("restaurant_table_qr_tokens")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", context.qrToken.id);
    res.set("Cache-Control", "no-store");
    return res.json({
      success: true,
      restaurant: {
        name: hotelResult.data?.hotel_name || "Restaurant",
        logoUrl: hotelResult.data?.branding?.logo || "",
        orderingEnabled: true
      },
      table: {
        displayCode: context.table.table_code,
        displayName: context.table.table_name || `Table ${context.table.table_code}`
      },
      session: { requiresConfirmation: true },
      resolvedHotelSlug: context.qrToken.hotel_slug
    });
  } catch (error) {
    logger.error("Secure QR context failed", { requestId: req.requestId, message: error.message });
    return res.status(500).json({ success: false, message: "The table menu could not be opened. Please try again." });
  }
});

router.post("/:token/session", qrWriteLimiter, async (req, res) => {
  try {
    const context = await resolveOpaqueQrContext(req, res, req.params.token);
    if (!context) return;
    const sessionToken = generateCustomerSessionToken();
    const csrfToken = generateCsrfToken();
    const expiresAt = new Date(Date.now() + QR_SESSION_TTL_MS).toISOString();
    const database = getTenantMutationClient(req, supabase);
    const scope = env.tenantRuntimeWritesEnabled ? getTenantRequestScope(req) : null;
    const { data, error } = await database.from("qr_customer_sessions").insert([{
      ...(scope ? { tenant_id: scope.tenantId, property_id: scope.propertyId } : {}),
      hotel_slug: scope?.propertySlug || context.qrToken.hotel_slug,
      restaurant_table_id: context.qrToken.restaurant_table_id,
      qr_token_id: context.qrToken.id,
      qr_token_version: context.qrToken.token_version,
      session_token_hash: hashSecret(sessionToken),
      csrf_token_hash: hashSecret(csrfToken),
      expires_at: expiresAt
    }]).select("public_reference,expires_at").single();
    if (error) throw error;
    res.cookie(QR_SESSION_COOKIE, sessionToken, getQrSessionCookieOptions());
    res.set("Cache-Control", "no-store");
    return res.status(201).json({
      success: true,
      csrfToken,
      session: { publicReference: data.public_reference, version: 1, expiresAt: data.expires_at },
      table: { displayCode: context.table.table_code, displayName: context.table.table_name || `Table ${context.table.table_code}` }
    });
  } catch (error) {
    logger.error("Secure QR session create failed", { requestId: req.requestId, message: error.message });
    return res.status(isMissingSecureQrSchema(error) ? 503 : 500).json({ success: false, message: "A secure ordering session could not be started. Please scan again." });
  }
});

router.post("/:token/orders", qrWriteLimiter, validateBody(secureQrOrderSchema), async (req, res) => {
  try {
    const context = await resolveOpaqueQrContext(req, res, req.params.token);
    if (!context) return;
    const session = await getBoundSession(req, res, context);
    if (!session || !requireValidCsrf(req, res, session)) return;
    const orderingSettings = await fetchHotelOrderingSettings(context.qrToken.hotel_slug);
    if (orderingSettings.customerOrderingEnabled === false) {
      return res.status(403).json(buildCustomerOrderingDisabledPayload(orderingSettings));
    }
    if (!isHotelPaymentMethodEnabled(orderingSettings, req.validatedBody.paymentMethod)) {
      return res.status(409).json(
        buildPaymentMethodDisabledPayload(orderingSettings, req.validatedBody.paymentMethod)
      );
    }

    if (req.validatedBody.items.some((item) => item.variantId != null || (item.addonIds || []).length)) {
      return res.status(400).json({ success: false, message: "The selected variant or add-on is not available for secure QR ordering." });
    }
    const requestedItems = req.validatedBody.items.map((item) => ({
      id: item.menuItemId,
      qty: item.quantity,
      note: item.note || ""
    }));
    const pricing = await calculateVerifiedOrderPricing({
      hotelSlug: context.qrToken.hotel_slug,
      items: requestedItems,
      paymentMethod: req.validatedBody.paymentMethod,
      orderContext: { orderType: "dine-in", tableNumber: context.table.table_code, orderSource: "qr" }
    });
    if (pricing.error) {
      return res.status(400).json({ success: false, message: pricing.error });
    }
    if (
      normalizePaymentMethod(req.validatedBody.paymentMethod) === "manual_upi" &&
      !String(pricing.hotel?.owner_upi_id || "").trim()
    ) {
      return res.status(409).json({
        success: false,
        code: "PAYMENT_METHOD_NOT_CONFIGURED",
        message: "Google Pay / UPI is not configured for this hotel. Please choose another payment method."
      });
    }

    const submissionReference = crypto.randomUUID();
    const trustedItems = pricing.items.map((item) => ({
      ...item,
      publicItemReference: crypto.randomUUID(),
      qrSessionReference: session.public_reference,
      qrSubmissionReference: submissionReference,
      kitchenStatus: "new"
    }));
    const paymentStatus = req.validatedBody.paymentMethod === "Google Pay / UPI" && req.validatedBody.paymentConfirmed === true
      ? "customer_confirmed"
      : "unpaid";
    const customerAddress = `Dine-in table ${context.table.table_code}`;
    const whatsappMessage = buildVerifiedOrderSummary({
      hotelName: pricing.hotel.hotel_name,
      customerName: req.validatedBody.customerName,
      customerPhone: req.validatedBody.customerPhone,
      customerAddress,
      paymentMethod: req.validatedBody.paymentMethod,
      paymentConfirmed: req.validatedBody.paymentConfirmed === true,
      note: req.validatedBody.note || "",
      items: trustedItems,
      totals: pricing.totals,
      orderContext: { orderType: "dine-in", tableNumber: context.table.table_code, orderSource: "qr" }
    });
    const fingerprint = buildRequestFingerprint({
      session: session.public_reference,
      items: req.validatedBody.items,
      note: req.validatedBody.note || "",
      paymentMethod: req.validatedBody.paymentMethod
    });
    const idempotencyKeyHash = hashSecret(req.validatedBody.clientRequestId);
    const database = getTenantMutationClient(req, supabase);
    const { data: rpcData, error: rpcError } = await database.rpc("submit_secure_qr_table_order", {
      p_token_hash: context.tokenHash,
      p_session_hash: session.sessionHash,
      p_idempotency_key_hash: idempotencyKeyHash,
      p_request_fingerprint: fingerprint,
      p_order: {
        hotelName: pricing.hotel.hotel_name,
        customerName: req.validatedBody.customerName,
        customerPhone: req.validatedBody.customerPhone,
        customerAddress,
        paymentMethod: req.validatedBody.paymentMethod,
        paymentStatus,
        note: req.validatedBody.note || "",
        items: trustedItems,
        totals: pricing.totals,
        whatsappMessage,
        trackingToken: generateOrderTrackingToken(),
        submissionReference
      },
      p_request_id: req.requestId || ""
    });
    if (rpcError) throw rpcError;
    const result = Array.isArray(rpcData) ? rpcData[0] : rpcData;
    if (!result?.ok) {
      const conflictCodes = new Set(["IDEMPOTENCY_KEY_REUSED", "QR_SESSION_INVALID", "QR_TABLE_INACTIVE"]);
      const status = result?.code === "INVALID_QR_TOKEN" ? 404 : conflictCodes.has(result?.code) ? 409 : 400;
      return res.status(status).json({ success: false, code: result?.code || "QR_ORDER_REJECTED", message: "This QR order could not be accepted. Please refresh and try again." });
    }

    const submission = result.submission || {};
    res.set("Cache-Control", "no-store");
    return res.status(result.duplicate ? 200 : 201).json({
      success: true,
      duplicate: result.duplicate === true,
      message: result.duplicate
        ? "This order was already received. No duplicate items or KOT were created."
        : result.firstOrder ? "Your table order was received." : "Your added items were received.",
      table: { displayCode: context.table.table_code },
      order: { publicReference: submission.public_reference, status: submission.status || "new", roundSequence: submission.round_sequence },
      kitchen: { kotReference: result.kotReference, delivery: "queued" }
    });
  } catch (error) {
    if (isActiveTableOrderUniqueConflict(error)) {
      return res.status(409).json({
        success: false,
        code: "TABLE_ORDER_CHANGED",
        message: "This table order changed while your items were submitted. Please retry; no duplicate KOT was created."
      });
    }

    logger.error("Secure QR order submit failed", { requestId: req.requestId, message: error.message });
    return res.status(isMissingSecureQrSchema(error) ? 503 : 500).json({ success: false, message: "Your order was not confirmed. Please retry." });
  }
});

router.patch("/submissions/:publicReference", qrWriteLimiter, validateBody(secureQrEditSchema), async (req, res) => {
  try {
    const session = await getBoundSession(req, res);
    if (!session || !requireValidCsrf(req, res, session)) return;
    const publicReference = normalizeSecureQrText(req.params.publicReference, 80);
    const submissionResult = await supabase.from("qr_order_submissions")
      .select("public_reference,order_id,items,row_version,status,edit_expires_at")
      .eq("public_reference", publicReference)
      .eq("qr_session_id", session.id)
      .eq("hotel_slug", session.hotel_slug)
      .maybeSingle();
    if (submissionResult.error) throw submissionResult.error;
    const currentSubmission = submissionResult.data;
    if (!currentSubmission) {
      void recordSecurityEvent({
        hotelSlug: session.hotel_slug,
        tableId: session.restaurant_table_id,
        eventType: "QR_SESSION_OWNERSHIP_FAILURE",
        requestId: req.requestId,
        actorReference: session.public_reference
      });
      return res.status(404).json({ success: false, message: "This QR order is not available in your session." });
    }
    const allowedReferences = new Set((currentSubmission.items || [])
      .map((item) => String(item.publicItemReference || ""))
      .filter(Boolean));
    const foreignReference = req.validatedBody.items.find((item) =>
      item.publicItemReference && !allowedReferences.has(item.publicItemReference));
    if (foreignReference) {
      void recordSecurityEvent({
        hotelSlug: session.hotel_slug,
        tableId: session.restaurant_table_id,
        eventType: "QR_SESSION_OWNERSHIP_FAILURE",
        requestId: req.requestId,
        actorReference: session.public_reference
      });
      return res.status(403).json({ success: false, message: "You can edit only items from your own QR order." });
    }
    if (req.validatedBody.items.some((item) => item.variantId != null || (item.addonIds || []).length)) {
      return res.status(400).json({ success: false, message: "The selected variant or add-on is not available for secure QR ordering." });
    }
    const orderResult = await supabase.from("orders")
      .select("payment_method,table_number")
      .eq("id", currentSubmission.order_id)
      .eq("hotel_slug", session.hotel_slug)
      .maybeSingle();
    if (orderResult.error) throw orderResult.error;
    if (!orderResult.data) return res.status(404).json({ success: false, message: "This table order is no longer available." });
    const pricing = await calculateVerifiedOrderPricing({
      hotelSlug: session.hotel_slug,
      items: req.validatedBody.items.map((item) => ({ id: item.menuItemId, qty: item.quantity, note: item.note || "" })),
      paymentMethod: orderResult.data.payment_method || "COD",
      orderContext: { orderType: "dine-in", tableNumber: orderResult.data.table_number, orderSource: "qr" }
    });
    if (pricing.error) return res.status(400).json({ success: false, message: pricing.error });
    const trustedItems = pricing.items.map((item, index) => ({
      ...item,
      publicItemReference: req.validatedBody.items[index].publicItemReference || crypto.randomUUID(),
      qrSessionReference: session.public_reference,
      qrSubmissionReference: publicReference,
      kitchenStatus: "new"
    }));
    const fingerprint = buildRequestFingerprint({
      submission: publicReference,
      expectedVersion: req.validatedBody.expectedRoundVersion,
      items: req.validatedBody.items,
      note: req.validatedBody.note || ""
    });
    const database = getTenantMutationClient(req, supabase);
    const { data: rpcData, error: rpcError } = await database.rpc("edit_secure_qr_submission", {
      p_session_hash: session.sessionHash,
      p_submission_reference: publicReference,
      p_expected_version: req.validatedBody.expectedRoundVersion,
      p_idempotency_key_hash: hashSecret(req.validatedBody.clientRequestId),
      p_request_fingerprint: fingerprint,
      p_items: trustedItems,
      p_totals: pricing.totals,
      p_note: req.validatedBody.note || "",
      p_request_id: req.requestId || ""
    });
    if (rpcError) throw rpcError;
    const result = Array.isArray(rpcData) ? rpcData[0] : rpcData;
    if (!result?.ok) {
      const code = result?.code || "QR_EDIT_REJECTED";
      const status = code === "QR_SUBMISSION_NOT_OWNED" ? 404
        : ["QR_EDIT_LOCKED", "QR_SUBMISSION_CHANGED", "IDEMPOTENCY_KEY_REUSED"].includes(code) ? 409 : 400;
      const message = code === "QR_SUBMISSION_CHANGED"
        ? "This order was updated by another user. The latest version has been loaded."
        : code === "QR_EDIT_LOCKED"
          ? "This order is already being prepared and can no longer be edited. Please contact restaurant staff."
          : "This QR order could not be updated.";
      return res.status(status).json({ success: false, code, message, currentVersion: result?.currentVersion });
    }
    return res.json({
      success: true,
      duplicate: result.duplicate === true,
      message: result.duplicate ? "This correction was already saved." : "Your order correction was saved.",
      order: {
        publicReference,
        version: Number(result.submission?.row_version || req.validatedBody.expectedRoundVersion + 1),
        status: result.submission?.status || "new",
        items: result.submission?.items || trustedItems,
        totals: result.submission?.totals_delta || pricing.totals,
        editable: true
      }
    });
  } catch (error) {
    logger.error("Secure QR submission edit failed", { requestId: req.requestId, message: error.message });
    return res.status(isMissingSecureQrSchema(error) ? 503 : 500).json({ success: false, message: "Your order correction was not confirmed. Please retry." });
  }
});

router.get("/submissions/:publicReference", qrContextLimiter, async (req, res) => {

  try {
    const session = await getBoundSession(req, res);
    if (!session) return;
    const publicReference = normalizeSecureQrText(req.params.publicReference, 80);
    const submissionResult = await supabase
      .from("qr_order_submissions")
      .select("public_reference,order_id,round_sequence,status,items,totals_delta,note,row_version,edit_expires_at,created_at,updated_at")
      .eq("public_reference", publicReference)
      .eq("qr_session_id", session.id)
      .eq("hotel_slug", session.hotel_slug)
      .maybeSingle();
    if (submissionResult.error) throw submissionResult.error;
    if (!submissionResult.data) {
      void recordSecurityEvent({ hotelSlug: session.hotel_slug, tableId: session.restaurant_table_id, eventType: "QR_SESSION_OWNERSHIP_FAILURE", requestId: req.requestId, actorReference: session.public_reference });
      return res.status(404).json({ success: false, message: "This QR order is not available in your session." });
    }
    const submission = submissionResult.data;
    let kitchenStatus = submission.status;
    if (Number(submission.round_sequence) === 1) {
      const orderResult = await supabase.from("orders").select("kitchen_status,status").eq("id", submission.order_id).eq("hotel_slug", session.hotel_slug).maybeSingle();
      if (orderResult.error) throw orderResult.error;
      kitchenStatus = orderResult.data?.kitchen_status || orderResult.data?.status || submission.status;
    } else {
      const roundResult = await supabase.from("order_rounds").select("status").eq("order_id", submission.order_id).eq("hotel_slug", session.hotel_slug).eq("sequence_number", submission.round_sequence).maybeSingle();
      if (roundResult.error) throw roundResult.error;
      kitchenStatus = roundResult.data?.status || submission.status;
    }
    const editable = ["pending", "new", "received"].includes(String(kitchenStatus).toLowerCase()) &&
      (!submission.edit_expires_at || Date.parse(submission.edit_expires_at) > Date.now());
    res.set("Cache-Control", "no-store");
    return res.json({
      success: true,
      order: {
        publicReference: submission.public_reference,
        status: kitchenStatus,
        editable,
        version: Number(submission.row_version || 1),
        roundSequence: submission.round_sequence,
        items: submission.items,
        totals: submission.totals_delta,
        note: submission.note || "",
        createdAt: submission.created_at,
        updatedAt: submission.updated_at
      }
    });
  } catch (error) {
    logger.error("Secure QR submission status failed", { requestId: req.requestId, message: error.message });
    return res.status(500).json({ success: false, message: "Your order status could not be loaded." });
  }
});

module.exports = router;
