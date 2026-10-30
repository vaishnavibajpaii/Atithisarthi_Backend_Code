"use strict";

const { monitorEventLoopDelay } = require("node:perf_hooks");
const OPERATIONS = Object.freeze(["health", "auth", "payment_webhook", "payment", "checkout", "booking", "qr", "kds", "billing", "pos", "notifications", "public", "admin", "staff", "other"]);
const BUCKETS = Object.freeze([5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 15000, 30000, Infinity]);

function operationForPath(value = "") {
  const pathname = String(value).split("?")[0].toLowerCase();
  if (/^\/api\/(health|readiness)\/?$/.test(pathname)) return "health";
  if (/\/payments\/webhook(?:\/|$)/.test(pathname)) return "payment_webhook";
  if (/\/auth(?:\/|$)|\/login\/?$|\/logout\/?$|\/refresh\/?$/.test(pathname)) return "auth";
  if (/checkout/.test(pathname)) return "checkout";
  if (/payment/.test(pathname)) return "payment";
  if (/booking|\/rooms/.test(pathname)) return "booking";
  if (/\/qr(?:\/|$)/.test(pathname)) return "qr";
  if (/\/kds(?:\/|$)|kitchen/.test(pathname)) return "kds";
  if (/bill/.test(pathname)) return "billing";
  if (/orders|order-tracking/.test(pathname)) return "pos";
  if (/notification/.test(pathname)) return "notifications";
  if (/^\/api\/public(?:\/|$)/.test(pathname)) return "public";
  if (/^\/api\/admin(?:\/|$)/.test(pathname)) return "admin";
  if (/^\/api\/staff(?:\/|$)/.test(pathname)) return "staff";
  return "other";
}

function databaseCategory(code) {
  const value = String(code || "");
  if (value === "57014") return "timeout";
  if (value === "40P01") return "deadlock";
  if (value === "55P03") return "lock_timeout";
  if (value === "40001") return "serialization";
  if (/^23/.test(value)) return "constraint";
  if (/^08|^ECONN|^ETIMEDOUT|^ENOTFOUND/.test(value)) return "connection";
  return value ? "other" : "success";
}

function createMetrics({ now = Date.now } = {}) {
  const startedAt = now();
  const requests = new Map();
  const database = Object.fromEntries(["success", "timeout", "deadlock", "lock_timeout", "serialization", "constraint", "connection", "other"].map((key) => [key, 0]));
  const workers = { payment_webhook: {}, qr_outbox: {}, public_notification_intents: {} };
  let loop;
  let databaseDurationMs = 0;
  const count = (value) => Number.isFinite(value) && value >= 0 ? value : 0;
  function request({ operation, statusCode, durationMs, aborted = false }) {
    const name = OPERATIONS.includes(operation) ? operation : "other";
    const duration = count(durationMs);
    let record = requests.get(name);
    if (!record) {
      record = { operation: name, count: 0, serverErrors: 0, clientErrors: 0, conflicts: 0, authDenials: 0, rateLimits: 0, timeouts: 0, aborted: 0,
        durationMsTotal: 0, buckets: BUCKETS.map(() => 0) };
      requests.set(name, record);
    }
    record.count += 1;
    record.durationMsTotal += duration;
    record.buckets[BUCKETS.findIndex((bound) => duration <= bound)] += 1;
    if (aborted) record.aborted += 1;
    else if (statusCode === 409) record.conflicts += 1;
    else if (statusCode === 429) record.rateLimits += 1;
    else if ([401, 403].includes(statusCode)) record.authDenials += 1;
    else if (statusCode >= 500) record.serverErrors += 1;
    else if (statusCode >= 400) record.clientErrors += 1;
    if ([408, 504].includes(statusCode)) record.timeouts += 1;
  }
  function percentile(record, fraction) {
    const target = Math.ceil(record.count * fraction);
    let cumulative = 0;
    for (let i = 0; i < BUCKETS.length; i += 1) {
      cumulative += record.buckets[i];
      if (cumulative >= target) return Number.isFinite(BUCKETS[i]) ? BUCKETS[i] : null;
    }
    return null;
  }
  function worker(name, patch = {}) {
    if (!Object.hasOwn(workers, name)) return;
    const state = workers[name];
    for (const key of ["enabled", "running"]) if (typeof patch[key] === "boolean") state[key] = patch[key];
    if (patch.started) state.lastStartedAt = now();
    if (patch.completed) {
      state.lastCompletedAt = now();
      state.cycles = (state.cycles || 0) + 1;
      state.failures = (state.failures || 0) + (patch.failed ? 1 : 0);
    }
  }
  function snapshot() {
    return { scope: "PROCESS_LOCAL_SINCE_START", startedAt: new Date(startedAt).toISOString(), uptimeSeconds: Math.floor((now() - startedAt) / 1000),
      requests: [...requests.values()].map((record) => ({ ...record, buckets: undefined,
        p50UpperBoundMs: percentile(record, .50), p95UpperBoundMs: percentile(record, .95), p99UpperBoundMs: percentile(record, .99) })),
      database: { transactions: { ...database }, durationMsTotal: databaseDurationMs }, workers: JSON.parse(JSON.stringify(workers)),
      process: { memoryBytes: process.memoryUsage(), cpuMicroseconds: process.cpuUsage(),
        eventLoopP99Ms: loop ? Math.round(loop.percentile(99) / 1e6 * 100) / 100 : null } };
  }
  return { request, worker, snapshot,
    database: ({ code, durationMs = 0 } = {}) => { database[databaseCategory(code)] += 1; databaseDurationMs += count(durationMs); },
    start: () => { if (!loop) { loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable(); } },
    stop: () => { if (loop) { loop.disable(); loop = undefined; } } };
}

module.exports = { OPERATIONS, BUCKETS, createMetrics, operationForPath, databaseCategory, metrics: createMetrics() };
