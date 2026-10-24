"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  ORDER_CREATION_SCOPES,
  buildOrderCreationRequestFingerprint,
  executeTask6OrderAtomic,
  getOrderIdempotencyKey,
  isMissingTask6OrderAtomicRpc,
  isTask6OrderIdempotencyConflict,
  isTask6OrderSnapshotInvalid,
  normalizeTask6OrderAtomicResult
} = require("../utils/order-idempotency");
const {
  buildExactOrderFinancialSnapshot,
  decimalToScaledInteger
} = require("../utils/exact-money");
const {
  TASK6_POS_BILLING_SCOPES,
  buildTask6PosBillingRequestFingerprint,
  getSafeTask6PosBillingDatabaseDiagnostic,
  mapTask6PosBillingFinalizerError,
  normalizeTask6PosBillingRpcData
} = require("../utils/task6-pos-billing-finalizer");
const {
  buildTask6OrderStateFinalityConflictResponse,
  isTask6OrderStateFinalityConflict
} = require("../utils/task6-order-state-finality");
const { buildTask6FoodBillNumber } = require("../utils/food-order-bill");

const backendRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(backendRoot, "..");

function readBackend(relativePath) {
  return fs.readFileSync(path.join(backendRoot, relativePath), "utf8");
}

function readWorkspace(relativePath) {
  return fs.readFileSync(path.join(workspaceRoot, relativePath), "utf8");
}

test("order request fingerprints are canonical and reject changed intent", () => {
  const original = buildOrderCreationRequestFingerprint({
    operationScope: ORDER_CREATION_SCOPES.PUBLIC,
    request: {
      hotelSlug: "hotel-a",
      note: "less spicy",
      items: [{ id: "7", qty: 2 }]
    }
  });
  const replay = buildOrderCreationRequestFingerprint({
    request: {
      items: [{ qty: 2, id: "7" }],
      note: "less spicy",
      hotelSlug: "hotel-a"
    },
    operationScope: ORDER_CREATION_SCOPES.PUBLIC
  });
  const changed = buildOrderCreationRequestFingerprint({
    operationScope: ORDER_CREATION_SCOPES.PUBLIC,
    request: {
      hotelSlug: "hotel-a",
      note: "less spicy",
      items: [{ id: "7", qty: 3 }]
    }
  });

  assert.match(original, /^[a-f0-9]{64}$/);
  assert.equal(replay, original);
  assert.notEqual(changed, original);
});

test("new POS snapshots use exact minor-unit math with the existing whole-rupee policy", () => {
  const snapshot = buildExactOrderFinancialSnapshot({
    items: [{ id: "7", qty: 3, price: "19.99", lineTotal: 999999 }],
    gstPercent: "5",
    deliveryCharge: "10.25",
    upiDiscountPercent: "10",
    includeUpiPolicy: true,
    applyUpiDiscount: true
  });

  assert.equal(decimalToScaledInteger("19.99", 2), 1999n);
  assert.deepEqual(snapshot.items.map(({ qty, price, lineTotal }) => ({ qty, price, lineTotal })), [
    { qty: 3, price: 19.99, lineTotal: 59.97 }
  ]);
  assert.deepEqual(snapshot.totals, {
    subtotal: 59.97,
    gst: 3,
    deliveryCharge: 10.25,
    gstPercent: 5,
    normalTotal: 73.22,
    total: 66.22,
    upiDiscountPercent: 10,
    gpayDiscount: 7,
    gpayFinalTotal: 66.22
  });
});

test("exact POS math avoids binary accumulation and rounds half-up to a whole rupee", () => {
  const fractional = buildExactOrderFinancialSnapshot({
    items: [{ id: "1", qty: 3, price: "0.10" }],
    gstPercent: "0",
    deliveryCharge: "0"
  });
  const halfRupeeTax = buildExactOrderFinancialSnapshot({
    items: [{ id: "2", qty: 1, price: "10.00" }],
    gstPercent: "5",
    deliveryCharge: "0"
  });

  assert.equal(fractional.totals.subtotal, 0.3);
  assert.equal(fractional.totals.total, 0.3);
  assert.equal(halfRupeeTax.totals.gst, 1);
  assert.equal(halfRupeeTax.totals.total, 11);
});

test("order idempotency keys distinguish missing, invalid, and valid values", () => {
  assert.deepEqual(getOrderIdempotencyKey({ headers: {} }), {
    key: null,
    error: "Idempotency-Key is required"
  });
  assert.match(getOrderIdempotencyKey({ headers: { "idempotency-key": "bad key" } }).error, /safe characters/);
  assert.deepEqual(getOrderIdempotencyKey({ headers: { "idempotency-key": "order:request-123" } }), {
    key: "order:request-123",
    error: null
  });
});

test("atomic order RPC adapter preserves direct and PostgREST-wrapped results", async () => {
  const payload = { created: true, idempotent: false, order: { id: 42 } };
  assert.deepEqual(normalizeTask6OrderAtomicResult(payload), payload);
  assert.deepEqual(
    normalizeTask6OrderAtomicResult([{ task6_create_order_atomic: payload }]),
    payload
  );
  assert.equal(normalizeTask6OrderAtomicResult([]), null);

  const calls = [];
  const databaseClient = {
    async rpc(name, args) {
      calls.push({ name, args });
      return { data: [{ task6_create_order_atomic: payload }], error: null };
    }
  };
  const result = await executeTask6OrderAtomic({
    databaseClient,
    operationScope: ORDER_CREATION_SCOPES.PUBLIC,
    idempotencyKey: "order:request-123",
    requestFingerprint: "a".repeat(64),
    order: { hotel_slug: "hotel-a" }
  });

  assert.deepEqual(result, { data: payload, error: null });
  assert.deepEqual(calls, [{
    name: "task6_create_order_atomic",
    args: {
      p_operation_scope: ORDER_CREATION_SCOPES.PUBLIC,
      p_idempotency_key: "order:request-123",
      p_request_fingerprint: "a".repeat(64),
      p_order: { hotel_slug: "hotel-a" }
    }
  }]);
});

test("atomic order errors are classified without leaking database details", () => {
  assert.equal(isMissingTask6OrderAtomicRpc({ code: "PGRST202" }), true);
  assert.equal(
    isTask6OrderIdempotencyConflict({ message: "TASK6_ORDER_IDEMPOTENCY_CONFLICT" }),
    true
  );
  assert.equal(
    isTask6OrderSnapshotInvalid({ details: "TASK6_ORDER_FINANCIAL_SNAPSHOT_INVALID" }),
    true
  );
});

test("TASK6-C RPC serializes retries and protects canonical financial snapshots", () => {
  const migration = readBackend("scripts/task6-c-order-atomic-idempotency.sql");

  assert.match(migration, /security invoker/i);
  assert.match(migration, /set search_path = pg_catalog, public/i);
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(migration, /TASK6_ORDER_IDEMPOTENCY_CONFLICT/);
  assert.match(migration, /task6_order_snapshot_valid/i);
  assert.match(migration, /financial_snapshot_version[\s\S]*v_scope, v_key, v_fingerprint, 1/i);
  assert.match(migration, /from public\.orders[\s\S]*for update/i);
  assert.match(migration, /from public\.room_bookings[\s\S]*for update/i);
  assert.match(migration, /get_staff_active_table_order/i);
  assert.match(migration, /v_hotel\.tenant_id, v_hotel\.id/i);
  assert.doesNotMatch(migration, /update\s+public\.orders/i);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.orders/i);
});

test("all targeted order-create routes use the atomic RPC and post-commit notifications", () => {
  for (const relativePath of [
    "routes/orders.js",
    "routes/order-tracking.js",
    "routes/staff.js"
  ]) {
    const source = readBackend(relativePath);
    assert.match(source, /executeTask6OrderAtomic/);
    assert.match(source, /ORDER_IDEMPOTENCY_CONFLICT/);
    assert.match(source, /ORDER_FINANCIAL_SNAPSHOT_INVALID/);
    assert.match(source, /atomicResult\.created === true[\s\S]*createNotificationEventSafely/);
  }

  const publicRoute = readBackend("routes/orders.js");
  const addonRoute = readBackend("routes/order-tracking.js");
  const staffRoute = readBackend("routes/staff.js");
  assert.match(publicRoute, /ORDER_CREATION_SCOPES\.PUBLIC/);
  assert.match(addonRoute, /ORDER_CREATION_SCOPES\.PUBLIC_ADDON/);
  assert.match(staffRoute, /ORDER_CREATION_SCOPES\.STAFF_TABLE/);
  assert.match(staffRoute, /ORDER_CREATION_SCOPES\.STAFF_ROOM_SERVICE/);
});

test("public order creation does not expose tenant or idempotency persistence metadata", () => {
  const publicRoute = readBackend("routes/orders.js");
  const presenterMatch = publicRoute.match(
    /function buildPublicCreatedOrder\(order = \{\}\) \{([\s\S]*?)\n\}/
  );

  assert.ok(presenterMatch, "public order presenter must exist");
  assert.doesNotMatch(presenterMatch[1], /tenant_id|property_id|creation_idempotency|creation_request_fingerprint/);
  assert.match(publicRoute, /order: buildPublicCreatedOrder\(data\)/);
  assert.doesNotMatch(publicRoute, /\n\s*order: data,/);
});

test("public and staff clients persist and send durable order operation keys", () => {
  const publicClient = readWorkspace("frontend/js/main.js");
  const staffClient = readWorkspace("frontend/js/staff-orders.js");

  assert.match(publicClient, /getTask6OrderClientRequestId/);
  assert.match(publicClient, /"Idempotency-Key": task6ClientRequestId/);
  assert.match(staffClient, /roomServiceIdempotencyKey/);
  assert.match(staffClient, /tableOrderIdempotencyKey/);
  assert.match(staffClient, /"Idempotency-Key": idempotencyKey/);
});

test("tenant mutation allowlist includes only the named Task 6 order RPC", () => {
  const source = readBackend("utils/tenant-mutation-client.js");
  assert.match(source, /TENANT_RPCS[\s\S]*task6_create_order_atomic/);
});

test("live POS verifier is explicitly TEST-write gated and checks one logical result", () => {
  const source = readBackend("scripts/verify-task6-pos-live.js");
  assert.match(source, /TASK6_POS_TEST_WRITES_CONFIRMED/);
  assert.match(source, /TASK6_POS_LIVE_ENV[\s\S]*TEST/);
  assert.match(source, /Promise\.all\(/);
  assert.match(source, /ids\.length !== 1/);
  assert.match(source, /ORDER_IDEMPOTENCY_CONFLICT/);
  assert.match(source, /CLIENT TAMPERED NAME/);
  assert.match(source, /itemType[\s\S]*combo/);
  assert.match(source, /Cancel this synthetic unpaid order/);
});

test("live POS billing verifier is TEST-gated and preserves any ambiguous financial evidence", () => {
  const source = readBackend("scripts/verify-task6-pos-billing-live.js");
  const packageJson = readBackend("package.json");

  assert.match(source, /TASK6_POS_BILLING_TEST_WRITES_CONFIRMED/);
  assert.match(source, /TASK6_POS_BILLING_LIVE_ENV[\s\S]*TEST/);
  assert.match(source, /TASK6_POS_BILLING_TEST_BEARER_TOKEN/);
  assert.match(source, /task6_pos_billing_finalizer/);
  assert.match(source, /enabled !== true/);
  assert.match(source, /Promise\.all\(/);
  assert.match(source, /ORDER_BILLING_IDEMPOTENCY_CONFLICT/);
  assert.match(source, /paymentStatus[^\n]*unpaid/);
  assert.match(source, /Preserve the TEST order, bill snapshot, and audit evidence/);
  assert.match(packageJson, /"verify:task6-pos-billing-live"/);
});

test("Task 6 POS billing finalizer preserves the billing intent across retries", () => {
  const original = buildTask6PosBillingRequestFingerprint({
    hotelSlug: "hotel-a",
    orderId: "42",
    finalizeScope: TASK6_POS_BILLING_SCOPES.SINGLE
  });
  const replay = buildTask6PosBillingRequestFingerprint({
    orderId: 42,
    finalizeScope: "single_bill",
    hotelSlug: "hotel-a"
  });
  const changed = buildTask6PosBillingRequestFingerprint({
    hotelSlug: "hotel-a",
    orderId: "42",
    finalizeScope: TASK6_POS_BILLING_SCOPES.FAMILY
  });

  assert.match(original, /^[a-f0-9]{64}$/);
  assert.equal(replay, original);
  assert.notEqual(changed, original);
  assert.equal(
    buildTask6FoodBillNumber({ hotel_slug: "hotel-a", id: 42 }, "2026-10-23T11:00:00.000Z"),
    "BILL-HOTEL-A-20261023-42"
  );
});

test("Task 6 POS billing adapter accepts only a scalar RPC result and maps conflicts safely", () => {
  const payload = { idempotentReplay: false, orders: [{ id: 42 }], snapshots: [{ id: 7 }] };
  assert.deepEqual(normalizeTask6PosBillingRpcData(payload), payload);
  assert.deepEqual(
    normalizeTask6PosBillingRpcData([{ task6_finalize_order_family: payload }]),
    payload
  );
  assert.equal(normalizeTask6PosBillingRpcData([]), null);

  assert.equal(
    mapTask6PosBillingFinalizerError({ message: "TASK6_ORDER_BILL_IDEMPOTENCY_CONFLICT" }).code,
    "ORDER_BILLING_IDEMPOTENCY_CONFLICT"
  );
  assert.equal(
    mapTask6PosBillingFinalizerError({ message: "TASK6_ORDER_BILL_FINANCIAL_SNAPSHOT_NOT_FINALIZABLE" }).status,
    409
  );
  assert.equal(
    mapTask6PosBillingFinalizerError({ message: "TASK6_ORDER_BILL_SNAPSHOT_MISMATCH" }).status,
    409
  );
  assert.deepEqual(
    getSafeTask6PosBillingDatabaseDiagnostic({ code: "P0001", message: "TASK6_ORDER_BILL_TEST" }),
    { databaseCode: "P0001", databaseMessage: "TASK6_ORDER_BILL_TEST" }
  );

  const finalizerSource = readBackend("utils/task6-pos-billing-finalizer.js");
  assert.match(
    finalizerSource,
    /p_snapshots:\s*JSON\.stringify\(candidateSet\.candidates\)/
  );
});

test("Task 6 POS billing is feature-gated and leaves gateway payment finality outside the bill finalizer", () => {
  const envSource = readBackend("config/env.js");
  const serverSource = readBackend("server.js");
  const staffRoute = readBackend("routes/staff.js");
  const mutationClient = readBackend("utils/tenant-mutation-client.js");
  const billingMigration = readBackend("scripts/task6-e-a-pos-billing-finalizer.sql");
  const staffClient = readWorkspace("frontend/js/staff-orders.js");

  assert.match(envSource, /TASK6_POS_BILLING_FINALIZER_ENABLED",\s*"false"\)\s*===\s*"true"/);
  assert.match(serverSource, /"task6_pos_billing_finalizer"[\s\S]*?env\.task6PosBillingFinalizerEnabled/);
  assert.match(staffRoute, /task6PosBillingFinalizerEnabled[\s\S]*?TASK6_POS_BILLING_SCOPES\.SINGLE/);
  assert.match(staffRoute, /task6PosBillingFinalizerEnabled[\s\S]*?TASK6_POS_BILLING_SCOPES\.FAMILY/);
  assert.match(staffRoute, /ORDER_BILLING_IDEMPOTENCY_REQUIRED/);
  assert.match(mutationClient, /TENANT_RPCS[\s\S]*task6_finalize_order_family/);
  assert.match(staffClient, /getStaffFinancialActionIdempotencyKey/);
  assert.match(staffClient, /"Idempotency-Key": idempotencyKey/);
  assert.match(billingMigration, /Provider payment finality remains Task 2 controlled/i);
  assert.doesNotMatch(billingMigration, /razorpay.*api|fetch\s*\(/i);
});

test("existing POS billing replay verifier is TEST-gated and never creates a second order", () => {
  const source = readBackend("scripts/verify-task6-pos-billing-replay-live.js");
  const packageJson = readBackend("package.json");

  assert.match(source, /TASK6_POS_BILLING_EXISTING_REPLAY_CONFIRMED/);
  assert.match(source, /TASK6_POS_BILLING_LIVE_ENV[\s\S]*TEST/);
  assert.match(source, /TASK6_POS_BILLING_REPLAY_ORDER_ID/);
  assert.match(source, /TASK6_POS_BILLING_REPLAY_IDEMPOTENCY_KEY/);
  assert.match(source, /Promise\.all\(\[finalizeBill\(inputs\), finalizeBill\(inputs\)\]\)/);
  assert.match(source, /ORDER_BILLING_IDEMPOTENCY_CONFLICT/);
  assert.doesNotMatch(source, /api\/orders/);
  assert.match(packageJson, /"verify:task6-pos-billing-replay-live"/);
});

test("Task 6-E-B maps database finality guard conflicts without exposing database details", () => {
  assert.equal(
    isTask6OrderStateFinalityConflict({ message: "TASK6_ORDER_KITCHEN_TRANSITION_INVALID" }),
    true
  );
  assert.equal(
    isTask6OrderStateFinalityConflict({ details: "TASK6_ORDER_FINAL_PAYMENT_IMMUTABLE" }),
    true
  );
  assert.equal(
    isTask6OrderStateFinalityConflict({ message: "TASK6_ORDER_FINAL_OPERATIONAL_STATE_IMMUTABLE" }),
    true
  );
  assert.equal(isTask6OrderStateFinalityConflict({ message: "other failure" }), false);
  assert.deepEqual(buildTask6OrderStateFinalityConflictResponse(), {
    success: false,
    code: "ORDER_STATE_FINALITY_CONFLICT",
    message: "This order is finalized or the requested lifecycle transition is not allowed. Reload the order and use the approved workflow."
  });

  const staffRoute = readBackend("routes/staff.js");
  const adminRoute = readBackend("routes/admin.js");
  assert.match(staffRoute, /isTask6OrderStateFinalityConflict\(error\)[\s\S]*?status\(409\)/);
  assert.match(adminRoute, /isTask6OrderStateFinalityConflict\(error\)[\s\S]*?status\(409\)/);
});

test("Task 6-E-B2 blocks terminal operational changes after financial finality", () => {
  const migration = readBackend("scripts/task6-e-b2-finalized-order-operational-guard.sql");
  const verifier = readBackend("scripts/verify-task6-e-b2-finalized-order-operational-guard-migration.js");
  const packageJson = readBackend("package.json");

  assert.match(migration, /task6_guard_order_state_and_finality/i);
  assert.match(migration, /create trigger orders_11_task6_finalized_operational_guard/i);
  assert.match(migration, /TASK6_ORDER_FINAL_OPERATIONAL_STATE_IMMUTABLE/i);
  assert.match(migration, /security invoker/i);
  assert.match(migration, /set search_path = pg_catalog, public/i);
  assert.doesNotMatch(migration, /\b(?:delete|update)\s+public\.(?:orders|food_order_bill_snapshots|food_order_bill_audit)\b/i);
  assert.match(verifier, /Task 6-E-B2 finalized operational guard migration contract: PASS/);
  assert.match(packageJson, /"verify:task6-e-b2-finalized-operational-guard-migration"/);
});

test("Task 6-E-B2 runtime failure injection is TEST-order-scoped and rolls back", () => {
  const testSql = readBackend("scripts/task6-e-b2-finalized-order-runtime-rollback-test.sql");
  const verifier = readBackend("scripts/verify-task6-e-b2-runtime-rollback-test.js");
  const packageJson = readBackend("package.json");

  assert.match(testSql, /v_order_id bigint := 274/i);
  assert.match(testSql, /v_hotel_slug text := 'hotel-sai-raj'/i);
  assert.match(testSql, /TASK6_E_B2_RUNTIME_TEST_TARGET_NOT_FINALIZED/i);
  assert.match(testSql, /TASK6_ORDER_FINAL_FINANCIAL_SNAPSHOT_IMMUTABLE/i);
  assert.match(testSql, /TASK6_ORDER_FINAL_BILL_IMMUTABLE/i);
  assert.match(testSql, /TASK6_ORDER_FINAL_OPERATIONAL_STATE_IMMUTABLE/i);
  assert.match(testSql, /create temporary table/i);
  assert.match(testSql, /rollback;/i);
  assert.doesNotMatch(testSql, /\b(?:insert into|delete from)\s+public\./i);
  assert.match(verifier, /Task 6-E-B2 runtime rollback failure-injection contract: PASS/);
  assert.match(packageJson, /"verify:task6-e-b2-runtime-rollback-test"/);
});

