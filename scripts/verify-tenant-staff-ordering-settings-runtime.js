"use strict";

require("dotenv").config({ quiet: true });

process.env.TENANT_RUNTIME_ENABLED = "true";
process.env.TENANT_RUNTIME_STAFF_ORDERING_SETTINGS_ENABLED = "true";
process.env.PAYMENT_WEBHOOK_WORKER_ENABLED = "false";
process.env.NOTIFICATION_DELIVERY_ENABLED = "false";
process.env.SUPABASE_URL ||= "https://tenant-staff-ordering-verifier.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const express = require("express");
const crypto = require("crypto");
const staffRouter = require("../routes/staff");
const { signStaffToken } = require("../utils/auth");
const {
  fetchHotelFeatureConfig,
  isHotelFeatureEnabled
} = require("../utils/hotel-feature-settings");
const {
  fetchHotelOrderingSettings
} = require("../utils/hotel-ordering-settings");
const {
  buildStaffOrderingSettingsPayload
} = require("../utils/staff-ordering-settings-presentation");
const {
  closeTenantPool
} = require("../utils/tenant-database");
const {
  normalizePropertySlug
} = require("../utils/tenant-request-context");
const {
  supabase
} = require("../utils/supabase");
const {
  validateTenantDatabaseUrl
} = require("./verify-tenant-runtime-connection");

const EXPECTED_CONFIRMATION =
  "TASK3E_STAFF_ORDERING_SETTINGS_READ_ONLY";
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
      "TASK3_STAFF_ORDERING_ITERATIONS_INVALID",
      "TASK3_STAFF_ROUTE_CONCURRENCY_ITERATIONS must be from 1 to 50"
    );
  }
  return parsed;
}

function readInputs() {
  if (
    process.env.TASK3_STAFF_ORDERING_SETTINGS_VERIFY_CONFIRM !==
    EXPECTED_CONFIRMATION
  ) {
    throw createVerifierError(
      "TASK3_STAFF_ORDERING_CONFIRMATION_MISSING",
      `Set TASK3_STAFF_ORDERING_SETTINGS_VERIFY_CONFIRM=${EXPECTED_CONFIRMATION}`
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
      "TASK3_STAFF_ORDERING_CONTEXTS_INVALID",
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
          "TASK3_STAFF_ORDERING_SERVER_INVALID",
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
        "TASK3_STAFF_ORDERING_RESPONSE_INVALID",
        "Staff ordering-settings route did not return JSON"
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

function verifyOrderingResponse(result, expectedSlug) {
  const ordering = result.body?.ordering;
  const requiredBooleans = [
    "staffOrderingEnabled",
    "enforceTableMaster",
    "secureOnlinePaymentEnabled",
    "cashOnDeliveryEnabled",
    "manualUpiPaymentEnabled"
  ];
  if (
    result.status !== 200 ||
    result.body?.success !== true ||
    result.body?.hotelSlug !== expectedSlug ||
    !ordering ||
    typeof ordering !== "object" ||
    requiredBooleans.some(
      (key) => typeof ordering[key] !== "boolean"
    )
  ) {
    throw createVerifierError(
      "TASK3_STAFF_ORDERING_RESPONSE_MISMATCH",
      "Staff ordering-settings route returned an invalid contract"
    );
  }
  if (hasInternalContext(result.body)) {
    throw createVerifierError(
      "TASK3_STAFF_ORDERING_CONTEXT_EXPOSED",
      "Staff ordering-settings response exposed ownership fields"
    );
  }
  return {
    httpStatus: result.status,
    matchedSlug: result.body.hotelSlug,
    internalContextExposed: false
  };
}

function createStaffToken(slug) {
  return signStaffToken({
    id: `TASK3E_STAFF_ORDERING_${crypto
      .createHash("sha256")
      .update(slug)
      .digest("hex")
      .slice(0, 16)}`,
    hotel_slug: slug,
    display_name: "Task 3E Staff Ordering Verifier",
    role: "staff",
    kds_role: "general"
  });
}

async function probeOrdering(baseUrl, context) {
  const query = new URLSearchParams({
    hotelSlug: context.forgedSlug,
    tenant_id: context.forgedTenantId,
    property_id: context.forgedPropertyId
  });
  const result = await requestJson(
    `${baseUrl}/api/staff/ordering-settings?${query}`,
    {
      headers: {
        authorization: `Bearer ${createStaffToken(context.slug)}`,
        "x-tenant-id": context.forgedTenantId,
        "x-property-id": context.forgedPropertyId
      }
    }
  );
  return {
    evidence: verifyOrderingResponse(result, context.slug),
    payload: result.body
  };
}

async function fetchLegacyPayload(hotelSlug) {
  const featureConfig = await fetchHotelFeatureConfig(
    supabase,
    hotelSlug
  );
  if (!isHotelFeatureEnabled(featureConfig, "food")) {
    throw createVerifierError(
      "TASK3_STAFF_ORDERING_FIXTURE_FEATURE_DISABLED",
      `Food feature is disabled for ${hotelSlug}`
    );
  }
  return buildStaffOrderingSettingsPayload({
    hotelSlug,
    settings: await fetchHotelOrderingSettings(hotelSlug)
  });
}

function verifyLegacyCompatibility(legacy, restricted) {
  const legacyJson = JSON.stringify(legacy);
  const restrictedJson = JSON.stringify(restricted);
  if (legacyJson !== restrictedJson) {
    throw createVerifierError(
      "TASK3_STAFF_ORDERING_COMPATIBILITY_FAILED",
      "Restricted ordering-settings output differs from legacy output"
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
    error?.code || "TASK3_STAFF_ORDERING_FAILED"
  );
  return {
    success: false,
    code,
    message:
      code.startsWith("TASK3_") || code.startsWith("TENANT_")
        ? String(
            error?.message ||
              "Tenant staff ordering verification failed"
          )
        : "Tenant staff ordering connection or query failed"
  };
}

async function main() {
  const inputs = readInputs();
  let localServer;
  try {
    const local = await startLocalApp();
    localServer = local.server;
    const anonymous = await requestJson(
      `${local.baseUrl}/api/staff/ordering-settings`
    );
    if (
      anonymous.status !== 401 ||
      anonymous.body?.success !== false
    ) {
      throw createVerifierError(
        "TASK3_STAFF_ORDERING_AUTH_REQUIRED_FAILED",
        "Ordering-settings route did not reject anonymous access"
      );
    }
    const tenantAResult = await probeOrdering(
      local.baseUrl,
      inputs.contextA
    );
    const tenantBResult = await probeOrdering(
      local.baseUrl,
      inputs.contextB
    );
    const compatibility = {
      tenantA: verifyLegacyCompatibility(
        await fetchLegacyPayload(inputs.contextA.slug),
        tenantAResult.payload
      ),
      tenantB: verifyLegacyCompatibility(
        await fetchLegacyPayload(inputs.contextB.slug),
        tenantBResult.payload
      )
    };
    const unknown = await requestJson(
      `${local.baseUrl}/api/staff/ordering-settings`,
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
        "TASK3_STAFF_ORDERING_UNKNOWN_SLUG_FAILED",
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
        probeOrdering(local.baseUrl, inputs.contextA),
        probeOrdering(local.baseUrl, inputs.contextB)
      ]);
      concurrentPasses += pair.length;
    }
    const expectedPasses = inputs.iterations * 2;
    if (concurrentPasses !== expectedPasses) {
      throw createVerifierError(
        "TASK3_STAFF_ORDERING_CONCURRENCY_FAILED",
        "Concurrent ordering-settings probes did not all pass"
      );
    }
    process.stdout.write(
      `${JSON.stringify({
        success: true,
        mode: "READ_ONLY_STAFF_ORDERING_SETTINGS_ROUTE_PILOT",
        route: "/api/staff/ordering-settings",
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
        paymentMethodPatchMigrated: false,
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
  verifyOrderingResponse
};
