"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createQrOutboxProcessor } = require("../utils/qr-outbox-processor");
const { buildNotificationDedupeKey } = require("../utils/notification-dedupe");
const TENANT = "11111111-1111-4111-8111-111111111111";
const copy = (value) => JSON.parse(JSON.stringify(value));
function setup() {
  const state = { now: Date.parse("2026-10-28T13:00:00Z"), delivered: 0, created: 0, published: [], logs: [], metrics: [], ackFailOnce: false };
  const event = { id: "1", tenant_id: TENANT, property_id: "10", hotel_slug: "fixture-hotel", aggregate_type: "order", aggregate_id: "20",
    event_type: "QR_ITEMS_EDITED", deduplication_key: "fixture-edit-1", payload: { roundSequence: 2 }, attempt_count: 0,
    published_at: null, next_attempt_at: new Date(state.now).toISOString(), last_error: null };
  const tables = { qr_event_outbox: [event], notification_events: [], hotels: [{ id: "10", tenant_id: TENANT, slug: "fixture-hotel" }],
    orders: [{ id: "20", tenant_id: TENANT, property_id: "10", hotel_slug: "fixture-hotel" }] };
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.count = Infinity; }
    select() { return this; }
    update(values) { this.values = values; return this; }
    eq(key, value) { this.filters.push((row) => String(row[key]) === String(value)); return this; }
    is(key, value) { this.filters.push((row) => row[key] === value); return this; }
    lte(key, value) { this.filters.push((row) => Date.parse(row[key]) <= Date.parse(value)); return this; }
    contains(key, value) { this.filters.push((row) => Object.keys(value).every((field) => row[key]?.[field] === value[field])); return this; }
    order() { return this; }
    limit(value) { this.count = value; return this; }
    maybeSingle() { this.single = true; return this; }
    then(resolve, reject) { return Promise.resolve().then(() => {
      let rows = tables[this.table].filter((row) => this.filters.every((filter) => filter(row))).slice(0, this.count);
      if (this.values?.published_at && state.ackFailOnce) { state.ackFailOnce = false; return { data: null, error: { code: "08006", message: "PRIVATE-SMTP-DIAGNOSTIC" } }; }
      if (this.values) rows.forEach((row) => Object.assign(row, this.values));
      return { data: this.single ? copy(rows[0] || null) : copy(rows), error: null };
    }).then(resolve, reject); }
  }
  const db = { from: (table) => new Query(table) };
  async function createEvent(input) {
    state.created++;
    assert.equal(input.databaseClient, db);
    const row = { id: String(100 + state.created), tenant_id: input.tenantId, property_id: input.propertyId, hotel_slug: input.hotelSlug,
      source_type: input.sourceType, source_id: String(input.sourceId), payload: input.payload, status: "pending",
      dedupe_key: buildNotificationDedupeKey({ sourceType: input.sourceType, sourceId: input.sourceId, eventType: "order_created", payload: input.payload }) };
    const prior = tables.notification_events.find((item) => item.dedupe_key === row.dedupe_key);
    if (prior) return copy(prior);
    tables.notification_events.push(row); return copy(row);
  }
  async function deliver(row) {
    state.delivered++;
    const stored = tables.notification_events.find((item) => item.id === row.id);
    stored.status = "sent"; return copy(stored);
  }
  function processor(overrides = {}) {
    return createQrOutboxProcessor({ databaseClient: db, createEvent, deliver, publish: (row) => state.published.push(copy(row)), now: () => state.now,
      metrics: { worker: (name, patch) => state.metrics.push({ name, ...patch }) }, logger: { warn: (...args) => state.logs.push(args), error: (...args) => state.logs.push(args) }, ...overrides });
  }
  return { state, event, tables, processor, createEvent, deliver };
}
test("QR event is durably created/published, delivered and acknowledged with its canonical owner", async () => {
  const x = setup(); assert.deepEqual(await x.processor().processQrOutboxBatch(), { processed: 1, skipped: false });
  assert.equal(x.state.created, 1); assert.equal(x.state.delivered, 1); assert.equal(x.state.published.length, 1);
  assert.ok(x.event.published_at); assert.equal(x.tables.notification_events[0].tenant_id, TENANT);
});
test("failed notification stays unpublished and the existing row is retried to success", async () => {
  const x = setup(); const worker = x.processor({ deliver: async (row) => {
    if (!x.state.delivered++) { x.tables.notification_events[0].status = "failed"; return { ...row, status: "failed" }; }
    x.tables.notification_events[0].status = "sent"; return { ...row, status: "sent" };
  } });
  assert.equal((await worker.processQrOutboxBatch()).processed, 0); assert.equal(x.event.published_at, null);
  x.state.now += 5001; assert.equal((await worker.processQrOutboxBatch()).processed, 1);
  assert.equal(x.state.created, 1); assert.equal(x.state.delivered, 2);
});
test("swallowed delivery failure returning null cannot acknowledge the QR source", async () => {
  const x = setup(); await x.processor({ deliver: async () => null }).processQrOutboxBatch();
  assert.equal(x.event.published_at, null); assert.match(x.event.last_error, /^QR_OUTBOX_/);
});
test("explicitly skipped notification preserves disabled/internal delivery semantics", async () => {
  const x = setup(); await x.processor({ deliver: async (row) => ({ ...row, status: "skipped" }) }).processQrOutboxBatch();
  assert.ok(x.event.published_at); assert.equal(x.state.delivered, 0);
});
test("crash before external send leaves a reusable notification row and retryable source", async () => {
  const x = setup(); await x.processor({ deliver: async () => { throw new Error("PRIVATE-SMTP-DIAGNOSTIC"); } }).processQrOutboxBatch();
  assert.equal(x.event.published_at, null); assert.equal(x.state.created, 1); assert.equal(x.state.delivered, 0);
  x.state.now += 5001; await x.processor().processQrOutboxBatch(); assert.equal(x.state.created, 1); assert.equal(x.state.delivered, 1);
  assert.ok(!JSON.stringify([x.state.logs, x.event.last_error]).includes("PRIVATE-SMTP-DIAGNOSTIC"));
});
test("send/status success followed by ack failure retries acknowledgement without another send", async () => {
  const x = setup(); x.state.ackFailOnce = true; await x.processor().processQrOutboxBatch();
  assert.equal(x.event.published_at, null); assert.equal(x.state.delivered, 1);
  x.state.now += 5001; await x.processor().processQrOutboxBatch(); assert.equal(x.state.delivered, 1); assert.ok(x.event.published_at);
});
test("ambiguous provider success before durable status can duplicate delivery: no exactly-once claim", async () => {
  const x = setup(); await x.processor({ deliver: async () => { x.state.delivered++; throw new Error("Provider accepted before process failure"); } }).processQrOutboxBatch();
  x.state.now += 5001; await x.processor().processQrOutboxBatch(); assert.equal(x.state.delivered, 2);
});
test("two processor instances cannot claim the same current attempt concurrently", async () => {
  const x = setup(); const results = await Promise.all([x.processor().processQrOutboxBatch(), x.processor().processQrOutboxBatch()]);
  assert.equal(results.reduce((sum, value) => sum + value.processed, 0), 1); assert.equal(x.state.delivered, 1);
});
test("stale successful attempt cannot acknowledge a newer retry owner", async () => {
  const x = setup(); await x.processor({ deliver: async (row) => {
    x.event.attempt_count++; x.event.next_attempt_at = new Date(x.state.now + 60000).toISOString(); return { ...row, status: "sent" };
  } }).processQrOutboxBatch(); assert.equal(x.event.published_at, null);
});
test("stale failed attempt cannot overwrite a newer attempt diagnostic", async () => {
  const x = setup(); await x.processor({ deliver: async () => {
    x.event.attempt_count++; x.event.next_attempt_at = new Date(x.state.now + 60000).toISOString(); x.event.last_error = "NEWER_ATTEMPT";
    throw new Error("late timeout");
  } }).processQrOutboxBatch(); assert.equal(x.event.last_error, "NEWER_ATTEMPT");
});
test("canonical hotel mismatch prevents external notification delivery", async () => {
  const x = setup(); x.tables.hotels[0].tenant_id = "22222222-2222-4222-8222-222222222222";
  await x.processor().processQrOutboxBatch(); assert.equal(x.state.delivered, 0); assert.equal(x.state.created, 0); assert.equal(x.event.published_at, null);
});
test("cross-property aggregate cannot be used to deliver a notification", async () => {
  const x = setup(); x.tables.orders[0].property_id = "11";
  await x.processor().processQrOutboxBatch(); assert.equal(x.state.delivered, 0); assert.equal(x.event.published_at, null);
});
test("wrong-owner notification returned from creation is rejected before send", async () => {
  const x = setup(); await x.processor({ createEvent: async (input) => ({ ...await x.createEvent(input), property_id: "11" }) }).processQrOutboxBatch();
  assert.equal(x.state.delivered, 0); assert.equal(x.event.published_at, null);
});
test("invalid payload or missing owner fails closed without mutating an unclaimed row", async () => {
  for (const change of [{ payload: [] }, { tenant_id: null }, { property_id: "0" }, { attempt_count: -1 }, { aggregate_type: "booking" }]) {
    const x = setup(); Object.assign(x.event, change); await x.processor().processQrOutboxBatch();
    assert.equal(x.event.attempt_count, change.attempt_count ?? 0); assert.equal(x.state.created, 0); assert.equal(x.state.delivered, 0);
  }
});
test("distinct edits in the same QR round retain distinct source-event dedupe identities", async () => {
  const x = setup(); x.tables.qr_event_outbox.push({ ...copy(x.event), id: "2", deduplication_key: "fixture-edit-2" });
  assert.equal((await x.processor().processQrOutboxBatch()).processed, 2); assert.equal(x.state.created, 2);
  assert.notEqual(x.tables.notification_events[0].dedupe_key, x.tables.notification_events[1].dedupe_key);
});
test("local SSE failure does not undo durable notification or successful delivery", async () => {
  const x = setup(); await x.processor({ publish: () => { throw new Error("closed subscriber"); } }).processQrOutboxBatch();
  assert.equal(x.state.delivered, 1); assert.ok(x.event.published_at);
});
test("future backoff prevents early reclaim and retry delay remains capped", async () => {
  const x = setup(); x.event.attempt_count = 100;
  await x.processor({ deliver: async () => null }).processQrOutboxBatch();
  assert.equal(Date.parse(x.event.next_attempt_at) - x.state.now, 300000);
  const attempts = x.event.attempt_count; await x.processor().processQrOutboxBatch(); assert.equal(x.event.attempt_count, attempts);
});
test("large string IDs are preserved without unsafe Number conversion", async () => {
  const x = setup(); x.event.aggregate_id = "9007199254740993"; x.tables.orders[0].id = x.event.aggregate_id;
  await x.processor().processQrOutboxBatch(); assert.equal(x.tables.notification_events[0].source_id, "9007199254740993");
});
test("same processor prevents overlapping cycles and releases its busy state on failure", async () => {
  const x = setup(); let release; const gate = new Promise((resolve) => { release = resolve; });
  const worker = x.processor({ deliver: async (row) => { await gate; return { ...row, status: "sent" }; } });
  const first = worker.processQrOutboxBatch(); assert.deepEqual(await worker.processQrOutboxBatch(), { processed: 0, skipped: true });
  release(); await first; assert.equal(worker.isProcessing(), false); assert.equal(x.state.metrics.at(-1).running, false);
});
test("backoff is not a send lease: a slow older send can overlap a later attempt", async () => {
  const x = setup(); let release, entered; const gate = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { entered = resolve; });
  const first = x.processor({ deliver: async (row) => { entered(); await gate; x.state.delivered++; return { ...row, status: "sent" }; } }).processQrOutboxBatch();
  await ready; x.state.now += 5001;
  const second = await x.processor().processQrOutboxBatch(); release();
  assert.equal((await first).processed, 0); assert.equal(second.processed, 1); assert.equal(x.state.delivered, 2);
});
test("unknown delivery status and mismatched returned event identity cannot acknowledge", async () => {
  for (const change of [{ status: "processing" }, { id: "999", status: "sent" }]) {
    const x = setup(); await x.processor({ deliver: async (row) => ({ ...row, ...change }) }).processQrOutboxBatch();
    assert.equal(x.event.published_at, null);
  }
});
test("worker discovery SQL is read-only and returns no payload/error/credential content", () => {
  const fs = require("node:fs"), path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "../scripts/task7d-worker-state-inventory.sql"), "utf8");
  const sql = source.replace(/--[^\n]*/g, "").replace(/'(?:''|[^'])*'/g, "''");
  assert.match(sql, /begin transaction isolation level repeatable read read only;/i);
  assert.doesNotMatch(sql, /\b(insert|update|delete|truncate|alter|drop|create|grant|revoke|call|copy)\b/i);
  assert.doesNotMatch(sql, /\b(select\s+\*|vault\.|decrypted_secret|smtp_pass|error_message|last_error)\b/i);
  assert.doesNotMatch(source, /'config'\s*,\s*p\.proconfig/);
});

function leasedFixture(x, { lostBeforeSend = false, staleCompletion = false } = {}) {
  const calls = { claims: 0, checks: 0, stops: 0, completions: [] };
  const claimed = { ...copy(x.event), attempt_count: 1, _task7Lease: { owner: TENANT, version: "9007199254740993" } };
  const leaseStore = {
    async claim() { return ++calls.claims === 1 ? claimed : null; },
    watch() { return { assertOwned: async () => {
      calls.checks++; if (lostBeforeSend) throw Object.assign(new Error("lost"), { code: "QR_OUTBOX_LEASE_LOST" });
    }, stop() { calls.stops++; } }; },
    async complete(event, success, code) { assert.equal(event, claimed); calls.completions.push({ success, code }); return !staleCompletion; }
  };
  return { calls, leaseStore };
}
test("leased processor uses fresh claims and RPC completion without legacy source writes", async () => {
  const x = setup(), lease = leasedFixture(x);
  assert.equal((await x.processor({ leaseStore: lease.leaseStore }).processQrOutboxBatch()).processed, 1);
  assert.equal(x.state.delivered, 1); assert.equal(x.event.attempt_count, 0); assert.equal(x.event.published_at, null);
  assert.equal(lease.calls.claims, 2); assert.equal(lease.calls.stops, 1);
  assert.deepEqual(lease.calls.completions, [{ success: true, code: undefined }]); assert.equal(lease.calls.checks, 4);
});
test("lost lease blocks notification creation and send and always stops heartbeat", async () => {
  const x = setup(), lease = leasedFixture(x, { lostBeforeSend: true });
  assert.equal((await x.processor({ leaseStore: lease.leaseStore }).processQrOutboxBatch()).processed, 0);
  assert.equal(x.state.created, 0); assert.equal(x.state.delivered, 0); assert.equal(lease.calls.stops, 1);
  assert.deepEqual(lease.calls.completions, [{ success: false, code: "QR_OUTBOX_LEASE_LOST" }]);
});
test("stale RPC completion cannot report successful processing after a send", async () => {
  const x = setup(), lease = leasedFixture(x, { staleCompletion: true });
  assert.equal((await x.processor({ leaseStore: lease.leaseStore }).processQrOutboxBatch()).processed, 0);
  assert.equal(x.state.delivered, 1); assert.equal(lease.calls.stops, 1); assert.equal(x.event.published_at, null);
  assert.equal(lease.calls.completions[1].code, "QR_OUTBOX_LEASE_LOST");
});
test("paused or missing leased RPC never falls back to legacy queue claims", async () => {
  for (const claim of [async () => null, async () => { throw new Error("PRIVATE-RPC-DIAGNOSTIC"); }]) {
    const x = setup(); await x.processor({ leaseStore: { claim } }).processQrOutboxBatch();
    assert.equal(x.event.attempt_count, 0); assert.equal(x.state.delivered, 0);
    assert.ok(!JSON.stringify(x.state.logs).includes("PRIVATE-RPC-DIAGNOSTIC"));
  }
});
test("leased delivery failure records a bounded retry category and stops heartbeat", async () => {
  const x = setup(), lease = leasedFixture(x);
  await x.processor({ leaseStore: lease.leaseStore, deliver: async () => { throw new Error("PRIVATE-SMTP-DIAGNOSTIC"); } }).processQrOutboxBatch();
  assert.equal(lease.calls.stops, 1); assert.deepEqual(lease.calls.completions, [{ success: false, code: "QR_OUTBOX_RETRYABLE_ERROR" }]);
  assert.ok(!JSON.stringify(x.state.logs).includes("PRIVATE-SMTP-DIAGNOSTIC"));
});
test("heartbeat loss during a slow send fences successful completion even if send returns sent", async (t) => {
  const { QrDeliveryLeaseStore } = require("../utils/qr-delivery-lease-store");
  t.mock.timers.enable({ apis: ["setInterval"] });
  const x = setup(); let claimed = false, lose = false, entered, release; const completions = [];
  const ready = new Promise((resolve) => { entered = resolve; }), pending = new Promise((resolve) => { release = resolve; });
  const store = new QrDeliveryLeaseStore({ rpc: async (name, args) => {
    if (name === "task7d_claim_qr_delivery") {
      if (claimed) return { data: null }; claimed = true;
      return { data: { event: { ...copy(x.event), attempt_count: 1 }, lease: { owner: args.p_lease_owner, version: "1" } } };
    }
    if (name === "task7d_renew_qr_delivery") return { data: !lose };
    completions.push(args.p_success); return { data: false };
  } }, { heartbeatMs: 1000 });
  const run = x.processor({ leaseStore: store, deliver: async (row) => { entered(); await pending; return { ...row, status: "sent" }; } }).processQrOutboxBatch();
  await ready; lose = true; t.mock.timers.tick(1000); await new Promise((resolve) => setImmediate(resolve)); release();
  assert.equal((await run).processed, 0); assert.deepEqual(completions, [false]); assert.equal(x.event.published_at, null);
});
