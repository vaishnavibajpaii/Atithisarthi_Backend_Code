"use strict";

const crypto = require("crypto");
const { env } = require("../config/env");
const { supabase } = require("../utils/supabase");
const { withTenantTransaction } = require("../utils/tenant-database");
const {
  createRazorpayCredentialAdapter,
  getPaymentGatewayAdapter,
  getPaymentGatewayConfig,
  isPaymentGatewayConfigured
} = require("../utils/payment-gateway");
const { LEGACY_RAZORPAY_MERCHANT_REF } = require("./payment-domain");

const PURPOSES = Object.freeze({
  NEW_PAYMENT: "NEW_PAYMENT",
  VERIFY: "VERIFY",
  RECONCILE: "RECONCILE",
  WEBHOOK: "WEBHOOK"
});

class GatewayResolutionError extends Error {
  constructor(code, message, httpStatus = 503) {
    super(message);
    this.name = "GatewayResolutionError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function firstRow(result) {
  return Array.isArray(result?.rows) ? (result.rows[0] || null) : null;
}

function normalizeScope({ tenantId, propertyId } = {}) {
  const tenant = String(tenantId || "").trim().toLowerCase();
  const property = Number(propertyId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(tenant) ||
      !Number.isSafeInteger(property) || property <= 0) {
    throw new GatewayResolutionError(
      "GATEWAY_CANONICAL_SCOPE_REQUIRED",
      "Canonical tenant and property context is required",
      400
    );
  }
  return { tenantId: tenant, propertyId: property };
}

function normalizeProvider(provider = "razorpay") {
  const value = String(provider || "").trim().toLowerCase();
  if (value !== "razorpay") {
    throw new GatewayResolutionError("GATEWAY_PROVIDER_UNSUPPORTED", "Payment provider is unsupported", 400);
  }
  return value;
}

class PostgresGatewayRepository {
  async getPropertyPolicy(scope, provider) {
    const { data, error } = await supabase.rpc("task5_get_property_gateway_policy_internal", {
      p_tenant_id: scope.tenantId,
      p_property_id: scope.propertyId,
      p_provider: provider
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return row || null;
  }

  async resolveActiveCredential(scope, provider) {
    return withTenantTransaction(scope, async (client) => firstRow(await client.query(
      "select * from public.task5_resolve_active_gateway_credential($1)",
      [provider]
    )), { readOnly: true });
  }

  async resolveBoundCredential(scope, intent) {
    return withTenantTransaction(scope, async (client) => firstRow(await client.query(
      "select * from public.task5_resolve_bound_gateway_credential($1, $2, $3)",
      [String(intent.gateway_account_id), String(intent.merchant_ref), String(intent.credential_ref)]
    )), { readOnly: true });
  }

  async resolveWebhookCandidates(webhookRef) {
    const { data, error } = await supabase.rpc("task5_resolve_webhook_candidates_internal", {
      p_webhook_ref: webhookRef
    });
    if (error) throw error;
    return Array.isArray(data) ? data : (data ? [data] : []);
  }
}

function createBoundAdapter(row) {
  if (!row || !row.key_id || !row.key_secret || !row.merchant_ref || !row.credential_ref) {
    throw new GatewayResolutionError(
      "PAYMENT_GATEWAY_CREDENTIAL_UNAVAILABLE",
      "The bound payment credential is unavailable"
    );
  }
  const mode = String(row.mode || "").toUpperCase();
  if ((mode === "TEST" && !String(row.key_id).startsWith("rzp_test_")) ||
      (mode === "LIVE" && !String(row.key_id).startsWith("rzp_live_"))) {
    throw new GatewayResolutionError("PAYMENT_GATEWAY_MODE_MISMATCH", "The payment credential mode is invalid");
  }
  if (mode === "LIVE" && !env.isProduction) {
    throw new GatewayResolutionError("LIVE_GATEWAY_REFUSED", "Live payment credentials are disabled outside production");
  }
  const config = getPaymentGatewayConfig();
  return createRazorpayCredentialAdapter({
    merchantRef: row.merchant_ref,
    credentialRef: row.credential_ref,
    keyId: row.key_id,
    keySecret: row.key_secret,
    apiBaseUrl: config.razorpay.apiBaseUrl,
    timeoutMs: config.razorpay.timeoutMs,
    currency: config.currency
  });
}

function resolveLegacyBoundAdapter(intent, purpose) {
  if (String(intent?.merchant_ref || "") !== LEGACY_RAZORPAY_MERCHANT_REF || intent?.gateway_account_id) {
    throw new GatewayResolutionError("PAYMENT_GATEWAY_BINDING_INVALID", "Payment gateway binding is invalid", 409);
  }
  if (!isPaymentGatewayConfigured()) {
    throw new GatewayResolutionError("HISTORICAL_CREDENTIAL_UNAVAILABLE", "The exact historical payment credential is unavailable", 409);
  }
  const adapter = getPaymentGatewayAdapter();
  if (adapter.credentialRef !== String(intent?.credential_ref || "")) {
    const code = purpose === PURPOSES.RECONCILE
      ? "RECONCILIATION_BLOCKED_CREDENTIAL_RETIRED"
      : "HISTORICAL_CREDENTIAL_UNAVAILABLE";
    throw new GatewayResolutionError(code, "The exact historical payment credential is unavailable", 409);
  }
  return adapter;
}

async function resolvePaymentGateway({
  tenantId,
  propertyId,
  provider = "razorpay",
  purpose,
  paymentIntent = null,
  repository = new PostgresGatewayRepository()
} = {}) {
  const scope = normalizeScope({ tenantId, propertyId });
  const normalizedProvider = normalizeProvider(provider);
  const normalizedPurpose = String(purpose || "").toUpperCase();
  if (!Object.values(PURPOSES).includes(normalizedPurpose) || normalizedPurpose === PURPOSES.WEBHOOK) {
    throw new GatewayResolutionError("GATEWAY_PURPOSE_INVALID", "Payment gateway resolution purpose is invalid", 400);
  }

  if (normalizedPurpose === PURPOSES.NEW_PAYMENT) {
    const policy = await repository.getPropertyPolicy(scope, normalizedProvider);
    if (!policy && env.perHotelPaymentGatewayRequireExplicitPolicy) {
      throw new GatewayResolutionError(
        "PROPERTY_GATEWAY_POLICY_REQUIRED",
        "Online payment is not configured for this property",
        409
      );
    }
    const resolutionMode = String(policy?.resolution_mode || "LEGACY_GLOBAL").toUpperCase();
    if (resolutionMode === "LEGACY_GLOBAL") {
      if (!isPaymentGatewayConfigured()) {
        throw new GatewayResolutionError("LEGACY_GATEWAY_NOT_READY", "The legacy payment gateway is not ready");
      }
      return Object.freeze({
        kind: "LEGACY_GLOBAL",
        gatewayAccountId: null,
        mode: null,
        adapter: getPaymentGatewayAdapter()
      });
    }
    if (resolutionMode !== "PER_PROPERTY") {
      throw new GatewayResolutionError("GATEWAY_POLICY_INVALID", "Payment gateway policy is invalid");
    }
    if (!env.perHotelPaymentGatewayEnabled) {
      throw new GatewayResolutionError(
        "PER_PROPERTY_GATEWAY_DISABLED",
        "Per-property payment gateway is not enabled"
      );
    }
    const row = await repository.resolveActiveCredential(scope, normalizedProvider);
    if (!row) {
      throw new GatewayResolutionError(
        "PROPERTY_GATEWAY_NOT_READY",
        "This property does not have an active payment gateway"
      );
    }
    return Object.freeze({
      kind: "PER_PROPERTY",
      gatewayAccountId: String(row.gateway_account_id),
      mode: String(row.mode || "").toUpperCase(),
      adapter: createBoundAdapter(row)
    });
  }

  if (!paymentIntent || String(paymentIntent.tenant_id) !== scope.tenantId ||
      Number(paymentIntent.property_id) !== scope.propertyId ||
      String(paymentIntent.provider) !== normalizedProvider) {
    throw new GatewayResolutionError("PAYMENT_INTENT_SCOPE_MISMATCH", "PaymentIntent ownership does not match", 409);
  }
  if (!paymentIntent.gateway_account_id) {
    return Object.freeze({
      kind: "LEGACY_GLOBAL",
      gatewayAccountId: null,
      mode: null,
      adapter: resolveLegacyBoundAdapter(paymentIntent, normalizedPurpose)
    });
  }
  if (!env.perHotelPaymentGatewayEnabled) {
    throw new GatewayResolutionError(
      "PER_PROPERTY_GATEWAY_DISABLED",
      "Per-property payment gateway is not enabled"
    );
  }
  const row = await repository.resolveBoundCredential(scope, paymentIntent);
  if (!row) {
    const code = normalizedPurpose === PURPOSES.RECONCILE
      ? "RECONCILIATION_BLOCKED_CREDENTIAL_RETIRED"
      : "HISTORICAL_CREDENTIAL_UNAVAILABLE";
    throw new GatewayResolutionError(code, "The exact historical payment credential is unavailable", 409);
  }
  if (String(row.gateway_account_id) !== String(paymentIntent.gateway_account_id) ||
      String(row.merchant_ref) !== String(paymentIntent.merchant_ref) ||
      String(row.credential_ref) !== String(paymentIntent.credential_ref)) {
    throw new GatewayResolutionError("PAYMENT_GATEWAY_BINDING_MISMATCH", "Payment gateway binding does not match", 409);
  }
  return Object.freeze({
    kind: "PER_PROPERTY",
    gatewayAccountId: String(row.gateway_account_id),
    mode: String(row.mode || "").toUpperCase(),
    adapter: createBoundAdapter(row)
  });
}

function validWebhookHmac(secret, rawBody, signature) {
  const normalizedSignature = String(signature || "").trim();
  if (!secret || !rawBody || !/^[a-fA-F0-9]+$/.test(normalizedSignature)) return false;
  const expected = crypto.createHmac("sha256", String(secret)).update(rawBody).digest();
  const actual = Buffer.from(normalizedSignature, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function authenticatePropertyWebhook({
  webhookRef,
  rawBody,
  signature,
  repository = new PostgresGatewayRepository()
} = {}) {
  const ref = String(webhookRef || "").trim();
  if (!/^rwh_[a-f0-9]{32}$/.test(ref)) {
    throw new GatewayResolutionError("WEBHOOK_ACCOUNT_REF_INVALID", "Webhook account reference is invalid", 400);
  }
  if (!env.perHotelPaymentGatewayEnabled) {
    throw new GatewayResolutionError("PER_PROPERTY_GATEWAY_DISABLED", "Per-property webhook intake is disabled");
  }
  const candidates = await repository.resolveWebhookCandidates(ref);
  let matched = null;
  for (const candidate of candidates) {
    if (validWebhookHmac(candidate.webhook_secret, rawBody, signature)) {
      if (matched) {
        throw new GatewayResolutionError("WEBHOOK_SECRET_AMBIGUOUS", "Webhook authentication is ambiguous", 409);
      }
      matched = candidate;
    }
  }
  if (!matched) {
    throw new GatewayResolutionError("WEBHOOK_SIGNATURE_INVALID", "Webhook signature is invalid", 400);
  }
  return Object.freeze({
    provider: "razorpay",
    tenantId: String(matched.tenant_id),
    propertyId: Number(matched.property_id),
    gatewayAccountId: String(matched.gateway_account_id),
    merchantRef: String(matched.merchant_ref),
    webhookSecretRef: String(matched.webhook_secret_ref)
  });
}

module.exports = {
  GatewayResolutionError,
  PURPOSES,
  PostgresGatewayRepository,
  authenticatePropertyWebhook,
  resolvePaymentGateway
};
