"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const test = require("node:test");
require("dotenv").config({ path: path.join(__dirname, "../.env"), quiet: true });
const { env } = require("../config/env");
const {
  GatewayResolutionError,
  PURPOSES,
  authenticatePropertyWebhook,
  resolvePaymentGateway
} = require("../payments/payment-gateway-resolver");
const { validateCapturedEvidence } = require("../payments/payment-domain");
const { getEffectivePermissions } = require("../utils/permissions");
const {
  classifyGatewayAdminError
} = require("../payments/payment-gateway-admin-errors");

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MERCHANT_A = "RZP_MERCHANT_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MERCHANT_B = "RZP_MERCHANT_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CRED_A1 = "RZP_CRED_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const CRED_A2 = "RZP_CRED_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2";

function row(overrides = {}) {
  return {
    gateway_account_id: ACCOUNT_A,
    merchant_ref: MERCHANT_A,
    credential_ref: CRED_A1,
    mode: "TEST",
    key_id: "rzp_test_hotelA",
    key_secret: "hotel-a-secret-never-print",
    ...overrides
  };
}

function intent(overrides = {}) {
  return {
    tenant_id: TENANT_A,
    property_id: 101,
    gateway_account_id: ACCOUNT_A,
    provider: "razorpay",
    merchant_ref: MERCHANT_A,
    credential_ref: CRED_A1,
    provider_order_id: "order_A_1",
    expected_amount_minor: 12000,
    currency: "INR",
    status: "PENDING",
    ...overrides
  };
}

class Repository {
  constructor({ active = row(), bound = row(), policy = "PER_PROPERTY", candidates = [] } = {}) {
    this.active = active;
    this.bound = bound;
    this.policy = policy;
    this.candidates = candidates;
  }
  async getPropertyPolicy() { return { resolution_mode: this.policy, mode: "TEST" }; }
  async resolveActiveCredential() { return this.active; }
  async resolveBoundCredential() { return this.bound; }
  async resolveWebhookCandidates() { return this.candidates; }
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}

test.before(() => { env.perHotelPaymentGatewayEnabled = true; });

test("correct hotel credential is selected for a new PaymentIntent", async () => {
  const result = await resolvePaymentGateway({
    tenantId: TENANT_A, propertyId: 101, provider: "razorpay",
    purpose: PURPOSES.NEW_PAYMENT, repository: new Repository()
  });
  assert.equal(result.gatewayAccountId, ACCOUNT_A);
  assert.equal(result.adapter.merchantRef, MERCHANT_A);
  assert.equal(result.adapter.credentialRef, CRED_A1);
});

test("missing or inactive credential fails closed for a new payment", async () => {
  await expectCode(resolvePaymentGateway({
    tenantId: TENANT_A, propertyId: 101, provider: "razorpay",
    purpose: PURPOSES.NEW_PAYMENT, repository: new Repository({ active: null })
  }), "PROPERTY_GATEWAY_NOT_READY");
});

test("PER_PROPERTY policy never falls back to global when feature flag is off", async () => {
  env.perHotelPaymentGatewayEnabled = false;
  try {
    await expectCode(resolvePaymentGateway({
      tenantId: TENANT_A, propertyId: 101, provider: "razorpay",
      purpose: PURPOSES.NEW_PAYMENT, repository: new Repository()
    }), "PER_PROPERTY_GATEWAY_DISABLED");
  } finally {
    env.perHotelPaymentGatewayEnabled = true;
  }
});

test("wrong tenant and wrong property bindings are denied", async () => {
  for (const scope of [
    { tenantId: TENANT_B, propertyId: 101 },
    { tenantId: TENANT_A, propertyId: 202 }
  ]) {
    await expectCode(resolvePaymentGateway({
      ...scope, provider: "razorpay", purpose: PURPOSES.VERIFY,
      paymentIntent: intent(), repository: new Repository()
    }), "PAYMENT_INTENT_SCOPE_MISMATCH");
  }
});

test("wrong credential_ref and merchant_ref are denied", async () => {
  await expectCode(resolvePaymentGateway({
    tenantId: TENANT_A, propertyId: 101, provider: "razorpay",
    purpose: PURPOSES.VERIFY, paymentIntent: intent(),
    repository: new Repository({ bound: row({ credential_ref: CRED_A2 }) })
  }), "PAYMENT_GATEWAY_BINDING_MISMATCH");
  await expectCode(resolvePaymentGateway({
    tenantId: TENANT_A, propertyId: 101, provider: "razorpay",
    purpose: PURPOSES.VERIFY, paymentIntent: intent(),
    repository: new Repository({ bound: row({ merchant_ref: MERCHANT_B }) })
  }), "PAYMENT_GATEWAY_BINDING_MISMATCH");
});

test("rotation selects V2 for new payment while a V1 intent resolves V1", async () => {
  const repository = new Repository({
    active: row({ credential_ref: CRED_A2, key_id: "rzp_test_hotelA_v2", key_secret: "hotel-a-v2-secret" }),
    bound: row({ credential_ref: CRED_A1 })
  });
  const current = await resolvePaymentGateway({
    tenantId: TENANT_A, propertyId: 101, provider: "razorpay",
    purpose: PURPOSES.NEW_PAYMENT, repository
  });
  const historical = await resolvePaymentGateway({
    tenantId: TENANT_A, propertyId: 101, provider: "razorpay",
    purpose: PURPOSES.RECONCILE, paymentIntent: intent(), repository
  });
  assert.equal(current.adapter.credentialRef, CRED_A2);
  assert.equal(historical.adapter.credentialRef, CRED_A1);
});

test("retired historical credential blocks reconciliation without marking failure", async () => {
  await expectCode(resolvePaymentGateway({
    tenantId: TENANT_A, propertyId: 101, provider: "razorpay",
    purpose: PURPOSES.RECONCILE, paymentIntent: intent(),
    repository: new Repository({ bound: null })
  }), "RECONCILIATION_BLOCKED_CREDENTIAL_RETIRED");
});

test("captured evidence must carry the exact credential version", () => {
  assert.throws(() => validateCapturedEvidence({
    intent: intent(),
    evidence: {
      provider: "razorpay", merchantRef: MERCHANT_A, credentialRef: CRED_A2,
      providerOrderId: "order_A_1", providerPaymentId: "pay_A_1",
      amountMinor: 12000, currency: "INR", status: "captured", captured: true
    }
  }), (error) => error?.code === "CREDENTIAL_MISMATCH");
});

test("Hotel A webhook signature cannot authenticate Hotel B endpoint", async () => {
  const rawBody = Buffer.from('{"event":"payment.captured"}');
  const hotelASecret = "hotel-a-webhook-secret";
  const signature = crypto.createHmac("sha256", hotelASecret).update(rawBody).digest("hex");
  const repository = new Repository({ candidates: [{
    tenant_id: TENANT_B,
    property_id: 202,
    gateway_account_id: ACCOUNT_B,
    merchant_ref: MERCHANT_B,
    webhook_secret_ref: "RZP_WEBHOOK_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    webhook_secret: "hotel-b-webhook-secret"
  }] });
  await expectCode(authenticatePropertyWebhook({
    webhookRef: "rwh_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    rawBody,
    signature,
    repository
  }), "WEBHOOK_SIGNATURE_INVALID");
});

test("resolved secrets do not serialize into API JSON or errors", async () => {
  const secret = "unique-secret-that-must-never-escape";
  const result = await resolvePaymentGateway({
    tenantId: TENANT_A, propertyId: 101, provider: "razorpay",
    purpose: PURPOSES.NEW_PAYMENT,
    repository: new Repository({ active: row({ key_secret: secret }) })
  });
  assert.equal(JSON.stringify(result).includes(secret), false);
  const error = new GatewayResolutionError("SAFE_CODE", "Safe message");
  assert.equal(JSON.stringify(error).includes(secret), false);
});

test("gateway admin diagnostics expose only allowlisted markers and safe SQLSTATE categories", () => {
  const secret = "unique-admin-secret-that-must-never-escape";
  assert.deepEqual(
    classifyGatewayAdminError({ code: "23514", message: `constraint rejected ${secret}` }),
    {
      code: "TASK5_DATABASE_CONSTRAINT_REJECTED",
      status: 409,
      message: "Database gateway safeguards rejected the operation"
    }
  );
  assert.deepEqual(
    classifyGatewayAdminError({ code: "23514", message: "TASK5_GATEWAY_ACCOUNT_NOT_READY" }),
    {
      code: "TASK5_GATEWAY_ACCOUNT_NOT_READY",
      status: 409,
      message: "Payment gateway operation could not be completed"
    }
  );
  assert.equal(
    JSON.stringify(classifyGatewayAdminError({ code: "XX000", message: secret })).includes(secret),
    false
  );
});

test("hotel-facing route is write-only for secrets and ignores client credential selection", () => {
  const fs = require("node:fs");
  const route = fs.readFileSync(path.join(__dirname, "../routes/staff-payment-gateway.js"), "utf8");
  const paymentSchema = fs.readFileSync(path.join(__dirname, "../validators/payments.js"), "utf8");
  assert.match(route, /clearSubmittedSecrets/);
  assert.match(route, /task5_configure_property_gateway_staged/);
  assert.match(route, /PER_HOTEL_GATEWAY_FEATURE_DISABLED/);
  assert.doesNotMatch(route, /res\.json\([^)]*(?:keySecret|webhookSecret)/s);
  assert.doesNotMatch(paymentSchema, /merchantRef|credentialRef|gatewayAccountId/);
});

test("credential staging cannot silently cut over payment routing", () => {
  const fs = require("node:fs");
  const migration = fs.readFileSync(
    path.join(__dirname, "../scripts/task5-gateway-rollout-controls.sql"),
    "utf8"
  );
  assert.match(migration, /v_prior_resolution_mode/);
  assert.match(migration, /resolution_mode = v_prior_resolution_mode/);
  assert.match(migration, /task5_set_property_gateway_resolution/);
  assert.match(migration, /revoke all on function public\.task5_configure_property_gateway\(/);
});

test("restricted gateway owner alone can execute configuration trigger guards", () => {
  const fs = require("node:fs");
  const migration = fs.readFileSync(
    path.join(__dirname, "../scripts/task5-gateway-trigger-execute-fix.sql"),
    "utf8"
  );
  assert.match(migration, /to app_payment_gateway_secret_owner/);
  assert.match(
    migration,
    /from public, anon, authenticated, app_tenant_runtime, app_tenant_rpc_owner, service_role/
  );
  assert.match(migration, /task5_assert_active_account_ready/);
  assert.doesNotMatch(migration, /grant execute[\s\S]*to app_tenant_runtime/i);
});

test("hotel owner UI keeps credentials write-only and cutover explicit", () => {
  const fs = require("node:fs");
  const html = fs.readFileSync(path.join(__dirname, "../../frontend/staff-orders.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "../../frontend/js/staff-orders.js"), "utf8");
  assert.match(html, /data-staff-view="gateway" data-staff-owner-only/);
  assert.match(html, /id="staffGatewayKeySecretInput"[^>]+type="password"/);
  assert.match(html, /id="staffGatewayWebhookSecretInput"[^>]+type="password"/);
  assert.doesNotMatch(html, /value="rzp_(?:test|live)_/);
  assert.match(script, /clearStaffGatewaySecretInputs/);
  assert.match(script, /payment-gateway\/resolution/);
  assert.match(script, /mode: "TEST"/);
});

test("gateway RBAC is owner-only and excluded from platform/KDS boundaries", () => {
  const owner = getEffectivePermissions({ principal_type: "hotel_staff", role: "owner", kds_role: "manager" });
  const staff = getEffectivePermissions({ principal_type: "hotel_staff", role: "staff", kds_role: "general" });
  const kds = getEffectivePermissions({ principal_type: "hotel_staff", role: "staff", kds_role: "kitchen" });
  const platform = getEffectivePermissions({ principal_type: "platform_admin" });
  assert.equal(owner.has("gateway.read"), true);
  assert.equal(owner.has("gateway.manage"), true);
  assert.equal(staff.has("gateway.read"), false);
  assert.equal(kds.has("gateway.manage"), false);
  assert.equal(platform.has("gateway.manage"), false);
});
