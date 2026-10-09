"use strict";

require("dotenv").config({ quiet: true });

// This verifier runs only against the already-provisioned restricted role.
// It never calls application notification or payment code.
process.env.TENANT_RUNTIME_ENABLED = "true";
process.env.NOTIFICATION_DELIVERY_ENABLED = "false";
process.env.PAYMENT_WEBHOOK_WORKER_ENABLED = "false";
process.env.SUPABASE_URL ||= "https://tenant-write-verifier.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used-by-tenant-write-verifier";
process.env.JWT_SECRET ||= "not-used-by-tenant-write-verifier";

const crypto = require("crypto");
const {
  closeTenantPool,
  normalizeTenantContext,
  withTenantTransaction
} = require("../utils/tenant-database");
const {
  validateTenantDatabaseUrl
} = require("./verify-tenant-runtime-connection");

const EXPECTED_CONFIRMATION = "TASK3G_WRITE_RUNTIME_SYNTHETIC";
const DEFAULT_ITERATIONS = 10;
const EXPECTED_DENIAL_CODES = new Set(["23503", "23514", "42501", "P0001"]);

function createVerifierError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeSlug(value) {
  const slug = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw createVerifierError(
      "TASK3G_WRITE_SLUG_INVALID",
      "A canonical property slug is required"
    );
  }
  return slug;
}

function readContext(prefix) {
  const canonical = normalizeTenantContext({
    tenantId: process.env[`TASK3_TEST_TENANT_${prefix}_ID`],
    propertyId: process.env[`TASK3_TEST_PROPERTY_${prefix}_ID`]
  });
  return Object.freeze({
    ...canonical,
    propertySlug: normalizeSlug(
      process.env[`TASK3_TEST_PROPERTY_${prefix}_SLUG`]
    )
  });
}

function readInputs() {
  if (process.env.TASK3_RUNTIME_WRITE_CONFIRM !== EXPECTED_CONFIRMATION) {
    throw createVerifierError(
      "TASK3G_WRITE_CONFIRMATION_MISSING",
      `Set TASK3_RUNTIME_WRITE_CONFIRM=${EXPECTED_CONFIRMATION}`
    );
  }
  validateTenantDatabaseUrl(process.env.TENANT_DATABASE_URL);
  if (String(process.env.NOTIFICATION_DELIVERY_ENABLED || "false") !== "false") {
    throw createVerifierError(
      "TASK3G_WRITE_NOTIFICATIONS_UNSAFE",
      "Notification delivery must be disabled for the synthetic write verifier"
    );
  }
  if (String(process.env.PAYMENT_WEBHOOK_WORKER_ENABLED || "false") !== "false") {
    throw createVerifierError(
      "TASK3G_WRITE_PAYMENT_WORKER_UNSAFE",
      "Payment webhook worker must be disabled inside the synthetic verifier"
    );
  }
  const contextA = readContext("A");
  const contextB = readContext("B");
  if (
    contextA.tenantId === contextB.tenantId ||
    contextA.propertyId === contextB.propertyId ||
    contextA.propertySlug === contextB.propertySlug
  ) {
    throw createVerifierError(
      "TASK3G_WRITE_CONTEXTS_NOT_DISTINCT",
      "Two distinct canonical tenant/property contexts are required"
    );
  }
  const iterations = Number(
    process.env.TASK3_RUNTIME_WRITE_CONCURRENCY_ITERATIONS || DEFAULT_ITERATIONS
  );
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 25) {
    throw createVerifierError(
      "TASK3G_WRITE_ITERATIONS_INVALID",
      "Write concurrency iterations must be from 1 to 25"
    );
  }
  return { contextA, contextB, iterations };
}

async function canonicalHotel(context) {
  return withTenantTransaction(
    context,
    async (client) => {
      const result = await client.query(
        "SELECT tenant_id::text AS tenant_id, id::text AS property_id, slug FROM public.hotels WHERE slug=$1",
        [context.propertySlug]
      );
      const row = result.rows?.[0];
      if (
        result.rowCount !== 1 ||
        row.tenant_id !== context.tenantId ||
        row.property_id !== context.propertyId ||
        row.slug !== context.propertySlug
      ) {
        throw createVerifierError(
          "TASK3G_WRITE_CANONICAL_HOTEL_MISMATCH",
          "Runtime context does not match exactly one canonical hotel"
        );
      }
      return true;
    },
    { readOnly: true }
  );
}

async function insertFixture(context, marker) {
  return withTenantTransaction(context, async (client) => {
    const result = await client.query(
      `INSERT INTO public.testimonials (
        tenant_id,property_id,hotel_slug,guest_name,guest_role,review_text,
        star_rating,avatar_url,sort_order,is_active,is_archived,is_approved
      ) VALUES ($1::uuid,$2::bigint,$3,$4,'synthetic_verifier',$5,5,'',0,false,true,false)
      RETURNING id,tenant_id::text AS tenant_id,property_id::text AS property_id,hotel_slug`,
      [
        context.tenantId,
        context.propertyId,
        context.propertySlug,
        marker,
        `${marker}:CREATED`
      ]
    );
    const row = result.rows?.[0];
    if (
      result.rowCount !== 1 ||
      row.tenant_id !== context.tenantId ||
      row.property_id !== context.propertyId ||
      row.hotel_slug !== context.propertySlug
    ) {
      throw createVerifierError(
        "TASK3G_WRITE_INSERT_FAILED",
        "Synthetic fixture was not bound to the canonical tenant"
      );
    }
    return { id: String(row.id), marker };
  });
}

async function verifyOwnReadUpdate(context, fixture) {
  return withTenantTransaction(context, async (client) => {
    const read = await client.query(
      "SELECT id FROM public.testimonials WHERE id=$1::bigint AND guest_name=$2",
      [fixture.id, fixture.marker]
    );
    if (read.rowCount !== 1) {
      throw createVerifierError(
        "TASK3G_WRITE_OWN_READ_FAILED",
        "Tenant could not read its own synthetic fixture"
      );
    }
    const updated = await client.query(
      "UPDATE public.testimonials SET review_text=$1,updated_at=now() WHERE id=$2::bigint AND guest_name=$3 RETURNING id",
      [`${fixture.marker}:UPDATED`, fixture.id, fixture.marker]
    );
    if (updated.rowCount !== 1) {
      throw createVerifierError(
        "TASK3G_WRITE_OWN_UPDATE_FAILED",
        "Tenant could not update its own synthetic fixture"
      );
    }
    return true;
  });
}

async function verifyCrossTenantIsolation(context, foreignFixture) {
  return withTenantTransaction(context, async (client) => {
    const read = await client.query(
      "SELECT id FROM public.testimonials WHERE id=$1::bigint",
      [foreignFixture.id]
    );
    const update = await client.query(
      "UPDATE public.testimonials SET review_text='TASK3G_CROSS_UPDATE' WHERE id=$1::bigint RETURNING id",
      [foreignFixture.id]
    );
    const deletion = await client.query(
      "DELETE FROM public.testimonials WHERE id=$1::bigint RETURNING id",
      [foreignFixture.id]
    );
    if (read.rowCount !== 0 || update.rowCount !== 0 || deletion.rowCount !== 0) {
      throw createVerifierError(
        "TASK3G_WRITE_CROSS_TENANT_EFFECT",
        "Cross-tenant read, update, or delete reached a foreign fixture"
      );
    }
    return true;
  });
}

async function expectDatabaseDenial(label, operation) {
  try {
    await operation();
  } catch (error) {
    if (String(error?.code || "").startsWith("TASK3G_")) throw error;
    if (!EXPECTED_DENIAL_CODES.has(String(error?.code || ""))) {
      throw createVerifierError(
        "TASK3G_WRITE_UNEXPECTED_DENIAL",
        `${label} failed with an unexpected database error class`
      );
    }
    return true;
  }
  throw createVerifierError(
    "TASK3G_WRITE_EXPECTED_DENIAL_MISSING",
    `${label} unexpectedly succeeded`
  );
}

async function verifyForgedOwnership(context, otherContext, marker) {
  return expectDatabaseDenial("Forged ownership insert", () =>
    withTenantTransaction(context, (client) => client.query(
      `INSERT INTO public.testimonials (
        tenant_id,property_id,hotel_slug,guest_name,guest_role,review_text,
        star_rating,avatar_url,sort_order,is_active,is_archived,is_approved
      ) VALUES ($1::uuid,$2::bigint,$3,$4,'synthetic_verifier','FORGED',5,'',0,false,true,false)`,
      [
        otherContext.tenantId,
        otherContext.propertyId,
        context.propertySlug,
        marker
      ]
    ))
  );
}

async function findRoomId(context) {
  return withTenantTransaction(
    context,
    async (client) => {
      const result = await client.query(
        "SELECT id::text AS id FROM public.rooms ORDER BY id LIMIT 1"
      );
      if (result.rowCount !== 1) {
        throw createVerifierError(
          "TASK3G_WRITE_ROOM_FIXTURE_MISSING",
          "Tenant A requires one existing room for the cross-tenant FK probe"
        );
      }
      return result.rows[0].id;
    },
    { readOnly: true }
  );
}

async function verifyCrossTenantParentBinding(
  attackerContext,
  foreignRoomId,
  token
) {
  return expectDatabaseDenial("Cross-tenant room-image parent insert", () =>
    withTenantTransaction(attackerContext, (client) => client.query(
      `INSERT INTO public.room_images (
        tenant_id,property_id,hotel_slug,room_id,storage_path,original_url,
        mime_type,alt_text,width,height,file_size,created_by
      ) VALUES (
        $1::uuid,$2::bigint,$3,$4::bigint,$5,$6,
        'image/webp','Task 3 synthetic isolation probe',320,240,1,'TASK3G_VERIFIER'
      )`,
      [
        attackerContext.tenantId,
        attackerContext.propertyId,
        attackerContext.propertySlug,
        foreignRoomId,
        `tenants/${attackerContext.tenantId}/properties/${attackerContext.propertyId}/room-images/TASK3G_${token}.webp`,
        `https://task3.invalid/TASK3G_${token}.webp`
      ]
    ))
  );
}

async function verifyAtomicRollback(context, marker) {
  try {
    await withTenantTransaction(context, async (client) => {
      await client.query(
        `INSERT INTO public.testimonials (
          tenant_id,property_id,hotel_slug,guest_name,guest_role,review_text,
          star_rating,avatar_url,sort_order,is_active,is_archived,is_approved
        ) VALUES ($1::uuid,$2::bigint,$3,$4,'synthetic_verifier','ROLLBACK',5,'',0,false,true,false)`,
        [context.tenantId, context.propertyId, context.propertySlug, marker]
      );
      await client.query("SELECT 1/0");
    });
    throw createVerifierError(
      "TASK3G_WRITE_ROLLBACK_ERROR_MISSING",
      "Forced transaction error unexpectedly succeeded"
    );
  } catch (error) {
    if (String(error?.code || "") !== "22012") throw error;
  }
  return withTenantTransaction(
    context,
    async (client) => {
      const result = await client.query(
        "SELECT count(*)::int AS count FROM public.testimonials WHERE guest_name=$1",
        [marker]
      );
      if (Number(result.rows?.[0]?.count) !== 0) {
        throw createVerifierError(
          "TASK3G_WRITE_ATOMIC_ROLLBACK_FAILED",
          "Synthetic row survived a failed transaction"
        );
      }
      return true;
    },
    { readOnly: true }
  );
}

async function runConcurrentUpdate(context, fixture, iteration) {
  return withTenantTransaction(context, async (client) => {
    const result = await client.query(
      "UPDATE public.testimonials SET sort_order=$1,updated_at=now() WHERE id=$2::bigint AND guest_name=$3 RETURNING id",
      [iteration, fixture.id, fixture.marker]
    );
    if (result.rowCount !== 1) {
      throw createVerifierError(
        "TASK3G_WRITE_CONCURRENT_UPDATE_FAILED",
        "Concurrent tenant write did not affect exactly its own row"
      );
    }
    return true;
  });
}

async function cleanupFixture(context, fixture) {
  if (!fixture?.id) return true;
  return withTenantTransaction(context, async (client) => {
    const result = await client.query(
      "DELETE FROM public.testimonials WHERE id=$1::bigint AND guest_name=$2 RETURNING id",
      [fixture.id, fixture.marker]
    );
    if (result.rowCount !== 1) {
      throw createVerifierError(
        "TASK3G_WRITE_CLEANUP_FAILED",
        "Synthetic fixture cleanup did not delete exactly one owned row"
      );
    }
    return true;
  });
}

function safeFailure(error) {
  const code = String(error?.code || "TASK3G_WRITE_VERIFY_FAILED");
  return {
    success: false,
    code,
    message:
      code.startsWith("TASK3G_") || code.startsWith("TENANT_")
        ? String(error?.message || "Restricted tenant write verification failed")
        : "Restricted tenant database write verification failed"
  };
}

async function main() {
  const { contextA, contextB, iterations } = readInputs();
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  const markerA = `TEST_TASK3G_A_${token}`;
  const markerB = `TEST_TASK3G_B_${token}`;
  let fixtureA;
  let fixtureB;
  let cleanup = "NOT_REQUIRED";
  try {
    await Promise.all([canonicalHotel(contextA), canonicalHotel(contextB)]);
    [fixtureA, fixtureB] = await Promise.all([
      insertFixture(contextA, markerA),
      insertFixture(contextB, markerB)
    ]);
    await Promise.all([
      verifyOwnReadUpdate(contextA, fixtureA),
      verifyOwnReadUpdate(contextB, fixtureB),
      verifyCrossTenantIsolation(contextA, fixtureB),
      verifyCrossTenantIsolation(contextB, fixtureA)
    ]);
    await verifyForgedOwnership(
      contextA,
      contextB,
      `TEST_TASK3G_FORGED_${token}`
    );
    const tenantARoomId = await findRoomId(contextA);
    await verifyCrossTenantParentBinding(contextB, tenantARoomId, token);
    await verifyAtomicRollback(
      contextA,
      `TEST_TASK3G_ROLLBACK_${token}`
    );
    let concurrentPasses = 0;
    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      const results = await Promise.all([
        runConcurrentUpdate(contextA, fixtureA, iteration),
        runConcurrentUpdate(contextB, fixtureB, iteration)
      ]);
      concurrentPasses += results.filter(Boolean).length;
    }
    await Promise.all([
      cleanupFixture(contextA, fixtureA),
      cleanupFixture(contextB, fixtureB)
    ]);
    cleanup = "PASS";
    fixtureA = null;
    fixtureB = null;
    process.stdout.write(`${JSON.stringify({
      success: true,
      mode: "LIVE_SYNTHETIC_RESTRICTED_WRITES",
      role: "app_tenant_runtime",
      notifications: "DISABLED",
      paymentWorker: "DISABLED",
      tenantA: { create: "PASS", read: "PASS", update: "PASS", delete: "PASS" },
      tenantB: { create: "PASS", read: "PASS", update: "PASS", delete: "PASS" },
      crossTenantCrud: "DENIED",
      forgedOwnership: "DENIED",
      crossTenantCompositeParent: "DENIED",
      atomicRollback: "PASS",
      concurrency: {
        iterations,
        expectedPasses: iterations * 2,
        actualPasses: concurrentPasses,
        result: concurrentPasses === iterations * 2 ? "PASS" : "FAIL"
      },
      cleanup,
      identifiersLogged: false,
      result: "PASS",
      timestamp: new Date().toISOString()
    }, null, 2)}\n`);
  } finally {
    if (fixtureA || fixtureB) {
      const results = await Promise.allSettled([
        cleanupFixture(contextA, fixtureA),
        cleanupFixture(contextB, fixtureB)
      ]);
      if (results.some((result) => result.status === "rejected")) {
        throw createVerifierError(
          "TASK3G_WRITE_CLEANUP_FAILED",
          "Synthetic verifier cleanup failed; inspect only TEST_TASK3G_* testimonial rows"
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
          code: "TASK3G_WRITE_POOL_CLOSE_FAILED",
          message: "Tenant runtime verifier could not close its pool cleanly"
        }, null, 2)}\n`);
        process.exitCode = 1;
      }
    });
}

module.exports = {
  EXPECTED_CONFIRMATION,
  EXPECTED_DENIAL_CODES,
  normalizeSlug,
  readInputs,
  safeFailure
};
