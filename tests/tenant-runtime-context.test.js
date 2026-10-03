const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
process.env.JWT_SECRET ||= "test-jwt-secret";

const {
  normalizeTenantContext,
  runTenantTransaction
} = require("../utils/tenant-database");

const TENANT_ID = "123e4567-e89b-42d3-a456-426614174000";

function createFakePool({
  failOnSql = "",
  rollbackFails = false,
  identity = {
    rolname: "app_tenant_runtime",
    rolcanlogin: true,
    rolsuper: false,
    rolbypassrls: false
  }
} = {}) {
  const calls = [];
  let released = 0;
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (rollbackFails && sql === "ROLLBACK") {
        throw new Error("rollback failed");
      }
      if (failOnSql && sql.includes(failOnSql)) {
        throw new Error("synthetic query failure");
      }
      if (sql.includes("FROM pg_roles WHERE rolname = current_user")) {
        return { rows: identity ? [identity] : [] };
      }
      return { rows: [] };
    },
    release() {
      released += 1;
    }
  };
  return {
    pool: {
      async connect() {
        return client;
      }
    },
    calls,
    released: () => released
  };
}

test("normalizes canonical tenant and property context", () => {
  assert.deepEqual(
    normalizeTenantContext({ tenantId: TENANT_ID.toUpperCase(), propertyId: "42" }),
    { tenantId: TENANT_ID, propertyId: "42" }
  );
});

test("rejects missing or malformed context before acquiring a connection", async () => {
  let connectCount = 0;
  const pool = {
    async connect() {
      connectCount += 1;
      throw new Error("must not connect");
    }
  };

  await assert.rejects(
    runTenantTransaction(pool, { tenantId: "client-value", propertyId: 1 }, async () => {}),
    { code: "TENANT_CONTEXT_INVALID" }
  );
  await assert.rejects(
    runTenantTransaction(pool, { tenantId: TENANT_ID, propertyId: 0 }, async () => {}),
    { code: "TENANT_CONTEXT_INVALID" }
  );
  assert.equal(connectCount, 0);
});

test("sets transaction-local scope before work and commits once", async () => {
  const fake = createFakePool();
  const result = await runTenantTransaction(
    fake.pool,
    { tenantId: TENANT_ID, propertyId: 7 },
    async (client, scope) => {
      assert.deepEqual(scope, { tenantId: TENANT_ID, propertyId: "7" });
      assert.equal(Object.isFrozen(scope), true);
      await client.query("SELECT id FROM public.orders");
      return "done";
    },
    { statementTimeoutMs: 3210 }
  );

  assert.equal(result, "done");
  assert.deepEqual(fake.calls.map((entry) => entry.sql), [
    "BEGIN",
    "SELECT rolname, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    "SELECT set_config('statement_timeout', $1, true)",
    "SELECT set_config('app.tenant_id', $1, true), set_config('app.property_id', $2, true)",
    "SELECT id FROM public.orders",
    "COMMIT"
  ]);
  assert.deepEqual(fake.calls[2].params, ["3210ms"]);
  assert.deepEqual(fake.calls[3].params, [TENANT_ID, "7"]);
  assert.equal(fake.released(), 1);
});

test("read-only mode is set before tenant-scoped work", async () => {
  const fake = createFakePool();
  await runTenantTransaction(
    fake.pool,
    { tenantId: TENANT_ID, propertyId: 8 },
    async () => "ok",
    { readOnly: true }
  );

  assert.deepEqual(fake.calls.slice(0, 2).map((entry) => entry.sql), [
    "BEGIN",
    "SET TRANSACTION READ ONLY"
  ]);
});

test("rejects a superuser, BYPASSRLS role, or misconfigured connection", async () => {
  const fake = createFakePool({
    identity: {
      rolname: "postgres",
      rolcanlogin: true,
      rolsuper: true,
      rolbypassrls: true
    }
  });
  let workCalled = false;

  await assert.rejects(
    runTenantTransaction(
      fake.pool,
      { tenantId: TENANT_ID, propertyId: 8 },
      async () => {
        workCalled = true;
      }
    ),
    { code: "TENANT_DATABASE_ROLE_UNSAFE" }
  );

  assert.equal(workCalled, false);
  assert.equal(fake.calls.at(-1).sql, "ROLLBACK");
  assert.equal(fake.released(), 1);
});

test("work failure rolls back and releases the client", async () => {
  const fake = createFakePool();
  const original = new Error("work failed");

  await assert.rejects(
    runTenantTransaction(
      fake.pool,
      { tenantId: TENANT_ID, propertyId: 9 },
      async () => {
        throw original;
      }
    ),
    (error) => error === original
  );

  assert.equal(fake.calls.at(-1).sql, "ROLLBACK");
  assert.equal(fake.calls.some((entry) => entry.sql === "COMMIT"), false);
  assert.equal(fake.released(), 1);
});

test("rollback failure never hides the original financial or business error", async () => {
  const fake = createFakePool({ rollbackFails: true });
  const original = new Error("business operation failed");
  const logger = require("../utils/logger");
  const originalLoggerError = logger.error;
  logger.error = () => {};

  try {
    await assert.rejects(
      runTenantTransaction(
        fake.pool,
        { tenantId: TENANT_ID, propertyId: 10 },
        async () => {
          throw original;
        }
      ),
      (error) => error === original
    );
    assert.equal(fake.released(), 1);
  } finally {
    logger.error = originalLoggerError;
  }
});

test("context setup failure rolls back before releasing the client", async () => {
  const fake = createFakePool({ failOnSql: "app.tenant_id" });

  await assert.rejects(
    runTenantTransaction(
      fake.pool,
      { tenantId: TENANT_ID, propertyId: 11 },
      async () => {
        throw new Error("work must not run");
      }
    ),
    /synthetic query failure/
  );

  assert.equal(fake.calls.at(-1).sql, "ROLLBACK");
  assert.equal(fake.released(), 1);
});
