"use strict";

require("dotenv").config({ quiet: true });

process.env.TENANT_RUNTIME_ENABLED = "true";
process.env.TENANT_RUNTIME_PUBLIC_ROOMS_ENABLED = "true";
process.env.PAYMENT_WEBHOOK_WORKER_ENABLED = "false";
process.env.NOTIFICATION_DELIVERY_ENABLED = "false";
process.env.SUPABASE_URL ||= "https://tenant-public-rooms-verifier.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const crypto = require("crypto");
const express = require("express");
const publicRoomsRouter = require("../routes/public-room-booking");
const { env } = require("../config/env");
const { closeTenantPool } = require("../utils/tenant-database");
const { normalizePropertySlug } = require("../utils/tenant-request-context");
const { validateTenantDatabaseUrl } = require("./verify-tenant-runtime-connection");

const EXPECTED_CONFIRMATION = "TASK3E_PUBLIC_ROOMS_READ_ONLY";
const DEFAULT_ITERATIONS = 10;
const DEFAULT_CHECK_IN = "2099-01-15";
const DEFAULT_CHECK_OUT = "2099-01-17";

function createVerifierError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value || fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 50) {
    throw createVerifierError(
      "TASK3_PUBLIC_ROOMS_ITERATIONS_INVALID",
      "TASK3_PUBLIC_ROUTE_CONCURRENCY_ITERATIONS must be from 1 to 50"
    );
  }
  return parsed;
}

function readInputs() {
  if (process.env.TASK3_PUBLIC_ROOMS_VERIFY_CONFIRM !== EXPECTED_CONFIRMATION) {
    throw createVerifierError(
      "TASK3_PUBLIC_ROOMS_CONFIRMATION_MISSING",
      `Set TASK3_PUBLIC_ROOMS_VERIFY_CONFIRM=${EXPECTED_CONFIRMATION}`
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
      "TASK3_PUBLIC_ROOMS_CONTEXTS_INVALID",
      "Two distinct canonical tenant/property test contexts are required"
    );
  }
  return {
    contextA: { slug: slugA, forgedTenantId: tenantBId, forgedPropertyId: propertyBId },
    contextB: { slug: slugB, forgedTenantId: tenantAId, forgedPropertyId: propertyAId },
    checkInDate: String(process.env.TASK3_PUBLIC_ROOMS_CHECK_IN_DATE || DEFAULT_CHECK_IN),
    checkOutDate: String(process.env.TASK3_PUBLIC_ROOMS_CHECK_OUT_DATE || DEFAULT_CHECK_OUT),
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
  app.use("/api/public/rooms", publicRoomsRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(createVerifierError("TASK3_PUBLIC_ROOMS_SERVER_INVALID", "Local verifier did not expose a TCP port"));
        return;
      }
      resolve({ baseUrl: `http://127.0.0.1:${address.port}`, server });
    });
    server.once("error", reject);
  });
}

async function stopLocalApp(server) {
  if (!server) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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
      throw createVerifierError("TASK3_PUBLIC_ROOMS_RESPONSE_INVALID", "Public rooms route did not return JSON");
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
  return Object.entries(value).some(([key, nested]) => forbidden.has(key) || hasInternalContext(nested));
}

function verifyRoomPayload(result, kind) {
  if (result.status !== 200 || result.body?.success !== true) {
    const safeCode = String(result.body?.code || "").slice(0, 120);
    const safeMessage = String(result.body?.message || "").slice(0, 240);
    throw createVerifierError(
      "TASK3_PUBLIC_ROOMS_RESPONSE_MISMATCH",
      `Public room ${kind} route returned HTTP ${result.status}` +
        `${safeCode ? ` code ${safeCode}` : ""}` +
        `${safeMessage ? `: ${safeMessage}` : ""}`
    );
  }
  if (hasInternalContext(result.body)) {
    throw createVerifierError(
      "TASK3_PUBLIC_ROOMS_CONTEXT_EXPOSED",
      `Public room ${kind} response exposed internal ownership fields`
    );
  }
  if (kind === "list" || kind === "availability") {
    if (!Array.isArray(result.body.rooms) || result.body.count !== result.body.rooms.length) {
      throw createVerifierError("TASK3_PUBLIC_ROOMS_RESPONSE_MISMATCH", `Public room ${kind} list shape is invalid`);
    }
  }
  if (kind.startsWith("discovery") && (!Array.isArray(result.body.items) || !result.body.pagination)) {
    throw createVerifierError("TASK3_PUBLIC_ROOMS_RESPONSE_MISMATCH", `Public room ${kind} discovery shape is invalid`);
  }
  if (kind === "detail" && (!result.body.room || typeof result.body.room !== "object")) {
    throw createVerifierError("TASK3_PUBLIC_ROOMS_RESPONSE_MISMATCH", "Public room detail shape is invalid");
  }
  return result.body;
}

function verifyRoomListOutcome(result) {
  if (
    result.status === 403 &&
    result.body?.success === false &&
    ["FEATURE_DISABLED", "ROOM_BOOKING_DISABLED"].includes(result.body?.code)
  ) {
    return {
      featureDisabled: true,
      httpStatus: result.status,
      code: result.body.code,
      body: result.body
    };
  }
  return {
    featureDisabled: false,
    httpStatus: result.status,
    body: verifyRoomPayload(result, "list")
  };
}

function compatibilityDigest(legacy, restricted, label) {
  const legacyJson = JSON.stringify(legacy);
  const restrictedJson = JSON.stringify(restricted);
  if (legacyJson !== restrictedJson) {
    throw createVerifierError(
      "TASK3_PUBLIC_ROOMS_COMPATIBILITY_FAILED",
      `Restricted ${label} output differs from the current legacy output`
    );
  }
  return crypto.createHash("sha256").update(restrictedJson).digest("hex").slice(0, 16);
}

function buildHeaders(context) {
  return {
    "x-tenant-id": context.forgedTenantId,
    "x-property-id": context.forgedPropertyId
  };
}

function querySuffix(context) {
  return new URLSearchParams({
    tenant_id: context.forgedTenantId,
    property_id: context.forgedPropertyId
  }).toString();
}

async function fetchSuite(baseUrl, context, dates) {
  const slug = encodeURIComponent(context.slug);
  const forged = querySuffix(context);
  const dateQuery = new URLSearchParams({
    checkInDate: dates.checkInDate,
    checkOutDate: dates.checkOutDate,
    adults: "1",
    children: "0",
    tenant_id: context.forgedTenantId,
    property_id: context.forgedPropertyId
  }).toString();
  const headers = buildHeaders(context);
  const listResult = await requestJson(`${baseUrl}/api/public/rooms/${slug}?${forged}`, { headers });
  const listOutcome = verifyRoomListOutcome(listResult);
  if (listOutcome.featureDisabled) {
    return {
      featureDisabled: true,
      featureGate: listOutcome.body
    };
  }
  const list = listOutcome.body;
  const typeDiscovery = verifyRoomPayload(
    await requestJson(`${baseUrl}/api/public/rooms/${slug}/discovery?mode=types&page=1&pageSize=12&${dateQuery}`, { headers }),
    "discovery-types"
  );
  const roomDiscovery = verifyRoomPayload(
    await requestJson(`${baseUrl}/api/public/rooms/${slug}/discovery?mode=rooms&page=1&pageSize=12&${dateQuery}`, { headers }),
    "discovery-rooms"
  );
  const availability = verifyRoomPayload(
    await requestJson(`${baseUrl}/api/public/rooms/${slug}/availability?${dateQuery}`, { headers }),
    "availability"
  );
  let detail = null;
  const roomId = list.rooms[0]?.id;
  if (roomId) {
    detail = verifyRoomPayload(
      await requestJson(`${baseUrl}/api/public/rooms/${slug}/rooms/${encodeURIComponent(roomId)}?${forged}`, { headers }),
      "detail"
    );
  }
  return { list, typeDiscovery, roomDiscovery, availability, detail };
}

async function probeRestricted(baseUrl, context, dates) {
  env.tenantRuntimePublicRoomsEnabled = true;
  return fetchSuite(baseUrl, context, dates);
}

async function fetchLegacy(baseUrl, context, dates) {
  env.tenantRuntimePublicRoomsEnabled = false;
  try {
    return await fetchSuite(baseUrl, context, dates);
  } finally {
    env.tenantRuntimePublicRoomsEnabled = true;
  }
}

function summarizeSuite(suite) {
  if (suite.featureDisabled) {
    return {
      featureDisabled: true,
      httpStatus: 403,
      code: suite.featureGate.code,
      internalContextExposed: false
    };
  }
  return {
    featureDisabled: false,
    listCount: suite.list.rooms.length,
    typeDiscoveryCount: suite.typeDiscovery.items.length,
    roomDiscoveryCount: suite.roomDiscovery.items.length,
    availabilityCount: suite.availability.rooms.length,
    detailChecked: Boolean(suite.detail),
    matchedSlug: suite.list.hotelSlug,
    internalContextExposed: false
  };
}

function compareSuites(legacy, restricted) {
  if (legacy.featureDisabled || restricted.featureDisabled) {
    if (!(legacy.featureDisabled && restricted.featureDisabled)) {
      throw createVerifierError(
        "TASK3_PUBLIC_ROOMS_COMPATIBILITY_FAILED",
        "Legacy and restricted room feature-gate outcomes differ"
      );
    }
    return {
      featureGate: compatibilityDigest(
        legacy.featureGate,
        restricted.featureGate,
        "room feature gate"
      )
    };
  }
  return {
    list: compatibilityDigest(legacy.list, restricted.list, "room list"),
    typeDiscovery: compatibilityDigest(legacy.typeDiscovery, restricted.typeDiscovery, "room-type discovery"),
    roomDiscovery: compatibilityDigest(legacy.roomDiscovery, restricted.roomDiscovery, "physical-room discovery"),
    availability: compatibilityDigest(legacy.availability, restricted.availability, "room availability"),
    detail: legacy.detail || restricted.detail
      ? compatibilityDigest(legacy.detail, restricted.detail, "room detail")
      : "NOT_APPLICABLE"
  };
}

function safeFailure(error) {
  const code = error?.code ? String(error.code) : "TASK3_PUBLIC_ROOMS_FAILED";
  return {
    success: false,
    code,
    message: code.startsWith("TASK3_") || code.startsWith("TENANT_")
      ? String(error?.message || "Tenant public rooms verification failed")
      : "Tenant public rooms connection or query failed"
  };
}

async function main() {
  const inputs = readInputs();
  const dates = { checkInDate: inputs.checkInDate, checkOutDate: inputs.checkOutDate };
  let localServer;
  try {
    const local = await startLocalApp();
    localServer = local.server;
    const tenantARestricted = await probeRestricted(local.baseUrl, inputs.contextA, dates);
    const tenantALegacy = await fetchLegacy(local.baseUrl, inputs.contextA, dates);
    const tenantBRestricted = await probeRestricted(local.baseUrl, inputs.contextB, dates);
    const tenantBLegacy = await fetchLegacy(local.baseUrl, inputs.contextB, dates);
    const compatibility = {
      tenantA: compareSuites(tenantALegacy, tenantARestricted),
      tenantB: compareSuites(tenantBLegacy, tenantBRestricted)
    };
    env.tenantRuntimePublicRoomsEnabled = true;
    const unknown = await requestJson(`${local.baseUrl}/api/public/rooms/task3e-property-does-not-exist`);
    if (unknown.status !== 404 || unknown.body?.success !== false) {
      throw createVerifierError("TASK3_PUBLIC_ROOMS_UNKNOWN_SLUG_FAILED", "Unknown public rooms slug did not fail closed");
    }
    let concurrentPasses = 0;
    for (let index = 0; index < inputs.iterations; index += 1) {
      const pair = await Promise.all([
        requestJson(`${local.baseUrl}/api/public/rooms/${encodeURIComponent(inputs.contextA.slug)}`),
        requestJson(`${local.baseUrl}/api/public/rooms/${encodeURIComponent(inputs.contextB.slug)}`)
      ]);
      pair.forEach((result) => verifyRoomListOutcome(result));
      concurrentPasses += pair.length;
    }
    const expectedPasses = inputs.iterations * 2;
    if (concurrentPasses !== expectedPasses) {
      throw createVerifierError("TASK3_PUBLIC_ROOMS_CONCURRENCY_FAILED", "Concurrent public room probes did not all pass");
    }
    process.stdout.write(`${JSON.stringify({
      success: true,
      mode: "READ_ONLY_PUBLIC_ROOMS_ROUTE_PILOT",
      routes: [
        "/api/public/rooms/:slug/discovery",
        "/api/public/rooms/:slug/rooms/:roomId",
        "/api/public/rooms/:slug",
        "/api/public/rooms/:slug/availability"
      ],
      runtimeRole: "app_tenant_runtime",
      dates,
      tenantA: summarizeSuite(tenantARestricted),
      tenantB: summarizeSuite(tenantBRestricted),
      legacyCompatibility: compatibility,
      forgedTenantInputsIgnored: true,
      twoRoomEnabledTenantsAvailable: !(
        tenantARestricted.featureDisabled || tenantBRestricted.featureDisabled
      ),
      tenantBExpectedFeatureDisabled: tenantBRestricted.featureDisabled === true,
      unknownSlug: { httpStatus: unknown.status, result: "PASS" },
      concurrency: { iterations: inputs.iterations, expectedPasses, actualPasses: concurrentPasses, result: "PASS" },
      bookingPostMigrated: false,
      result: "PASS",
      timestamp: new Date().toISOString()
    }, null, 2)}\n`);
  } finally {
    env.tenantRuntimePublicRoomsEnabled = true;
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
  hasInternalContext,
  readPositiveInteger,
  summarizeSuite,
  verifyRoomListOutcome,
  verifyRoomPayload
};
