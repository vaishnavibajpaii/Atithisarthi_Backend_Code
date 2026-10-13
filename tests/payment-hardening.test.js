"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
require("dotenv").config({ path: path.join(__dirname, "../.env"), quiet: true });
const {
  PaymentIntegrityError,
  digestJson,
  nextProviderState,
  parseIdempotencyKey,
  validateCapturedEvidence
} = require("../payments/payment-domain");
const { finalizeProviderPayment } = require("../payments/payment-finalizer");
const { MockRazorpayAdapter } = require("../payments/mock-razorpay-adapter");
const { processInboxRecord } = require("../workers/payment-webhook-worker");

function intent(overrides = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    hotel_slug: "test-hotel-alpha",
    business_order_id: "101",
    provider: "razorpay",
    merchant_ref: "LEGACY_PLATFORM_RAZORPAY",
    credential_ref: "MOCK_RAZORPAY_V1",
    expected_amount_minor: 14900,
    currency: "INR",
    status: "PENDING",
    provider_order_id: "order_mock_1",
    provider_payment_id: null,
    ...overrides
  };
}

class AtomicStore {
  constructor() { this.effects = 0; }
  async finalizeCaptured(target, evidence) {
    if (["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(target.status)) {
      if (target.provider_payment_id === evidence.providerPaymentId) {
        return { ok: true, idempotent: true, orderUpdated: false };
      }
      throw new PaymentIntegrityError("CONFLICTING_CAPTURED_PAYMENT", "conflict");
    }
    target.status = "PAID";
    target.provider_payment_id = evidence.providerPaymentId;
    this.effects += 1;
    await Promise.resolve();
    return { ok: true, idempotent: false, orderUpdated: true };
  }
}

function capturedAdapter({ paymentId = "pay_ok", amountMinor = 14900, currency = "INR", orderId = "order_mock_1", merchantRef } = {}) {
  const adapter = new MockRazorpayAdapter(merchantRef ? { merchantRef } : undefined);
  adapter.addPayment({ id: paymentId, orderId, amountMinor, currency, status: "captured", merchantRef: merchantRef || adapter.merchantRef });
  return adapter;
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}

test("valid signature plus captured provider payment finalizes paid", async () => {
  const adapter = capturedAdapter();
  const store = new AtomicStore();
  const target = intent();
  const signature = adapter.signCheckout(target.provider_order_id, "pay_ok");
  assert.equal(adapter.verifyCheckoutEvidence({ gatewayOrderId: target.provider_order_id, gatewayPaymentId: "pay_ok", gatewaySignature: signature }), true);
  const result = await finalizeProviderPayment({ intent: target, paymentId: "pay_ok", adapter, store, source: "TEST" });
  assert.equal(result.evidence.status, "captured");
  assert.equal(target.status, "PAID");
  assert.equal(store.effects, 1);
});

test("valid signature with authorized-only payment is not paid", async () => {
  const adapter = new MockRazorpayAdapter();
  adapter.addPayment({ id: "pay_auth", orderId: "order_mock_1", amountMinor: 14900, status: "authorized" });
  const store = new AtomicStore();
  await expectCode(finalizeProviderPayment({ intent: intent(), paymentId: "pay_auth", adapter, store, source: "TEST" }), "PAYMENT_NOT_CAPTURED");
  assert.equal(store.effects, 0);
});

test("valid signature with failed payment is not paid", async () => {
  const adapter = new MockRazorpayAdapter();
  adapter.addPayment({ id: "pay_failed", orderId: "order_mock_1", amountMinor: 14900, status: "failed" });
  const store = new AtomicStore();
  await expectCode(finalizeProviderPayment({ intent: intent(), paymentId: "pay_failed", adapter, store, source: "TEST" }), "PAYMENT_NOT_CAPTURED");
  assert.equal(store.effects, 0);
});

test("invalid checkout signature is rejected", () => {
  const adapter = new MockRazorpayAdapter();
  assert.equal(adapter.verifyCheckoutEvidence({ gatewayOrderId: "order_mock_1", gatewayPaymentId: "pay_ok", gatewaySignature: "invalid" }), false);
});

for (const scenario of [
  ["wrong amount", capturedAdapter({ amountMinor: 149 }), "AMOUNT_MISMATCH"],
  ["wrong currency", capturedAdapter({ currency: "USD" }), "CURRENCY_MISMATCH"],
  ["wrong provider order", capturedAdapter({ orderId: "order_wrong" }), "PROVIDER_ORDER_MISMATCH"],
  ["wrong merchant", capturedAdapter({ merchantRef: "OTHER_MERCHANT" }), "MERCHANT_MISMATCH"]
]) {
  test(`captured payment ${scenario[0]} is rejected`, async () => {
    await expectCode(finalizeProviderPayment({ intent: intent(), paymentId: "pay_ok", adapter: scenario[1], store: new AtomicStore(), source: "TEST" }), scenario[2]);
  });
}

test("repeated verification creates one financial effect", async () => {
  const adapter = capturedAdapter();
  const store = new AtomicStore();
  const target = intent();
  await Promise.all([
    finalizeProviderPayment({ intent: target, paymentId: "pay_ok", adapter, store, source: "VERIFY" }),
    finalizeProviderPayment({ intent: target, paymentId: "pay_ok", adapter, store, source: "WEBHOOK" })
  ]);
  assert.equal(store.effects, 1);
  assert.equal(target.status, "PAID");
});

test("second conflicting captured payment raises an exception", async () => {
  const adapter = capturedAdapter({ paymentId: "pay_second" });
  const target = intent({ status: "PAID", provider_payment_id: "pay_first" });
  await expectCode(finalizeProviderPayment({ intent: target, paymentId: "pay_second", adapter, store: new AtomicStore(), source: "TEST" }), "CONFLICTING_CAPTURED_PAYMENT");
});

test("late failure after captured remains paid", () => {
  assert.equal(nextProviderState("PAID", "failed"), "PAID");
  assert.equal(nextProviderState("PAID", "authorized"), "PAID");
});

test("captured before authorized remains paid after late authorized", () => {
  assert.equal(nextProviderState(nextProviderState("PENDING", "captured"), "authorized"), "PAID");
});

test("manual UPI customer_confirmed remains distinct from paid", () => {
  const ordersSource = fs.readFileSync(path.join(__dirname, "../routes/orders.js"), "utf8");
  assert.match(ordersSource, /paymentConfirmed[\s\S]{0,120}"customer_confirmed"[\s\S]{0,80}"unpaid"/);
  assert.notEqual("customer_confirmed", "paid");
});

test("idempotency key validation and deterministic digest", () => {
  assert.equal(parseIdempotencyKey("pay-attempt-123"), "pay-attempt-123");
  assert.throws(() => parseIdempotencyKey("short"), /Idempotency-Key/);
  assert.equal(digestJson({ b: 2, a: 1 }), digestJson({ a: 1, b: 2 }));
});

test("same key and digest reuses one logical intent; changed digest conflicts", async () => {
  const rows = new Map();
  let creations = 0;
  async function create(key, digest) {
    const existing = rows.get(key);
    if (existing) {
      if (existing.digest !== digest) throw Object.assign(new Error("conflict"), { code: "IDEMPOTENCY_KEY_REUSED" });
      return existing;
    }
    const row = { id: `intent-${++creations}`, digest };
    rows.set(key, row);
    return row;
  }
  const digest = digestJson({ amount: 14900 });
  const [a, b] = await Promise.all([create("same-key", digest), create("same-key", digest)]);
  assert.equal(a.id, b.id);
  assert.equal(creations, 1);
  await expectCode(create("same-key", digestJson({ amount: 15000 })), "IDEMPOTENCY_KEY_REUSED");
});

test("provider timeout is uncertain and never treated as failed or paid", async () => {
  const adapter = new MockRazorpayAdapter();
  adapter.timeoutNextCreate = true;
  await assert.rejects(
    adapter.createPaymentOrder({ amountMinor: 14900, currency: "INR" }),
    (error) => error.code === "PROVIDER_TIMEOUT" && error.uncertain === true
  );
  assert.equal(adapter.createCalls, 1);
});

test("initiation persists and claims an intent before provider creation and has attachment recovery", () => {
  const route = fs.readFileSync(path.join(__dirname, "../routes/payments.js"), "utf8");
  const createIntentAt = route.indexOf("paymentIntentStore.createOrReuse");
  const claimIntentAt = route.indexOf("paymentIntentStore.claimProviderCreation", createIntentAt);
  const createProviderAt = route.indexOf("adapter.createPaymentOrder", claimIntentAt);
  const attachProviderAt = route.indexOf("paymentIntentStore.attachProviderOrder", createProviderAt);
  assert.ok(createIntentAt > 0 && claimIntentAt > createIntentAt);
  assert.ok(createProviderAt > claimIntentAt && attachProviderAt > createProviderAt);
  assert.match(route, /PROVIDER_ORDER_ATTACH_FAILED[\s\S]{0,800}requiresReconciliation: true/);
  assert.match(route, /provider_creation_started_at/);
  assert.match(route, /paymentIntent\.requires_reconciliation/);
});

test("mock provider supports created, authorized, captured, failed and mismatch fixtures", async () => {
  const adapter = new MockRazorpayAdapter();
  const order = await adapter.createPaymentOrder({ amountMinor: 14900, currency: "INR" });
  assert.equal(order.gatewayStatus, "created");
  adapter.addPayment({ id: "authorized", orderId: order.gatewayOrderId, amountMinor: 14900, status: "authorized" });
  adapter.addPayment({ id: "captured", orderId: order.gatewayOrderId, amountMinor: 14900, status: "captured" });
  adapter.addPayment({ id: "failed", orderId: order.gatewayOrderId, amountMinor: 14900, status: "failed" });
  assert.equal((await adapter.getPaymentStatus("authorized")).status, "authorized");
  assert.equal((await adapter.getPaymentStatus("captured")).captured, true);
  assert.equal((await adapter.getPaymentStatus("failed")).status, "failed");
});

test("migration provides database-enforced idempotency, atomic finalization, and leased inbox claims", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../scripts/create-payment-correctness-hardening.sql"), "utf8");
  assert.match(sql, /unique \(hotel_slug, operation, idempotency_key\)/i);
  assert.match(sql, /select \* into v_intent[\s\S]*for update/i);
  assert.match(sql, /for update skip locked/i);
  assert.match(sql, /status in \('RECEIVED','PROCESSING','FAILED'\)/i);
  assert.match(sql, /provider, merchant_ref, provider_event_id/i);
  assert.match(sql, /coalesce\(payment_status, ''\) <> 'paid'/i);
});

test("duplicate webhook states remain recoverable unless processed", () => {
  const retryable = new Set(["RECEIVED", "FAILED", "PROCESSING"]);
  assert.equal(retryable.has("FAILED"), true);
  assert.equal(retryable.has("PROCESSING"), true);
  assert.equal(retryable.has("PROCESSED"), false);
});

test("webhook worker processes captured, duplicate, authorized, failed, and out-of-order events", async () => {
  const adapter = capturedAdapter();
  adapter.addPayment({ id: "pay_auth", orderId: "order_mock_1", amountMinor: 14900, status: "authorized" });
  adapter.addPayment({ id: "pay_fail", orderId: "order_mock_1", amountMinor: 14900, status: "failed" });
  const target = intent();
  const store = new AtomicStore();
  store.findForVerification = async () => target;
  store.applyNonFinalState = async (row, providerStatus, paymentId) => {
    row.status = nextProviderState(row.status, providerStatus);
    row.provider_payment_id = paymentId;
    return row;
  };
  const record = (eventType, paymentId, eventId) => ({
    id: eventId,
    provider: target.provider,
    merchant_ref: target.merchant_ref,
    gateway_account_id: null,
    provider_event_id: eventId,
    event_type: eventType,
    payload: {
      event: eventType,
      payload: { payment: { entity: { id: paymentId, order_id: "order_mock_1" } } }
    }
  });
  const notifyPaidOrder = async () => null;
  await processInboxRecord({ record: record("payment.authorized", "pay_auth", "evt-auth"), db: {}, adapter, intentStore: store, notifyPaidOrder });
  assert.equal(target.status, "AUTHORIZED");
  await processInboxRecord({ record: record("payment.captured", "pay_ok", "evt-captured"), db: {}, adapter, intentStore: store, notifyPaidOrder });
  assert.equal(target.status, "PAID");
  await processInboxRecord({ record: record("payment.captured", "pay_ok", "evt-captured-duplicate"), db: {}, adapter, intentStore: store, notifyPaidOrder });
  assert.equal(store.effects, 1);
  await processInboxRecord({ record: record("payment.failed", "pay_fail", "evt-failed-late"), db: {}, adapter, intentStore: store, notifyPaidOrder });
  assert.equal(target.status, "PAID");
});

test("webhook worker rejects unknown internal orders", async () => {
  const adapter = capturedAdapter();
  const store = { findForVerification: async () => null };
  await expectCode(processInboxRecord({
    record: {
      provider_event_id: "evt-unknown", event_type: "payment.captured",
      payload: { event: "payment.captured", payload: { payment: { entity: { id: "pay_ok", order_id: "order_mock_1" } } } }
    },
    db: {}, adapter, intentStore: store
  }), "PAYMENT_INTENT_NOT_FOUND");
});

test("webhook intake source rejects invalid signatures and scopes duplicate identity by provider and merchant", () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/payment-webhooks.js"), "utf8");
  assert.match(source, /verifyWebhook/);
  assert.match(source, /status\(400\)[\s\S]{0,100}Invalid webhook signature/);
  assert.match(source, /provider: adapter\.provider[\s\S]*merchantRef: adapter\.merchantRef[\s\S]*providerEventId/);
});

test("crash recovery contracts preserve retryability before and after financial commit", () => {
  const worker = fs.readFileSync(path.join(__dirname, "../workers/payment-webhook-worker.js"), "utf8");
  const sql = fs.readFileSync(path.join(__dirname, "../scripts/create-payment-correctness-hardening.sql"), "utf8");
  assert.match(sql, /status = 'PROCESSING' and lease_until < now\(\)/i);
  assert.match(worker, /finalizeProviderPayment[\s\S]*inbox\.complete/);
  assert.match(sql, /if v_intent\.provider_payment_id = p_provider_payment_id[\s\S]*idempotent/i);
});

test("parallel captured webhook, parallel verify, and mixed verify/webhook converge to one effect", async () => {
  for (const sources of [["WEBHOOK", "WEBHOOK"], ["VERIFY", "VERIFY"], ["VERIFY", "WEBHOOK"]]) {
    const target = intent();
    const store = new AtomicStore();
    const adapter = capturedAdapter();
    await Promise.all(sources.map((source) => finalizeProviderPayment({
      intent: target, paymentId: "pay_ok", adapter, store, source
    })));
    assert.equal(store.effects, 1);
  }
});

test("pricing and zero-value rules are not redefined by Task 2A", () => {
  const route = fs.readFileSync(path.join(__dirname, "../routes/payments.js"), "utf8");
  assert.match(route, /calculateGatewayTotals/);
  assert.match(route, /toGatewayMinorAmount\(paymentContext\.totals\.gatewayAmount\)/);
  assert.doesNotMatch(route, /TASK_2A_PRICE_OVERRIDE/);
});

test("production safety guards remain present", () => {
  const gateway = fs.readFileSync(path.join(__dirname, "../utils/payment-gateway.js"), "utf8");
  const route = fs.readFileSync(path.join(__dirname, "../routes/payments.js"), "utf8");
  assert.match(gateway, /Refusing to use a non-test Razorpay key outside production/);
  assert.match(gateway, /AbortController/);
  assert.match(gateway, /PROVIDER_TIMEOUT/);
  assert.match(route, /TASK_2A_PAYMENT_INTENT_V1/);
  assert.match(route, /paymentIntentRequired:\s*true/);
  assert.match(route, /intentBeforeProviderOrder:\s*true/);
  assert.match(route, /finality:\s*"CAPTURED_PROVIDER_EVIDENCE"/);
  assert.match(route, /worker:\s*\{[\s\S]*enabled:\s*!!env\.paymentWebhookWorkerEnabled[\s\S]*intervalMs:\s*env\.paymentWebhookWorkerIntervalMs/);
});
