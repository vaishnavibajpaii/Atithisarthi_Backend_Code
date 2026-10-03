"use strict";

require("dotenv").config({ quiet: true });

const {
  normalizeBaseUrl,
  normalizeSlug,
  requireReadyCheck
} = require("./verify-tenant-public-hotel-live");

const EXPECTED_CONFIRMATION = "TASK3E_PUBLIC_GALLERY_LIVE_READ_ONLY";
const DEFAULT_ITERATIONS = 10;

function createVerifierError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readInputs() {
  if (process.env.TASK3_PUBLIC_GALLERY_LIVE_CONFIRM !== EXPECTED_CONFIRMATION) {
    throw createVerifierError(
      "TASK3_PUBLIC_GALLERY_LIVE_CONFIRMATION_MISSING",
      `Set TASK3_PUBLIC_GALLERY_LIVE_CONFIRM=${EXPECTED_CONFIRMATION}`
    );
  }
  const iterations = Number(
    process.env.TASK3_PUBLIC_ROUTE_CONCURRENCY_ITERATIONS || DEFAULT_ITERATIONS
  );
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 50) {
    throw createVerifierError(
      "TASK3_PUBLIC_GALLERY_LIVE_ITERATIONS_INVALID",
      "TASK3_PUBLIC_ROUTE_CONCURRENCY_ITERATIONS must be from 1 to 50"
    );
  }
  return {
    baseUrl: normalizeBaseUrl(process.env.TASK3_PUBLIC_GALLERY_LIVE_BASE_URL),
    contextA: {
      slug: normalizeSlug(process.env.TASK3_TEST_PROPERTY_A_SLUG),
      forgedTenantId: String(process.env.TASK3_TEST_TENANT_B_ID || "").trim(),
      forgedPropertyId: String(process.env.TASK3_TEST_PROPERTY_B_ID || "").trim()
    },
    contextB: {
      slug: normalizeSlug(process.env.TASK3_TEST_PROPERTY_B_SLUG),
      forgedTenantId: String(process.env.TASK3_TEST_TENANT_A_ID || "").trim(),
      forgedPropertyId: String(process.env.TASK3_TEST_PROPERTY_A_ID || "").trim()
    },
    iterations
  };
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
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
        "TASK3_PUBLIC_GALLERY_LIVE_RESPONSE_INVALID",
        "Live public gallery endpoint did not return JSON"
      );
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

function hasInternalContext(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasInternalContext);
  const forbidden = new Set(["tenant_id", "property_id", "tenantId", "propertyId"]);
  return Object.entries(value).some(
    ([key, nested]) => forbidden.has(key) || hasInternalContext(nested)
  );
}

function verifyGallery(result) {
  if (
    result.status !== 200 ||
    result.body?.success !== true ||
    !Array.isArray(result.body?.gallery)
  ) {
    throw createVerifierError(
      "TASK3_PUBLIC_GALLERY_LIVE_RESPONSE_MISMATCH",
      "Live public gallery endpoint returned an invalid response contract"
    );
  }
  if (hasInternalContext(result.body)) {
    throw createVerifierError(
      "TASK3_PUBLIC_GALLERY_LIVE_CONTEXT_EXPOSED",
      "Live public gallery endpoint exposed internal ownership fields"
    );
  }
  return {
    httpStatus: result.status,
    itemCount: result.body.gallery.length,
    internalContextExposed: false
  };
}

async function probeGallery(baseUrl, context) {
  const query = new URLSearchParams({
    tenant_id: context.forgedTenantId,
    property_id: context.forgedPropertyId
  });
  const result = await requestJson(
    `${baseUrl}/api/public/gallery/${encodeURIComponent(context.slug)}?${query}`,
    {
      headers: {
        "x-tenant-id": context.forgedTenantId,
        "x-property-id": context.forgedPropertyId
      }
    }
  );
  return verifyGallery(result);
}

function safeFailure(error) {
  const code = error?.code ? String(error.code) : "TASK3_PUBLIC_GALLERY_LIVE_FAILED";
  return {
    success: false,
    code,
    message: code.startsWith("TASK3_")
      ? String(error?.message || "Live public gallery verification failed")
      : "Live public gallery request failed"
  };
}

async function main() {
  const inputs = readInputs();
  const health = await requestJson(`${inputs.baseUrl}/api/health`);
  if (health.status !== 200 || health.body?.success !== true) {
    throw createVerifierError(
      "TASK3_PUBLIC_GALLERY_LIVE_HEALTH_FAILED",
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
      "TASK3_PUBLIC_GALLERY_LIVE_READINESS_FAILED",
      "Backend readiness endpoint is not ready"
    );
  }
  requireReadyCheck(readiness, "tenant_runtime_database");
  requireReadyCheck(readiness, "tenant_runtime_public_hotel");
  requireReadyCheck(readiness, "tenant_runtime_public_menu");
  requireReadyCheck(readiness, "tenant_runtime_public_gallery");

  const tenantA = await probeGallery(inputs.baseUrl, inputs.contextA);
  const tenantB = await probeGallery(inputs.baseUrl, inputs.contextB);
  const unknown = await requestJson(
    `${inputs.baseUrl}/api/public/gallery/task3e-property-does-not-exist`
  );
  if (unknown.status !== 404 || unknown.body?.success !== false) {
    throw createVerifierError(
      "TASK3_PUBLIC_GALLERY_LIVE_UNKNOWN_SLUG_FAILED",
      "Unknown live public gallery slug did not fail closed"
    );
  }
  let concurrentPasses = 0;
  for (let index = 0; index < inputs.iterations; index += 1) {
    const pair = await Promise.all([
      probeGallery(inputs.baseUrl, inputs.contextA),
      probeGallery(inputs.baseUrl, inputs.contextB)
    ]);
    concurrentPasses += pair.length;
  }
  const expectedPasses = inputs.iterations * 2;
  if (concurrentPasses !== expectedPasses) {
    throw createVerifierError(
      "TASK3_PUBLIC_GALLERY_LIVE_CONCURRENCY_FAILED",
      "Live concurrent public gallery probes did not all pass"
    );
  }
  process.stdout.write(`${JSON.stringify({
    success: true,
    mode: "LIVE_READ_ONLY_GALLERY_ROUTE_CANARY",
    route: "/api/public/gallery/:slug",
    health: "PASS",
    readiness: "PASS",
    tenantRuntimeDatabase: "PASS",
    tenantRuntimePublicHotel: "PASS",
    tenantRuntimePublicMenu: "PASS",
    tenantRuntimePublicGallery: "PASS",
    tenantA,
    tenantB,
    forgedTenantInputsIgnored: true,
    unknownSlug: { httpStatus: unknown.status, result: "PASS" },
    concurrency: {
      iterations: inputs.iterations,
      expectedPasses,
      actualPasses: concurrentPasses,
      result: "PASS"
    },
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
  hasInternalContext,
  verifyGallery
};
