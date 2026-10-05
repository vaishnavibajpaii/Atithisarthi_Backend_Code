"use strict";

require("dotenv").config({ quiet: true });

const {
  normalizeBaseUrl,
  normalizeSlug,
  requireEnabledReadyCheck
} = require("./verify-tenant-public-hotel-live");
const {
  hasInternalContext,
  summarizeSuite,
  verifyRoomListOutcome,
  verifyRoomPayload
} = require("./verify-tenant-public-rooms-runtime");

const EXPECTED_CONFIRMATION = "TASK3E_PUBLIC_ROOMS_LIVE_READ_ONLY";
const DEFAULT_ITERATIONS = 10;
const DEFAULT_CHECK_IN = "2099-01-15";
const DEFAULT_CHECK_OUT = "2099-01-17";

function createVerifierError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readInputs() {
  if (process.env.TASK3_PUBLIC_ROOMS_LIVE_CONFIRM !== EXPECTED_CONFIRMATION) {
    throw createVerifierError(
      "TASK3_PUBLIC_ROOMS_LIVE_CONFIRMATION_MISSING",
      `Set TASK3_PUBLIC_ROOMS_LIVE_CONFIRM=${EXPECTED_CONFIRMATION}`
    );
  }
  const iterations = Number(process.env.TASK3_PUBLIC_ROUTE_CONCURRENCY_ITERATIONS || DEFAULT_ITERATIONS);
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 50) {
    throw createVerifierError(
      "TASK3_PUBLIC_ROOMS_LIVE_ITERATIONS_INVALID",
      "TASK3_PUBLIC_ROUTE_CONCURRENCY_ITERATIONS must be from 1 to 50"
    );
  }
  return {
    baseUrl: normalizeBaseUrl(process.env.TASK3_PUBLIC_ROOMS_LIVE_BASE_URL),
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
    checkInDate: String(process.env.TASK3_PUBLIC_ROOMS_CHECK_IN_DATE || DEFAULT_CHECK_IN),
    checkOutDate: String(process.env.TASK3_PUBLIC_ROOMS_CHECK_OUT_DATE || DEFAULT_CHECK_OUT),
    iterations
  };
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { ...options, redirect: "error", signal: controller.signal });
    let body;
    try { body = await response.json(); } catch {
      throw createVerifierError("TASK3_PUBLIC_ROOMS_LIVE_RESPONSE_INVALID", "Live public rooms endpoint did not return JSON");
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

function verifyExpectedSlug(body, expectedSlug, label) {
  if (body?.hotelSlug !== expectedSlug) {
    throw createVerifierError(
      "TASK3_PUBLIC_ROOMS_LIVE_PROPERTY_MISMATCH",
      `Live public room ${label} returned the wrong property slug`
    );
  }
  if (hasInternalContext(body)) {
    throw createVerifierError(
      "TASK3_PUBLIC_ROOMS_LIVE_CONTEXT_EXPOSED",
      `Live public room ${label} exposed internal ownership fields`
    );
  }
  return body;
}

async function probeTenant(baseUrl, context, dates) {
  const slug = encodeURIComponent(context.slug);
  const headers = {
    "x-tenant-id": context.forgedTenantId,
    "x-property-id": context.forgedPropertyId
  };
  const forged = new URLSearchParams({
    tenant_id: context.forgedTenantId,
    property_id: context.forgedPropertyId
  }).toString();
  const dateQuery = new URLSearchParams({
    checkInDate: dates.checkInDate,
    checkOutDate: dates.checkOutDate,
    adults: "1",
    children: "0",
    tenant_id: context.forgedTenantId,
    property_id: context.forgedPropertyId
  }).toString();
  const listOutcome = verifyRoomListOutcome(
    await requestJson(`${baseUrl}/api/public/rooms/${slug}?${forged}`, { headers })
  );
  if (listOutcome.featureDisabled) {
    return { featureDisabled: true, featureGate: listOutcome.body };
  }
  const list = verifyExpectedSlug(listOutcome.body, context.slug, "list");
  const typeDiscovery = verifyExpectedSlug(
    verifyRoomPayload(
      await requestJson(`${baseUrl}/api/public/rooms/${slug}/discovery?mode=types&page=1&pageSize=12&${dateQuery}`, { headers }),
      "discovery-types"
    ),
    context.slug,
    "type discovery"
  );
  const roomDiscovery = verifyExpectedSlug(
    verifyRoomPayload(
      await requestJson(`${baseUrl}/api/public/rooms/${slug}/discovery?mode=rooms&page=1&pageSize=12&${dateQuery}`, { headers }),
      "discovery-rooms"
    ),
    context.slug,
    "room discovery"
  );
  const availability = verifyExpectedSlug(
    verifyRoomPayload(
      await requestJson(`${baseUrl}/api/public/rooms/${slug}/availability?${dateQuery}`, { headers }),
      "availability"
    ),
    context.slug,
    "availability"
  );
  let detail = null;
  const roomId = list.rooms[0]?.id;
  if (roomId) {
    detail = verifyExpectedSlug(
      verifyRoomPayload(
        await requestJson(`${baseUrl}/api/public/rooms/${slug}/rooms/${encodeURIComponent(roomId)}?${forged}`, { headers }),
        "detail"
      ),
      context.slug,
      "detail"
    );
  }
  return { featureDisabled: false, list, typeDiscovery, roomDiscovery, availability, detail };
}

function safeFailure(error) {
  const code = error?.code ? String(error.code) : "TASK3_PUBLIC_ROOMS_LIVE_FAILED";
  return {
    success: false,
    code,
    message: code.startsWith("TASK3_")
      ? String(error?.message || "Live public rooms verification failed")
      : "Live public rooms request failed"
  };
}

async function main() {
  const inputs = readInputs();
  const dates = { checkInDate: inputs.checkInDate, checkOutDate: inputs.checkOutDate };
  const health = await requestJson(`${inputs.baseUrl}/api/health`);
  if (health.status !== 200 || health.body?.success !== true) {
    throw createVerifierError("TASK3_PUBLIC_ROOMS_LIVE_HEALTH_FAILED", "Backend health endpoint is not healthy");
  }
  const readiness = await requestJson(`${inputs.baseUrl}/api/readiness`);
  if (readiness.status !== 200 || readiness.body?.success !== true || readiness.body?.ready !== true) {
    throw createVerifierError("TASK3_PUBLIC_ROOMS_LIVE_READINESS_FAILED", "Backend readiness endpoint is not ready");
  }
  [
    "tenant_runtime_database",
    "tenant_runtime_public_hotel",
    "tenant_runtime_public_menu",
    "tenant_runtime_public_gallery",
    "tenant_runtime_public_testimonials",
    "tenant_runtime_public_popup",
    "tenant_runtime_public_rooms"
  ].forEach((name) => requireEnabledReadyCheck(readiness, name));
  const tenantASuite = await probeTenant(inputs.baseUrl, inputs.contextA, dates);
  const tenantBSuite = await probeTenant(inputs.baseUrl, inputs.contextB, dates);
  const unknown = await requestJson(`${inputs.baseUrl}/api/public/rooms/task3e-property-does-not-exist`);
  if (unknown.status !== 404 || unknown.body?.success !== false) {
    throw createVerifierError("TASK3_PUBLIC_ROOMS_LIVE_UNKNOWN_SLUG_FAILED", "Unknown live public rooms slug did not fail closed");
  }
  let concurrentPasses = 0;
  for (let index = 0; index < inputs.iterations; index += 1) {
    const pair = await Promise.all([
      requestJson(`${inputs.baseUrl}/api/public/rooms/${encodeURIComponent(inputs.contextA.slug)}`),
      requestJson(`${inputs.baseUrl}/api/public/rooms/${encodeURIComponent(inputs.contextB.slug)}`)
    ]);
    pair.forEach((result) => verifyRoomListOutcome(result));
    concurrentPasses += pair.length;
  }
  const expectedPasses = inputs.iterations * 2;
  if (concurrentPasses !== expectedPasses) {
    throw createVerifierError("TASK3_PUBLIC_ROOMS_LIVE_CONCURRENCY_FAILED", "Live concurrent public room probes did not all pass");
  }
  process.stdout.write(`${JSON.stringify({
    success: true,
    mode: "LIVE_READ_ONLY_PUBLIC_ROOMS_ROUTE_CANARY",
    routes: [
      "/api/public/rooms/:slug/discovery",
      "/api/public/rooms/:slug/rooms/:roomId",
      "/api/public/rooms/:slug",
      "/api/public/rooms/:slug/availability"
    ],
    health: "PASS",
    readiness: "PASS",
    tenantRuntimeDatabase: "PASS",
    tenantRuntimePublicHotel: "PASS",
    tenantRuntimePublicMenu: "PASS",
    tenantRuntimePublicGallery: "PASS",
    tenantRuntimePublicTestimonials: "PASS",
    tenantRuntimePublicPopup: "PASS",
    tenantRuntimePublicRooms: "PASS",
    dates,
    tenantA: summarizeSuite(tenantASuite),
    tenantB: summarizeSuite(tenantBSuite),
    forgedTenantInputsIgnored: true,
    twoRoomEnabledTenantsAvailable: !(tenantASuite.featureDisabled || tenantBSuite.featureDisabled),
    tenantBExpectedFeatureDisabled: tenantBSuite.featureDisabled === true,
    unknownSlug: { httpStatus: unknown.status, result: "PASS" },
    concurrency: { iterations: inputs.iterations, expectedPasses, actualPasses: concurrentPasses, result: "PASS" },
    bookingPostMigrated: false,
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
  probeTenant,
  verifyExpectedSlug
};
