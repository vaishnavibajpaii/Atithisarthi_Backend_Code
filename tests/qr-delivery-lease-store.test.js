"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { QrDeliveryLeaseStore } = require("../utils/qr-delivery-lease-store");
const OWNER = "11111111-1111-4111-8111-111111111111";
const event = () => ({ id: "9007199254740993", _task7Lease: { owner: OWNER, version: "9007199254740995", until: "2026-10-29T00:01:00Z" } });
const flush = () => new Promise((resolve) => setImmediate(resolve));
function setup(handler = () => true, options) {
  const calls = [];
  const store = new QrDeliveryLeaseStore({ rpc: async (name, args) => {
    calls.push({ name, args });
    return { data: await handler(name, args), error: null };
  } }, options);
  return { store, calls };
}

test("lease timing rejects invalid or dangerously sparse heartbeat configurations", () => {
  for (const options of [{ leaseSeconds: 29 }, { leaseSeconds: 301 }, { leaseSeconds: 60.5 }, { heartbeatMs: 999 }, { heartbeatMs: 30000 }, { heartbeatMs: Infinity }]) {
    assert.throws(() => setup(undefined, options), /QR_LEASE_CONFIG_INVALID/);
  }
  assert.doesNotThrow(() => setup(undefined, { leaseSeconds: 30, heartbeatMs: 1000 }));
});

test("readiness uses only the dedicated service RPC", async () => {
  const expected = { schema_version: 1, enabled: false, min_event_id: null };
  const { store, calls } = setup(() => expected);
  assert.deepEqual(await store.readiness(), expected);
  assert.deepEqual(calls, [{ name: "task7d_qr_delivery_readiness", args: {} }]);
});

test("each claim has a fresh UUID and preserves large source and version strings", async () => {
  const { store, calls } = setup((name, args) => ({ event: { id: "9007199254740993" }, lease: { owner: args.p_lease_owner, version: "9007199254740995" } }));
  const first = await store.claim(), second = await store.claim();
  assert.equal(first.id, "9007199254740993");
  assert.equal(first._task7Lease.version, "9007199254740995");
  assert.match(first._task7Lease.owner, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(first._task7Lease.owner, second._task7Lease.owner);
  assert.equal(calls[0].name, "task7d_claim_qr_delivery");
  assert.equal(calls[0].args.p_lease_seconds, 60);
});

test("paused or empty claims return null without inventing an event", async () => {
  const { store, calls } = setup(() => null);
  assert.equal(await store.claim(), null);
  assert.equal(calls.length, 1);
});

test("malformed claim envelopes fail closed before any renewal or completion", async () => {
  for (const reply of [{}, { event: {} }, { event: {}, lease: { owner: OWNER, version: "0" } }, { event: {}, lease: { owner: OWNER, version: "1.5" } }, { event: {}, lease: { owner: OWNER, version: "-1" } }]) {
    const { store, calls } = setup(() => reply);
    await assert.rejects(store.claim(), { code: "QR_OUTBOX_LEASE_LOST" });
    assert.equal(calls.length, 1);
  }
});

test("RPC failures reject rather than falling back to legacy claim writes", async () => {
  const expected = Object.assign(new Error("synthetic RPC unavailable"), { code: "42883" });
  const store = new QrDeliveryLeaseStore({ rpc: async () => ({ data: null, error: expected }) });
  await assert.rejects(store.claim(), (error) => error === expected);
});
test("claim rejects returned owner substitution and unsafe numeric claim versions", async () => {
  for (const change of [{ owner: OWNER }, { version: 9007199254740992 }, { version: 1 }]) {
    const { store } = setup((name, args) => ({ event: { id: "1" }, lease: { owner: args.p_lease_owner, version: "1", ...change } }));
    await assert.rejects(store.claim(), { code: "QR_OUTBOX_LEASE_LOST" });
  }
});
test("effect guard transport failure latches loss and emits only a bounded category", async () => {
  const { store, calls } = setup(() => { throw new Error("PRIVATE-RPC-DIAGNOSTIC"); }); const watch = store.watch(event());
  try {
    await assert.rejects(watch.assertOwned(), { message: "QR_OUTBOX_LEASE_LOST" });
    await assert.rejects(watch.assertOwned(), { code: "QR_OUTBOX_LEASE_LOST" }); assert.equal(calls.length, 1);
  } finally { watch.stop(); }
});

test("renewal and completion bind source ID, owner and monotonically increasing version", async () => {
  const { store, calls } = setup();
  assert.equal(await store.renew(event()), true);
  assert.equal(await store.complete(event(), true), true);
  assert.equal(await store.complete(event(), false, "QR_OUTBOX_RETRYABLE_ERROR"), true);
  const identity = { p_event_id: "9007199254740993", p_lease_owner: OWNER, p_claim_version: "9007199254740995" };
  assert.deepEqual(calls, [
    { name: "task7d_renew_qr_delivery", args: { ...identity, p_lease_seconds: 60 } },
    { name: "task7d_complete_qr_delivery", args: { ...identity, p_success: true, p_error_code: null } },
    { name: "task7d_complete_qr_delivery", args: { ...identity, p_success: false, p_error_code: "QR_OUTBOX_RETRYABLE_ERROR" } }
  ]);
});

test("only literal successful RPC booleans authorize renewal or completion", async () => {
  for (const reply of [false, null, "true", 1, {}]) {
    const { store } = setup(() => reply);
    assert.equal(await store.renew(event()), false);
    assert.equal(await store.complete(event(), true), false);
  }
  const { store, calls } = setup();
  await assert.rejects(store.renew({ id: "1" }), { code: "QR_OUTBOX_LEASE_LOST" });
  assert.equal(calls.length, 0);
});

test("watch renews on its timer, prevents overlapping timer renewals and stops cleanly", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { store, calls } = setup(() => pending, { heartbeatMs: 1000 });
  const watch = store.watch(event());
  try {
    t.mock.timers.tick(1000); await flush();
    assert.equal(calls.length, 1);
    t.mock.timers.tick(5000); await flush();
    assert.equal(calls.length, 1);
    release(true); await flush();
    t.mock.timers.tick(1000); await flush();
    assert.equal(calls.length, 2);
    watch.stop(); t.mock.timers.tick(10000); await flush();
    assert.equal(calls.length, 2);
    await assert.rejects(watch.assertOwned(), { code: "QR_OUTBOX_LEASE_LOST" });
    assert.equal(calls.length, 2);
  } finally { release(true); watch.stop(); }
});

test("a failed heartbeat permanently fences the watch before later effects", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { store, calls } = setup(() => false, { heartbeatMs: 1000 });
  const watch = store.watch(event());
  try {
    t.mock.timers.tick(1000); await flush();
    await assert.rejects(watch.assertOwned(), { code: "QR_OUTBOX_LEASE_LOST" });
    assert.equal(calls.length, 1);
  } finally { watch.stop(); }
});

test("heartbeat transport failure is contained and fences the next effect guard", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { store, calls } = setup(() => { throw new Error("synthetic network fault"); }, { heartbeatMs: 1000 });
  const watch = store.watch(event());
  try {
    t.mock.timers.tick(1000); await flush();
    await assert.rejects(watch.assertOwned(), { code: "QR_OUTBOX_LEASE_LOST" });
    assert.equal(calls.length, 1);
  } finally { watch.stop(); }
});

test("effect guard renews immediately and rejects a refused lease", async () => {
  const { store, calls } = setup(() => false);
  const watch = store.watch(event());
  try {
    await assert.rejects(watch.assertOwned(), { code: "QR_OUTBOX_LEASE_LOST" });
    assert.equal(calls.length, 1);
    await assert.rejects(watch.assertOwned(), { code: "QR_OUTBOX_LEASE_LOST" });
    assert.equal(calls.length, 1);
  } finally { watch.stop(); }
});
