"use strict";

require("dotenv").config({ quiet: true });

process.env.TENANT_RUNTIME_ENABLED = "true";
process.env.TENANT_RUNTIME_STAFF_SESSION_ENABLED = "true";
process.env.PAYMENT_WEBHOOK_WORKER_ENABLED = "false";
process.env.NOTIFICATION_DELIVERY_ENABLED = "false";
process.env.SUPABASE_URL ||= "https://tenant-staff-session-verifier.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const crypto = require("crypto");
const express = require("express");
const staffRouter = require("../routes/staff");
const { signStaffToken } = require("../utils/auth");
const {
  fetchHotelFeatureConfig
} = require("../utils/hotel-feature-settings");
const {
  buildStaffSessionPayload
} = require("../utils/staff-session-presentation");
const { closeTenantPool } = require("../utils/tenant-database");
const {
  normalizePropertySlug
} = require("../utils/tenant-request-context");
const { supabase } = require("../utils/supabase");
const {
  validateTenantDatabaseUrl
} = require("./verify-tenant-runtime-connection");

const EXPECTED_CONFIRMATION = "TASK3E_STAFF_SESSION_READ_ONLY";
const DEFAULT_ITERATIONS = 10;

function createVerifierError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value || fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 50) {
    throw createVerifierError(
      "TASK3_STAFF_SESSION_ITERATIONS_INVALID",
      "TASK3_STAFF_ROUTE_CONCURRENCY_ITERATIONS must be from 1 to 50"
    );
  }
  return parsed;
}

function readInputs() {
  if (
    process.env.TASK3_STAFF_SESSION_VERIFY_CONFIRM !==
    EXPECTED_CONFIRMATION
  ) {
    throw createVerifierError(
      "TASK3_STAFF_SESSION_CONFIRMATION_MISSING",
      `Set TASK3_STAFF_SESSION_VERIFY_CONFIRM=${EXPECTED_CONFIRMATION}`
    );
  }
  validateTenantDatabaseUrl(process.env.TENANT_DATABASE_URL);
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
  const slugA = normalizePropertySlug(
    process.env.TASK3_TEST_PROPERTY_A_SLUG
  );
  const slugB = normalizePropertySlug(
    process.env.TASK3_TEST_PROPERTY_B_SLUG
  );
  if (
    !tenantAId ||
    !tenantBId ||
    !propertyAId ||
    !propertyBId ||
    tenantAId === tenantBId ||
    propertyAId === propertyBId ||
    slugA === slugB
  ) {
    throw createVerifierError(
      "TASK3_STAFF_SESSION_CONTEXTS_INVALID",
      "Two distinct canonical tenant/property contexts are required"
    );
  }
  return {
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

function startLocalApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use("/api/staff", staffRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(createVerifierError(
          "TASK3_STAFF_SESSION_SERVER_INVALID",
          "Local verification server did not expose a TCP port"
        ));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        server
      });
    });
    server.once("error", reject);
  });
}

async function stopLocalApp(server) {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    let body;
    try {
      body = await response.json();
    } catch {
      throw createVerifierError(
        "TASK3_STAFF_SESSION_RESPONSE_INVALID",
        "Staff session route did not return JSON"
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
    JSON.stringify(staffUser.features) !== JSON.stringify(features)
  ) {
    throw createVerifierError(
      "TASK3_STAFF_SESSION_RESPONSE_MISMATCH",
      "Staff session route returned an invalid contract"
    );
  }
  if (hasInternalContext(body)) {
    throw createVerifierError(
      "TASK3_STAFF_SESSION_CONTEXT_EXPOSED",
      "Staff session response exposed ownership fields"
    );
  }
  return {
    httpStatus: result.status,
    matchedSlug: staffUser.hotelSlug,
    businessType: features.businessType,
    internalContextExposed: false
  };
}

function createStaffIdentity(slug) {
  return {
    id: `TASK3E_STAFF_SESSION_${crypto
      .createHash("sha256")
      .update(slug)
      .digest("hex")
      .slice(0, 16)}`,
    hotel_slug: slug,
    display_name: "Task 3E Staff Session Verifier",
    role: "staff",
    kds_role: "general"
  };
}

async function probeSession(baseUrl, context) {
  const identity = createStaffIdentity(context.slug);
  const query = new URLSearchParams({
    hotelSlug: context.forgedSlug,
    tenant_id: context.forgedTenantId,
    property_id: context.forgedPropertyId
  });
  const result = await requestJson(
    `${baseUrl}/api/staff/me?${query}`,
    {
      headers: {
        authorization: `Bearer ${signStaffToken(identity)}`,
        "x-tenant-id": context.forgedTenantId,
        "x-property-id": context.forgedPropertyId
      }
    }
  );
  return {
    evidence: verifySessionResponse(result, context.slug),
    identity,
    payload: result.body
  };
}

async function fetchLegacyPayload(identity) {
  const features = await fetchHotelFeatureConfig(
    supabase,
    identity.hotel_slug
  );
  return buildStaffSessionPayload({
    staffUser: {
      sub: identity.id,
      hotelSlug: identity.hotel_slug,
      displayName: identity.display_name,
      role: identity.role,
      kdsRole: identity.kds_role
    },
    features
  });
}

function verifyLegacyCompatibility(legacy, restricted) {
  const legacyJson = JSON.stringify(legacy);
  const restrictedJson = JSON.stringify(restricted);
  if (legacyJson !== restrictedJson) {
    throw createVerifierError(
      "TASK3_STAFF_SESSION_COMPATIBILITY_FAILED",
      "Restricted staff session output differs from legacy output"
    );
  }
  return {
    result: "PASS",
    payloadDigest: crypto
      .createHash("sha256")
      .update(restrictedJson)
      .digest("hex")
      .slice(0, 16)
  };
}

function safeFailure(error) {
  const code = String(
    error?.code || "TASK3_STAFF_SESSION_FAILED"
  );
  return {
    success: false,
    code,
    message:
      code.startsWith("TASK3_") || code.startsWith("TENANT_")
        ? String(
            error?.message ||
              "Tenant staff session verification failed"
          )
        : "Tenant staff session connection or query failed"
  };
}

async function main() {
  const inputs = readInputs();
  let localServer;
  try {
    const local = await startLocalApp();
    localServer = local.server;
    const anonymous = await requestJson(
      `${local.baseUrl}/api/staff/me`
    );
    if (
      anonymous.status !== 401 ||
      anonymous.body?.success !== false
    ) {
      throw createVerifierError(
        "TASK3_STAFF_SESSION_AUTH_REQUIRED_FAILED",
        "Staff session route did not reject anonymous access"
      );
    }
    const tenantAResult = await probeSession(
      local.baseUrl,
      inputs.contextA
    );
    const tenantBResult = await probeSession(
      local.baseUrl,
      inputs.contextB
    );
    const compatibility = {
      tenantA: verifyLegacyCompatibility(
        await fetchLegacyPayload(tenantAResult.identity),
        tenantAResult.payload
      ),
      tenantB: verifyLegacyCompatibility(
        await fetchLegacyPayload(tenantBResult.identity),
        tenantBResult.payload
      )
    };
    const unknown = await requestJson(
      `${local.baseUrl}/api/staff/me`,
      {
        headers: {
          authorization: `Bearer ${signStaffToken(
            createStaffIdentity("task3e-property-does-not-exist")
          )}`
        }
      }
    );
    if (
      unknown.status !== 403 ||
      unknown.body?.success !== false
    ) {
      throw createVerifierError(
        "TASK3_STAFF_SESSION_UNKNOWN_SLUG_FAILED",
        "Unknown staff hotel scope did not fail closed"
      );
    }

    let concurrentPasses = 0;
    for (
      let index = 0;
      index < inputs.iterations;
      index += 1
    ) {
      const pair = await Promise.all([
        probeSession(local.baseUrl, inputs.contextA),
        probeSession(local.baseUrl, inputs.contextB)
      ]);
      concurrentPasses += pair.length;
    }
    const expectedPasses = inputs.iterations * 2;
    if (concurrentPasses !== expectedPasses) {
      throw createVerifierError(
        "TASK3_STAFF_SESSION_CONCURRENCY_FAILED",
        "Concurrent staff session probes did not all pass"
      );
    }
    process.stdout.write(
      `${JSON.stringify({
        success: true,
        mode: "READ_ONLY_STAFF_SESSION_ROUTE_PILOT",
        route: "/api/staff/me",
        runtimeRole: "app_tenant_runtime",
        authentication: "SIGNED_SYNTHETIC_LOCAL_STAFF_TOKEN",
        anonymousRejected: true,
        tenantA: tenantAResult.evidence,
        tenantB: tenantBResult.evidence,
        legacyCompatibility: compatibility,
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
  } finally {
    await stopLocalApp(localServer);
    await closeTenantPool();
  }
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
  hasInternalContext,
  readInputs,
  verifyLegacyCompatibility,
  verifySessionResponse
};
