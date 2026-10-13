"use strict";

const express = require("express");
const { env } = require("../config/env");
const { requireStaffAuth } = require("../middleware/require-staff-auth");
const { validateBody } = require("../validators/common");
const {
  gatewayConfigureSchema,
  gatewayEnabledSchema,
  gatewayResolutionSchema,
  gatewayTestConnectionSchema
} = require("../validators/payment-gateway-admin");
const { getTenantRequestScope } = require("../utils/tenant-request-context");
const { withTenantTransaction } = require("../utils/tenant-database");
const {
  createRazorpayCredentialAdapter,
  getPaymentGatewayConfig
} = require("../utils/payment-gateway");

const router = express.Router();
router.use(requireStaffAuth);

function firstRow(result) {
  return Array.isArray(result?.rows) ? (result.rows[0] || null) : null;
}

function actorRef(req) {
  return `hotel_staff:${String(req.authPrincipal?.principal_id || req.staffUser?.sub || "unknown").slice(0, 160)}`;
}

function clearSubmittedSecrets(req) {
  for (const target of [req?.validatedBody, req?.body]) {
    if (!target || typeof target !== "object") continue;
    if (Object.prototype.hasOwnProperty.call(target, "keySecret")) target.keySecret = "";
    if (Object.prototype.hasOwnProperty.call(target, "webhookSecret")) target.webhookSecret = "";
  }
}

function assertModeAllowed(mode, keyId) {
  const normalizedMode = String(mode || "").toUpperCase();
  if ((normalizedMode === "TEST" && !String(keyId).startsWith("rzp_test_")) ||
      (normalizedMode === "LIVE" && !String(keyId).startsWith("rzp_live_"))) {
    const error = new Error("Credential mode does not match the key ID");
    error.code = "GATEWAY_MODE_MISMATCH";
    error.httpStatus = 400;
    throw error;
  }
  if (normalizedMode === "LIVE" && !env.isProduction) {
    const error = new Error("Live credentials are disabled outside production");
    error.code = "LIVE_GATEWAY_REFUSED";
    error.httpStatus = 409;
    throw error;
  }
}

function transientAdapter({ keyId, keySecret, merchantRef = "TEST_CONNECTION", credentialRef = "TEST_CONNECTION" }) {
  const config = getPaymentGatewayConfig();
  return createRazorpayCredentialAdapter({
    merchantRef,
    credentialRef,
    keyId,
    keySecret,
    apiBaseUrl: config.razorpay.apiBaseUrl,
    timeoutMs: config.razorpay.timeoutMs,
    currency: config.currency
  });
}

function safeStatus(row = {}) {
  return {
    provider: "razorpay",
    configured: row.configured === true,
    resolutionMode: String(row.resolution_mode || "LEGACY_GLOBAL"),
    mode: row.mode || null,
    status: row.account_status || null,
    merchantRef: row.merchant_ref || null,
    credentialRef: row.credential_ref || null,
    keyIdMasked: row.key_id_masked || null,
    secretConfigured: row.secret_configured === true,
    webhookConfigured: row.webhook_configured === true,
    perHotelFeatureEnabled: env.perHotelPaymentGatewayEnabled === true,
    webhookPath: row.webhook_ref
      ? `/api/payments/webhook/razorpay/${row.webhook_ref}`
      : null
  };
}

async function readInternalStatus(scope) {
  return withTenantTransaction(scope, async (client) => firstRow(await client.query(
    "select * from public.task5_get_property_gateway_status()"
  )), { readOnly: true });
}

function handleAdminError(res, error) {
  const allowed = new Set([
    "GATEWAY_MODE_MISMATCH",
    "LIVE_GATEWAY_REFUSED",
    "GATEWAY_ROTATION_CONTINUITY_UNAVAILABLE",
    "GATEWAY_ROTATION_CONTINUITY_FAILED",
    "TASK5_GATEWAY_CREDENTIAL_CHANGED",
    "TASK5_ROTATION_CONTINUITY_REQUIRED",
    "TASK5_PROPERTY_GATEWAY_NOT_FOUND",
    "TASK5_PER_PROPERTY_GATEWAY_NOT_READY",
    "PER_HOTEL_GATEWAY_FEATURE_DISABLED",
    "PROVIDER_LOOKUP_FAILED",
    "PROVIDER_TIMEOUT"
  ]);
  const code = allowed.has(String(error?.code || ""))
    ? String(error.code)
    : "GATEWAY_OPERATION_FAILED";
  const status = Number(error?.httpStatus) || (code === "PROVIDER_LOOKUP_FAILED" ? 400 : 409);
  return res.status(status).json({
    success: false,
    code,
    message: code === "PROVIDER_LOOKUP_FAILED"
      ? "Razorpay rejected the submitted TEST credential"
      : "Payment gateway operation could not be completed"
  });
}

router.get("/", async (req, res) => {
  try {
    const status = await readInternalStatus(getTenantRequestScope(req));
    return res.json({ success: true, gateway: safeStatus(status) });
  } catch (error) {
    return handleAdminError(res, error);
  }
});

router.post("/test-connection", validateBody(gatewayTestConnectionSchema), async (req, res) => {
  try {
    const { mode, keyId, keySecret } = req.validatedBody;
    assertModeAllowed(mode, keyId);
    await transientAdapter({ keyId, keySecret }).testConnection();
    return res.json({
      success: true,
      provider: "razorpay",
      mode,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    return handleAdminError(res, error);
  } finally {
    clearSubmittedSecrets(req);
  }
});

router.put("/", validateBody(gatewayConfigureSchema), async (req, res) => {
  try {
    const scope = getTenantRequestScope(req);
    const { provider, mode, keyId, keySecret, webhookSecret } = req.validatedBody;
    assertModeAllowed(mode, keyId);
    const existing = await readInternalStatus(scope);
    const adapter = transientAdapter({
      keyId,
      keySecret,
      merchantRef: existing?.merchant_ref || "PENDING_PROPERTY_MERCHANT",
      credentialRef: existing?.credential_ref || "PENDING_PROPERTY_CREDENTIAL"
    });
    await adapter.testConnection();

    let continuityVerified = false;
    if (existing?.configured && existing?.credential_ref) {
      const continuity = await withTenantTransaction(scope, async (client) => firstRow(await client.query(
        `select provider_order_id
           from public.payment_intents
          where gateway_account_id = $1
            and provider_order_id is not null
          order by created_at desc
          limit 1`,
        [existing.gateway_account_id]
      )), { readOnly: true });
      if (!continuity?.provider_order_id) {
        const error = new Error("Rotation continuity evidence is unavailable");
        error.code = "GATEWAY_ROTATION_CONTINUITY_UNAVAILABLE";
        throw error;
      }
      try {
        await adapter.getOrderPayments(continuity.provider_order_id);
        continuityVerified = true;
      } catch {
        const error = new Error("Rotation continuity verification failed");
        error.code = "GATEWAY_ROTATION_CONTINUITY_FAILED";
        throw error;
      }
    }

    await withTenantTransaction(scope, async (client) => client.query(
      `select * from public.task5_configure_property_gateway_staged(
        $1, $2, $3, $4, $5, $6, $7, $8, $9
      )`,
      [
        provider, mode, keyId, keySecret, webhookSecret, actorRef(req),
        "TEST_CONNECTION_OK", continuityVerified,
        existing?.credential_ref || null
      ]
    ));
    const updated = await readInternalStatus(scope);
    return res.status(existing?.configured ? 200 : 201).json({
      success: true,
      gateway: safeStatus(updated)
    });
  } catch (error) {
    return handleAdminError(res, error);
  } finally {
    clearSubmittedSecrets(req);
  }
});

router.patch("/enabled", validateBody(gatewayEnabledSchema), async (req, res) => {
  try {
    const scope = getTenantRequestScope(req);
    await withTenantTransaction(scope, async (client) => client.query(
      "select public.task5_set_property_gateway_enabled($1, $2)",
      [req.validatedBody.enabled, actorRef(req)]
    ));
    return res.json({ success: true, gateway: safeStatus(await readInternalStatus(scope)) });
  } catch (error) {
    return handleAdminError(res, error);
  }
});

router.patch("/resolution", validateBody(gatewayResolutionSchema), async (req, res) => {
  try {
    const resolutionMode = req.validatedBody.resolutionMode;
    if (resolutionMode === "PER_PROPERTY" && !env.perHotelPaymentGatewayEnabled) {
      const error = new Error("Per-property gateway rollout is disabled");
      error.code = "PER_HOTEL_GATEWAY_FEATURE_DISABLED";
      error.httpStatus = 409;
      throw error;
    }
    const scope = getTenantRequestScope(req);
    await withTenantTransaction(scope, async (client) => client.query(
      "select public.task5_set_property_gateway_resolution($1, $2)",
      [resolutionMode, actorRef(req)]
    ));
    return res.json({ success: true, gateway: safeStatus(await readInternalStatus(scope)) });
  } catch (error) {
    return handleAdminError(res, error);
  }
});

module.exports = router;
