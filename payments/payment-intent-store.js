"use strict";

const { PaymentIntegrityError } = require("./payment-domain");
const { withTenantTransaction } = require("../utils/tenant-database");

function isMissingTask2ASchema(error) {
  const text = `${error?.code || ""} ${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  return text.includes("payment_intents") || text.includes("payment_webhook_inbox") || text.includes("pgrst202") || text.includes("pgrst205") || text.includes("42p01");
}

class PaymentIntentStore {
  constructor(supabaseClient, options = {}) {
    this.db = supabaseClient;
    this.tenantTransactionRunner =
      options.tenantTransactionRunner || withTenantTransaction;
  }

  async findByIdempotency(hotelSlug, operation, idempotencyKey) {
    const { data, error } = await this.db.from("payment_intents").select("*")
      .eq("hotel_slug", hotelSlug).eq("operation", operation).eq("idempotency_key", idempotencyKey).maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async createOrReuse(input) {
    const row = {
      hotel_slug: input.hotelSlug, operation: input.operation,
      business_order_id: input.businessOrderId || null,
      provider: input.provider, merchant_ref: input.merchantRef,
      credential_ref: input.credentialRef,
      gateway_account_id: input.gatewayAccountId || null,
      expected_amount_minor: input.expectedAmountMinor, currency: input.currency,
      idempotency_key: input.idempotencyKey, request_digest: input.requestDigest,
      context: input.context || {}
    };

    if (row.gateway_account_id) {
      if (!input.tenantId || !input.propertyId) {
        throw new PaymentIntegrityError(
          "PAYMENT_INTENT_SCOPE_REQUIRED",
          "Canonical tenant and property context is required for a property gateway PaymentIntent",
          409
        );
      }
      return this.createOrReuseTenantScoped(input, row);
    }

    const inserted = await this.db.from("payment_intents").insert([row]).select("*").single();
    if (!inserted.error) return { intent: inserted.data, reused: false };
    if (String(inserted.error.code) !== "23505") throw inserted.error;
    const existing = await this.findByIdempotency(input.hotelSlug, input.operation, input.idempotencyKey);
    if (!existing) throw inserted.error;
    if (existing.request_digest !== input.requestDigest) {
      throw new PaymentIntegrityError("IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used for a different payment request", 409);
    }
    return { intent: existing, reused: true };
  }

  async createOrReuseTenantScoped(input, row) {
    return this.tenantTransactionRunner(
      {
        tenantId: input.tenantId,
        propertyId: input.propertyId
      },
      async (client, scope) => {
        const values = [
          scope.tenantId,
          scope.propertyId,
          row.hotel_slug,
          row.operation,
          row.business_order_id,
          row.provider,
          row.merchant_ref,
          row.credential_ref,
          row.gateway_account_id,
          row.expected_amount_minor,
          row.currency,
          row.idempotency_key,
          row.request_digest,
          JSON.stringify(row.context)
        ];
        const inserted = await client.query(
          `WITH inserted AS (
             INSERT INTO public.payment_intents (
               tenant_id, property_id, hotel_slug, operation,
               business_order_id, provider, merchant_ref, credential_ref,
               gateway_account_id, expected_amount_minor, currency,
               idempotency_key, request_digest, context
             ) VALUES (
               $1::uuid, $2::bigint, $3, $4,
               $5, $6, $7, $8,
               $9::uuid, $10::bigint, $11,
               $12, $13, $14::jsonb
             )
             ON CONFLICT (hotel_slug, operation, idempotency_key) DO NOTHING
             RETURNING *
           )
           SELECT to_jsonb(inserted) AS payload FROM inserted`,
          values
        );
        if (inserted.rows.length === 1) {
          return { intent: inserted.rows[0].payload, reused: false };
        }

        const existing = await client.query(
          `SELECT to_jsonb(intent) AS payload
             FROM public.payment_intents AS intent
            WHERE intent.tenant_id = $1::uuid
              AND intent.property_id = $2::bigint
              AND intent.hotel_slug = $3
              AND intent.operation = $4
              AND intent.idempotency_key = $5
            LIMIT 2`,
          [
            scope.tenantId,
            scope.propertyId,
            row.hotel_slug,
            row.operation,
            row.idempotency_key
          ]
        );
        if (existing.rows.length !== 1) {
          throw new PaymentIntegrityError(
            "PAYMENT_INTENT_IDEMPOTENCY_CONFLICT",
            "The existing payment request could not be resolved safely",
            409
          );
        }
        const intent = existing.rows[0].payload;
        if (intent.request_digest !== row.request_digest) {
          throw new PaymentIntegrityError(
            "IDEMPOTENCY_KEY_REUSED",
            "Idempotency-Key was already used for a different payment request",
            409
          );
        }
        return { intent, reused: true };
      }
    );
  }

  async claimProviderCreation(id) {
    const { data, error } = await this.db.rpc("claim_payment_intent_provider_creation", { p_intent_id: id });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  async attachProviderOrder(id, providerOrderId, businessOrderId = null) {
    const { data, error } = await this.db.rpc("attach_payment_intent_provider_order", {
      p_intent_id: id, p_provider_order_id: providerOrderId, p_business_order_id: businessOrderId
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  async markReconciliationRequired(id, errorCode, errorMessage) {
    const { data, error } = await this.db.from("payment_intents").update({
      status: "PENDING", requires_reconciliation: true,
      last_error_code: String(errorCode || "PROVIDER_OUTCOME_UNKNOWN").slice(0, 100),
      last_error_message: String(errorMessage || "Provider outcome requires reconciliation").slice(0, 500),
      updated_at: new Date().toISOString()
    }).eq("id", id).neq("status", "PAID").select("*").maybeSingle();
    if (error) throw error;
    return data;
  }

  async findForVerification({ intentId = "", hotelSlug = "", businessOrderId = "", providerOrderId = "" }) {
    let query = this.db.from("payment_intents").select("*");
    if (intentId) query = query.eq("id", intentId);
    else query = query.eq("provider_order_id", providerOrderId);
    if (hotelSlug) query = query.eq("hotel_slug", hotelSlug);
    if (businessOrderId) query = query.eq("business_order_id", businessOrderId);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async finalizeCaptured(intent, evidence, source, evidenceDigest) {
    const { data, error } = await this.db.rpc("finalize_captured_payment", {
      p_intent_id: intent.id, p_provider: evidence.provider, p_merchant_ref: evidence.merchantRef,
      p_provider_order_id: evidence.providerOrderId, p_provider_payment_id: evidence.providerPaymentId,
      p_amount_minor: evidence.amountMinor, p_currency: evidence.currency,
      p_provider_status: evidence.status, p_evidence_source: source, p_evidence_digest: evidenceDigest
    });
    if (error) throw error;
    return data;
  }

  async recordRejectedAttempt(intent, evidence, source, evidenceDigest, rejectionCode) {
    const { error } = await this.db.from("payment_attempts").insert([{
      payment_intent_id: intent.id,
      provider: String(evidence?.provider || intent.provider || ""),
      merchant_ref: String(evidence?.merchantRef || intent.merchant_ref || ""),
      credential_ref: String(evidence?.credentialRef || intent.credential_ref || ""),
      provider_order_id: String(evidence?.providerOrderId || "") || null,
      provider_payment_id: String(evidence?.providerPaymentId || "") || null,
      provider_status: String(evidence?.status || "") || null,
      amount_minor: Number.isSafeInteger(Number(evidence?.amountMinor)) ? Number(evidence.amountMinor) : null,
      currency: String(evidence?.currency || "").toUpperCase() || null,
      evidence_source: source,
      evidence_digest: evidenceDigest,
      accepted: false,
      rejection_code: String(rejectionCode || "PAYMENT_EVIDENCE_REJECTED").slice(0, 100)
    }]);
    if (error && String(error.code) !== "23505") throw error;
  }

  async applyNonFinalState(intent, providerStatus, providerPaymentId = null) {
    const status = String(providerStatus || "").toLowerCase() === "authorized" ? "AUTHORIZED" : "FAILED";
    const query = this.db.from("payment_intents").update({
      status, provider_status: String(providerStatus || "").toLowerCase(),
      ...(providerPaymentId ? { provider_payment_id: providerPaymentId } : {}),
      updated_at: new Date().toISOString()
    }).eq("id", intent.id).in("status", ["CREATED", "PENDING", "AUTHORIZED"]);
    const { data, error } = await query.select("*").maybeSingle();
    if (error) throw error;
    return data || intent;
  }
}

module.exports = { PaymentIntentStore, isMissingTask2ASchema };
