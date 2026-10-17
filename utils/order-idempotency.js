"use strict";

const crypto = require("crypto");

const ORDER_CREATION_SCOPES = Object.freeze({
  PUBLIC: "public_order_create",
  STAFF_TABLE: "staff_table_order_create",
  STAFF_ROOM_SERVICE: "staff_room_service_order_create",
  PUBLIC_ADDON: "public_order_addon_create"
});

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableJson(value[key]);
    return result;
  }, {});
}

function buildOrderCreationRequestFingerprint({ operationScope, request } = {}) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableJson({
      operationScope: String(operationScope || "").trim(),
      request: request && typeof request === "object" && !Array.isArray(request) ? request : {}
    })))
    .digest("hex");
}

function getOrderIdempotencyKey(req = {}, bodyKey = "") {
  const raw = String(
    req.get?.("Idempotency-Key") ||
    req.headers?.["idempotency-key"] ||
    bodyKey ||
    ""
  ).trim();

  if (!raw) {
    return { key: null, error: "Idempotency-Key is required" };
  }
  if (raw.length < 8 || raw.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(raw)) {
    return { key: null, error: "Idempotency-Key must be 8 to 200 safe characters" };
  }
  return { key: raw, error: null };
}

function normalizeTask6OrderAtomicResult(value) {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") return null;
  const wrapped = row.task6_create_order_atomic;
  return wrapped && typeof wrapped === "object" ? wrapped : row;
}

function getTask6OrderErrorText(error) {
  return `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toUpperCase();
}

function isMissingTask6OrderAtomicRpc(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  return ["42883", "PGRST202"].includes(code) ||
    getTask6OrderErrorText(error).includes("TASK6_CREATE_ORDER_ATOMIC");
}

function isTask6OrderIdempotencyConflict(error) {
  return getTask6OrderErrorText(error).includes("TASK6_ORDER_IDEMPOTENCY_CONFLICT");
}

function isTask6OrderSnapshotInvalid(error) {
  return getTask6OrderErrorText(error).includes("TASK6_ORDER_FINANCIAL_SNAPSHOT_INVALID");
}

async function executeTask6OrderAtomic({
  databaseClient,
  operationScope,
  idempotencyKey,
  requestFingerprint,
  order
}) {
  const { data, error } = await databaseClient.rpc("task6_create_order_atomic", {
    p_operation_scope: operationScope,
    p_idempotency_key: idempotencyKey,
    p_request_fingerprint: requestFingerprint,
    p_order: order
  });

  return {
    data: error ? null : normalizeTask6OrderAtomicResult(data),
    error
  };
}

module.exports = {
  ORDER_CREATION_SCOPES,
  buildOrderCreationRequestFingerprint,
  executeTask6OrderAtomic,
  getOrderIdempotencyKey,
  isMissingTask6OrderAtomicRpc,
  isTask6OrderIdempotencyConflict,
  isTask6OrderSnapshotInvalid,
  normalizeTask6OrderAtomicResult,
  stableJson
};
