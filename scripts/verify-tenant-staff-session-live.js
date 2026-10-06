"use strict";

require("dotenv").config({ quiet: true });

process.env.SUPABASE_URL ||= "https://tenant-staff-session-live.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const crypto = require("crypto");
const { signStaffToken } = require("../utils/auth");
const {
  normalizePropertySlug
} = require("../utils/tenant-request-context");

const EXPECTED_CONFIRMATION =
  "TASK3E_STAFF_SESSION_LIVE_READ_ONLY";
const ALLOWED_BASE_URL =
  "https://atithisarthibackendcode-production-f8d1.up.railway.app";
const DEFAULT_ITERATIONS = 10;
const REQUIRED_READINESS_CHECKS = [
  "tenant_runtime_database",
  "tenant_runtime_public_hotel",
  "tenant_runtime_public_menu",
  "tenant_runtime_public_gallery",
  "tenant_runtime_public_testimonials",
  "tenant_runtime_public_popup",
  "tenant_runtime_public_rooms",
  "tenant_runtime_public_order_tracking",
  "tenant_runtime_staff_menu",
  "tenant_runtime_staff_ordering_settings",
  "tenant_runtime_staff_session"
];

function createVerifierError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeBaseUrl(value) {
  const candidate = String(value || "").trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw createVerifierError(
      "TASK3_STAFF_SESSION_LIVE_BASE_URL_INVALID",
      "A valid HTTPS live base URL is required"
    );
  }
  if (
    candidate !== ALLOWED_BASE_URL ||
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw createVerifierError(
      "TASK3_STAFF_SESSION_LIVE_ORIGIN_NOT_ALLOWED",
      "Live verifier is restricted to the approved Railway origin"
    );
  }
  return candidate;
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value || fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 50) {
    throw createVerifierError(
      "TASK3_STAFF_SESSION_LIVE_ITERATIONS_INVALID",
      "TASK3_STAFF_ROUTE_CONCURRENCY_ITERATIONS must be from 1 to 50"
    );
  }
  return parsed;
}

function readInputs() {
  if (
    process.env.TASK3_STAFF_SESSION_LIVE_CONFIRM !==
    EXPECTED_CONFIRMATION
  ) {
    throw createVerifierError(
      "TASK3_STAFF_SESSION_LIVE_CONFIRMATION_MISSING",
      `Set TASK3_STAFF_SESSION_LIVE_CONFIRM=${EXPECTED_CONFIRMATION}`
    );
  }
  const slugA = normalizePropertySlug(
    process.env.TASK3_TEST_PROPERTY_A_SLUG
  );
  const slugB = normalizePropertySlug(
    process.env.TASK3_TEST_PROPERTY_B_SLUG
  );
  const tenantAId = String(
    process.env.TASK3_TEST_TENANT_A_ID || ""
  ).trim();
  const tenantBId = String(
    process.env.TASK3_TEST_TENANT_B_ID || ""
  ).trim();
  const propertyAId = String(
    process.env.TASK3_TEST_PROPERTY_A_ID || ""
  ).trim();
  const propertyBId = String(
    process.env.TASK3_TEST_PROPERTY_B_ID || ""
  ).trim();
  if (
    !tenantAId ||
    !tenantBId ||
    !propertyAId ||
    !propertyBId ||
    slugA === slugB
  ) {
    throw createVerifierError(
      "TASK3_STAFF_SESSION_LIVE_CONTEXTS_INVALID",
      "Two distinct tenant test contexts are required"
    );
  }
  return {
    baseUrl: normalizeBaseUrl(
      process.env.TASK3_STAFF_SESSION_LIVE_BASE_URL
    ),
    contextA: {
      slug: slugA,
      forgedSlug: slugB,
      forgedTenantId: tenantBId,
      forgedPropertyId: propertyBId
    },
    contextB: {
      slug: slugB,
      forgedSlug: slugA,
      forgedTenantId: tenantAId,
      forgedPropertyId: propertyAId
    },
    iterations: readPositiveInteger(
      process.env.TASK3_STAFF_ROUTE_CONCURRENCY_ITERATIONS,
      DEFAULT_ITERATIONS
    )
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
        "TASK3_STAFF_SESSION_LIVE_RESPONSE_INVALID",
        "Live staff session endpoint did not return JSON"
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
  const forbidden = new Set([
    "tenant_id",
    "property_id",
    "tenantId",
    "propertyId"
  ]);
  return Object.entries(value).some(
    ([key, nested]) => forbidden.has(key) || hasInternalContext(nested)
  );
}

function verifySessionResponse(result, expectedSlug) {
  const body = result.body || {};
  const staffUser = body.staffUser;
  const features = body.features;
  const validFeatureContract =
    features &&
    typeof features === "object" &&
    features.hotelSlug === expectedSlug &&
    typeof features.enableFoodModule === "boolean" &&
    typeof features.enableRoomModule === "boolean" &&
    typeof features.businessType === "string";
  const featuresMatch =
    JSON.stringify(staffUser?.features) === JSON.stringify(features);
  if (
    result.status !== 200 ||
    body.success !== true ||
    !staffUser ||
    typeof staffUser !== "object" ||
    staffUser.hotelSlug !== expectedSlug ||
    staffUser.role !== "staff" ||
    staffUser.isManager !== false ||
    staffUser.kdsRole !== "general" ||
    !validFeatureContract ||
    !featuresMatch
  ) {
    const safeCode = String(body.code || "")
      .replace(/[^A-Z0-9_-]/gi, "")
      .slice(0, 80);
    throw createVerifierError(
      "TASK3_STAFF_SESSION_LIVE_RESPONSE_MISMATCH",
      [
        "Live staff session endpoint returned an invalid contract",
        `status=${Number(result.status || 0)}`,
        `success=${body.success === true}`,
        `code=${safeCode || "none"}`,
        `hotelMatch=${staffUser?.hotelSlug === expectedSlug}`,
        `featuresValid=${validFeatureContract}`,
        `featuresMatch=${featuresMatch}`
      ].join(" ")
    );
  }
  if (hasInternalContext(body)) {
    throw createVerifierError(
      "TASK3_STAFF_SESSION_LIVE_CONTEXT_EXPOSED",
      "Live staff session endpoint exposed ownership fields"
    );
  }
  return {
    httpStatus: result.status,
    matchedSlug: staffUser.hotelSlug,
    businessType: features.businessType,
    internalContextExposed: false
  };
}

function createStaffToken(slug) {
  return signStaffToken({
    id: `TASK3E_STAFF_SESSION_LIVE_${crypto
      .createHash("sha256")
      .update(slug)
      .digest("hex")
      .slice(0, 16)}`,
    hotel_slug: slug,
    display_name: "Task 3E Staff Session Live Verifier",
    role: "staff",
    kds_role: "general"
  });
}

async function probeSession(baseUrl, context) {
  const query = new URLSearchParams({
    hotelSlug: context.forgedSlug,
    tenant_id: context.forgedTenantId,
    property_id: context.forgedPropertyId
  });
  const result = await requestJson(
    `${baseUrl}/api/staff/me?${query}`,
    {
      headers: {
        authorization: `Bearer ${createStaffToken(context.slug)}`,
        "x-tenant-id": context.forgedTenantId,
        "x-property-id": context.forgedPropertyId
      }
    }
  );
  return verifySessionResponse(result, context.slug);
}

function requireReadyCheck(readiness, name) {
  const check = readiness.body?.checks?.find(
    (candidate) => candidate?.name === name
  );
  if (
    !check ||
    check.ready !== true ||
    check.enabled !== true
  ) {
    throw createVerifierError(
      "TASK3_STAFF_SESSION_LIVE_RUNTIME_DISABLED",
      `Readiness check ${name} is not enabled and ready`
    );
  }
}

function safeFailure(error) {
  const code = String(
    error?.code || "TASK3_STAFF_SESSION_LIVE_FAILED"
  );
  return {
    success: false,
    code,
    message: code.startsWith("TASK3_")
      ? String(
          error?.message ||
            "Live staff session verification failed"
        )
      : "Live staff session request failed"
  };
}

async function main() {
  const inputs = readInputs();
  const health = await requestJson(
    `${inputs.baseUrl}/api/health`
  );
  if (health.status !== 200 || health.body?.success !== true) {
    throw createVerifierError(
      "TASK3_STAFF_SESSION_LIVE_HEALTH_FAILED",
      "Backend health endpoint is not healthy"
    );
  }
  const readiness = await requestJson(
    `${inputs.baseUrl}/api/readiness`
  );
  if (
    readiness.status !== 200 ||
    readiness.body?.success !== true ||
    readiness.body?.ready !== true
  ) {
    throw createVerifierError(
      "TASK3_STAFF_SESSION_LIVE_READINESS_FAILED",
      "Backend readiness endpoint is not ready"
    );
  }
  for (const name of REQUIRED_READINESS_CHECKS) {
    requireReadyCheck(readiness, name);
  }
  const anonymous = await requestJson(
    `${inputs.baseUrl}/api/staff/me`
  );
  if (
    anonymous.status !== 401 ||
    anonymous.body?.success !== false
  ) {
    throw createVerifierError(
      "TASK3_STAFF_SESSION_LIVE_AUTH_REQUIRED_FAILED",
      "Live staff session route did not reject anonymous access"
    );
  }
  const tenantA = await probeSession(
    inputs.baseUrl,
    inputs.contextA
  );
  const tenantB = await probeSession(
    inputs.baseUrl,
    inputs.contextB
  );
  const unknown = await requestJson(
    `${inputs.baseUrl}/api/staff/me`,
    {
      headers: {
        authorization:
          `Bearer ${createStaffToken(
            "task3e-property-does-not-exist"
          )}`
      }
    }
  );
  if (
    unknown.status !== 403 ||
    unknown.body?.success !== false
  ) {
    throw createVerifierError(
      "TASK3_STAFF_SESSION_LIVE_UNKNOWN_SLUG_FAILED",
      "Unknown live staff hotel scope did not fail closed"
    );
  }

  let concurrentPasses = 0;
  for (
    let index = 0;
    index < inputs.iterations;
    index += 1
  ) {
    const pair = await Promise.all([
      probeSession(inputs.baseUrl, inputs.contextA),
      probeSession(inputs.baseUrl, inputs.contextB)
    ]);
    concurrentPasses += pair.length;
  }
  const expectedPasses = inputs.iterations * 2;
  if (concurrentPasses !== expectedPasses) {
    throw createVerifierError(
      "TASK3_STAFF_SESSION_LIVE_CONCURRENCY_FAILED",
      "Live concurrent staff session probes did not pass"
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      success: true,
      mode: "LIVE_READ_ONLY_STAFF_SESSION_ROUTE_CANARY",
      route: "/api/staff/me",
      tokenTransport: "REDACTED_AUTHORIZATION_HEADER",
      health: "PASS",
      readiness: "PASS",
      tenantRuntimeDatabase: "PASS",
      tenantRuntimeStaffMenu: "PASS",
      tenantRuntimeStaffOrderingSettings: "PASS",
      tenantRuntimeStaffSession: "PASS",
      anonymousRejected: true,
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
      staffWritesMigrated: false,
      result: "PASS",
      timestamp: new Date().toISOString()
    }, null, 2)}\n`
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify(safeFailure(error), null, 2)}\n`
    );
    process.exitCode = 1;
  });
}

module.exports = {
  ALLOWED_BASE_URL,
  hasInternalContext,
  normalizeBaseUrl,
  verifySessionResponse
};
