"use strict";

require("dotenv").config({ quiet: true });

const crypto = require("node:crypto");
const {
  normalizeBaseUrl,
  normalizeSlug
} = require("./verify-tenant-public-hotel-live");

const EXPECTED_CONFIRMATION = "TASK6_POS_BILLING_TEST_WRITES_CONFIRMED";
let createdOrderId = null;
let billingStarted = false;
let billingIdempotencyKey = null;
let marker = null;

function fail(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function normalizeBearerToken(value) {
  const token = String(value || "").trim().replace(/^Bearer\s+/i, "");
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || token.length < 100) {
    fail(
      "TASK6_POS_BILLING_TEST_TOKEN_MISSING",
      "Set TASK6_POS_BILLING_TEST_BEARER_TOKEN to a current TEST manager token"
    );
  }
  return token;
}

function readInputs() {
  if (process.env.TASK6_POS_BILLING_LIVE_CONFIRM !== EXPECTED_CONFIRMATION) {
    fail(
      "TASK6_POS_BILLING_LIVE_CONFIRMATION_MISSING",
      `Set TASK6_POS_BILLING_LIVE_CONFIRM=${EXPECTED_CONFIRMATION}; this probe creates and finalizes one synthetic TEST food bill`
    );
  }
  if (String(process.env.TASK6_POS_BILLING_LIVE_ENV || "").trim().toUpperCase() !== "TEST") {
    fail("TASK6_POS_BILLING_LIVE_ENV_INVALID", "TASK6_POS_BILLING_LIVE_ENV must be TEST");
  }

  return {
    baseUrl: normalizeBaseUrl(
      process.env.TASK6_POS_BILLING_LIVE_BASE_URL ||
      process.env.TASK6_POS_LIVE_BASE_URL ||
      process.env.APP_BACKEND_BASE_URL
    ),
    slug: normalizeSlug(
      process.env.TASK6_TEST_PROPERTY_SLUG || process.env.TASK3_TEST_PROPERTY_A_SLUG
    ),
    bearerToken: normalizeBearerToken(process.env.TASK6_POS_BILLING_TEST_BEARER_TOKEN),
    requestedItemId: String(process.env.TASK6_POS_MENU_ITEM_ID || "").trim()
  };
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      ...options,
      redirect: "error",
      signal: controller.signal
    });
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

function findReadinessCheck(readiness, name) {
  return Array.isArray(readiness?.checks)
    ? readiness.checks.find((check) => check?.name === name) || null
    : null;
}

async function requireHealthyAndEnabled(baseUrl) {
  const health = await requestJson(`${baseUrl}/api/health`);
  if (health.status !== 200 || health.body?.success !== true) {
    fail("TASK6_POS_BILLING_BACKEND_NOT_READY", "health endpoint is not ready", health);
  }
  const readiness = await requestJson(`${baseUrl}/api/readiness`);
  if (readiness.status !== 200 || readiness.body?.success !== true) {
    fail("TASK6_POS_BILLING_BACKEND_NOT_READY", "readiness endpoint is not ready", readiness);
  }
  const billingFinalizer = findReadinessCheck(readiness.body, "task6_pos_billing_finalizer");
  if (!billingFinalizer || billingFinalizer.ready !== true || billingFinalizer.enabled !== true) {
    fail(
      "TASK6_POS_BILLING_FINALIZER_NOT_ENABLED",
      "Enable TASK6_POS_BILLING_FINALIZER_ENABLED=true only in the TEST service and redeploy before running this probe",
      billingFinalizer || null
    );
  }
  const tenantWrites = findReadinessCheck(readiness.body, "tenant_runtime_writes");
  if (!tenantWrites || tenantWrites.ready !== true || tenantWrites.enabled !== true) {
    fail("TASK6_POS_BILLING_RUNTIME_NOT_READY", "The TEST tenant write runtime is not ready", tenantWrites || null);
  }
}

async function selectMenuItem(inputs) {
  const response = await requestJson(
    `${inputs.baseUrl}/api/public/menu/${encodeURIComponent(inputs.slug)}`
  );
  if (response.status !== 200 || response.body?.success !== true) {
    fail("TASK6_POS_BILLING_MENU_FAILED", "Could not read the TEST public menu", response);
  }

  const positivePriceItems = Object.values(response.body?.menu || {})
    .flat()
    .filter((item) => item?.id && Number.isFinite(Number(item?.price)) && Number(item.price) > 0);
  const nonComboItems = positivePriceItems.filter(
    (item) => String(item?.itemType || "single").trim().toLowerCase() !== "combo"
  );
  const selected = inputs.requestedItemId
    ? nonComboItems.find((item) => String(item.id) === inputs.requestedItemId)
    : nonComboItems[0];
  if (!selected) {
    fail(
      "TASK6_POS_BILLING_NO_MENU_ITEM",
      "No positive-price eligible non-combo TEST menu item was found; optionally set TASK6_POS_MENU_ITEM_ID to a currently active item"
    );
  }
  return selected;
}

async function createSyntheticOrder(inputs, item, creationKey, syntheticMarker) {
  return requestJson(`${inputs.baseUrl}/api/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": creationKey
    },
    body: JSON.stringify({
      hotelName: "Task 6 TEST Hotel",
      hotelSlug: inputs.slug,
      customerName: "Task Six Synthetic Guest",
      customerPhone: "+910000000001",
      customerAddress: "TASK6 TEST synthetic final bill; preserve financial evidence",
      paymentMethod: "COD",
      paymentConfirmed: false,
      note: syntheticMarker,
      items: [{
        id: String(item.id),
        name: "CLIENT TAMPERED NAME",
        qty: 1,
        price: 999999.99
      }],
      totals: {
        subtotal: 0,
        gst: 0,
        total: 0,
        normalTotal: 0,
        gpayDiscount: 0,
        gpayFinalTotal: 0
      },
      whatsappMessage: "CLIENT TAMPERED TOTAL"
    })
  });
}

function publicOrderId(response) {
  return String(response?.body?.order?.id || "").trim() || null;
}

function safeCreationResponse(response) {
  return {
    status: response?.status || 0,
    success: response?.body?.success === true,
    code: response?.body?.code || null,
    message: String(response?.body?.message || "").slice(0, 240) || null,
    orderId: publicOrderId(response)
  };
}

function verifyCreatedOrder(response, menuItem) {
  const order = response?.body?.order;
  const line = Array.isArray(order?.items) ? order.items[0] : null;
  if (
    ![200, 201].includes(response?.status) ||
    response?.body?.success !== true ||
    !publicOrderId(response) ||
    !line ||
    Number(line.price) !== Number(menuItem.price) ||
    line.name === "CLIENT TAMPERED NAME" ||
    Number(order?.totals?.subtotal) !== Number(menuItem.price) ||
    Number(order?.totals?.total) <= 0
  ) {
    fail(
      "TASK6_POS_BILLING_SYNTHETIC_CREATE_FAILED",
      "Could not create a canonical synthetic TEST order with a Task 6 price snapshot",
      safeCreationResponse(response)
    );
  }
  return order;
}

async function finalizeBill(inputs, orderId, key, endpoint = "mark-billed") {
  return requestJson(
    `${inputs.baseUrl}/api/staff/orders/${encodeURIComponent(orderId)}/${endpoint}`,
    {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${inputs.bearerToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key
      },
      body: "{}"
    }
  );
}

function finalizedOrder(response) {
  return response?.body?.order && typeof response.body.order === "object"
    ? response.body.order
    : null;
}

function safeBillingResponse(response) {
  const order = finalizedOrder(response);
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
    billNumber: order?.billNumber || null,
    foodBillSnapshotsReady: Number(response?.body?.foodBillSnapshotsReady || 0)
  };
}

function isAtomicBillingSuccess(response, orderId) {
  const order = finalizedOrder(response);
  return [200, 201].includes(response?.status) &&
    response?.body?.success === true &&
    response?.body?.atomicFinalizer === true &&
    String(order?.id || "") === String(orderId) &&
    String(order?.billingStatus || "").toLowerCase() === "billed" &&
    String(order?.billNumber || "").trim().length > 0 &&
    String(order?.paymentStatus || "").toLowerCase() === "unpaid" &&
    Number(response?.body?.foodBillSnapshotsReady) === 1;
}

function requireConcurrentBillingContract(responses, orderId) {
  if (!responses.every((response) => isAtomicBillingSuccess(response, orderId))) {
    fail(
      "TASK6_POS_BILLING_CONCURRENT_REPLAY_FAILED",
      "Two simultaneous bill finalizations did not converge on one immutable TEST bill",
      responses.map(safeBillingResponse)
    );
  }

  const invoices = new Set(responses.map((response) => finalizedOrder(response)?.billNumber));
  const created = responses.filter(
    (response) => response.status === 201 && response.body?.idempotentReplay === false
  );
  const replayed = responses.filter(
    (response) => response.status === 200 && response.body?.idempotentReplay === true
  );
  if (invoices.size !== 1 || created.length !== 1 || replayed.length !== 1) {
    fail(
      "TASK6_POS_BILLING_REPLAY_CONTRACT_FAILED",
      "Expected one new immutable bill and one idempotent replay of the same bill",
      responses.map(safeBillingResponse)
    );
  }
}

async function main() {
  const inputs = readInputs();
  await requireHealthyAndEnabled(inputs.baseUrl);
  const menuItem = await selectMenuItem(inputs);
  const runId = crypto.randomUUID();
  const creationKey = `task6-pos-billing-create-${runId}`;
  billingIdempotencyKey = `task6-pos-billing-finalize-${runId}`;
  marker = `TASK6 POS billing synthetic ${runId}`;

  const created = await createSyntheticOrder(inputs, menuItem, creationKey, marker);
  const canonicalOrder = verifyCreatedOrder(created, menuItem);
  createdOrderId = publicOrderId(created);

  billingStarted = true;
  const concurrent = await Promise.all([
    finalizeBill(inputs, createdOrderId, billingIdempotencyKey),
    finalizeBill(inputs, createdOrderId, billingIdempotencyKey)
  ]);
  requireConcurrentBillingContract(concurrent, createdOrderId);

  const replay = await finalizeBill(inputs, createdOrderId, billingIdempotencyKey);
  if (
    !isAtomicBillingSuccess(replay, createdOrderId) ||
    replay.status !== 200 ||
    replay.body?.idempotentReplay !== true ||
    finalizedOrder(replay)?.billNumber !== finalizedOrder(concurrent[0])?.billNumber
  ) {
    fail(
      "TASK6_POS_BILLING_REPLAY_FAILED",
      "A billing retry did not return the original immutable bill",
      safeBillingResponse(replay)
    );
  }

  const changedDigest = await finalizeBill(
    inputs,
    createdOrderId,
    billingIdempotencyKey,
    "mark-family-billed"
  );
  if (
    changedDigest.status !== 409 ||
    changedDigest.body?.code !== "ORDER_BILLING_IDEMPOTENCY_CONFLICT"
  ) {
    fail(
      "TASK6_POS_BILLING_DIGEST_CONFLICT_FAILED",
      "Same billing key with a changed finalization scope was not rejected",
      safeBillingResponse(changedDigest)
    );
  }

  const finalOrder = finalizedOrder(replay);
  process.stdout.write(`${JSON.stringify({
    success: true,
    result: "PASS",
    propertySlug: inputs.slug,
    syntheticOrder: {
      orderId: createdOrderId,
      marker,
      serverPrice: Number(menuItem.price),
      serverTotal: Number(canonicalOrder?.totals?.total),
      paymentStatus: finalOrder?.paymentStatus,
      billingStatus: finalOrder?.billingStatus,
      invoiceNumber: finalOrder?.billNumber
    },
    concurrent: concurrent.map(safeBillingResponse),
    replay: safeBillingResponse(replay),
    changedDigest: safeBillingResponse(changedDigest),
    evidence: "One TEST-only immutable food bill, its snapshot, and its audit evidence were preserved. No payment provider call was made."
  }, null, 2)}\n`);
}

function safeFailure(error) {
  const possibleCommittedFinancialEvidence = createdOrderId && billingStarted
    ? {
        orderId: createdOrderId,
        idempotencyKey: billingIdempotencyKey,
        marker,
        action: "A bill request may have committed. Preserve the TEST order, bill snapshot, and audit evidence; retry only with the same key after investigation."
      }
    : null;
  const cleanup = createdOrderId && !billingStarted
    ? {
        orderId: createdOrderId,
        marker,
        action: "Billing was not started. Cancel this synthetic unpaid TEST order in the staff/admin workflow."
      }
    : null;
  return {
    success: false,
    result: "FAIL",
    code: String(error?.code || "TASK6_POS_BILLING_LIVE_FAILED"),
    message: String(error?.message || "Task 6 live POS billing verification failed"),
    details: error?.details,
    possibleCommittedFinancialEvidence,
    cleanup
  };
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(safeFailure(error), null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  isAtomicBillingSuccess,
  safeBillingResponse,
  safeFailure
};
