const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DIRECT_SCOPED_TABLES,
  assertSafeInputs,
  parseCount,
  quoteIdentifier,
  readConcurrencyIterations,
  validateTenantDatabaseUrl
} = require("../scripts/verify-tenant-runtime-connection");

const CONTEXT_A = {
  tenantId: "123e4567-e89b-42d3-a456-426614174000",
  propertyId: "1"
};
const CONTEXT_B = {
  tenantId: "123e4567-e89b-42d3-a456-426614174001",
  propertyId: "2"
};

test("runtime verifier manifest covers 67 direct tables plus hotels", () => {
  assert.equal(DIRECT_SCOPED_TABLES.length, 67);
  assert.equal(new Set(DIRECT_SCOPED_TABLES).size, 67);
  assert.equal(DIRECT_SCOPED_TABLES.includes("payment_intents"), true);
  assert.equal(DIRECT_SCOPED_TABLES.includes("payment_webhook_inbox"), true);
});

test("runtime verifier accepts only static SQL identifiers", () => {
  assert.equal(quoteIdentifier("room_bookings"), '"room_bookings"');
  assert.throws(
    () => quoteIdentifier("hotels; drop table hotels"),
    { code: "TASK3_RUNTIME_IDENTIFIER_INVALID" }
  );
});

test("runtime verifier validates database counts", () => {
  assert.equal(parseCount("0", "count"), 0);
  assert.equal(parseCount("42", "count"), 42);
  assert.throws(() => parseCount("-1", "count"), {
    code: "TASK3_RUNTIME_RESULT_INVALID"
  });
  assert.throws(() => parseCount("not-a-count", "count"), {
    code: "TASK3_RUNTIME_RESULT_INVALID"
  });
});

test("runtime verifier requires explicit confirmation and distinct scopes", () => {
  const originalConfirmation = process.env.TASK3_RUNTIME_VERIFY_CONFIRM;
  const originalDatabaseUrl = process.env.TENANT_DATABASE_URL;
  try {
    delete process.env.TASK3_RUNTIME_VERIFY_CONFIRM;
    process.env.TENANT_DATABASE_URL =
      "postgresql://app_tenant_runtime.project-ref:encoded-password@db.example.invalid:5432/postgres?sslmode=verify-full";
    assert.throws(() => assertSafeInputs(CONTEXT_A, CONTEXT_B), {
      code: "TASK3_RUNTIME_CONFIRMATION_MISSING"
    });

    process.env.TASK3_RUNTIME_VERIFY_CONFIRM = "TASK3E_READ_ONLY";
    assert.doesNotThrow(() => assertSafeInputs(CONTEXT_A, CONTEXT_B));
    assert.throws(
      () => assertSafeInputs(CONTEXT_A, {
        tenantId: CONTEXT_A.tenantId,
        propertyId: CONTEXT_B.propertyId
      }),
      { code: "TASK3_RUNTIME_CONTEXTS_NOT_DISTINCT" }
    );
  } finally {
    if (originalConfirmation === undefined) {
      delete process.env.TASK3_RUNTIME_VERIFY_CONFIRM;
    } else {
      process.env.TASK3_RUNTIME_VERIFY_CONFIRM = originalConfirmation;
    }
    if (originalDatabaseUrl === undefined) {
      delete process.env.TENANT_DATABASE_URL;
    } else {
      process.env.TENANT_DATABASE_URL = originalDatabaseUrl;
    }
  }
});

test("runtime verifier rejects URL placeholders and weaker future SSL semantics", () => {
  assert.throws(
    () => validateTenantDatabaseUrl(
      "postgresql://app_tenant_runtime.PROJECT_REF:password@POOLER_HOST:5432/postgres?sslmode=verify-full"
    ),
    { code: "TENANT_DATABASE_URL_PLACEHOLDER" }
  );
  assert.throws(
    () => validateTenantDatabaseUrl(
      "postgresql://app_tenant_runtime.project-ref:password@db.example.invalid:5432/postgres?sslmode=require"
    ),
    { code: "TENANT_DATABASE_SSL_MODE_UNSAFE" }
  );
  assert.equal(
    validateTenantDatabaseUrl(
      "postgresql://app_tenant_runtime.project-ref:password@db.example.invalid:5432/postgres?sslmode=verify-full"
    ),
    true
  );
});

test("runtime verifier bounds concurrency iterations", () => {
  const original = process.env.TASK3_RUNTIME_CONCURRENCY_ITERATIONS;
  try {
    process.env.TASK3_RUNTIME_CONCURRENCY_ITERATIONS = "10";
    assert.equal(readConcurrencyIterations(), 10);
    process.env.TASK3_RUNTIME_CONCURRENCY_ITERATIONS = "0";
    assert.throws(() => readConcurrencyIterations(), {
      code: "TASK3_RUNTIME_ITERATIONS_INVALID"
    });
    process.env.TASK3_RUNTIME_CONCURRENCY_ITERATIONS = "51";
    assert.throws(() => readConcurrencyIterations(), {
      code: "TASK3_RUNTIME_ITERATIONS_INVALID"
    });
  } finally {
    if (original === undefined) {
      delete process.env.TASK3_RUNTIME_CONCURRENCY_ITERATIONS;
    } else {
      process.env.TASK3_RUNTIME_CONCURRENCY_ITERATIONS = original;
    }
  }
});
