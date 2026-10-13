const crypto = require("crypto");
const { env } = require("../config/env");

const SUPPORTED_PAYMENT_GATEWAYS = ["razorpay"];
const { LEGACY_RAZORPAY_MERCHANT_REF } = require("../payments/payment-domain");

function normalizeProvider(value = "") {
  const provider = String(value || "").trim().toLowerCase();
  return SUPPORTED_PAYMENT_GATEWAYS.includes(provider) ? provider : "razorpay";
}

function getPaymentGatewayConfig() {
  const provider = normalizeProvider(env.paymentGatewayProvider);

  return {
    enabled: !!env.paymentGatewayEnabled,
    isProduction: !!env.isProduction,
    provider,
    currency: String(env.paymentGatewayCurrency || "INR").trim().toUpperCase() || "INR",
    routeTransfersEnabled: !!env.paymentRouteTransfersEnabled,
    razorpay: {
      keyId: env.razorpayKeyId || "",
      keySecret: env.razorpayKeySecret || "",
      webhookSecret: env.razorpayWebhookSecret || "",
      apiBaseUrl: String(env.razorpayApiBaseUrl || "https://api.razorpay.com/v1").replace(/\/$/, ""),
      timeoutMs: Number.isFinite(env.paymentGatewayTimeoutMs) && env.paymentGatewayTimeoutMs > 0
        ? env.paymentGatewayTimeoutMs
        : 10000
    }
  };
}

function getCredentialRef(keyId = "") {
  const fingerprint = crypto.createHash("sha256").update(String(keyId || "")).digest("hex").slice(0, 12);
  return `RAZORPAY_KEY_${fingerprint || "UNCONFIGURED"}`;
}

async function fetchWithProviderTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("Payment provider request outcome is unknown");
      timeoutError.code = "PROVIDER_TIMEOUT";
      timeoutError.uncertain = true;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function getPaymentGatewaySafetyIssue(config = getPaymentGatewayConfig()) {
  if (!config.enabled) {
    return "";
  }

  if (
    config.provider === "razorpay" &&
    !config.isProduction &&
    config.razorpay.keyId &&
    !config.razorpay.keyId.startsWith("rzp_test_")
  ) {
    return "Refusing to use a non-test Razorpay key outside production";
  }

  return "";
}

function isPaymentGatewayConfigured() {
  const config = getPaymentGatewayConfig();

  if (!config.enabled) {
    return false;
  }

  if (getPaymentGatewaySafetyIssue(config)) {
    return false;
  }

  if (config.provider === "razorpay") {
    return Boolean(config.razorpay.keyId && config.razorpay.keySecret);
  }

  return false;
}

function assertPaymentGatewayConfigured() {
  const config = getPaymentGatewayConfig();
  const safetyIssue = getPaymentGatewaySafetyIssue(config);

  if (safetyIssue) {
    throw new Error(safetyIssue);
  }

  if (!isPaymentGatewayConfigured()) {
    throw new Error("Payment gateway is not configured");
  }
}

function toGatewayMinorAmount(amount) {
  const numericAmount = Number(amount);

  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error("Payment amount must be greater than zero");
  }

  return Math.round(numericAmount * 100);
}

function buildRazorpayAuthHeader(keyId, keySecret) {
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
}

function getRazorpayRuntimeOptions(overrides = {}) {
  const config = getPaymentGatewayConfig();
  return {
    keyId: String(overrides.keyId ?? config.razorpay.keyId ?? "").trim(),
    keySecret: String(overrides.keySecret ?? config.razorpay.keySecret ?? ""),
    webhookSecret: String(overrides.webhookSecret ?? config.razorpay.webhookSecret ?? ""),
    apiBaseUrl: String(overrides.apiBaseUrl ?? config.razorpay.apiBaseUrl).replace(/\/$/, ""),
    timeoutMs: Number.isFinite(Number(overrides.timeoutMs)) && Number(overrides.timeoutMs) > 0
      ? Number(overrides.timeoutMs)
      : config.razorpay.timeoutMs,
    currency: String(overrides.currency ?? config.currency ?? "INR").trim().toUpperCase() || "INR"
  };
}

function assertRazorpayRuntimeOptions(options) {
  if (!options.keyId || !options.keySecret) {
    const error = new Error("Payment gateway credential is unavailable");
    error.code = "PAYMENT_GATEWAY_CREDENTIAL_UNAVAILABLE";
    throw error;
  }
}

function providerRequestError(response, fallbackCode) {
  const error = new Error("Payment provider request failed");
  error.code = fallbackCode;
  error.providerStatus = Number(response?.status) || null;
  return error;
}

function verifyHmac({ secret, content, signature }) {
  const normalizedSecret = String(secret || "");
  const normalizedSignature = String(signature || "").trim();
  if (!normalizedSecret || !content || !/^[a-fA-F0-9]+$/.test(normalizedSignature)) return false;
  const expected = crypto.createHmac("sha256", normalizedSecret).update(content).digest();
  const actual = Buffer.from(normalizedSignature, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function normalizeRazorpayTransfers(transfers = []) {
  if (!Array.isArray(transfers)) {
    return [];
  }

  return transfers
    .map((transfer) => {
      const account = String(transfer?.account || "").trim();
      const amountMinor = Number(transfer?.amount || 0);
      const currency = String(transfer?.currency || "INR").trim().toUpperCase();
      const notes =
        transfer?.notes &&
        typeof transfer.notes === "object" &&
        !Array.isArray(transfer.notes)
          ? transfer.notes
          : {};
      const linkedAccountNotes = Array.isArray(transfer?.linked_account_notes)
        ? transfer.linked_account_notes
            .map((key) => String(key || "").trim())
            .filter((key) => key && Object.prototype.hasOwnProperty.call(notes, key))
        : [];
      const normalizedTransfer = {
        account,
        amount: Math.round(amountMinor),
        currency,
        notes,
        on_hold: transfer?.on_hold === true
      };

      if (linkedAccountNotes.length) {
        normalizedTransfer.linked_account_notes = linkedAccountNotes;
      }

      if (transfer?.on_hold_until) {
        normalizedTransfer.on_hold_until = transfer.on_hold_until;
      }

      return normalizedTransfer;
    })
    .filter((transfer) => (
      /^acc_[A-Za-z0-9]+$/.test(transfer.account) &&
      Number.isInteger(transfer.amount) &&
      transfer.amount > 0 &&
      transfer.currency === "INR"
    ));
}

async function createRazorpayOrder({ amount, currency, receipt, notes, transfers } = {}) {
  const config = getPaymentGatewayConfig();
  assertPaymentGatewayConfigured();

  const amountMinor = toGatewayMinorAmount(amount);
  const normalizedTransfers = normalizeRazorpayTransfers(transfers);
  const requestBody = {
    amount: amountMinor,
    currency: currency || config.currency,
    receipt,
    notes: notes || {},
    payment_capture: 1
  };

  if (normalizedTransfers.length) {
    requestBody.transfers = normalizedTransfers;
    requestBody.partial_payment = false;
  }

  const response = await fetchWithProviderTimeout(`${config.razorpay.apiBaseUrl}/orders`, {
    method: "POST",
    headers: {
      Authorization: buildRazorpayAuthHeader(
        config.razorpay.keyId,
        config.razorpay.keySecret
      ),
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  }, config.razorpay.timeoutMs);

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.error?.description || data?.message || "Failed to create payment order";
    throw new Error(message);
  }

  return {
    provider: "razorpay",
    merchantRef: LEGACY_RAZORPAY_MERCHANT_REF,
    credentialRef: getCredentialRef(config.razorpay.keyId),
    keyId: config.razorpay.keyId,
    gatewayOrderId: data.id,
    gatewayStatus: data.status || "created",
    amount: amountMinor / 100,
    amountMinor,
    currency: data.currency || currency || config.currency,
    receipt: data.receipt || receipt || "",
    transfers: Array.isArray(data.transfers) ? data.transfers : [],
    transfersRequested: normalizedTransfers,
    raw: data
  };
}

async function fetchRazorpayOrderPayments(gatewayOrderId = "") {
  const config = getPaymentGatewayConfig();
  assertPaymentGatewayConfigured();

  const orderId = String(gatewayOrderId || "").trim();

  if (!orderId) {
    throw new Error("Gateway order id is required");
  }

  const response = await fetchWithProviderTimeout(
    `${config.razorpay.apiBaseUrl}/orders/${encodeURIComponent(orderId)}/payments`,
    {
      method: "GET",
      headers: {
        Authorization: buildRazorpayAuthHeader(
          config.razorpay.keyId,
          config.razorpay.keySecret
        )
      }
    },
    config.razorpay.timeoutMs
  );
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.error?.description || data?.message || "Failed to fetch payment status";
    throw new Error(message);
  }

  return {
    provider: "razorpay",
    gatewayOrderId: orderId,
    payments: Array.isArray(data.items) ? data.items : [],
    raw: data
  };
}

async function fetchRazorpayPayment(gatewayPaymentId = "") {
  const config = getPaymentGatewayConfig();
  assertPaymentGatewayConfigured();
  const paymentId = String(gatewayPaymentId || "").trim();
  if (!paymentId) throw new Error("Gateway payment id is required");
  const response = await fetchWithProviderTimeout(
    `${config.razorpay.apiBaseUrl}/payments/${encodeURIComponent(paymentId)}`,
    {
      method: "GET",
      headers: {
        Authorization: buildRazorpayAuthHeader(config.razorpay.keyId, config.razorpay.keySecret)
      }
    },
    config.razorpay.timeoutMs
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.description || data?.message || "Failed to fetch payment status";
    const error = new Error(message);
    error.code = "PROVIDER_LOOKUP_FAILED";
    throw error;
  }
  return {
    provider: "razorpay",
    merchantRef: LEGACY_RAZORPAY_MERCHANT_REF,
    credentialRef: getCredentialRef(config.razorpay.keyId),
    providerOrderId: String(data.order_id || ""),
    providerPaymentId: String(data.id || paymentId),
    amountMinor: Number(data.amount),
    currency: String(data.currency || "").toUpperCase(),
    status: String(data.status || "").toLowerCase(),
    captured: data.captured === true || String(data.status || "").toLowerCase() === "captured",
    raw: data
  };
}

function verifyRazorpaySignature({ gatewayOrderId, gatewayPaymentId, gatewaySignature } = {}) {
  const config = getPaymentGatewayConfig();
  assertPaymentGatewayConfigured();

  const orderId = String(gatewayOrderId || "").trim();
  const paymentId = String(gatewayPaymentId || "").trim();
  const signature = String(gatewaySignature || "").trim();

  if (!orderId || !paymentId || !signature) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac("sha256", config.razorpay.keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  const expectedBuffer = Buffer.from(expectedSignature, "hex");
  const actualBuffer = Buffer.from(signature, "hex");

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function verifyRazorpayWebhookSignature({ rawBody, gatewaySignature } = {}) {
  const config = getPaymentGatewayConfig();
  const webhookSecret = String(config.razorpay.webhookSecret || "").trim();
  const signature = String(gatewaySignature || "").trim();

  if (!webhookSecret || !rawBody || !signature) {
    return false;
  }

  const bodyBuffer = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(String(rawBody));
  const expectedSignature = crypto
    .createHmac("sha256", webhookSecret)
    .update(bodyBuffer)
    .digest("hex");
  const expectedBuffer = Buffer.from(expectedSignature, "hex");
  const actualBuffer = Buffer.from(signature, "hex");

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

async function createPaymentGatewayOrder(payload = {}) {
  const config = getPaymentGatewayConfig();

  if (config.provider === "razorpay") {
    return createRazorpayOrder(payload);
  }

  throw new Error("Unsupported payment gateway provider");
}

async function fetchPaymentGatewayOrderPayments(gatewayOrderId = "") {
  const config = getPaymentGatewayConfig();

  if (config.provider === "razorpay") {
    return fetchRazorpayOrderPayments(gatewayOrderId);
  }

  throw new Error("Unsupported payment gateway provider");
}

function verifyPaymentGatewaySignature(payload = {}) {
  const config = getPaymentGatewayConfig();

  if (config.provider === "razorpay") {
    return verifyRazorpaySignature(payload);
  }

  return false;
}

function getPaymentGatewayAdapter() {
  const config = getPaymentGatewayConfig();
  if (config.provider !== "razorpay") throw new Error("Unsupported payment gateway provider");
  return createRazorpayCredentialAdapter({
    merchantRef: LEGACY_RAZORPAY_MERCHANT_REF,
    credentialRef: getCredentialRef(config.razorpay.keyId),
    keyId: config.razorpay.keyId,
    keySecret: config.razorpay.keySecret,
    webhookSecret: config.razorpay.webhookSecret,
    apiBaseUrl: config.razorpay.apiBaseUrl,
    timeoutMs: config.razorpay.timeoutMs,
    currency: config.currency
  });
}

function createRazorpayCredentialAdapter({
  merchantRef,
  credentialRef,
  keyId,
  keySecret,
  webhookSecret = "",
  apiBaseUrl,
  timeoutMs,
  currency
} = {}) {
  const identity = {
    merchantRef: String(merchantRef || "").trim(),
    credentialRef: String(credentialRef || "").trim()
  };
  const options = getRazorpayRuntimeOptions({
    keyId, keySecret, webhookSecret, apiBaseUrl, timeoutMs, currency
  });
  if (!identity.merchantRef || !identity.credentialRef) {
    const error = new Error("Payment gateway identity is unavailable");
    error.code = "PAYMENT_GATEWAY_IDENTITY_UNAVAILABLE";
    throw error;
  }

  async function providerRequest(path, requestOptions = {}) {
    assertRazorpayRuntimeOptions(options);
    const response = await fetchWithProviderTimeout(`${options.apiBaseUrl}${path}`, {
      ...requestOptions,
      headers: {
        Authorization: buildRazorpayAuthHeader(options.keyId, options.keySecret),
        ...(requestOptions.headers || {})
      }
    }, options.timeoutMs);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw providerRequestError(response, "PROVIDER_LOOKUP_FAILED");
    return data;
  }

  async function createPaymentOrder({ amountMinor, amount, receipt, notes, transfers } = {}) {
    const normalizedAmount = Number.isSafeInteger(Number(amountMinor))
      ? Number(amountMinor)
      : toGatewayMinorAmount(amount);
    const normalizedTransfers = normalizeRazorpayTransfers(transfers);
    const requestBody = {
      amount: normalizedAmount,
      currency: options.currency,
      receipt,
      notes: notes || {},
      payment_capture: 1
    };
    if (normalizedTransfers.length) {
      requestBody.transfers = normalizedTransfers;
      requestBody.partial_payment = false;
    }
    const data = await providerRequest("/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });
    return {
      provider: "razorpay",
      merchantRef: identity.merchantRef,
      credentialRef: identity.credentialRef,
      keyId: options.keyId,
      gatewayOrderId: data.id,
      gatewayStatus: data.status || "created",
      amount: normalizedAmount / 100,
      amountMinor: normalizedAmount,
      currency: String(data.currency || options.currency).toUpperCase(),
      receipt: data.receipt || receipt || "",
      transfers: Array.isArray(data.transfers) ? data.transfers : [],
      transfersRequested: normalizedTransfers,
      raw: data
    };
  }

  async function getPaymentStatus(paymentId = "") {
    const normalizedId = String(paymentId || "").trim();
    if (!normalizedId) {
      const error = new Error("Provider payment id is required");
      error.code = "PROVIDER_PAYMENT_MISSING";
      throw error;
    }
    const data = await providerRequest(`/payments/${encodeURIComponent(normalizedId)}`, { method: "GET" });
    return {
      provider: "razorpay",
      merchantRef: identity.merchantRef,
      credentialRef: identity.credentialRef,
      providerOrderId: String(data.order_id || ""),
      providerPaymentId: String(data.id || normalizedId),
      amountMinor: Number(data.amount),
      currency: String(data.currency || "").toUpperCase(),
      status: String(data.status || "").toLowerCase(),
      captured: data.captured === true || String(data.status || "").toLowerCase() === "captured",
      raw: data
    };
  }

  async function getOrderPayments(orderId = "") {
    const normalizedId = String(orderId || "").trim();
    if (!normalizedId) {
      const error = new Error("Provider order id is required");
      error.code = "PROVIDER_ORDER_MISSING";
      throw error;
    }
    const data = await providerRequest(`/orders/${encodeURIComponent(normalizedId)}/payments`, { method: "GET" });
    return Array.isArray(data.items) ? data.items : [];
  }

  function verifyCheckoutEvidence({ gatewayOrderId, gatewayPaymentId, gatewaySignature } = {}) {
    const orderId = String(gatewayOrderId || "").trim();
    const paymentId = String(gatewayPaymentId || "").trim();
    if (!orderId || !paymentId) return false;
    return verifyHmac({
      secret: options.keySecret,
      content: `${orderId}|${paymentId}`,
      signature: gatewaySignature
    });
  }

  function verifyWebhook({ rawBody, gatewaySignature } = {}) {
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""));
    return verifyHmac({ secret: options.webhookSecret, content: body, signature: gatewaySignature });
  }

  async function testConnection() {
    await providerRequest("/orders?count=1", { method: "GET" });
    return { ok: true, provider: "razorpay" };
  }

  return Object.freeze({
    provider: "razorpay",
    merchantRef: identity.merchantRef,
    credentialRef: identity.credentialRef,
    publicKeyId: options.keyId,
    createPaymentOrder,
    getPaymentStatus,
    getOrderPayments,
    verifyCheckoutEvidence,
    verifyWebhook,
    testConnection
  });
}

module.exports = {
  getPaymentGatewayConfig,
  getPaymentGatewaySafetyIssue,
  isPaymentGatewayConfigured,
  createPaymentGatewayOrder,
  fetchRazorpayPayment,
  fetchPaymentGatewayOrderPayments,
  createRazorpayCredentialAdapter,
  getPaymentGatewayAdapter,
  verifyPaymentGatewaySignature,
  verifyRazorpayWebhookSignature,
  toGatewayMinorAmount
};
