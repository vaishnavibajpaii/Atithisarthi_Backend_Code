"use strict";

require("dotenv").config({ quiet: true });

const { normalizeBaseUrl } = require("./verify-tenant-public-hotel-live");

const EXPECTED_LIVE_CONFIRMATION = "TASK6_CHECKOUT_TEST_WRITES_CONFIRMED";
const EXPECTED_REPLAY_CONFIRMATION = "TASK6_EXISTING_COMMIT_REPLAY_CONFIRMED";
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let requestContext = null;

function fail(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function readInputs() {
  if (process.env.TASK6_CHECKOUT_LIVE_CONFIRM !== EXPECTED_LIVE_CONFIRMATION) {
    fail("TASK6_CHECKOUT_LIVE_CONFIRMATION_MISSING", "The existing TEST checkout confirmation is required");
  }
  if (process.env.TASK6_CHECKOUT_REPLAY_CONFIRM !== EXPECTED_REPLAY_CONFIRMATION) {
    fail("TASK6_CHECKOUT_REPLAY_CONFIRMATION_MISSING", `Set TASK6_CHECKOUT_REPLAY_CONFIRM=${EXPECTED_REPLAY_CONFIRMATION}`);
  }
  if (String(process.env.TASK6_CHECKOUT_LIVE_ENV || "").trim().toUpperCase() !== "TEST") {
    fail("TASK6_CHECKOUT_LIVE_ENV_INVALID", "TASK6_CHECKOUT_LIVE_ENV must be TEST");
  }

  const baseUrl = normalizeBaseUrl(process.env.TASK6_CHECKOUT_LIVE_BASE_URL);
  const token = String(process.env.TASK6_CHECKOUT_TEST_BEARER_TOKEN || "").trim();
  const bookingId = String(process.env.TASK6_CHECKOUT_TEST_BOOKING_ID || "").trim();
  const idempotencyKey = String(process.env.TASK6_CHECKOUT_TEST_REPLAY_IDEMPOTENCY_KEY || "").trim();
  const amount = Number(process.env.TASK6_CHECKOUT_TEST_REPLAY_AMOUNT);

  if (!token) fail("TASK6_CHECKOUT_TEST_TOKEN_MISSING", "The current TEST manager bearer token is required");
  if (!/^\d+$/.test(bookingId) || BigInt(bookingId) <= 0n) {
    fail("TASK6_CHECKOUT_TEST_BOOKING_INVALID", "TASK6_CHECKOUT_TEST_BOOKING_ID must be a positive integer");
  }
  const runId = idempotencyKey.startsWith("task6-checkout-")
    ? idempotencyKey.slice("task6-checkout-".length)
    : "";
  if (!RUN_ID_PATTERN.test(runId)) {
    fail("TASK6_CHECKOUT_REPLAY_KEY_INVALID", "Use the existing task6-checkout-<run-id> key from the failed run");
  }
  if (!Number.isFinite(amount) || amount <= 0 || amount > 99999999.99 || Math.round(amount * 100) !== amount * 100) {
    fail("TASK6_CHECKOUT_REPLAY_AMOUNT_INVALID", "Replay amount must be the exact positive amount recorded for the existing TEST receipt");
  }

  return { baseUrl, token, bookingId, idempotencyKey, runId, amount };
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {
      ...options,
      redirect: "error",
      signal: controller.signal
    });
    let body;
    try {
      body = await response.json();
    } catch {
      fail("TASK6_CHECKOUT_RESPONSE_NOT_JSON", "The TEST backend did not return JSON");
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

function authHeaders(token, idempotencyKey = null) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {})
  };
}

function safeResponse(response) {
  return {
    status: response?.status || 0,
    success: response?.body?.success === true,
    code: response?.body?.code || null,
    atomicFinalizer: response?.body?.atomicFinalizer === true,
    idempotentReplay: response?.body?.idempotentReplay === true,
    bookingId: String(response?.body?.booking?.id || "") || null,
    receiptId: String(response?.body?.receipt?.id || "") || null,
    invoiceNumber: String(response?.body?.checkoutBill?.invoiceNumber || "") || null
  };
}

async function getReadiness(baseUrl) {
  const response = await requestJson(`${baseUrl}/api/readiness`);
  if (response.status !== 200 || response.body?.ready !== true) {
    fail("TASK6_CHECKOUT_BACKEND_NOT_READY", "The TEST backend readiness check failed");
  }
  if (String(response.body?.env || "").trim().toLowerCase() === "production") {
    fail("TASK6_CHECKOUT_LIVE_ENV_PRODUCTION", "This TEST-only replay probe refuses a production backend");
  }
  const finalizer = Array.isArray(response.body?.checks)
    ? response.body.checks.find((check) => check?.name === "task6_room_checkout_finalizer")
    : null;
  if (!finalizer || finalizer.ready !== true || finalizer.enabled !== true) {
    fail("TASK6_CHECKOUT_FINALIZER_NOT_ENABLED", "The TEST backend does not report the atomic checkout finalizer as enabled");
  }
}

async function getClosedCheckoutSummary({ baseUrl, token, bookingId }) {
  const response = await requestJson(
    `${baseUrl}/api/staff/room-booking/bookings/${encodeURIComponent(bookingId)}/checkout-summary`,
    { headers: authHeaders(token) }
  );
  if (response.status !== 200 || response.body?.success !== true) {
    fail("TASK6_CHECKOUT_SUMMARY_FAILED", "Could not read the existing TEST checkout summary", {
      status: response.status,
      code: response.body?.code || null
    });
  }
  const summary = response.body?.summary;
  if (
    summary?.booking?.bookingStatus !== "checked_out" ||
    summary?.booking?.paymentStatus !== "paid" ||
    Number(summary?.totals?.finalPayableAmount) !== 0
  ) {
    fail("TASK6_CHECKOUT_REPLAY_NOT_CLOSED", "Replay-only mode requires the already-paid, checked-out TEST booking");
  }
}

async function postReplay({ baseUrl, token, bookingId, idempotencyKey, payload }) {
  return requestJson(
    `${baseUrl}/api/staff/room-booking/bookings/${encodeURIComponent(bookingId)}/combined-checkout`,
    {
      method: "POST",
      headers: authHeaders(token, idempotencyKey),
      body: JSON.stringify(payload)
    }
  );
}

async function main() {
  const inputs = readInputs();
  const notes = `TASK6 synthetic checkout TEST ${inputs.runId}`;
  const payload = {
    amount: inputs.amount,
    paymentMethod: "cash",
    transactionId: `TASK6TEST-${inputs.runId}`,
    notes,
    idempotencyKey: inputs.idempotencyKey,
    currency: "INR"
  };

  await getReadiness(inputs.baseUrl);
  await getClosedCheckoutSummary(inputs);
  requestContext = {
    bookingId: inputs.bookingId,
    idempotencyKey: inputs.idempotencyKey,
    notes
  };

  const concurrent = await Promise.all([
    postReplay({ ...inputs, payload }),
    postReplay({ ...inputs, payload })
  ]);
  const safeConcurrent = concurrent.map(safeResponse);
  const receiptIds = new Set(safeConcurrent.map((result) => result.receiptId));
  const invoiceNumbers = new Set(safeConcurrent.map((result) => result.invoiceNumber));
  if (
    safeConcurrent.some((result) =>
      result.status !== 200 || !result.success || !result.atomicFinalizer ||
      !result.idempotentReplay || result.bookingId !== inputs.bookingId || !result.receiptId || !result.invoiceNumber
    ) || receiptIds.size !== 1 || invoiceNumbers.size !== 1
  ) {
    fail("TASK6_CHECKOUT_EXISTING_REPLAY_FAILED", "Concurrent retries did not return the one existing checkout receipt", safeConcurrent);
  }

  const replayResponse = await postReplay({ ...inputs, payload });
  const replay = safeResponse(replayResponse);
  if (
    replayResponse.status !== 200 || !replay.success || !replay.atomicFinalizer ||
    !replay.idempotentReplay || replay.receiptId !== safeConcurrent[0].receiptId ||
    replay.invoiceNumber !== safeConcurrent[0].invoiceNumber
  ) {
    fail("TASK6_CHECKOUT_EXISTING_REPLAY_FAILED", "The exact existing checkout retry did not return its original receipt", replay);
  }

  const changedDigestResponse = await postReplay({
    ...inputs,
    payload: { ...payload, notes: `${notes} changed` }
  });
  const changedDigest = safeResponse(changedDigestResponse);
  if (changedDigestResponse.status !== 409 || changedDigest.code !== "checkout_idempotency_conflict") {
    fail("TASK6_CHECKOUT_CHANGED_DIGEST_FAILED", "Reusing the existing key with changed details was not rejected", changedDigest);
  }

  console.log(JSON.stringify({
    success: true,
    result: "PASS",
    bookingId: inputs.bookingId,
    existingReceiptId: replay.receiptId,
    invoiceNumber: replay.invoiceNumber,
    concurrentExistingReplays: safeConcurrent,
    replay,
    changedDigest,
    evidence: "The original TEST receipt, final folio, payment evidence, and audit remain preserved; no new payment provider call was made."
  }, null, 2));
}

main().catch((error) => {
  console.log(JSON.stringify({
    success: false,
    result: "FAIL",
    code: error.code || "TASK6_CHECKOUT_REPLAY_FAILED",
    message: error.message || "Task 6 existing checkout replay verification failed",
    details: error.details,
    existingEvidence: requestContext
      ? {
          bookingId: requestContext.bookingId,
          idempotencyKey: requestContext.idempotencyKey,
          marker: requestContext.notes,
          action: "Preserve the existing TEST financial evidence; do not run the fresh-checkout probe"
        }
      : null
  }, null, 2));
  process.exitCode = 1;
});
