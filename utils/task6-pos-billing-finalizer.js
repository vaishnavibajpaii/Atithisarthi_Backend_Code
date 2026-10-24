"use strict";

const crypto = require("crypto");
const {
  buildTask6FoodBillFinalizationCandidates
} = require("./food-order-bill");

const TASK6_POS_BILLING_RPC_NAME = "task6_finalize_order_family";
const TASK6_POS_BILLING_SCOPES = Object.freeze({
  SINGLE: "single_bill",
  FAMILY: "family_bill"
});
const SCHEMA_ERROR_CODES = new Set([
  "42P01", "42703", "42883", "PGRST202", "PGRST204", "PGRST205"
]);

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableJson(value[key]);
    return result;
  }, {});
}

function normalizeText(value, label, maxLength) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  if (normalized.length > maxLength) throw new TypeError(`${label} is too long`);
  return normalized;
}

function normalizeOptionalText(value, maxLength) {
  const normalized = String(value || "").trim();
  if (normalized.length > maxLength) throw new TypeError("Optional billing value is too long");
  return normalized || null;
}

function normalizeOrderId(value) {
  const normalized = String(value || "").trim();
  if (!/^\d+$/.test(normalized)) throw new TypeError("Order id must be a positive integer");
  const parsed = BigInt(normalized);
  if (parsed <= 0n || parsed > 9223372036854775807n) {
    throw new TypeError("Order id must be a positive integer");
  }
  return parsed.toString();
}

function normalizeScope(value) {
  const scope = String(value || "").trim().toLowerCase();
  if (!Object.values(TASK6_POS_BILLING_SCOPES).includes(scope)) {
    throw new TypeError("Billing finalization scope is invalid");
  }
  return scope;
}

function normalizeIdempotencyKey(value) {
  const key = normalizeText(value, "Idempotency key", 200);
  if (key.length < 8 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(key)) {
    throw new TypeError("Idempotency key is invalid");
  }
  return key;
}

function buildTask6PosBillingRequestFingerprint({ hotelSlug, orderId, finalizeScope } = {}) {
  return crypto.createHash("sha256").update(JSON.stringify(stableJson({
    operation: TASK6_POS_BILLING_RPC_NAME,
    hotelSlug: normalizeText(hotelSlug, "Hotel scope", 120),
    orderId: normalizeOrderId(orderId),
    finalizeScope: normalizeScope(finalizeScope)
  }))).digest("hex");
}

function normalizeTask6PosBillingRpcData(value) {
  let data = Array.isArray(value) ? (value.length === 1 ? value[0] : null) : value;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { return null; }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (Object.prototype.hasOwnProperty.call(data, TASK6_POS_BILLING_RPC_NAME)) {
    data = data[TASK6_POS_BILLING_RPC_NAME];
  } else {
    const keys = Object.keys(data);
    if (keys.length === 1) data = data[keys[0]];
  }
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { return null; }
  }
  return data && typeof data === "object" && !Array.isArray(data) ? data : null;
}

function getTask6PosBillingErrorText(error = {}) {
  return `${error.message || ""} ${error.details || ""} ${error.hint || ""}`
    .trim()
    .toUpperCase();
}

function getSafeTask6PosBillingDatabaseDiagnostic(error = {}) {
  return {
    databaseCode: String(error.code || "").trim().slice(0, 40) || null,
    databaseMessage: String(error.message || "").trim().slice(0, 320) || null
  };
}

function mapTask6PosBillingFinalizerError(error = {}) {
  const code = String(error.code || "").trim().toUpperCase();
  const marker = getTask6PosBillingErrorText(error);
  if (SCHEMA_ERROR_CODES.has(code) || marker.includes("TASK6_FINALIZE_ORDER_FAMILY")) {
    return { ok: false, status: 503, code: "pos_billing_schema_unavailable", message: "Atomic POS billing is not available yet" };
  }
  if (code === "P0002") {
    return { ok: false, status: 404, code: "order_not_found", message: "Order was not found for this hotel" };
  }
  if (marker.includes("TASK6_ORDER_BILL_IDEMPOTENCY_CONFLICT")) {
    return { ok: false, status: 409, code: "ORDER_BILLING_IDEMPOTENCY_CONFLICT", message: "This billing request key was already used for different details" };
  }
  if (marker.includes("TASK6_ORDER_BILL_FAMILY_FINALIZATION_REQUIRED")) {
    return { ok: false, status: 409, code: "ORDER_FAMILY_BILLING_REQUIRED", message: "Linked table orders must be billed together" };
  }
  if (marker.includes("TASK6_ORDER_BILL_FINANCIAL_SNAPSHOT_NOT_FINALIZABLE")) {
    return { ok: false, status: 409, code: "ORDER_BILLING_SNAPSHOT_UNAVAILABLE", message: "This order has no Task 6 financial snapshot and needs manual review" };
  }
  if (marker.includes("TASK6_ORDER_BILL_")) {
    return { ok: false, status: 409, code: "order_billing_state_conflict", message: "Order state or authoritative bill snapshot changed. Reload and try again." };
  }
  if (code === "42501") {
    return { ok: false, status: 403, code: "order_billing_scope_denied", message: "Billing is not available for this hotel or order" };
  }
  if (code === "22023" || code === "23505" || code === "23514") {
    return { ok: false, status: 409, code: "order_billing_state_conflict", message: "Order state or authoritative bill snapshot changed. Reload and try again." };
  }
  return { ok: false, status: 500, code: "order_billing_failed", message: "Atomic order billing failed" };
}

async function finalizeTask6PosBilling({
  sourceClient,
  databaseClient,
  hotelSlug,
  orderId,
  finalizeScope,
  idempotencyKey,
  actorUserId = null,
  actorRole = null,
  actorDisplayName = null
} = {}) {
  if (!databaseClient || typeof databaseClient.rpc !== "function") {
    throw new TypeError("Tenant mutation client with rpc() is required");
  }
  const normalizedHotelSlug = normalizeText(hotelSlug, "Hotel scope", 120);
  const normalizedOrderId = normalizeOrderId(orderId);
  const normalizedScope = normalizeScope(finalizeScope);
  const normalizedKey = normalizeIdempotencyKey(idempotencyKey);
  const normalizedActorId = normalizeOptionalText(actorUserId, 200);
  const normalizedActorRole = normalizeOptionalText(actorRole, 80);
  const issuedAt = new Date().toISOString();
  const requestFingerprint = buildTask6PosBillingRequestFingerprint({
    hotelSlug: normalizedHotelSlug,
    orderId: normalizedOrderId,
    finalizeScope: normalizedScope
  });
  const candidateSet = await buildTask6FoodBillFinalizationCandidates({
    supabaseClient: sourceClient,
    hotelSlug: normalizedHotelSlug,
    orderId: normalizedOrderId,
    finalizeScope: normalizedScope,
    actor: { id: normalizedActorId, role: normalizedActorRole, displayName: actorDisplayName || "" },
    issuedAt
  });
  if (!candidateSet) {
    return { ok: false, status: 404, code: "order_not_found", message: "Order was not found for this hotel" };
  }

  const { data: rawData, error } = await databaseClient.rpc(TASK6_POS_BILLING_RPC_NAME, {
    p_hotel_slug: normalizedHotelSlug,
    p_order_id: normalizedOrderId,
    p_finalize_scope: normalizedScope,
    p_idempotency_key: normalizedKey,
    p_request_fingerprint: requestFingerprint,
    p_issued_at: issuedAt,
    p_actor_id: normalizedActorId,
    p_actor_role: normalizedActorRole,
    // node-postgres serializes a JavaScript Array as a PostgreSQL array literal.
    // This RPC parameter is jsonb, so send canonical JSON text explicitly.
    p_snapshots: JSON.stringify(candidateSet.candidates)
  });
  if (error) {
    return {
      ...mapTask6PosBillingFinalizerError(error),
      diagnostic: getSafeTask6PosBillingDatabaseDiagnostic(error)
    };
  }

  const data = normalizeTask6PosBillingRpcData(rawData);
  if (!data || !Array.isArray(data.orders) || !Array.isArray(data.snapshots) || data.orders.length !== data.snapshots.length || !data.orders.length) {
    return { ok: false, status: 502, code: "pos_billing_response_invalid", message: "Atomic POS billing returned an invalid response" };
  }
  return {
    ok: true,
    status: 200,
    atomicFinalizer: true,
    idempotentReplay: data.idempotentReplay === true,
    orders: data.orders,
    snapshots: data.snapshots
  };
}

module.exports = {
  TASK6_POS_BILLING_RPC_NAME,
  TASK6_POS_BILLING_SCOPES,
  buildTask6PosBillingRequestFingerprint,
  finalizeTask6PosBilling,
  getSafeTask6PosBillingDatabaseDiagnostic,
  mapTask6PosBillingFinalizerError,
  normalizeTask6PosBillingRpcData
};
