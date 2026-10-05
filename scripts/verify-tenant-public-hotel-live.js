"use strict";

require("dotenv").config({ quiet: true });

const EXPECTED_CONFIRMATION = "TASK3E_PUBLIC_LIVE_READ_ONLY";
const DEFAULT_ITERATIONS = 10;

function createVerifierError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeSlug(value) {
  const slug = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/.test(slug)) {
    throw createVerifierError(
      "TASK3_PUBLIC_LIVE_SLUG_INVALID",
      "A valid test property slug is required"
    );
  }
  return slug;
}

function normalizeBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw createVerifierError(
      "TASK3_PUBLIC_LIVE_URL_INVALID",
      "TASK3_PUBLIC_HOTEL_LIVE_BASE_URL must be a valid HTTPS URL"
    );
  }
  if (
    parsed.protocol !== "https:" ||
    ["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname)
  ) {
    throw createVerifierError(
      "TASK3_PUBLIC_LIVE_URL_INVALID",
      "Live verification requires a non-local HTTPS backend URL"
    );
  }
  return parsed.toString().replace(/\/$/, "");
}

function readInputs() {
  if (
    process.env.TASK3_PUBLIC_HOTEL_LIVE_CONFIRM !== EXPECTED_CONFIRMATION
  ) {
    throw createVerifierError(
      "TASK3_PUBLIC_LIVE_CONFIRMATION_MISSING",
      `Set TASK3_PUBLIC_HOTEL_LIVE_CONFIRM=${EXPECTED_CONFIRMATION}`
    );
  }
  const iterations = Number(
    process.env.TASK3_PUBLIC_ROUTE_CONCURRENCY_ITERATIONS ||
    DEFAULT_ITERATIONS
  );
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 50) {
    throw createVerifierError(
      "TASK3_PUBLIC_LIVE_ITERATIONS_INVALID",
      "TASK3_PUBLIC_ROUTE_CONCURRENCY_ITERATIONS must be from 1 to 50"
    );
  }
  return {
    baseUrl: normalizeBaseUrl(
      process.env.TASK3_PUBLIC_HOTEL_LIVE_BASE_URL
    ),
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
        "TASK3_PUBLIC_LIVE_RESPONSE_INVALID",
        "Live endpoint did not return JSON"
      );
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

function requireReadyCheck(readiness, name) {
  const check = Array.isArray(readiness?.body?.checks)
    ? readiness.body.checks.find((entry) => entry?.name === name)
    : null;
  if (!check) {
    throw createVerifierError(
      "TASK3_PUBLIC_LIVE_RELEASE_MISSING",
      `Readiness check ${name} is missing; the target does not have the current Task3-E release`
    );
  }
  if (check.ready !== true) {
    throw createVerifierError(
      "TASK3_PUBLIC_LIVE_READINESS_FAILED",
      `Readiness check ${name} is not ready: ${String(check.issue || "unknown_issue")}`
    );
  }
  return true;
}

function requireEnabledReadyCheck(readiness, name) {
  requireReadyCheck(readiness, name);
  const check = readiness.body.checks.find((entry) => entry?.name === name);
  if (check.enabled !== true) {
    throw createVerifierError(
      "TASK3_PUBLIC_LIVE_RUNTIME_DISABLED",
      `Readiness check ${name} is healthy but its tenant-runtime path is not enabled`
    );
  }
  return true;
}

function verifyHotel(result, expectedSlug) {
  if (
    result.status !== 200 ||
    result.body?.success !== true ||
    result.body?.hotel?.hotel_slug !== expectedSlug
  ) {
    throw createVerifierError(
      "TASK3_PUBLIC_LIVE_HOTEL_MISMATCH",
      "Live public hotel endpoint returned the wrong property"
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(result.body.hotel, "tenant_id") ||
    Object.prototype.hasOwnProperty.call(result.body.hotel, "property_id")
  ) {
    throw createVerifierError(
      "TASK3_PUBLIC_LIVE_CONTEXT_EXPOSED",
      "Live public endpoint exposed internal ownership fields"
    );
  }
  return {
    httpStatus: result.status,
    matchedSlug: expectedSlug,
    internalContextExposed: false
  };
}

async function probeHotel(baseUrl, context) {
  const query = new URLSearchParams({
    tenant_id: context.forgedTenantId,
    property_id: context.forgedPropertyId
  });
  const result = await requestJson(
    `${baseUrl}/api/public/hotel/${encodeURIComponent(context.slug)}?${query}`,
    {
      headers: {
        "x-tenant-id": context.forgedTenantId,
        "x-property-id": context.forgedPropertyId
      }
    }
  );
  return verifyHotel(result, context.slug);
}

function safeFailure(error) {
  const code = error?.code ? String(error.code) : "TASK3_PUBLIC_LIVE_FAILED";
  return {
    success: false,
    code,
    message:
      code.startsWith("TASK3_")
        ? String(error?.message || "Live tenant route verification failed")
        : "Live tenant route request failed"
  };
}

async function main() {
  const inputs = readInputs();
  const health = await requestJson(`${inputs.baseUrl}/api/health`);
  if (health.status !== 200 || health.body?.success !== true) {
    throw createVerifierError(
      "TASK3_PUBLIC_LIVE_HEALTH_FAILED",
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
      "TASK3_PUBLIC_LIVE_READINESS_FAILED",
      "Backend readiness endpoint is not ready"
    );
  }
  requireEnabledReadyCheck(readiness, "tenant_runtime_database");
  requireEnabledReadyCheck(readiness, "tenant_runtime_public_hotel");

  const tenantA = await probeHotel(inputs.baseUrl, inputs.contextA);
  const tenantB = await probeHotel(inputs.baseUrl, inputs.contextB);

  const unknown = await requestJson(
    `${inputs.baseUrl}/api/public/hotel/task3e-property-does-not-exist`
  );
  if (unknown.status !== 404 || unknown.body?.success !== false) {
    throw createVerifierError(
      "TASK3_PUBLIC_LIVE_UNKNOWN_SLUG_FAILED",
      "Unknown live hotel slug did not fail closed"
    );
  }

  let concurrentPasses = 0;
  for (let index = 0; index < inputs.iterations; index += 1) {
    const pair = await Promise.all([
      probeHotel(inputs.baseUrl, inputs.contextA),
      probeHotel(inputs.baseUrl, inputs.contextB)
    ]);
    concurrentPasses += pair.length;
  }
  const expectedPasses = inputs.iterations * 2;
  if (concurrentPasses !== expectedPasses) {
    throw createVerifierError(
      "TASK3_PUBLIC_LIVE_CONCURRENCY_FAILED",
      "Live concurrent tenant route probes did not all pass"
    );
  }

  process.stdout.write(`${JSON.stringify({
    success: true,
    mode: "LIVE_READ_ONLY_ROUTE_CANARY",
    route: "/api/public/hotel/:slug",
    health: "PASS",
    readiness: "PASS",
    tenantRuntimeDatabase: "PASS",
    tenantRuntimePublicHotel: "PASS",
    tenantA,
    tenantB,
    forgedTenantInputsIgnored: true,
    unknownSlug: {
      httpStatus: unknown.status,
      result: "PASS"
    },
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
  normalizeBaseUrl,
  normalizeSlug,
  requireEnabledReadyCheck,
  requireReadyCheck,
  verifyHotel
};
