"use strict";

const crypto = require("crypto");
const express = require("express");
const { supabase } = require("../utils/supabase");
const logger = require("../utils/logger");
const { getPaymentGatewayAdapter, getPaymentGatewayConfig } = require("../utils/payment-gateway");
const { WebhookInboxStore } = require("../payments/webhook-inbox-store");
const { isMissingTask2ASchema } = require("../payments/payment-intent-store");
const { processPaymentWebhookInboxOnce } = require("../workers/payment-webhook-worker");
const {
  GatewayResolutionError,
  authenticatePropertyWebhook
} = require("../payments/payment-gateway-resolver");

const router = express.Router();
const inbox = new WebhookInboxStore(supabase);

function safeText(value, max = 200) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseRawBody(rawBody) {
  const buffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""));
  return { buffer, payload: JSON.parse(buffer.toString("utf8")) };
}

router.post(["/", "/:provider/:webhookRef"], async (req, res) => {
  const correlationId = safeText(req.requestId, 120);
  try {
    const signature = req.get("x-razorpay-signature") || "";
    let authenticated;
    if (req.params.webhookRef) {
      if (String(req.params.provider || "").toLowerCase() !== "razorpay") {
        return res.status(404).json({ success: false, message: "Webhook endpoint was not found" });
      }
      authenticated = await authenticatePropertyWebhook({
        webhookRef: req.params.webhookRef,
        rawBody: req.body,
        signature
      });
    } else {
      const config = getPaymentGatewayConfig();
      if (!config.razorpay.webhookSecret) {
        return res.status(503).json({ success: false, message: "Payment webhook secret is not configured" });
      }
      const adapter = getPaymentGatewayAdapter();
      if (adapter.verifyWebhook({ rawBody: req.body, gatewaySignature: signature })) {
        authenticated = {
          provider: adapter.provider,
          merchantRef: adapter.merchantRef,
          gatewayAccountId: null,
          webhookSecretRef: null
        };
      }
    }
    if (!authenticated) {
      logger.warn("Payment webhook signature verification failed", {
        correlationId, provider: "razorpay", paymentEvent: "webhook_signature_failure"
      });
      return res.status(400).json({ success: false, message: "Invalid webhook signature" });
    }

    let parsed;
    try { parsed = parseRawBody(req.body); }
    catch {
      return res.status(400).json({ success: false, message: "Invalid webhook body" });
    }
    const payloadDigest = sha256(parsed.buffer);
    const eventType = safeText(parsed.payload?.event, 120);
    const providerEventId = safeText(
      req.get("x-razorpay-event-id") || parsed.payload?.id || `digest:${payloadDigest}`,
      260
    );
    if (!eventType || !providerEventId) {
      return res.status(400).json({ success: false, message: "Webhook event identity is missing" });
    }
    const eventId = providerEventId;
    res.set("x-webhook-event-id", eventId);

    const result = await inbox.enqueue({
      provider: authenticated.provider,
      merchantRef: authenticated.merchantRef,
      gatewayAccountId: authenticated.gatewayAccountId,
      webhookSecretRef: authenticated.webhookSecretRef,
      providerEventId,
      payloadDigest,
      eventType,
      payload: parsed.payload
    });
    const existingStatus = String(result.event?.status || "RECEIVED").toUpperCase();
    logger.info("Payment webhook durably received", {
      correlationId, provider: authenticated.provider, merchantRef: authenticated.merchantRef,
      webhookEventId: providerEventId, eventType,
      duplicate: result.duplicate, inboxStatus: existingStatus,
      paymentEvent: result.duplicate ? "duplicate_webhook" : "webhook_received"
    });

    if (result.duplicate && existingStatus === "PROCESSED") {
      return res.json({
        success: true, duplicate: true, processed: true,
        eventId: providerEventId, message: "Webhook event already processed"
      });
    }

    // RECEIVED, FAILED, or an expired PROCESSING lease remains claimable. The HTTP
    // acknowledgement never converts an incomplete duplicate into permanent success.
    setImmediate(() => {
      void processPaymentWebhookInboxOnce().catch((error) => {
        logger.error("Payment webhook immediate worker trigger failed", {
          correlationId, webhookEventId: providerEventId,
          errorCode: error.code || "WORKER_TRIGGER_ERROR"
        });
      });
    });
    return res.status(202).json({
      success: true,
      duplicate: result.duplicate,
      processed: false,
      retryable: true,
      eventId: providerEventId,
      status: existingStatus,
      message: result.duplicate ? "Webhook remains queued for recovery" : "Webhook accepted for processing"
    });
  } catch (error) {
    if (error instanceof GatewayResolutionError) {
      return res.status(error.httpStatus).json({ success: false, code: error.code, message: error.message });
    }
    if (error?.code === "WEBHOOK_EVENT_PAYLOAD_CONFLICT") {
      return res.status(409).json({ success: false, code: error.code, message: "Webhook event payload conflict" });
    }
    if (isMissingTask2ASchema(error)) {
      return res.status(503).json({
        success: false, code: "PAYMENT_HARDENING_SCHEMA_NOT_READY",
        message: "Payment webhook inbox is not ready"
      });
    }
    logger.error("Payment webhook intake failed", {
      correlationId, paymentEvent: "webhook_intake_failure",
      errorCode: safeText(error.code || "WEBHOOK_INTAKE_ERROR", 100)
    });
    return res.status(500).json({ success: false, message: "Failed to accept payment webhook" });
  }
});

module.exports = router;
