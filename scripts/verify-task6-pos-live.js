"use strict";

require("dotenv").config({ quiet: true });

const crypto = require("node:crypto");
const {
  normalizeBaseUrl,
  normalizeSlug
} = require("./verify-tenant-public-hotel-live");

const EXPECTED_CONFIRMATION = "TASK6_POS_TEST_WRITES_CONFIRMED";
let cleanupOrderId = null;

function fail(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function readInputs() {
  if (process.env.TASK6_POS_LIVE_CONFIRM !== EXPECTED_CONFIRMATION) {
    fail(
      "TASK6_POS_LIVE_CONFIRMATION_MISSING",
      `Set TASK6_POS_LIVE_CONFIRM=${EXPECTED_CONFIRMATION}; this probe creates one synthetic unpaid TEST order`
    );
  }
  if (String(process.env.TASK6_POS_LIVE_ENV || "").trim().toUpperCase() !== "TEST") {
    fail("TASK6_POS_LIVE_ENV_INVALID", "TASK6_POS_LIVE_ENV must be TEST");
  }

  return {
    baseUrl: normalizeBaseUrl(
      process.env.TASK6_POS_LIVE_BASE_URL ||
      process.env.TASK3_PUBLIC_HOTEL_LIVE_BASE_URL ||
      process.env.APP_BACKEND_BASE_URL
    ),
    slug: normalizeSlug(
      process.env.TASK6_TEST_PROPERTY_SLUG || process.env.TASK3_TEST_PROPERTY_A_SLUG
    ),
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
      fail("TASK6_POS_RESPONSE_NOT_JSON", "The TEST backend did not return JSON");
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function requireHealthy(baseUrl) {
  for (const endpoint of ["health", "readiness"]) {
    const response = await requestJson(`${baseUrl}/api/${endpoint}`);
    if (response.status !== 200 || response.body?.success !== true) {
      fail("TASK6_POS_BACKEND_NOT_READY", `${endpoint} endpoint is not ready`, response);
    }
  }
}

async function selectMenuItem(inputs) {
  const response = await requestJson(
    `${inputs.baseUrl}/api/public/menu/${encodeURIComponent(inputs.slug)}`
  );
  if (response.status !== 200 || response.body?.success !== true) {
    fail("TASK6_POS_MENU_FAILED", "Could not read the TEST public menu", response);
  }

  const positivePriceItems = Object.values(response.body?.menu || {})
    .flat()
    .filter((item) => item?.id && Number.isFinite(Number(item?.price)) && Number(item.price) > 0);
  const items = positivePriceItems.filter(
    (item) => String(item?.itemType || "single").trim().toLowerCase() !== "combo"
  );
  const selected = inputs.requestedItemId
    ? positivePriceItems.find((item) => String(item.id) === inputs.requestedItemId)
    : items[0];
  if (!selected) {
    fail(
      "TASK6_POS_NO_MENU_ITEM",
      "No positive-price eligible non-combo TEST menu item was found; optionally set TASK6_POS_MENU_ITEM_ID to a currently active item"
    );
  }
  return selected;
}

async function createOrder(inputs, payload, key) {
  return requestJson(`${inputs.baseUrl}/api/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key
    },
    body: JSON.stringify({ ...payload, clientRequestId: key })
  });
}

function orderId(response) {
  return String(response?.body?.order?.id || "").trim() || null;
}

function isCreated(response) {
  return [200, 201].includes(response?.status) &&
    response?.body?.success === true &&
    !!orderId(response);
}

function safeResponse(response) {
  const validationDetails = Array.isArray(response?.body?.details)
    ? response.body.details.slice(0, 5).map((detail) => ({
        path: Array.isArray(detail?.path) ? detail.path.map(String) : [],
        message: String(detail?.message || "").slice(0, 240)
      }))
    : undefined;
  return {
    status: response?.status || 0,
    success: response?.body?.success === true,
    code: response?.body?.code || null,
    message: String(response?.body?.message || "").slice(0, 240) || null,
    ...(validationDetails?.length ? { validationDetails } : {}),
    idempotent: response?.body?.idempotent === true,
    orderId: orderId(response)
  };
}

function findForbiddenKey(value, path = "response") {
  if (!value || typeof value !== "object") return null;
  const forbidden = new Set([
    "tenant_id",
    "property_id",
    "creation_idempotency_scope",
    "creation_idempotency_key",
    "creation_request_fingerprint"
  ]);
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) return `${path}.${key}`;
    const nested = findForbiddenKey(child, `${path}.${key}`);
    if (nested) return nested;
  }
  return null;
}

async function main() {
  const inputs = readInputs();
  await requireHealthy(inputs.baseUrl);
  const item = await selectMenuItem(inputs);
  const runId = crypto.randomUUID();
  const idempotencyKey = `task6-pos-${runId}`;
  const marker = `TASK6 POS synthetic ${runId}`;
  const payload = {
    hotelName: "Task 6 TEST Hotel",
    hotelSlug: inputs.slug,
    customerName: "Task Six Synthetic Guest",
    customerPhone: "+910000000001",
    customerAddress: "TASK6 TEST synthetic order; cancel after verification",
    paymentMethod: "COD",
    paymentConfirmed: false,
    note: marker,
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
  };

  const concurrent = await Promise.all([
    createOrder(inputs, payload, idempotencyKey),
    createOrder(inputs, payload, idempotencyKey)
  ]);
  const successes = concurrent.filter(isCreated);
  const ids = [...new Set(successes.map(orderId))];
  if (successes.length !== 2 || ids.length !== 1) {
    fail(
      "TASK6_POS_CONCURRENT_REPLAY_FAILED",
      "Two simultaneous identical requests did not converge on one logical order",
      concurrent.map(safeResponse)
    );
  }
  cleanupOrderId = ids[0];
  if (
    concurrent.filter((response) => response.status === 201 && response.body?.idempotent !== true).length !== 1 ||
    concurrent.filter((response) => response.status === 200 && response.body?.idempotent === true).length !== 1
  ) {
    fail(
      "TASK6_POS_REPLAY_CONTRACT_FAILED",
      "Expected one new result and one idempotent replay",
      concurrent.map(safeResponse)
    );
  }

  const canonical = successes[0].body.order;
  const storedItem = Array.isArray(canonical?.items) ? canonical.items[0] : null;
  if (
    !storedItem ||
    Number(storedItem.price) !== Number(item.price) ||
    storedItem.name === "CLIENT TAMPERED NAME" ||
    Number(canonical?.totals?.subtotal) !== Number(item.price) ||
    Number(canonical?.totals?.total) <= 0
  ) {
    fail(
      "TASK6_POS_SERVER_PRICING_FAILED",
      "The persisted order did not ignore client price/name/total tampering",
      {
        menuItemId: String(item.id),
        menuPrice: Number(item.price),
        storedPrice: Number(storedItem?.price),
        storedSubtotal: Number(canonical?.totals?.subtotal),
        storedTotal: Number(canonical?.totals?.total)
      }
    );
  }

  const forbiddenPath = findForbiddenKey(successes[0].body);
  if (forbiddenPath) {
    fail(
      "TASK6_POS_PUBLIC_METADATA_EXPOSED",
      "The public order response exposed internal persistence metadata",
      { path: forbiddenPath }
    );
  }

  const changedDigest = await createOrder(
    inputs,
    { ...payload, note: `${marker} changed` },
    idempotencyKey
  );
  if (
    changedDigest.status !== 409 ||
    changedDigest.body?.code !== "ORDER_IDEMPOTENCY_CONFLICT"
  ) {
    fail(
      "TASK6_POS_DIGEST_CONFLICT_FAILED",
      "Same-key/changed-request retry was not rejected",
      safeResponse(changedDigest)
    );
  }

  process.stdout.write(`${JSON.stringify({
    success: true,
    result: "PASS",
    propertySlug: inputs.slug,
    menuItem: {
      id: String(item.id),
      serverPrice: Number(item.price)
    },
    concurrent: concurrent.map(safeResponse),
    changedDigest: safeResponse(changedDigest),
    serverSnapshot: {
      unitPrice: Number(storedItem.price),
      subtotal: Number(canonical.totals.subtotal),
      total: Number(canonical.totals.total)
    },
    cleanup: {
      action: "Cancel this synthetic unpaid order in the TEST staff/admin order workflow",
      orderId: cleanupOrderId,
      marker
    }
  }, null, 2)}\n`);
}

function safeFailure(error) {
  return {
    success: false,
    result: "FAIL",
    code: String(error?.code || "TASK6_POS_LIVE_FAILED"),
    message: String(error?.message || "Task 6 live POS verification failed"),
    details: error?.details,
    cleanup: cleanupOrderId
      ? {
          action: "Cancel this synthetic unpaid TEST order in the staff/admin order workflow",
          orderId: cleanupOrderId
        }
      : null
  };
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(safeFailure(error), null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  findForbiddenKey,
  isCreated,
  safeResponse
};

