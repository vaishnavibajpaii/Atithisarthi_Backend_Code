"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
process.env.SUPABASE_URL ||= "https://task7-observability.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "synthetic-service-key";
process.env.JWT_SECRET ||= "synthetic-task7-jwt-secret-for-local-tests";
const { redact, redactText } = require("../utils/log-redaction");
const logger = require("../utils/logger");
const context = require("../utils/operational-context");
const { createMetrics, OPERATIONS, operationForPath, metrics, databaseCategory } = require("../utils/operational-metrics");
const { createDependencyHealth } = require("../utils/dependency-health");
const { createOperationsHandler } = require("../routes/operations");
const { getRequestId, traceId, attachRequestContext, logRequestLifecycle } = require("../middleware/request-observability");
const { resolveRoutePermission } = require("../middleware/enforce-route-permission");
const { runAuthTransaction, runTenantTransaction } = require("../utils/tenant-database");

function response() {
  const res = new EventEmitter();
  return Object.assign(res, { locals: {}, statusCode: 200, headers: {}, writableFinished: false,
    setHeader(key, value) { this.headers[key] = value; }, getHeader(key) { return this.headers[key]; },
    writeHead() { return this; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
}

test("central redaction removes nested secrets, payment payloads, credentials and PII", () => {
  const value = redact({ password: "private", nested: { accessToken: "opaque", guestPhone: "9000000000", payload: { key: "private" },
    message: "provider raw payload", ok: "operator@example.test" } });
  const serialized = JSON.stringify(value);
  for (const secret of ["private", "opaque", "9000000000", "provider raw payload", "operator@example.test"]) assert.ok(!serialized.includes(secret));
});

test("free text scrubs known secrets, JWTs, QR tokens, API keys, URLs, emails and phone numbers", () => {
  const result = redactText("known-secret-value Bearer opaque-value https://example.test/?token=private rzp_test_abc123 q1_opaque " +
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature guest@example.test +91 90000 00000\nforged", ["known-secret-value"]);
  for (const secret of ["known-secret-value", "opaque-value", "token=private", "rzp_test_abc123", "q1_opaque", "eyJhbGci", "guest@example.test", "90000"]) assert.ok(!result.includes(secret), secret);
  assert.ok(!result.includes("\n"));
});

test("redaction handles cycles and does not execute getters or toJSON", () => {
  const value = { safe: "ok", toJSON() { throw new Error("must not execute"); } };
  Object.defineProperty(value, "getter", { enumerable: true, get() { throw new Error("must not execute"); } });
  value.self = value;
  const result = JSON.stringify(redact(value));
  assert.match(result, /CIRCULAR/);
  assert.match(result, /ACCESSOR_OMITTED/);
});

test("logger emits one parseable JSON record and excludes arbitrary metadata/free-form errors", () => {
  const lines = [];
  const log = logger.createLogger({ write: (level, line) => lines.push(line), now: () => "2026-10-28T08:00:00.000Z" });
  log.error("Database request failed", { errorCode: "23505", durationMs: 10, guestName: "Synthetic Guest", message: "raw secret", stack: "private", payload: { private: true } });
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.errorCode, "23505");
  assert.equal(record.service, "atithisarthi-api");
  for (const value of ["Synthetic Guest", "raw secret", "private"]) assert.ok(!lines[0].includes(value));
});

test("logging sink failures cannot throw into business code and remain countable", () => {
  const log = logger.createLogger({ write() { throw new Error("synthetic sink failure"); } });
  assert.doesNotThrow(() => log.info("commit completed"));
  assert.equal(log.droppedCount(), 1);
});

test("logger captures environment secret values before emitting any records", () => {
  const old = process.env.TASK7_SYNTHETIC_SECRET;
  process.env.TASK7_SYNTHETIC_SECRET = "synthetic-unlabelled-value";
  try {
    const lines = [];
    const log = logger.createLogger({ write: (level, line) => lines.push(line) });
    log.info("failure synthetic-unlabelled-value", { code: "synthetic-unlabelled-value" });
    assert.ok(!lines.join("").includes("synthetic-unlabelled-value"));
  } finally {
    if (old === undefined) delete process.env.TASK7_SYNTHETIC_SECRET; else process.env.TASK7_SYNTHETIC_SECRET = old;
  }
});

test("legacy console bridge suppresses raw arguments and preserves a safe error code", () => {
  const code = "const l=require('./utils/logger');l.installSafeConsole();console.error('guest@example.test privatepayload',Object.assign(new Error('secret'),{code:'23505'}));";
  const result = spawnSync(process.execPath, ["-e", code], { cwd: require("node:path").resolve(__dirname, ".."), encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0);
  const line = JSON.parse(result.stderr.trim());
  assert.equal(line.message, "legacy_console");
  assert.equal(line.errorCode, "23505");
  assert.ok(!result.stderr.includes("guest@example.test") && !result.stderr.includes("privatepayload"));
});

test("concurrent request logging keeps correlation contexts separate", async () => {
  const output = [];
  const log = logger.createLogger({ write: (level, line) => output.push(JSON.parse(line)) });
  await Promise.all(["request-a", "request-b"].map((requestId) => context.run({ requestId }, async () => {
    await Promise.resolve(); log.info("operation complete");
  })));
  assert.deepEqual(output.map((row) => row.requestId).sort(), ["request-a", "request-b"]);
  assert.deepEqual(context.get(), {});
});

test("request IDs accept UUIDs but reject caller tokens, oversized values and line injection", () => {
  const uuid = "123e4567-e89b-42d3-a456-426614174000";
  assert.equal(getRequestId({ headers: { "x-request-id": uuid } }), uuid);
  for (const value of ["opaque-private-token", "x".repeat(10000), "safe\nforged", [uuid]]) {
    assert.match(getRequestId({ headers: { "x-request-id": value } }), /^[a-f0-9-]{36}$/i);
    assert.notEqual(getRequestId({ headers: { "x-request-id": value } }), value);
  }
});

test("trace context accepts only valid nonzero trace/span identifiers", () => {
  assert.equal(traceId({ headers: { traceparent: "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01" } }), "1234567890abcdef1234567890abcdef");
  assert.equal(traceId({ headers: { traceparent: "00-00000000000000000000000000000000-1234567890abcdef-01" } }), undefined);
  assert.equal(traceId({ headers: { traceparent: "private-input" } }), undefined);
});

test("request lifecycle records finish/close once without URLs, tokens, IP or hotel hints", () => {
  const req = { headers: { origin: "https://guest@example.test", "x-forwarded-for": "192.0.2.4" }, method: "POST",
    originalUrl: "/api/public/qr/q1_private/orders?token=private", query: { hotel: "private" } };
  const res = response();
  const records = [];
  const old = logger.info;
  const before = metrics.snapshot().requests.reduce((sum, row) => sum + row.count, 0);
  logger.info = (message, meta) => records.push({ message, ...meta });
  try {
    attachRequestContext(req, res, () => logRequestLifecycle(req, res, () => {}));
    res.writeHead(); res.writableFinished = true; res.emit("finish"); res.emit("close");
  } finally { logger.info = old; }
  assert.equal(records.length, 1);
  assert.equal(records[0].operation, "qr");
  assert.ok(!JSON.stringify(records).includes("private") && !JSON.stringify(records).includes("192.0.2.4"));
  assert.equal(metrics.snapshot().requests.reduce((sum, row) => sum + row.count, 0), before + 1);
  assert.match(res.headers["server-timing"], /^app;dur=/);
});

test("aborted requests are recorded without waiting for finish", () => {
  const req = { headers: {}, method: "GET", originalUrl: "/api/health" };
  const res = response();
  logRequestLifecycle(req, res, () => {}); res.emit("close");
  assert.ok(metrics.snapshot().requests.find((row) => row.operation === "health").aborted >= 1);
});

test("operation labels are fixed even under arbitrary paths and identifiers", () => {
  const local = createMetrics();
  for (let i = 0; i < 10000; i += 1) local.request({ operation: `untrusted-${i}`, statusCode: 200, durationMs: 12 });
  assert.equal(local.snapshot().requests.length, 1);
  assert.equal(local.snapshot().requests[0].operation, "other");
  for (const path of ["/api/payments/webhook/private", "/api/staff/room-booking/42", "/api/staff/kds/orders", "/unknown/private"]) assert.ok(OPERATIONS.includes(operationForPath(path)));
});

test("expected conflicts and rate limits are separate from server failures; percentiles are bounds", () => {
  const local = createMetrics();
  for (const statusCode of [200, 409, 429, 401, 500, 504]) local.request({ operation: "checkout", statusCode, durationMs: 42 });
  const value = local.snapshot().requests[0];
  assert.equal(value.conflicts, 1); assert.equal(value.rateLimits, 1); assert.equal(value.authDenials, 1);
  assert.equal(value.serverErrors, 2); assert.equal(value.timeouts, 1); assert.equal(value.p99UpperBoundMs, 50);
});

test("database errors use bounded categories without SQL or tenant metric labels", () => {
  const local = createMetrics();
  for (const code of ["57014", "40P01", "55P03", "40001", "23505", "ECONNRESET", "private-payload"]) local.database({ code, durationMs: 1 });
  assert.deepEqual(Object.values(local.snapshot().database.transactions).reduce((a, b) => a + b, 0), 7);
  assert.equal(databaseCategory("23514"), "constraint");
  assert.ok(!JSON.stringify(local.snapshot()).includes("private-payload"));
});

test("worker heartbeat distinguishes enabled, running, completed and failed cycles", () => {
  let now = 1000;
  const local = createMetrics({ now: () => now });
  local.worker("payment_webhook", { enabled: true, running: true, started: true });
  now += 100;
  local.worker("payment_webhook", { running: false, completed: true, failed: true });
  const state = local.snapshot().workers.payment_webhook;
  assert.equal(state.lastStartedAt, 1000); assert.equal(state.lastCompletedAt, 1100); assert.equal(state.failures, 1);
  local.worker("untrusted-worker", { enabled: true });
  assert.deepEqual(Object.keys(local.snapshot().workers).sort(), ["payment_webhook", "qr_outbox", "public_notification_intents"].sort());
  assert.equal(Object.hasOwn(local.snapshot().workers, "untrusted-worker"), false);
});

test("dependency readiness coalesces concurrent probes and caches a safe copy", async () => {
  let calls = 0;
  const health = createDependencyHealth({ probe: async () => { calls += 1; await Promise.resolve(); } });
  const values = await Promise.all(Array.from({ length: 20 }, () => health()));
  assert.equal(calls, 1); assert.ok(values.every((value) => value.ready));
  values[0].ready = false;
  assert.equal((await health()).ready, true);
});

test("dependency failures are generic and recover after cache expiry", async () => {
  let now = 0, fail = true;
  const health = createDependencyHealth({ now: () => now, cacheMs: 10, probe: async () => { if (fail) throw new Error("postgresql://private-credential"); } });
  assert.deepEqual(await health(), { ready: false, issue: "dependency_unavailable" });
  fail = false; now = 11;
  assert.deepEqual(await health(), { ready: true, issue: "" });
});

test("timed-out dependency probes cannot accumulate behind a hung connection", async () => {
  let calls = 0, release;
  const health = createDependencyHealth({ cacheMs: 0, timeoutMs: 5, probe: () => { calls += 1; return new Promise((resolve) => { release = resolve; }); } });
  assert.equal((await health()).ready, false);
  await Promise.all(Array.from({ length: 20 }, () => health()));
  assert.equal(calls, 1); release(); await Promise.resolve();
});

test("operations endpoint defaults disabled and denies hotel/legacy/missing principals", () => {
  const disabled = response(); createOperationsHandler({ enabled: () => false })({}, disabled); assert.equal(disabled.statusCode, 404);
  for (const principal of [null, { principal_type: "hotel_staff", role: "owner" }]) {
    const res = response(); createOperationsHandler({ enabled: () => true })({ authPrincipal: principal, authSession: {} }, res);
    assert.equal(res.statusCode, 403); assert.equal(res.headers["cache-control"], "no-store");
  }
  const legacy = response(); createOperationsHandler({ enabled: () => true })({ adminUser: { scope: "admin" } }, legacy); assert.equal(legacy.statusCode, 403);
});

test("operations endpoint uses existing platform permission and returns only supplied aggregate snapshot", () => {
  const res = response();
  createOperationsHandler({ enabled: () => true, snapshot: () => ({ scope: "PROCESS_LOCAL_SINCE_START", requests: [] }) })({
    authPrincipal: { principal_type: "platform_admin", principal_id: 1 }, authSession: { session_id: "synthetic" }
  }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.success, true);
  assert.equal(resolveRoutePermission("GET", "/api/admin/operations"), "platform.settings.read");
});

test("restricted DB telemetry preserves transaction SQL, rollback, thrown error and release", async () => {
  const calls = [];
  let released = 0;
  const failure = Object.assign(new Error("private query diagnostic"), { code: "40P01" });
  const pool = { async connect() { return { async query(sql) {
    calls.push(sql);
    if (sql.includes("FROM pg_roles")) return { rows: [{ rolname: "app_tenant_runtime", rolcanlogin: true, rolsuper: false, rolbypassrls: false }] };
    return { rows: [] };
  }, release() { released += 1; } }; } };
  await assert.rejects(runTenantTransaction(pool, { tenantId: "123e4567-e89b-42d3-a456-426614174000", propertyId: 7 }, async () => { throw failure; }), (error) => error === failure);
  assert.equal(calls[0], "BEGIN"); assert.equal(calls.at(-1), "ROLLBACK"); assert.equal(released, 1);
  calls.length = 0;
  await runAuthTransaction(pool, (client) => client.query("SELECT 1"), { readOnly: true, statementTimeoutMs: 2000 });
  assert.ok(calls.includes("SET TRANSACTION READ ONLY")); assert.equal(calls.at(-1), "COMMIT"); assert.equal(released, 2);
});

test("DB connection failures preserve their error and do not attempt rollback/release", async () => {
  const failure = Object.assign(new Error("synthetic"), { code: "ECONNREFUSED" });
  const pool = { async connect() { throw failure; } };
  await assert.rejects(runAuthTransaction(pool, async () => {}), (error) => error === failure);
});

test("pool diagnostics do not initialize a connection or disclose configuration", () => {
  assert.deepEqual(require("../utils/tenant-database").getTenantPoolDiagnostics(), { initialized: false });
});

test("QR heartbeat preserves idle batch result and concurrent local skip", async () => {
  const { supabase } = require("../utils/supabase");
  const { processQrOutboxBatch } = require("../utils/qr-outbox");
  const original = supabase.from;
  let release;
  const query = { select() { return this; }, is() { return this; }, lte() { return this; }, order() { return this; },
    limit() { return new Promise((resolve) => { release = resolve; }); } };
  supabase.from = () => query;
  try {
    const first = processQrOutboxBatch();
    assert.deepEqual(await processQrOutboxBatch(), { processed: 0, skipped: true });
    release({ data: [], error: null });
    assert.deepEqual(await first, { processed: 0, skipped: false });
    assert.equal(metrics.snapshot().workers.qr_outbox.running, false);
    assert.ok(metrics.snapshot().workers.qr_outbox.lastCompletedAt);
  } finally { supabase.from = original; }
});

test("payment heartbeat distinguishes idle polling from failure without changing claim semantics", async () => {
  const { env } = require("../config/env");
  const { supabase } = require("../utils/supabase");
  const worker = require("../workers/payment-webhook-worker");
  const originalRpc = supabase.rpc;
  const originalEnabled = env.paymentWebhookWorkerEnabled;
  const oldError = logger.error;
  const calls = [];
  env.paymentWebhookWorkerEnabled = true;
  logger.error = () => {};
  supabase.rpc = async (name, params) => { calls.push({ name, params }); return { data: null, error: null }; };
  try {
    worker.startPaymentWebhookWorker();
    await new Promise(setImmediate);
    worker.stopPaymentWebhookWorker();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "claim_payment_webhook");
    assert.equal(calls[0].params.p_lease_seconds, 60);
    assert.equal(calls[0].params.p_max_attempts, 12);
    const before = metrics.snapshot().workers.payment_webhook.failures;
    supabase.rpc = async () => { throw Object.assign(new Error("synthetic"), { code: "ECONNRESET" }); };
    worker.startPaymentWebhookWorker(); await new Promise(setImmediate); worker.stopPaymentWebhookWorker();
    assert.equal(metrics.snapshot().workers.payment_webhook.failures, before + 1);
    assert.equal(metrics.snapshot().workers.payment_webhook.enabled, false);
  } finally {
    worker.stopPaymentWebhookWorker(); supabase.rpc = originalRpc;
    env.paymentWebhookWorkerEnabled = originalEnabled; logger.error = oldError;
  }
});

test("operational SQL is an explicit read-only aggregate snapshot without mutation statements", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "../scripts/task7b-operational-metrics.sql"), "utf8");
  const sql = source.replace(/--[^\n]*/g, "").replace(/'(?:''|[^'])*'/g, "''");
  assert.match(sql, /begin transaction isolation level repeatable read read only;/i);
  assert.doesNotMatch(sql, /\b(insert|update|delete|truncate|alter|drop|create|grant|revoke|call|copy)\b/i);
  assert.doesNotMatch(sql, /\b(select\s+\*|payload|customer_name|guest_name|last_error_message)\b/i);
});
