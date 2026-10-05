"use strict";

require("dotenv").config({ quiet: true });

process.env.TENANT_RUNTIME_ENABLED = "true";
process.env.TENANT_RUNTIME_PUBLIC_ORDER_TRACKING_ENABLED = "true";
process.env.PAYMENT_WEBHOOK_WORKER_ENABLED = "false";
process.env.NOTIFICATION_DELIVERY_ENABLED = "false";
process.env.SUPABASE_URL ||= "https://tenant-public-order-tracking-verifier.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const crypto = require("crypto");
const express = require("express");
const orderTrackingRouter = require("../routes/order-tracking");
const { env } = require("../config/env");
const { supabase } = require("../utils/supabase");
const { closeTenantPool } = require("../utils/tenant-database");
const { normalizePropertySlug } = require("../utils/tenant-request-context");
const { validateTenantDatabaseUrl } = require("./verify-tenant-runtime-connection");

const EXPECTED_CONFIRMATION = "TASK3E_PUBLIC_ORDER_TRACKING_READ_ONLY";
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
      "TASK3_PUBLIC_ORDER_TRACKING_ITERATIONS_INVALID",
      "TASK3_PUBLIC_ROUTE_CONCURRENCY_ITERATIONS must be from 1 to 50"
    );
  }
  return parsed;
}

function readInputs() {
  if (
    process.env.TASK3_PUBLIC_ORDER_TRACKING_VERIFY_CONFIRM !==
    EXPECTED_CONFIRMATION
  ) {
    throw createVerifierError(
      "TASK3_PUBLIC_ORDER_TRACKING_CONFIRMATION_MISSING",
      `Set TASK3_PUBLIC_ORDER_TRACKING_VERIFY_CONFIRM=${EXPECTED_CONFIRMATION}`
    );
  }
  validateTenantDatabaseUrl(process.env.TENANT_DATABASE_URL);
  const tenantAId = String(process.env.TASK3_TEST_TENANT_A_ID || "").trim();
  const tenantBId = String(process.env.TASK3_TEST_TENANT_B_ID || "").trim();
  const propertyAId = String(process.env.TASK3_TEST_PROPERTY_A_ID || "").trim();
  const propertyBId = String(process.env.TASK3_TEST_PROPERTY_B_ID || "").trim();
  const slugA = normalizePropertySlug(process.env.TASK3_TEST_PROPERTY_A_SLUG);
  const slugB = normalizePropertySlug(process.env.TASK3_TEST_PROPERTY_B_SLUG);
  if (
    !tenantAId || !tenantBId || !propertyAId || !propertyBId ||
    tenantAId === tenantBId || propertyAId === propertyBId || slugA === slugB
  ) {
    throw createVerifierError(
      "TASK3_PUBLIC_ORDER_TRACKING_CONTEXTS_INVALID",
      "Two distinct canonical tenant/property test contexts are required"
    );
  }
  return {
    contextA: {
      slug: slugA,
      forgedTenantId: tenantBId,
      forgedPropertyId: propertyBId
    },
    contextB: {
      slug: slugB,
      forgedTenantId: tenantAId,
      forgedPropertyId: propertyAId
    },
    iterations: readPositiveInteger(
      process.env.TASK3_PUBLIC_ROUTE_CONCURRENCY_ITERATIONS,
      DEFAULT_ITERATIONS
    )
  };
}

async function discoverTrackingFixture(slug) {
  const result = await supabase
    .from("orders")
    .select("id,hotel_slug,tracking_token")
    .eq("hotel_slug", slug)
    .not("tracking_token", "is", null)
    .neq("tracking_token", "")
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (result.error) throw result.error;
  if (!result.data?.id || !result.data?.tracking_token) return null;
  return {
    slug,
    orderId: String(result.data.id),
    token: String(result.data.tracking_token)
  };
}

function startLocalApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use("/api/order-tracking", orderTrackingRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(createVerifierError(
          "TASK3_PUBLIC_ORDER_TRACKING_SERVER_INVALID",
          "Local verifier did not expose a TCP port"
        ));
        return;
      }
      resolve({ baseUrl: `http://127.0.0.1:${address.port}`, server });
    });
    server.once("error", reject);
  });
}

async function stopLocalApp(server) {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    let body;
    try {
      body = await response.json();
    } catch {
      throw createVerifierError(
        "TASK3_PUBLIC_ORDER_TRACKING_RESPONSE_INVALID",
        "Public order-tracking route did not return JSON"
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
    "propertyId",
    "tracking_token",
    "trackingToken"
  ]);
  return Object.entries(value).some(
    ([key, nested]) => forbidden.has(key) || hasInternalContext(nested)
  );
}

function verifyTrackingSuccess(result) {
  if (
    result.status !== 200 ||
    result.body?.success !== true ||
    !result.body?.order
  ) {
    throw createVerifierError(
      "TASK3_PUBLIC_ORDER_TRACKING_RESPONSE_MISMATCH",
      `Public order tracking returned HTTP ${result.status}`
    );
  }
  if (hasInternalContext(result.body)) {
    throw createVerifierError(
      "TASK3_PUBLIC_ORDER_TRACKING_CONTEXT_EXPOSED",
      "Public order-tracking response exposed internal ownership or token fields"
    );
  }
  return result.body;
}

function verifyTrackingDenied(result) {
  if (
    ![403, 404].includes(result.status) ||
    result.body?.success !== false ||
    hasInternalContext(result.body)
  ) {
    throw createVerifierError(
      "TASK3_PUBLIC_ORDER_TRACKING_DENY_FAILED",
      `Cross-tenant order-tracking probe returned HTTP ${result.status}`
    );
  }
  return {
    httpStatus: result.status,
    code: String(result.body?.code || ""),
    internalContextExposed: false
  };
}

function compatibilityDigest(legacy, restricted) {
  const legacyJson = JSON.stringify(legacy);
  const restrictedJson = JSON.stringify(restricted);
  if (legacyJson !== restrictedJson) {
    throw createVerifierError(
      "TASK3_PUBLIC_ORDER_TRACKING_COMPATIBILITY_FAILED",
      "Restricted order-tracking output differs from current legacy output"
    );
  }
  return crypto
    .createHash("sha256")
    .update(restrictedJson)
    .digest("hex")
    .slice(0, 16);
}

function fixtureDigest(fixture) {
  return crypto
    .createHash("sha256")
    .update(`${fixture.slug}:${fixture.orderId}`)
    .digest("hex")
    .slice(0, 16);
}

function buildTrackingUrl(baseUrl, fixture, forgedContext = {}) {
  const query = new URLSearchParams({
    token: fixture.token,
    tenant_id: forgedContext.forgedTenantId || "",
    property_id: forgedContext.forgedPropertyId || ""
  });
  return `${baseUrl}/api/order-tracking/${encodeURIComponent(fixture.slug)}/${encodeURIComponent(fixture.orderId)}?${query}`;
}

async function fetchWithMode(baseUrl, fixture, context, restricted) {
  env.tenantRuntimePublicOrderTrackingEnabled = restricted;
  return requestJson(buildTrackingUrl(baseUrl, fixture, context), {
    headers: {
      "x-tenant-id": context.forgedTenantId,
      "x-property-id": context.forgedPropertyId
    }
  });
}

function safeFailure(error) {
  const suppliedCode = error?.code ? String(error.code) : "";
  const code = suppliedCode || "TASK3_PUBLIC_ORDER_TRACKING_FAILED";
  const hasSafeSuppliedCode =
    suppliedCode.startsWith("TASK3_") ||
    suppliedCode.startsWith("TENANT_");
  return {
    success: false,
    code,
    message:
      hasSafeSuppliedCode
        ? String(error?.message || "Tenant public order-tracking verification failed")
        : "Tenant public order-tracking connection or query failed"
  };
}

async function main() {
  const inputs = readInputs();
  const fixtureA = await discoverTrackingFixture(inputs.contextA.slug);
  if (!fixtureA) {
    throw createVerifierError(
      "TASK3_PUBLIC_ORDER_TRACKING_FIXTURE_MISSING",
      "Tenant A has no existing order with opaque tracking evidence"
    );
  }
  const fixtureB = await discoverTrackingFixture(inputs.contextB.slug);
  let localServer;
  try {
    const local = await startLocalApp();
    localServer = local.server;

    const restrictedA = verifyTrackingSuccess(
      await fetchWithMode(local.baseUrl, fixtureA, inputs.contextA, true)
    );
    const legacyA = verifyTrackingSuccess(
      await fetchWithMode(local.baseUrl, fixtureA, inputs.contextA, false)
    );
    const compatibility = {
      tenantA: compatibilityDigest(legacyA, restrictedA)
    };

    let tenantB;
    if (fixtureB) {
      const restrictedB = verifyTrackingSuccess(
        await fetchWithMode(local.baseUrl, fixtureB, inputs.contextB, true)
      );
      const legacyB = verifyTrackingSuccess(
        await fetchWithMode(local.baseUrl, fixtureB, inputs.contextB, false)
      );
      compatibility.tenantB = compatibilityDigest(legacyB, restrictedB);
      tenantB = {
        trackingAvailable: true,
        fixtureReferenceDigest: fixtureDigest(fixtureB),
        matchedSlug: restrictedB.order.hotelSlug,
        internalContextExposed: false
      };
    } else {
      const crossTenantFixture = {
        ...fixtureA,
        slug: inputs.contextB.slug
      };
      env.tenantRuntimePublicOrderTrackingEnabled = true;
      tenantB = {
        trackingAvailable: false,
        crossTenantEvidenceDenied: verifyTrackingDenied(
          await requestJson(
            buildTrackingUrl(local.baseUrl, crossTenantFixture, inputs.contextB)
          )
        )
      };
      compatibility.tenantB = "NO_EXISTING_TRACKING_FIXTURE";
    }

    env.tenantRuntimePublicOrderTrackingEnabled = true;
    const wrongToken = verifyTrackingDenied(
      await requestJson(buildTrackingUrl(local.baseUrl, {
        ...fixtureA,
        token: `${fixtureA.token}-invalid`
      }, inputs.contextA))
    );
    const wrongSlug = verifyTrackingDenied(
      await requestJson(buildTrackingUrl(local.baseUrl, {
        ...fixtureA,
        slug: inputs.contextB.slug
      }, inputs.contextB))
    );
    const unknownSlug = verifyTrackingDenied(
      await requestJson(buildTrackingUrl(local.baseUrl, {
        ...fixtureA,
        slug: "task3e-property-does-not-exist"
      }, inputs.contextA))
    );

    let concurrentPasses = 0;
    for (let index = 0; index < inputs.iterations; index += 1) {
      const pair = await Promise.all([
        requestJson(buildTrackingUrl(local.baseUrl, fixtureA, inputs.contextA)),
        requestJson(buildTrackingUrl(local.baseUrl, {
          ...fixtureA,
          slug: inputs.contextB.slug
        }, inputs.contextB))
      ]);
      verifyTrackingSuccess(pair[0]);
      verifyTrackingDenied(pair[1]);
      concurrentPasses += 2;
    }
    const expectedPasses = inputs.iterations * 2;
    if (concurrentPasses !== expectedPasses) {
      throw createVerifierError(
        "TASK3_PUBLIC_ORDER_TRACKING_CONCURRENCY_FAILED",
        "Concurrent positive/deny tracking probes did not all pass"
      );
    }

    process.stdout.write(`${JSON.stringify({
      success: true,
      mode: "READ_ONLY_PUBLIC_ORDER_TRACKING_ROUTE_PILOT",
      route: "/api/order-tracking/:hotelSlug/:orderId",
      runtimeRole: "app_tenant_runtime",
      tenantA: {
        trackingAvailable: true,
        fixtureReferenceDigest: fixtureDigest(fixtureA),
        matchedSlug: restrictedA.order.hotelSlug,
        addOnCount: Array.isArray(restrictedA.order.addOns)
          ? restrictedA.order.addOns.length
          : 0,
        internalContextExposed: false
      },
      tenantB,
      legacyCompatibility: compatibility,
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
  } finally {
    env.tenantRuntimePublicOrderTrackingEnabled = true;
    await stopLocalApp(localServer);
    await closeTenantPool();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(safeFailure(error), null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  compatibilityDigest,
  fixtureDigest,
  hasInternalContext,
  readPositiveInteger,
  safeFailure,
  verifyTrackingDenied,
  verifyTrackingSuccess
};
