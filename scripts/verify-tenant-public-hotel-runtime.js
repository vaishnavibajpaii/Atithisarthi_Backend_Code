"use strict";

require("dotenv").config({ quiet: true });

process.env.TENANT_RUNTIME_ENABLED = "true";
process.env.TENANT_RUNTIME_PUBLIC_HOTEL_ENABLED = "true";
process.env.PAYMENT_WEBHOOK_WORKER_ENABLED = "false";
process.env.NOTIFICATION_DELIVERY_ENABLED = "false";
process.env.SUPABASE_URL ||= "https://tenant-public-route-verifier.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const express = require("express");
const publicRouter = require("../routes/public");
const { closeTenantPool } = require("../utils/tenant-database");
const {
  normalizePropertySlug
} = require("../utils/tenant-request-context");
const {
  validateTenantDatabaseUrl
} = require("./verify-tenant-runtime-connection");

const EXPECTED_CONFIRMATION = "TASK3E_PUBLIC_READ_ONLY";
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
      "TASK3_PUBLIC_ROUTE_ITERATIONS_INVALID",
      "TASK3_PUBLIC_ROUTE_CONCURRENCY_ITERATIONS must be from 1 to 50"
    );
  }
  return parsed;
}

function readInputs() {
  if (
    process.env.TASK3_PUBLIC_HOTEL_VERIFY_CONFIRM !== EXPECTED_CONFIRMATION
  ) {
    throw createVerifierError(
      "TASK3_PUBLIC_ROUTE_CONFIRMATION_MISSING",
      `Set TASK3_PUBLIC_HOTEL_VERIFY_CONFIRM=${EXPECTED_CONFIRMATION}`
    );
  }
  validateTenantDatabaseUrl(process.env.TENANT_DATABASE_URL);

  const tenantAId = String(process.env.TASK3_TEST_TENANT_A_ID || "").trim();
  const tenantBId = String(process.env.TASK3_TEST_TENANT_B_ID || "").trim();
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
      "TASK3_PUBLIC_ROUTE_CONTEXTS_INVALID",
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

function startLocalApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use("/api/public", publicRouter);
  app.use((error, req, res, next) => {
    void next;
    res.status(500).json({
      success: false,
      code: error?.code || "TASK3_PUBLIC_ROUTE_UNHANDLED",
      message: "Tenant public route verification failed"
    });
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(createVerifierError(
          "TASK3_PUBLIC_ROUTE_SERVER_INVALID",
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
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
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
    let body = null;
    try {
      body = await response.json();
    } catch {
      throw createVerifierError(
        "TASK3_PUBLIC_ROUTE_RESPONSE_INVALID",
        "Public hotel route did not return JSON"
      );
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

function verifySuccessfulHotelResponse(result, expectedSlug) {
  if (
    result.status !== 200 ||
    result.body?.success !== true ||
    result.body?.hotel?.hotel_slug !== expectedSlug
  ) {
    throw createVerifierError(
      "TASK3_PUBLIC_ROUTE_RESPONSE_MISMATCH",
      "Public hotel route did not return the expected canonical property"
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(result.body.hotel, "tenant_id") ||
    Object.prototype.hasOwnProperty.call(result.body.hotel, "property_id")
  ) {
    throw createVerifierError(
      "TASK3_PUBLIC_ROUTE_CONTEXT_EXPOSED",
      "Internal canonical ownership fields were exposed publicly"
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
  return verifySuccessfulHotelResponse(result, context.slug);
}

function safeFailure(error) {
  const code = error?.code ? String(error.code) : "TASK3_PUBLIC_ROUTE_FAILED";
  const safeMessage =
    code.startsWith("TASK3_") || code.startsWith("TENANT_")
      ? String(error?.message || "Tenant public route verification failed")
      : "Tenant public route connection or query failed";
  return {
    success: false,
    code,
    message: safeMessage
  };
}

async function main() {
  const inputs = readInputs();
  let localServer;
  try {
    const local = await startLocalApp();
    localServer = local.server;

    const tenantA = await probeHotel(local.baseUrl, inputs.contextA);
    const tenantB = await probeHotel(local.baseUrl, inputs.contextB);

    const unknown = await requestJson(
      `${local.baseUrl}/api/public/hotel/task3e-property-does-not-exist`
    );
    if (unknown.status !== 404 || unknown.body?.success !== false) {
      throw createVerifierError(
        "TASK3_PUBLIC_ROUTE_UNKNOWN_SLUG_FAILED",
        "Unknown public hotel slug did not fail closed"
      );
    }

    let concurrentPasses = 0;
    for (let index = 0; index < inputs.iterations; index += 1) {
      const pair = await Promise.all([
        probeHotel(local.baseUrl, inputs.contextA),
        probeHotel(local.baseUrl, inputs.contextB)
      ]);
      concurrentPasses += pair.length;
    }

    const expectedPasses = inputs.iterations * 2;
    if (concurrentPasses !== expectedPasses) {
      throw createVerifierError(
        "TASK3_PUBLIC_ROUTE_CONCURRENCY_FAILED",
        "Concurrent public tenant route probes did not all pass"
      );
    }

    process.stdout.write(`${JSON.stringify({
      success: true,
      mode: "READ_ONLY_ROUTE_PILOT",
      route: "/api/public/hotel/:slug",
      runtimeRole: "app_tenant_runtime",
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
  } finally {
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
  readInputs,
  readPositiveInteger,
  verifySuccessfulHotelResponse
};
