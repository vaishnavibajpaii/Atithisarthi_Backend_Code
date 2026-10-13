"use strict";

const crypto = require("crypto");
const { env } = require("../config/env");
const logger = require("../utils/logger");
const { supabase } = require("../utils/supabase");
const { finalizeProviderPayment } = require("../payments/payment-finalizer");
const { PaymentIntentStore } = require("../payments/payment-intent-store");
const { WebhookInboxStore } = require("../payments/webhook-inbox-store");
const { notifyPaidOrderAfterFinalization } = require("../payments/paid-order-notification");
const {
  PURPOSES,
  resolvePaymentGateway
} = require("../payments/payment-gateway-resolver");

let workerTimer = null;
let workerRunning = false;

function paymentEntity(payload) { return payload?.payload?.payment?.entity || {}; }
function orderEntity(payload) { return payload?.payload?.order?.entity || {}; }
function transferEntity(payload) { return payload?.payload?.transfer?.entity || {}; }
function providerOrderId(payload) {
  const payment = paymentEntity(payload);
  const order = orderEntity(payload);
  const transfer = transferEntity(payload);
  return String(payment.order_id || order.id || (String(transfer.source || "").startsWith("order_") ? transfer.source : "") || "");
}

async function processTransferEvent(db, record) {
  const payload = record.payload || {};
  const transfer = transferEntity(payload);
  const orderId = providerOrderId(payload);
  if (!orderId) return { paymentIntentId: null };
  const { data: order, error: readError } = await db.from("orders")
    .select("id,payment_metadata").eq("gateway_order_id", orderId).maybeSingle();
  if (readError) throw readError;
  if (!order) return { paymentIntentId: null };
  const previous = order.payment_metadata && typeof order.payment_metadata === "object" ? order.payment_metadata : {};
  const route = previous.route && typeof previous.route === "object" ? previous.route : {};
  const eventType = String(payload.event || "");
  const update = {
    gateway_transfer_id: String(transfer.id || "") || null,
    gateway_transfer_status: String(transfer.status || transfer.transfer_status || eventType.replace("transfer.", "")) || null,
    gateway_settlement_status: String(transfer.settlement_status || "") || null,
    gateway_transfer_error: String(transfer?.error?.description || transfer?.error?.reason || "") || null,
    payment_metadata: {
      ...previous,
      route: {
        ...route,
        transferId: String(transfer.id || ""),
        transferStatus: String(transfer.status || transfer.transfer_status || ""),
        settlementStatus: String(transfer.settlement_status || ""),
        transferWebhookEvent: eventType,
        transferWebhookReceivedAt: new Date().toISOString()
      }
    }
  };
  const { error } = await db.from("orders").update(update).eq("id", order.id).eq("gateway_order_id", orderId);
  if (error) {
    const details = `${error.code || ""} ${error.message || ""} ${error.details || ""}`.toLowerCase();
    const missingRouteColumns = details.includes("pgrst204") ||
      ["gateway_transfer_id", "gateway_transfer_status", "gateway_settlement_status", "gateway_transfer_error"]
        .some((column) => details.includes(column));
    if (!missingRouteColumns) throw error;
    const fallback = await db.from("orders").update({ payment_metadata: update.payment_metadata })
      .eq("id", order.id).eq("gateway_order_id", orderId);
    if (fallback.error) throw fallback.error;
  }
  return { paymentIntentId: null };
}

async function processInboxRecord({
  record,
  db,
  adapter = null,
  intentStore = null,
  notifyPaidOrder = notifyPaidOrderAfterFinalization
}) {
  const payload = record.payload || {};
  const eventType = String(record.event_type || payload.event || "").toLowerCase();
  if (eventType.startsWith("transfer.")) {
    if (record.gateway_account_id) {
      throw Object.assign(new Error("Per-property transfer events are unsupported"), {
        code: "BYOG_TRANSFER_EVENT_UNSUPPORTED"
      });
    }
    return processTransferEvent(db, record);
  }
  if (!["payment.authorized", "payment.captured", "payment.failed", "order.paid"].includes(eventType)) {
    return { paymentIntentId: null, skipped: true };
  }

  const gatewayOrderId = providerOrderId(payload);
  if (!gatewayOrderId) throw Object.assign(new Error("Provider order id is missing"), { code: "PROVIDER_ORDER_MISSING" });
  const intents = intentStore || new PaymentIntentStore(db);
  const intent = await intents.findForVerification({ providerOrderId: gatewayOrderId });
  if (!intent) throw Object.assign(new Error("Payment intent was not found"), { code: "PAYMENT_INTENT_NOT_FOUND" });
  if (intent.provider !== record.provider || intent.merchant_ref !== record.merchant_ref ||
      String(intent.gateway_account_id || "") !== String(record.gateway_account_id || "")) {
    throw Object.assign(new Error("Webhook merchant/provider does not match intent"), { code: "MERCHANT_MISMATCH" });
  }
  const effectiveAdapter = adapter || (await resolvePaymentGateway({
    tenantId: intent.tenant_id,
    propertyId: intent.property_id,
    provider: intent.provider,
    purpose: PURPOSES.VERIFY,
    paymentIntent: intent
  })).adapter;
  if (intent.provider !== effectiveAdapter.provider ||
      intent.merchant_ref !== effectiveAdapter.merchantRef ||
      intent.credential_ref !== effectiveAdapter.credentialRef) {
    throw Object.assign(new Error("Webhook credential does not match intent"), { code: "CREDENTIAL_MISMATCH" });
  }

  let paymentId = String(paymentEntity(payload).id || "");
  if (!paymentId && eventType === "order.paid") {
    const payments = await effectiveAdapter.getOrderPayments(gatewayOrderId);
    paymentId = String(payments.find((item) => item?.captured === true || String(item?.status).toLowerCase() === "captured")?.id || "");
  }
  if (!paymentId) throw Object.assign(new Error("Provider payment id is missing"), { code: "PROVIDER_PAYMENT_MISSING" });
  if (eventType === "payment.captured" || eventType === "order.paid") {
    const { finalization } = await finalizeProviderPayment({
      intent, paymentId, adapter: effectiveAdapter, store: intents, source: "WEBHOOK",
      evidenceContext: { providerEventId: record.provider_event_id }
    });
    if (finalization?.orderUpdated) {
      await notifyPaidOrder({ db, intent });
    }
    return { paymentIntentId: intent.id };
  }

  const evidence = await effectiveAdapter.getPaymentStatus(paymentId);
  if (evidence.providerOrderId !== intent.provider_order_id || evidence.merchantRef !== intent.merchant_ref) {
    throw Object.assign(new Error("Provider evidence binding failed"), { code: "PROVIDER_BINDING_MISMATCH" });
  }
  await intents.applyNonFinalState(intent, eventType === "payment.authorized" ? "authorized" : "failed", paymentId);
  return { paymentIntentId: intent.id };
}

async function processPaymentWebhookInboxOnce({ db = supabase, adapter = null, leaseOwner } = {}) {
  const owner = leaseOwner || `payment-worker-${process.pid}-${crypto.randomUUID()}`;
  const inbox = new WebhookInboxStore(db);
  const record = await inbox.claim(owner, 60, 12);
  if (!record) return { claimed: false };
  try {
    const result = await processInboxRecord({ record, db, adapter });
    const completed = await inbox.complete(record.id, owner, {
      success: true, paymentIntentId: result.paymentIntentId
    });
    return { claimed: true, completed, eventId: record.provider_event_id, ...result };
  } catch (error) {
    const deadLetter = Number(record.attempt_count || 0) >= 12;
    await inbox.complete(record.id, owner, {
      success: false, error: `${error.code || "PROCESSING_ERROR"}: ${error.message}`.slice(0, 500), deadLetter
    });
    logger.error("Payment webhook processing failed", {
      provider: record.provider, merchantRef: record.merchant_ref,
      webhookEventId: record.provider_event_id, attemptNumber: record.attempt_count,
      errorCode: error.code || "PROCESSING_ERROR"
    });
    return { claimed: true, completed: false, failed: true, deadLetter, eventId: record.provider_event_id };
  }
}

async function drainOneSafely() {
  if (workerRunning) return;
  workerRunning = true;
  try { await processPaymentWebhookInboxOnce(); }
  catch (error) {
    logger.error("Payment webhook worker cycle failed", { errorCode: error.code || "WORKER_ERROR" });
  } finally { workerRunning = false; }
}

function startPaymentWebhookWorker() {
  if (!env.paymentWebhookWorkerEnabled || workerTimer) return;
  const interval = Number.isFinite(env.paymentWebhookWorkerIntervalMs) && env.paymentWebhookWorkerIntervalMs >= 1000
    ? env.paymentWebhookWorkerIntervalMs : 5000;
  workerTimer = setInterval(drainOneSafely, interval);
  workerTimer.unref?.();
  void drainOneSafely();
}

function stopPaymentWebhookWorker() {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
}

module.exports = {
  processInboxRecord,
  processPaymentWebhookInboxOnce,
  startPaymentWebhookWorker,
  stopPaymentWebhookWorker
};
