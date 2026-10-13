"use strict";

const crypto = require("crypto");

const PAYMENT_STATES = Object.freeze({
  CREATED: "CREATED",
  PENDING: "PENDING",
  AUTHORIZED: "AUTHORIZED",
  PAID: "PAID",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
  REFUNDED: "REFUNDED"
});
const LEGACY_RAZORPAY_MERCHANT_REF = "LEGACY_PLATFORM_RAZORPAY";

class PaymentIntegrityError extends Error {
  constructor(code, message, httpStatus = 409) {
    super(message);
    this.name = "PaymentIntegrityError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((result, key) => {
      if (value[key] !== undefined) result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value;
}

function digestJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function parseIdempotencyKey(value = "") {
  const key = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(key)) {
    throw new PaymentIntegrityError(
      "INVALID_IDEMPOTENCY_KEY",
      "A valid Idempotency-Key header is required (8 to 200 safe characters).",
      400
    );
  }
  return key;
}

function normalizeCurrency(value = "") {
  return String(value || "").trim().toUpperCase();
}

function normalizeStatus(value = "") {
  return String(value || "").trim().toLowerCase();
}

function validateCapturedEvidence({ intent, evidence }) {
  if (!intent) throw new PaymentIntegrityError("PAYMENT_INTENT_NOT_FOUND", "Payment intent was not found", 404);
  if (!evidence) throw new PaymentIntegrityError("PAYMENT_EVIDENCE_MISSING", "Provider payment evidence is missing");
  if (String(evidence.provider || "") !== String(intent.provider || "")) {
    throw new PaymentIntegrityError("PROVIDER_MISMATCH", "Payment provider does not match the intent");
  }
  if (String(evidence.merchantRef || "") !== String(intent.merchant_ref || intent.merchantRef || "")) {
    throw new PaymentIntegrityError("MERCHANT_MISMATCH", "Payment merchant does not match the intent");
  }
  if (String(evidence.credentialRef || "") !== String(intent.credential_ref || intent.credentialRef || "")) {
    throw new PaymentIntegrityError("CREDENTIAL_MISMATCH", "Payment credential does not match the intent");
  }
  if (String(evidence.providerOrderId || "") !== String(intent.provider_order_id || intent.providerOrderId || "")) {
    throw new PaymentIntegrityError("PROVIDER_ORDER_MISMATCH", "Provider order does not match the intent");
  }
  if (!String(evidence.providerPaymentId || "").trim()) {
    throw new PaymentIntegrityError("PROVIDER_PAYMENT_MISSING", "Provider payment id is missing");
  }
  const expectedAmount = Number(intent.expected_amount_minor ?? intent.expectedAmountMinor);
  if (!Number.isSafeInteger(Number(evidence.amountMinor)) || Number(evidence.amountMinor) !== expectedAmount) {
    throw new PaymentIntegrityError("AMOUNT_MISMATCH", "Captured amount does not match the intent");
  }
  if (normalizeCurrency(evidence.currency) !== normalizeCurrency(intent.currency)) {
    throw new PaymentIntegrityError("CURRENCY_MISMATCH", "Captured currency does not match the intent");
  }
  if (normalizeStatus(evidence.status) !== "captured" || evidence.captured === false) {
    throw new PaymentIntegrityError("PAYMENT_NOT_CAPTURED", "Provider payment is not captured");
  }
  const state = String(intent.status || "").toUpperCase();
  const existingPaymentId = String(intent.provider_payment_id || intent.providerPaymentId || "");
  if ([PAYMENT_STATES.PAID, PAYMENT_STATES.PARTIALLY_REFUNDED, PAYMENT_STATES.REFUNDED].includes(state)) {
    if (existingPaymentId === String(evidence.providerPaymentId)) return { idempotent: true };
    throw new PaymentIntegrityError("CONFLICTING_CAPTURED_PAYMENT", "A different captured payment is already recorded");
  }
  if ([PAYMENT_STATES.CANCELLED, PAYMENT_STATES.REFUNDED].includes(state)) {
    throw new PaymentIntegrityError("PAYMENT_STATE_CONFLICT", "Payment state does not allow capture");
  }
  return { idempotent: false };
}

function nextProviderState(currentState, providerStatus) {
  const current = String(currentState || PAYMENT_STATES.CREATED).toUpperCase();
  const event = normalizeStatus(providerStatus);
  if ([PAYMENT_STATES.PAID, PAYMENT_STATES.PARTIALLY_REFUNDED, PAYMENT_STATES.REFUNDED].includes(current)) {
    return current;
  }
  if (event === "captured") return PAYMENT_STATES.PAID;
  if (event === "authorized" && [PAYMENT_STATES.CREATED, PAYMENT_STATES.PENDING].includes(current)) {
    return PAYMENT_STATES.AUTHORIZED;
  }
  if (event === "failed" && [PAYMENT_STATES.CREATED, PAYMENT_STATES.PENDING, PAYMENT_STATES.AUTHORIZED].includes(current)) {
    return PAYMENT_STATES.FAILED;
  }
  return current;
}

module.exports = {
  LEGACY_RAZORPAY_MERCHANT_REF,
  PAYMENT_STATES,
  PaymentIntegrityError,
  digestJson,
  nextProviderState,
  normalizeCurrency,
  parseIdempotencyKey,
  validateCapturedEvidence
};
