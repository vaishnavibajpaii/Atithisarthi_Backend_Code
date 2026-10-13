"use strict";

class WebhookInboxStore {
  constructor(supabaseClient) { this.db = supabaseClient; }

  async enqueue(event) {
    const row = {
      provider: event.provider, merchant_ref: event.merchantRef,
      gateway_account_id: event.gatewayAccountId || null,
      webhook_secret_ref: event.webhookSecretRef || null,
      provider_event_id: event.providerEventId, payload_digest: event.payloadDigest,
      event_type: event.eventType, payload: event.payload, status: "RECEIVED"
    };
    const result = await this.db.from("payment_webhook_inbox").insert([row]).select("*").single();
    if (!result.error) return { event: result.data, duplicate: false };
    if (String(result.error.code) !== "23505") throw result.error;
    const existing = await this.db.from("payment_webhook_inbox").select("*")
      .eq("provider", event.provider).eq("merchant_ref", event.merchantRef)
      .eq("provider_event_id", event.providerEventId).maybeSingle();
    if (existing.error) throw existing.error;
    if (!existing.data) throw result.error;
    if (existing.data.payload_digest !== event.payloadDigest) {
      const error = new Error("WEBHOOK_EVENT_PAYLOAD_CONFLICT");
      error.code = "WEBHOOK_EVENT_PAYLOAD_CONFLICT";
      throw error;
    }
    return { event: existing.data, duplicate: true };
  }

  async claim(leaseOwner, leaseSeconds = 60, maxAttempts = 12) {
    const { data, error } = await this.db.rpc("claim_payment_webhook", {
      p_lease_owner: leaseOwner, p_lease_seconds: leaseSeconds, p_max_attempts: maxAttempts
    });
    if (error) throw error;
    return Array.isArray(data) ? (data[0] || null) : data;
  }

  async complete(id, leaseOwner, { success, paymentIntentId = null, error = null, deadLetter = false }) {
    const result = await this.db.rpc("complete_payment_webhook", {
      p_id: id, p_lease_owner: leaseOwner, p_success: !!success,
      p_payment_intent_id: paymentIntentId, p_last_error: error,
      p_dead_letter: !!deadLetter
    });
    if (result.error) throw result.error;
    return result.data === true;
  }
}

module.exports = { WebhookInboxStore };
