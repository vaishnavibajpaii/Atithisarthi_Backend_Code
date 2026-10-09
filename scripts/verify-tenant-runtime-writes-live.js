"use strict";

require("dotenv").config({ quiet: true });

const crypto = require("crypto");
const {
  closeTenantPool,
  normalizeTenantContext,
  withTenantTransaction
} = require("../utils/tenant-database");
const {
  normalizeBaseUrl,
  normalizeSlug,
  requireEnabledReadyCheck
} = require("./verify-tenant-public-hotel-live");
const {
  validateTenantDatabaseUrl
} = require("./verify-tenant-runtime-connection");

const EXPECTED_CONFIRMATION = "TASK3G_LIVE_HTTP_WRITES_SYNTHETIC";

function createVerifierError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readContext(prefix, otherPrefix) {
  const canonical = normalizeTenantContext({
    tenantId: process.env[`TASK3_TEST_TENANT_${prefix}_ID`],
    propertyId: process.env[`TASK3_TEST_PROPERTY_${prefix}_ID`]
  });
  return Object.freeze({
    ...canonical,
    propertySlug: normalizeSlug(process.env[`TASK3_TEST_PROPERTY_${prefix}_SLUG`]),
    forgedTenantId: String(process.env[`TASK3_TEST_TENANT_${otherPrefix}_ID`] || "").trim(),
    forgedPropertyId: String(process.env[`TASK3_TEST_PROPERTY_${otherPrefix}_ID`] || "").trim()
  });
}

function readInputs() {
  if (process.env.TASK3_LIVE_WRITE_CONFIRM !== EXPECTED_CONFIRMATION) {
    throw createVerifierError(
      "TASK3G_LIVE_WRITE_CONFIRMATION_MISSING",
      `Set TASK3_LIVE_WRITE_CONFIRM=${EXPECTED_CONFIRMATION}`
    );
  }
  if (String(process.env.NOTIFICATION_DELIVERY_ENABLED || "false") !== "false") {
    throw createVerifierError(
      "TASK3G_LIVE_WRITE_NOTIFICATIONS_UNSAFE",
      "NOTIFICATION_DELIVERY_ENABLED must be false for the live synthetic write canary"
    );
  }
  validateTenantDatabaseUrl(process.env.TENANT_DATABASE_URL);
  const contextA = readContext("A", "B");
  const contextB = readContext("B", "A");
  if (
    contextA.tenantId === contextB.tenantId ||
    contextA.propertyId === contextB.propertyId ||
    contextA.propertySlug === contextB.propertySlug
  ) {
    throw createVerifierError(
      "TASK3G_LIVE_WRITE_CONTEXTS_NOT_DISTINCT",
      "Two distinct canonical tenant/property contexts are required"
    );
  }
  return {
    baseUrl: normalizeBaseUrl(process.env.TASK3_LIVE_WRITE_BASE_URL),
    contextA,
    contextB
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
        "TASK3G_LIVE_WRITE_RESPONSE_INVALID",
        "Live write endpoint did not return JSON"
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

async function createLiveFixture(baseUrl, context, marker) {
  const result = await requestJson(`${baseUrl}/api/testimonials`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tenant-id": context.forgedTenantId,
      "x-property-id": context.forgedPropertyId
    },
    body: JSON.stringify({
      hotelName: "Task 3G Synthetic Hotel",
      hotelSlug: context.propertySlug,
      name: marker,
      role: "synthetic_verifier",
      text: `${marker}: restricted HTTP write canary`,
      stars: 5
    })
  });
  const testimonial = result.body?.testimonial;
  if (
    result.status !== 201 ||
    result.body?.success !== true ||
    !testimonial?.id ||
    testimonial.hotelSlug !== context.propertySlug ||
    testimonial.name !== marker ||
    hasInternalContext(result.body)
  ) {
    throw createVerifierError(
      "TASK3G_LIVE_WRITE_CREATE_FAILED",
      "Live testimonial writer did not return the expected tenant-safe contract"
    );
  }
  return { id: String(testimonial.id), marker };
}

async function verifyLiveFixture(context, fixture) {
  return withTenantTransaction(
    context,
    async (client) => {
      const result = await client.query(
        `SELECT id,tenant_id::text AS tenant_id,property_id::text AS property_id,
                hotel_slug,guest_name,is_approved
           FROM public.testimonials
          WHERE id=$1::bigint AND guest_name=$2`,
        [fixture.id, fixture.marker]
      );
      const row = result.rows?.[0];
      if (
        result.rowCount !== 1 ||
        row.tenant_id !== context.tenantId ||
        row.property_id !== context.propertyId ||
        row.hotel_slug !== context.propertySlug ||
        row.guest_name !== fixture.marker ||
        row.is_approved !== false
      ) {
        throw createVerifierError(
          "TASK3G_LIVE_WRITE_BINDING_FAILED",
          "Live route fixture was not persisted with canonical tenant ownership"
        );
      }
      return true;
    },
    { readOnly: true }
  );
}

async function verifyForeignFixtureHidden(context, foreignFixture) {
  return withTenantTransaction(
    context,
    async (client) => {
      const result = await client.query(
        "SELECT id FROM public.testimonials WHERE id=$1::bigint",
        [foreignFixture.id]
      );
      if (result.rowCount !== 0) {
        throw createVerifierError(
          "TASK3G_LIVE_WRITE_CROSS_TENANT_VISIBLE",
          "Live route fixture is visible to another tenant"
        );
      }
      return true;
    },
    { readOnly: true }
  );
}

async function waitForNotification(context, fixture) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const found = await withTenantTransaction(
      context,
      async (client) => {
        const result = await client.query(
          `SELECT count(*)::int AS count
             FROM public.notification_events
            WHERE source_type='testimonial'
              AND source_id=$1
              AND hotel_slug=$2`,
          [fixture.id, context.propertySlug]
        );
        return Number(result.rows?.[0]?.count || 0) > 0;
      },
      { readOnly: true }
    );
    if (found) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function cleanupFixture(context, fixture, requireTestimonial = false) {
  if (!fixture?.id) return { testimonial: 0, notifications: 0 };
  return withTenantTransaction(context, async (client) => {
    const notifications = await client.query(
      `DELETE FROM public.notification_events
        WHERE source_type='testimonial'
          AND source_id=$1
          AND hotel_slug=$2
        RETURNING id`,
      [fixture.id, context.propertySlug]
    );
    const testimonial = await client.query(
      `DELETE FROM public.testimonials
        WHERE id=$1::bigint
          AND guest_name=$2
          AND hotel_slug=$3
        RETURNING id`,
      [fixture.id, fixture.marker, context.propertySlug]
    );
    if (requireTestimonial && testimonial.rowCount !== 1) {
      throw createVerifierError(
        "TASK3G_LIVE_WRITE_CLEANUP_FAILED",
        "Live synthetic testimonial cleanup did not delete exactly one row"
      );
    }
    return {
      testimonial: testimonial.rowCount,
      notifications: notifications.rowCount
    };
  });
}

function safeFailure(error) {
  const code = String(error?.code || "TASK3G_LIVE_WRITE_FAILED");
  return {
    success: false,
    code,
    message:
      code.startsWith("TASK3_") || code.startsWith("TENANT_")
        ? String(error?.message || "Live tenant write verification failed")
        : "Live tenant write request or restricted cleanup failed"
  };
}

async function main() {
  const { baseUrl, contextA, contextB } = readInputs();
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  let fixtureA;
  let fixtureB;
  try {
    const health = await requestJson(`${baseUrl}/api/health`);
    if (health.status !== 200 || health.body?.success !== true) {
      throw createVerifierError(
        "TASK3G_LIVE_WRITE_HEALTH_FAILED",
        "Backend health endpoint is not healthy"
      );
    }
    const readiness = await requestJson(`${baseUrl}/api/readiness`);
    if (
      readiness.status !== 200 ||
      readiness.body?.success !== true ||
      readiness.body?.ready !== true
    ) {
      throw createVerifierError(
        "TASK3G_LIVE_WRITE_READINESS_FAILED",
        "Backend readiness endpoint is not ready"
      );
    }
    requireEnabledReadyCheck(readiness, "tenant_runtime_database");
    requireEnabledReadyCheck(readiness, "tenant_runtime_public_hotel");
    requireEnabledReadyCheck(readiness, "tenant_runtime_writes");

    [fixtureA, fixtureB] = await Promise.all([
      createLiveFixture(baseUrl, contextA, `TEST_TASK3G_HTTP_A_${token}`),
      createLiveFixture(baseUrl, contextB, `TEST_TASK3G_HTTP_B_${token}`)
    ]);
    await Promise.all([
      verifyLiveFixture(contextA, fixtureA),
      verifyLiveFixture(contextB, fixtureB),
      verifyForeignFixtureHidden(contextA, fixtureB),
      verifyForeignFixtureHidden(contextB, fixtureA),
      waitForNotification(contextA, fixtureA),
      waitForNotification(contextB, fixtureB)
    ]);
    const cleanup = await Promise.all([
      cleanupFixture(contextA, fixtureA, true),
      cleanupFixture(contextB, fixtureB, true)
    ]);
    fixtureA = null;
    fixtureB = null;
    process.stdout.write(`${JSON.stringify({
      success: true,
      mode: "LIVE_SYNTHETIC_HTTP_WRITES",
      route: "/api/testimonials",
      health: "PASS",
      readiness: "PASS",
      tenantRuntimeDatabase: "PASS",
      tenantRuntimePublicHotel: "PASS",
      tenantRuntimeWrites: "PASS",
      tenantA: { httpStatus: 201, canonicalBinding: "PASS" },
      tenantB: { httpStatus: 201, canonicalBinding: "PASS" },
      forgedTenantInputsIgnored: true,
      crossTenantVisibility: "DENIED",
      notificationDelivery: "DISABLED",
      cleanup: cleanup.every((entry) => entry.testimonial === 1) ? "PASS" : "FAIL",
      identifiersLogged: false,
      result: "PASS",
      timestamp: new Date().toISOString()
    }, null, 2)}\n`);
  } finally {
    if (fixtureA || fixtureB) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      const results = await Promise.allSettled([
        cleanupFixture(contextA, fixtureA),
        cleanupFixture(contextB, fixtureB)
      ]);
      if (results.some((result) => result.status === "rejected")) {
        throw createVerifierError(
          "TASK3G_LIVE_WRITE_CLEANUP_FAILED",
          "Synthetic HTTP cleanup failed; inspect only TEST_TASK3G_HTTP_* rows"
        );
      }
    }
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`${JSON.stringify(safeFailure(error), null, 2)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await closeTenantPool();
      } catch {
        process.stderr.write(`${JSON.stringify({
          success: false,
          code: "TASK3G_LIVE_WRITE_POOL_CLOSE_FAILED",
          message: "Live write verifier could not close its pool cleanly"
        }, null, 2)}\n`);
        process.exitCode = 1;
      }
    });
}

module.exports = {
  EXPECTED_CONFIRMATION,
  hasInternalContext,
  safeFailure
};
