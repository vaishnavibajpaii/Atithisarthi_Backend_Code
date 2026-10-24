"use strict";

require("dotenv").config({ quiet: true });

const {
  normalizeBaseUrl
} = require("./verify-tenant-public-hotel-live");

const EXPECTED_CONFIRMATION = "TASK6_POS_BILLING_EXISTING_REPLAY_CONFIRMED";

function fail(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function normalizePositiveOrderId(value) {
  const normalized = String(value || "").trim();
  if (!/^\d+$/.test(normalized) || BigInt(normalized) <= 0n) {
    fail("TASK6_POS_BILLING_REPLAY_ORDER_INVALID", "TASK6_POS_BILLING_REPLAY_ORDER_ID must be a positive integer");
  }
  return normalized;
}

function normalizeIdempotencyKey(value) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(normalized)) {
    fail("TASK6_POS_BILLING_REPLAY_KEY_INVALID", "TASK6_POS_BILLING_REPLAY_IDEMPOTENCY_KEY is invalid");
  }
  return normalized;
}

function normalizeBearerToken(value) {
  const token = String(value || "").trim().replace(/^Bearer\s+/i, "");
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || token.length < 100) {
    fail("TASK6_POS_BILLING_TEST_TOKEN_MISSING", "The current TEST manager bearer token is required");
  }
  return token;
}

function readInputs() {
  if (process.env.TASK6_POS_BILLING_REPLAY_CONFIRM !== EXPECTED_CONFIRMATION) {
    fail(
      "TASK6_POS_BILLING_REPLAY_CONFIRMATION_MISSING",
      `Set TASK6_POS_BILLING_REPLAY_CONFIRM=${EXPECTED_CONFIRMATION}; this probe retries one explicitly selected synthetic TEST bill request`
    );
  }
  if (String(process.env.TASK6_POS_BILLING_LIVE_ENV || "").trim().toUpperCase() !== "TEST") {
    fail("TASK6_POS_BILLING_LIVE_ENV_INVALID", "TASK6_POS_BILLING_LIVE_ENV must be TEST");
  }
  return {
    baseUrl: normalizeBaseUrl(
      process.env.TASK6_POS_BILLING_LIVE_BASE_URL || process.env.APP_BACKEND_BASE_URL
    ),
    bearerToken: normalizeBearerToken(process.env.TASK6_POS_BILLING_TEST_BEARER_TOKEN),
    orderId: normalizePositiveOrderId(process.env.TASK6_POS_BILLING_REPLAY_ORDER_ID),
    idempotencyKey: normalizeIdempotencyKey(process.env.TASK6_POS_BILLING_REPLAY_IDEMPOTENCY_KEY)
  };
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { ...options, redirect: "error", signal: controller.signal });
    let body = null;
    try {
      body = await response.json();
    } catch {
      fail("TASK6_POS_BILLING_RESPONSE_NOT_JSON", "The TEST backend did not return JSON");
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

function getReadinessCheck(body, name) {
  return Array.isArray(body?.checks)
    ? body.checks.find((check) => check?.name === name) || null
    : null;
}

async function requireEnabledFinalizer(baseUrl) {
  const readiness = await requestJson(`${baseUrl}/api/readiness`);
  const billingFinalizer = getReadinessCheck(readiness.body, "task6_pos_billing_finalizer");
  if (
    readiness.status !== 200 ||
    readiness.body?.success !== true ||
    billingFinalizer?.ready !== true ||
    billingFinalizer?.enabled !== true
  ) {
    fail("TASK6_POS_BILLING_FINALIZER_NOT_ENABLED", "The TEST POS billing finalizer must be enabled before this replay probe", billingFinalizer || null);
  }
}

async function finalizeBill(inputs, endpoint = "mark-billed") {
  return requestJson(
    `${inputs.baseUrl}/api/staff/orders/${encodeURIComponent(inputs.orderId)}/${endpoint}`,
    {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${inputs.bearerToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": inputs.idempotencyKey
      },
      body: "{}"
    }
  );
}

function finalOrder(response) {
  return response?.body?.order && typeof response.body.order === "object"
    ? response.body.order
    : null;
}

function safeResponse(response) {
  const order = finalOrder(response);
  return {
    status: response?.status || 0,
    success: response?.body?.success === true,
    code: response?.body?.code || null,
    message: String(response?.body?.message || "").slice(0, 240) || null,
    atomicFinalizer: response?.body?.atomicFinalizer === true,
    idempotentReplay: response?.body?.idempotentReplay === true,
    orderId: order?.id ? String(order.id) : null,
    billingStatus: order?.billingStatus || null,
    paymentStatus: order?.paymentStatus || null,
    invoiceNumber: order?.billNumber || null,
    foodBillSnapshotsReady: Number(response?.body?.foodBillSnapshotsReady || 0)
  };
}

function isAtomicBill(response, orderId) {
  const order = finalOrder(response);
  return [200, 201].includes(response?.status) &&
    response?.body?.success === true &&
    response?.body?.atomicFinalizer === true &&
    String(order?.id || "") === String(orderId) &&
    String(order?.billingStatus || "").toLowerCase() === "billed" &&
    String(order?.paymentStatus || "").toLowerCase() === "unpaid" &&
    String(order?.billNumber || "").trim().length > 0 &&
    Number(response?.body?.foodBillSnapshotsReady) === 1;
}

async function main() {
  const inputs = readInputs();
  await requireEnabledFinalizer(inputs.baseUrl);

  const concurrent = await Promise.all([finalizeBill(inputs), finalizeBill(inputs)]);
  if (!concurrent.every((response) => isAtomicBill(response, inputs.orderId))) {
    fail(
      "TASK6_POS_BILLING_EXISTING_REPLAY_FAILED",
      "Concurrent retries did not converge to one immutable TEST bill",
      concurrent.map(safeResponse)
    );
  }

  const invoices = new Set(concurrent.map((response) => finalOrder(response)?.billNumber));
  const created = concurrent.filter((response) => response.status === 201 && response.body?.idempotentReplay === false);
  const replayed = concurrent.filter((response) => response.status === 200 && response.body?.idempotentReplay === true);
  if (invoices.size !== 1 || created.length !== 1 || replayed.length !== 1) {
    fail(
      "TASK6_POS_BILLING_EXISTING_REPLAY_CONTRACT_FAILED",
      "Expected one atomic finalization and one idempotent replay for the selected TEST order",
      concurrent.map(safeResponse)
    );
  }

  const replay = await finalizeBill(inputs);
  if (!isAtomicBill(replay, inputs.orderId) || replay.status !== 200 || replay.body?.idempotentReplay !== true) {
    fail("TASK6_POS_BILLING_EXISTING_REPLAY_FAILED", "A later retry did not return the original immutable TEST bill", safeResponse(replay));
  }

  const changedDigest = await finalizeBill(inputs, "mark-family-billed");
  if (changedDigest.status !== 409 || changedDigest.body?.code !== "ORDER_BILLING_IDEMPOTENCY_CONFLICT") {
    fail("TASK6_POS_BILLING_DIGEST_CONFLICT_FAILED", "Changed billing scope was not rejected for the existing request key", safeResponse(changedDigest));
  }

  process.stdout.write(`${JSON.stringify({
    success: true,
    result: "PASS",
    orderId: inputs.orderId,
    concurrent: concurrent.map(safeResponse),
    replay: safeResponse(replay),
    changedDigest: safeResponse(changedDigest),
    evidence: "The selected synthetic TEST bill, snapshot, and audit evidence remain preserved. No payment provider call was made."
  }, null, 2)}\n`);
}

function safeFailure(error, inputs = {}) {
  return {
    success: false,
    result: "FAIL",
    code: String(error?.code || "TASK6_POS_BILLING_EXISTING_REPLAY_FAILED"),
    message: String(error?.message || "Task 6 existing bill replay verification failed"),
    details: error?.details,
    existingEvidence: inputs.orderId
      ? {
          orderId: inputs.orderId,
          idempotencyKey: inputs.idempotencyKey || null,
          action: "Preserve the selected TEST order and all bill evidence. Do not create another synthetic order or retry with a different key."
        }
      : null
  };
}

if (require.main === module) {
  let inputs = {};
  try {
    inputs = readInputs();
    main().catch((error) => {
      process.stderr.write(`${JSON.stringify(safeFailure(error, inputs), null, 2)}\n`);
      process.exitCode = 1;
    });
  } catch (error) {
    process.stderr.write(`${JSON.stringify(safeFailure(error, inputs), null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  isAtomicBill,
  safeResponse
};
