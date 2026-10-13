"use strict";

const { digestJson, validateCapturedEvidence } = require("./payment-domain");

async function finalizeProviderPayment({ intent, paymentId, adapter, store, source, evidenceContext = {} }) {
  const evidence = await adapter.getPaymentStatus(paymentId);
  const evidenceDigest = digestJson({
    ...evidenceContext,
    provider: evidence.provider,
    merchantRef: evidence.merchantRef,
    credentialRef: evidence.credentialRef,
    providerOrderId: evidence.providerOrderId,
    providerPaymentId: evidence.providerPaymentId,
    amountMinor: evidence.amountMinor,
    currency: evidence.currency,
    status: evidence.status
  });
  let validation;
  try {
    validation = validateCapturedEvidence({ intent, evidence });
  } catch (error) {
    if (typeof store.recordRejectedAttempt === "function") {
      try { await store.recordRejectedAttempt(intent, evidence, source, evidenceDigest, error.code); }
      catch { /* rejection remains authoritative even if audit persistence is unavailable */ }
    }
    throw error;
  }
  if (validation.idempotent) {
    return { evidence, finalization: { ok: true, idempotent: true, orderUpdated: false } };
  }
  const finalization = await store.finalizeCaptured(intent, evidence, source, evidenceDigest);
  return { evidence, finalization };
}

module.exports = { finalizeProviderPayment };
