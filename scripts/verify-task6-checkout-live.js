"use strict";

require("dotenv").config({ quiet: true });

const crypto = require("node:crypto");
const { normalizeBaseUrl } = require("./verify-tenant-public-hotel-live");

const EXPECTED_CONFIRMATION = "TASK6_CHECKOUT_TEST_WRITES_CONFIRMED";
let runContext = null;

function fail(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function readInputs() {
  if (process.env.TASK6_CHECKOUT_LIVE_CONFIRM !== EXPECTED_CONFIRMATION) {
    fail(
      "TASK6_CHECKOUT_LIVE_CONFIRMATION_MISSING",
      `Set TASK6_CHECKOUT_LIVE_CONFIRM=${EXPECTED_CONFIRMATION}; this probe finalizes one explicitly selected synthetic TEST stay and preserves its receipt`
    );
  }
  if (String(process.env.TASK6_CHECKOUT_LIVE_ENV || "").trim().toUpperCase() !== "TEST") {
    fail("TASK6_CHECKOUT_LIVE_ENV_INVALID", "TASK6_CHECKOUT_LIVE_ENV must be TEST");
  }

  const baseUrl = normalizeBaseUrl(
    process.env.TASK6_CHECKOUT_LIVE_BASE_URL || process.env.APP_BACKEND_BASE_URL
  );
  const token = String(process.env.TASK6_CHECKOUT_TEST_BEARER_TOKEN || "").trim();
  const bookingId = String(process.env.TASK6_CHECKOUT_TEST_BOOKING_ID || "").trim();
  if (!token) fail("TASK6_CHECKOUT_TEST_TOKEN_MISSING", "Set the TEST manager bearer token in TASK6_CHECKOUT_TEST_BEARER_TOKEN");
  if (!/^\d+$/.test(bookingId) || BigInt(bookingId) <= 0n) {
    fail("TASK6_CHECKOUT_TEST_BOOKING_INVALID", "TASK6_CHECKOUT_TEST_BOOKING_ID must be a positive integer");
  }

  return { baseUrl, token, bookingId };
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

function authHeaders(token, idempotencyKey = null) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {})
  };
}

async function getReadiness(baseUrl) {
  const response = await requestJson(`${baseUrl}/api/readiness`);
  if (response.status !== 200 || response.body?.ready !== true) {
    fail("TASK6_CHECKOUT_BACKEND_NOT_READY", "The TEST backend readiness check failed", {
      status: response.status,
      ready: response.body?.ready === true
    });
  }
  if (String(response.body?.env || "").trim().toLowerCase() === "production") {
    fail("TASK6_CHECKOUT_LIVE_ENV_PRODUCTION", "This TEST-only probe refuses a production backend");
  }
  const flag = Array.isArray(response.body?.checks)
    ? response.body.checks.find((check) => check?.name === "task6_room_checkout_finalizer")
    : null;
  if (!flag || flag.ready !== true || flag.enabled !== true) {
    fail(
      "TASK6_CHECKOUT_FINALIZER_NOT_ENABLED",
      "The deployed TEST backend does not report the Task 6 atomic checkout finalizer as enabled"
    );
  }
  return response;
}

async function getCheckoutSummary({ baseUrl, token, bookingId }) {
  const response = await requestJson(
    `${baseUrl}/api/staff/room-booking/bookings/${encodeURIComponent(bookingId)}/checkout-summary`,
    { headers: authHeaders(token) }
  );
  if (response.status !== 200 || response.body?.success !== true) {
    fail("TASK6_CHECKOUT_SUMMARY_FAILED", "Could not read the selected TEST checkout summary", {
      status: response.status,
      code: response.body?.code || null
    });
  }
  if (response.body?.summary?.booking?.bookingStatus !== "checked_in") {
    fail("TASK6_CHECKOUT_BOOKING_NOT_CHECKED_IN", "The selected synthetic TEST stay must be checked in before this probe writes");
  }
  const payable = Number(response.body?.summary?.totals?.finalPayableAmount);
  if (!Number.isFinite(payable) || payable <= 0) {
    fail("TASK6_CHECKOUT_TEST_AMOUNT_INVALID", "Use a synthetic checked-in TEST stay with a positive remaining balance");
  }
  const amountCents = Math.round(payable * 100);
  if (Math.abs(payable - amountCents / 100) > 0.0000001) {
    fail("TASK6_CHECKOUT_TEST_AMOUNT_INVALID", "The checkout summary payable is not a valid two-decimal amount");
  }
  return amountCents / 100;
}

async function postCheckout({ baseUrl, token, bookingId, idempotencyKey, payload }) {
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
  const runId = crypto.randomUUID();
  const idempotencyKey = `task6-checkout-${runId}`;
  const notes = `TASK6 synthetic checkout TEST ${runId}`;
  runContext = { bookingId: inputs.bookingId, idempotencyKey, notes };

  await getReadiness(inputs.baseUrl);
  const amount = await getCheckoutSummary(inputs);
  const payload = {
    amount,
    paymentMethod: "cash",
    transactionId: `TASK6TEST-${runId}`,
    notes,
    idempotencyKey,
    currency: "INR"
  };

  const concurrent = await Promise.all([
    postCheckout({ ...inputs, idempotencyKey, payload }),
    postCheckout({ ...inputs, idempotencyKey, payload })
  ]);
  const safeConcurrent = concurrent.map(safeResponse);
  const statuses = safeConcurrent.map((result) => result.status).sort((left, right) => left - right);
  const receiptIds = new Set(safeConcurrent.map((result) => result.receiptId));
  const bookingIds = new Set(safeConcurrent.map((result) => result.bookingId));
  if (
    statuses[0] !== 200 || statuses[1] !== 201 ||
    safeConcurrent.some((result) => !result.success || !result.atomicFinalizer) ||
    safeConcurrent.filter((result) => result.idempotentReplay).length !== 1 ||
    receiptIds.size !== 1 || receiptIds.has(null) ||
    bookingIds.size !== 1 || !bookingIds.has(inputs.bookingId)
  ) {
    fail("TASK6_CHECKOUT_CONCURRENT_REPLAY_FAILED", "Concurrent duplicate checkouts did not converge to one atomic receipt", safeConcurrent);
  }

  const replayResponse = await postCheckout({ ...inputs, idempotencyKey, payload });
  const replay = safeResponse(replayResponse);
  if (
    replayResponse.status !== 200 || !replay.success ||
    !replay.atomicFinalizer || !replay.idempotentReplay ||
    replay.receiptId !== safeConcurrent[0].receiptId
  ) {
    fail("TASK6_CHECKOUT_REPLAY_FAILED", "A completed checkout retry did not return the original receipt", replay);
  }

  const changedDigestResponse = await postCheckout({
    ...inputs,
    idempotencyKey,
    payload: { ...payload, notes: `${notes} changed` }
  });
  const changedDigest = safeResponse(changedDigestResponse);
  if (changedDigestResponse.status !== 409 || changedDigest.code !== "checkout_idempotency_conflict") {
    fail("TASK6_CHECKOUT_CHANGED_DIGEST_FAILED", "Reusing the checkout key with changed details was not rejected", changedDigest);
  }

  console.log(JSON.stringify({
    success: true,
    result: "PASS",
    bookingId: inputs.bookingId,
    amount,
    concurrent: safeConcurrent,
    replay,
    changedDigest,
    cleanup: {
      action: "Preserve this synthetic paid checkout receipt, final folio, and audit evidence; do not delete or reverse them",
      receiptId: replay.receiptId,
      invoiceNumber: replay.invoiceNumber,
      marker: notes
    }
  }, null, 2));
}

main().catch((error) => {
  console.log(JSON.stringify({
    success: false,
    result: "FAIL",
    code: error.code || "TASK6_CHECKOUT_LIVE_FAILED",
    message: error.message || "Task 6 checkout live verification failed",
    details: error.details,
    possibleCommittedSyntheticEvidence: runContext
      ? {
          bookingId: runContext.bookingId,
          idempotencyKey: runContext.idempotencyKey,
          marker: runContext.notes,
          action: "If either request may have committed, retry the same idempotency key or inspect the TEST receipt; preserve any financial evidence"
        }
      : null
  }, null, 2));
  process.exitCode = 1;
});
