"use strict";

require("dotenv").config({ quiet: true });

const {
  normalizeBaseUrl,
  normalizeSlug,
  requireEnabledReadyCheck
} = require("./verify-tenant-public-hotel-live");
const {
  discoverTrackingFixture,
  fixtureDigest,
  hasInternalContext,
  verifyTrackingDenied,
  verifyTrackingSuccess
} = require("./verify-tenant-public-order-tracking-runtime");

const AUTHORIZED_BASE_URL =
  "https://atithisarthibackendcode-production-f8d1.up.railway.app";
const EXPECTED_CONFIRMATION =
  "TASK3E_PUBLIC_ORDER_TRACKING_LIVE_READ_ONLY";
const DEFAULT_ITERATIONS = 10;

function createVerifierError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readInputs() {
  if (
    process.env.TASK3_PUBLIC_ORDER_TRACKING_LIVE_CONFIRM !==
    EXPECTED_CONFIRMATION
  ) {
    throw createVerifierError(
      "TASK3_PUBLIC_ORDER_TRACKING_LIVE_CONFIRMATION_MISSING",
      `Set TASK3_PUBLIC_ORDER_TRACKING_LIVE_CONFIRM=${EXPECTED_CONFIRMATION}`
    );
  }
  const baseUrl = normalizeBaseUrl(
    process.env.TASK3_PUBLIC_ORDER_TRACKING_LIVE_BASE_URL
  );
  if (baseUrl !== AUTHORIZED_BASE_URL) {
    throw createVerifierError(
      "TASK3_PUBLIC_ORDER_TRACKING_LIVE_DESTINATION_DENIED",
      "Live order-tracking verification is restricted to the explicitly authorized Railway origin"
    );
  }
  const iterations = Number(
    process.env.TASK3_PUBLIC_ROUTE_CONCURRENCY_ITERATIONS ||
    DEFAULT_ITERATIONS
  );
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 50) {
    throw createVerifierError(
      "TASK3_PUBLIC_ORDER_TRACKING_LIVE_ITERATIONS_INVALID",
      "TASK3_PUBLIC_ROUTE_CONCURRENCY_ITERATIONS must be from 1 to 50"
    );
  }
  return {
    baseUrl,
    contextA: {
      slug: normalizeSlug(process.env.TASK3_TEST_PROPERTY_A_SLUG),
      forgedTenantId: String(
        process.env.TASK3_TEST_TENANT_B_ID || ""
      ).trim(),
      forgedPropertyId: String(
        process.env.TASK3_TEST_PROPERTY_B_ID || ""
      ).trim()
    },
    contextB: {
      slug: normalizeSlug(process.env.TASK3_TEST_PROPERTY_B_SLUG),
      forgedTenantId: String(
        process.env.TASK3_TEST_TENANT_A_ID || ""
      ).trim(),
      forgedPropertyId: String(
        process.env.TASK3_TEST_PROPERTY_A_ID || ""
      ).trim()
    },
    iterations
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
    let body;
    try {
      body = await response.json();
    } catch {
      throw createVerifierError(
        "TASK3_PUBLIC_ORDER_TRACKING_LIVE_RESPONSE_INVALID",
        "Live public order-tracking endpoint did not return JSON"
      );
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

function verifyExpectedSlug(result, expectedSlug) {
  const body = verifyTrackingSuccess(result);
  if (body.order.hotelSlug !== expectedSlug) {
    throw createVerifierError(
      "TASK3_PUBLIC_ORDER_TRACKING_LIVE_PROPERTY_MISMATCH",
      "Live public order-tracking route returned the wrong property slug"
    );
  }
  if (hasInternalContext(body)) {
    throw createVerifierError(
      "TASK3_PUBLIC_ORDER_TRACKING_LIVE_CONTEXT_EXPOSED",
      "Live public order-tracking route exposed internal ownership or token fields"
    );
  }
  return body;
}

function buildLiveRequest(baseUrl, fixture, context) {
  const query = new URLSearchParams({
    tenant_id: context.forgedTenantId,
    property_id: context.forgedPropertyId
  });
  return {
    url: `${baseUrl}/api/order-tracking/${encodeURIComponent(fixture.slug)}/${encodeURIComponent(fixture.orderId)}?${query}`,
    options: {
      headers: {
        "X-Order-Tracking-Token": fixture.token,
        "x-tenant-id": context.forgedTenantId,
        "x-property-id": context.forgedPropertyId
      }
    }
  };
}

async function probeFixture(baseUrl, fixture, context) {
  const request = buildLiveRequest(baseUrl, fixture, context);
  return requestJson(request.url, request.options);
}

function safeFailure(error) {
  const suppliedCode = error?.code ? String(error.code) : "";
  const code = suppliedCode || "TASK3_PUBLIC_ORDER_TRACKING_LIVE_FAILED";
  return {
    success: false,
    code,
    message: suppliedCode.startsWith("TASK3_")
      ? String(error?.message || "Live public order-tracking verification failed")
      : "Live public order-tracking request failed"
  };
}

async function main() {
  const inputs = readInputs();
  const fixtureA = await discoverTrackingFixture(inputs.contextA.slug);
  const fixtureB = await discoverTrackingFixture(inputs.contextB.slug);
  if (!fixtureA || !fixtureB) {
    throw createVerifierError(
      "TASK3_PUBLIC_ORDER_TRACKING_LIVE_FIXTURE_MISSING",
      "Both canonical test tenants require an existing opaque tracking fixture"
    );
  }

  const health = await requestJson(`${inputs.baseUrl}/api/health`);
  if (health.status !== 200 || health.body?.success !== true) {
    throw createVerifierError(
      "TASK3_PUBLIC_ORDER_TRACKING_LIVE_HEALTH_FAILED",
      "Backend health endpoint is not healthy"
    );
  }
  const readiness = await requestJson(`${inputs.baseUrl}/api/readiness`);
  if (
    readiness.status !== 200 ||
    readiness.body?.success !== true ||
    readiness.body?.ready !== true
  ) {
    throw createVerifierError(
      "TASK3_PUBLIC_ORDER_TRACKING_LIVE_READINESS_FAILED",
      "Backend readiness endpoint is not ready"
    );
  }
  [
    "tenant_runtime_database",
    "tenant_runtime_public_hotel",
    "tenant_runtime_public_menu",
    "tenant_runtime_public_gallery",
    "tenant_runtime_public_testimonials",
    "tenant_runtime_public_popup",
    "tenant_runtime_public_rooms",
    "tenant_runtime_public_order_tracking"
  ].forEach((name) => requireEnabledReadyCheck(readiness, name));

  const tenantA = verifyExpectedSlug(
    await probeFixture(inputs.baseUrl, fixtureA, inputs.contextA),
    inputs.contextA.slug
  );
  const tenantB = verifyExpectedSlug(
    await probeFixture(inputs.baseUrl, fixtureB, inputs.contextB),
    inputs.contextB.slug
  );
  const wrongToken = verifyTrackingDenied(
    await probeFixture(inputs.baseUrl, {
      ...fixtureA,
      token: `${fixtureA.token}-invalid`
    }, inputs.contextA)
  );
  const wrongSlug = verifyTrackingDenied(
    await probeFixture(inputs.baseUrl, {
      ...fixtureA,
      slug: inputs.contextB.slug
    }, inputs.contextB)
  );
  const unknownSlug = verifyTrackingDenied(
    await probeFixture(inputs.baseUrl, {
      ...fixtureA,
      slug: "task3e-property-does-not-exist"
    }, inputs.contextA)
  );

  let concurrentPasses = 0;
  for (let index = 0; index < inputs.iterations; index += 1) {
    const pair = await Promise.all([
      probeFixture(inputs.baseUrl, fixtureA, inputs.contextA),
      probeFixture(inputs.baseUrl, fixtureB, inputs.contextB)
    ]);
    verifyExpectedSlug(pair[0], inputs.contextA.slug);
    verifyExpectedSlug(pair[1], inputs.contextB.slug);
    concurrentPasses += 2;
  }
  const expectedPasses = inputs.iterations * 2;
  if (concurrentPasses !== expectedPasses) {
    throw createVerifierError(
      "TASK3_PUBLIC_ORDER_TRACKING_LIVE_CONCURRENCY_FAILED",
      "Live concurrent public order-tracking probes did not all pass"
    );
  }

  process.stdout.write(`${JSON.stringify({
    success: true,
    mode: "LIVE_READ_ONLY_PUBLIC_ORDER_TRACKING_ROUTE_CANARY",
    route: "/api/order-tracking/:hotelSlug/:orderId",
    tokenTransport: "REDACTED_HEADER",
    health: "PASS",
    readiness: "PASS",
    tenantRuntimeDatabase: "PASS",
    tenantRuntimePublicHotel: "PASS",
    tenantRuntimePublicMenu: "PASS",
    tenantRuntimePublicGallery: "PASS",
    tenantRuntimePublicTestimonials: "PASS",
    tenantRuntimePublicPopup: "PASS",
    tenantRuntimePublicRooms: "PASS",
    tenantRuntimePublicOrderTracking: "PASS",
    tenantA: {
      fixtureReferenceDigest: fixtureDigest(fixtureA),
      matchedSlug: tenantA.order.hotelSlug,
      addOnCount: Array.isArray(tenantA.order.addOns)
        ? tenantA.order.addOns.length
        : 0,
      internalContextExposed: false
    },
    tenantB: {
      fixtureReferenceDigest: fixtureDigest(fixtureB),
      matchedSlug: tenantB.order.hotelSlug,
      addOnCount: Array.isArray(tenantB.order.addOns)
        ? tenantB.order.addOns.length
        : 0,
      internalContextExposed: false
    },
    forgedTenantInputsIgnored: true,
    wrongToken,
    wrongSlug,
    unknownSlug,
    concurrency: {
      iterations: inputs.iterations,
      expectedPasses,
      actualPasses: concurrentPasses,
      result: "PASS"
    },
    trackingWritesMigrated: false,
    result: "PASS",
    timestamp: new Date().toISOString()
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(safeFailure(error), null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  AUTHORIZED_BASE_URL,
  buildLiveRequest,
  readInputs,
  safeFailure,
  verifyExpectedSlug
};
