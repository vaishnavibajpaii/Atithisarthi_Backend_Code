"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildFinalCheckoutSnapshotCandidate,
  mapSnapshotBill
} = require("../utils/room-checkout-bill");
const {
  TASK6_CHECKOUT_RPC_NAME,
  buildTask6CheckoutRequestFingerprint,
  buildTask6RoomCheckoutRpcParams,
  mapTask6CheckoutFinalizerError,
  settleTask6RoomCheckout
} = require("../utils/task6-room-checkout-finalizer");

const backendRoot = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(backendRoot, relativePath), "utf8");
}

function makeCheckoutRows({ orders = [], receipt = null } = {}) {
  return {
    room_bookings: {
      data: {
        id: 42,
        hotel_slug: "hotel-a",
        room_id: 7,
        room_number: "A-7",
        guest_name: "Synthetic Guest",
        guest_phone: "9000000000",
        guest_email: "guest@example.test",
        guest_id_proof: "ID-1234",
        adults: 2,
        children: 0,
        check_in_date: "2026-10-19",
        check_out_date: "2026-10-21",
        checked_in_at: "2026-10-19T10:00:00.000Z",
        booking_status: "checked_in",
        payment_status: "partially_paid",
        total_amount: 100,
        room_price: 90,
        tax_amount: 10,
        discount_amount: 0,
        advance_paid: 50,
        balance_amount: 50,
        total_nights: 2,
        tax_snapshot: {}
      },
      error: null
    },
    rooms: {
      data: {
        id: 7,
        hotel_slug: "hotel-a",
        room_number: "A-7",
        title: "Standard",
        room_type_id: null
      },
      error: null
    },
    orders: { data: orders, error: null },
    room_booking_payments: {
      data: [{
        id: 3,
        hotel_slug: "hotel-a",
        booking_id: 42,
        amount: 50,
        payment_method: "cash",
        payment_status: "paid",
        transaction_id: null,
        paid_at: "2026-10-19T10:00:00.000Z",
        created_at: "2026-10-19T10:00:00.000Z"
      }],
      error: null
    },
    room_booking_refunds: { data: [], error: null },
    room_checkout_receipts: { data: receipt, error: null },
    hotel_profiles: { data: null, error: null },
    room_checkout_bill_formats: { data: null, error: null }
  };
}

function createFakeDatabase({ rows, rpcResult = null } = {}) {
  const calls = [];
  const database = {
    calls,
    from(table) {
      calls.push({ operation: "from", table });
      const result = rows[table] || { data: null, error: null };
      const query = {
        select(columns) {
          calls.push({ operation: "select", table, columns });
          return this;
        },
        eq(column, value) {
          calls.push({ operation: "eq", table, column, value });
          return this;
        },
        order(column, options) {
          calls.push({ operation: "order", table, column, options });
          return this;
        },
        limit(value) {
          calls.push({ operation: "limit", table, value });
          return this;
        },
        maybeSingle() {
          calls.push({ operation: "maybeSingle", table });
          return Promise.resolve(result);
        },
        then(resolve, reject) {
          return Promise.resolve(result).then(resolve, reject);
        }
      };
      return query;
    },
    async rpc(name, params) {
      calls.push({ operation: "rpc", name, params });
      return typeof rpcResult === "function" ? rpcResult(name, params) : rpcResult;
    }
  };
  return database;
}

const roomServiceOrder = {
  id: "order-1",
  hotel_slug: "hotel-a",
  payment_method: null,
  payment_status: "unpaid",
  billing_status: "not_billed",
  status: "new",
  items: [{ id: "tea", name: "Tea", qty: 1, price: 20 }],
  totals: { subtotal: 20, gst: 0, gstPercent: 0, deliveryCharge: 0, normalTotal: 20, total: 20 },
  created_at: "2026-10-20T12:00:00.000Z",
  room_id: 7,
  room_booking_id: 42,
  room_number: "A-7",
  room_service_guest_name: "Synthetic Guest",
  room_service_charge_to_room: true
};

test("checkout request fingerprint is stable for the same request and conflicts on changed intent", () => {
  const request = {
    hotelSlug: "hotel-a",
    bookingId: "42",
    amountCents: 7000,
    paymentMethod: "cash",
    transactionId: null,
    notes: "checkout",
    currency: "INR"
  };
  const fingerprint = buildTask6CheckoutRequestFingerprint(request);

  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(buildTask6CheckoutRequestFingerprint({ ...request }), fingerprint);
  assert.notEqual(
    buildTask6CheckoutRequestFingerprint({ ...request, amountCents: 7001 }),
    fingerprint
  );
});

test("final checkout snapshot is server-built from stored booking and room-service rows", async () => {
  const sourceRows = makeCheckoutRows({ orders: [roomServiceOrder] });
  const client = createFakeDatabase({ rows: sourceRows });
  const issuedAt = "2026-10-21T12:30:00.000Z";
  const candidate = await buildFinalCheckoutSnapshotCandidate({
    supabaseClient: client,
    hotelSlug: "hotel-a",
    bookingId: "42",
    actor: { id: "manager-1", role: "manager", displayName: "Synthetic Manager" },
    paymentMethod: "cash",
    transactionId: "local-ref-1",
    currency: "INR",
    issuedAt
  });

  assert.ok(candidate);
  assert.match(candidate.payloadHash, /^[a-f0-9]{64}$/);
  assert.equal(candidate.bill.provisional, false);
  assert.equal(candidate.bill.documentType, "guest_folio");
  assert.equal(candidate.bill.checkoutStatus, "checked_out");
  assert.equal(candidate.bill.paymentStatus, "paid");
  assert.equal(candidate.bill.totals.grandTotal, 120);
  assert.equal(candidate.bill.totals.paid, 120);
  assert.equal(candidate.bill.totals.balance, 0);
  assert.equal(candidate.bill.issuedAt, issuedAt);
  assert.equal(candidate.source.booking.advance_paid, 100);
  assert.equal(candidate.source.booking.balance_amount, 0);
  assert.equal(candidate.source.orders[0].payment_status, "paid");
  assert.equal(candidate.source.orders[0].billing_status, "billed");
  assert.equal(sourceRows.orders.data[0].payment_status, "unpaid", "preview does not mutate the source row");
});

test("RPC parameter builder requires server-generated digest and exact snapshot hash", () => {
  const snapshot = {
    documentType: "guest_folio",
    provisional: false,
    checkoutStatus: "checked_out",
    paymentStatus: "paid",
    totals: { grandTotal: 100, paid: 100, balance: 0 },
    lines: [],
    stay: {},
    folioNumber: "GF-HOTEL-A-42",
    issuedAt: "2026-10-21T12:30:00.000Z"
  };
  const params = buildTask6RoomCheckoutRpcParams({
    hotelSlug: "hotel-a",
    bookingId: 42,
    amount: 50,
    paymentMethod: "cash",
    idempotencyKey: "checkout:42:once",
    snapshotJson: snapshot,
    requestFingerprint: "a".repeat(64),
    payloadHash: "b".repeat(64)
  });

  assert.equal(params.p_booking_id, "42");
  assert.equal(params.p_amount, 50);
  assert.equal(params.p_request_fingerprint, "a".repeat(64));
  assert.equal(params.p_payload_hash, "b".repeat(64));
  assert.deepEqual(params.p_snapshot_json, snapshot);
  assert.throws(() => buildTask6RoomCheckoutRpcParams({
    hotelSlug: "hotel-a",
    bookingId: 42,
    amount: 50,
    paymentMethod: "cash",
    idempotencyKey: "checkout:42:once",
    snapshotJson: snapshot,
    requestFingerprint: "untrusted-client-value",
    payloadHash: "b".repeat(64)
  }), /request fingerprint is invalid/i);
});

test("atomic checkout adapter sends one scoped RPC and returns the immutable bill", async () => {
  let rpcParams;
  const client = createFakeDatabase({
    rows: makeCheckoutRows({ orders: [roomServiceOrder] }),
    rpcResult: async (name, params) => {
      assert.equal(name, TASK6_CHECKOUT_RPC_NAME);
      rpcParams = params;
      return {
        data: {
          idempotentReplay: false,
          receipt: { id: 99, booking_id: 42, payment_status: "paid", amount: 70 },
          booking: { id: 42, hotel_slug: "hotel-a", booking_status: "checked_out", checked_out_at: "2026-10-21T12:30:00.000Z" },
          snapshot: {
            id: 100,
            hotel_slug: "hotel-a",
            invoice_number: "RCPT-HOTEL-A-99",
            snapshot_json: params.p_snapshot_json
          },
          settledOrderCount: 1
        },
        error: null
      };
    }
  });

  const result = await settleTask6RoomCheckout({
    supabaseClient: client,
    hotelSlug: "hotel-a",
    bookingId: "42",
    amount: 70,
    paymentMethod: "cash",
    idempotencyKey: "checkout:42:once",
    currency: "INR",
    actorUserId: "manager-1",
    actorRole: "manager",
    actorDisplayName: "Synthetic Manager"
  });

  assert.equal(result.ok, true);
  assert.equal(result.atomicFinalizer, true);
  assert.equal(result.idempotentReplay, false);
  assert.equal(result.settledOrderCount, 1);
  assert.equal(result.checkoutBill.invoiceNumber, "RCPT-HOTEL-A-99");
  assert.equal(rpcParams.p_hotel_slug, "hotel-a");
  assert.equal(rpcParams.p_booking_id, "42");
  assert.match(rpcParams.p_request_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(rpcParams.p_snapshot_json.totals.grandTotal, 120);
});

test("atomic checkout adapter unwraps the tenant RPC row and function column", async () => {
  const client = createFakeDatabase({
    rows: makeCheckoutRows({ orders: [roomServiceOrder] }),
    rpcResult: async (name, params) => {
      assert.equal(name, TASK6_CHECKOUT_RPC_NAME);
      return {
        data: [{
          [TASK6_CHECKOUT_RPC_NAME]: {
            idempotentReplay: true,
            receipt: { id: 99, booking_id: 42, payment_status: "paid", amount: 70 },
            booking: { id: 42, hotel_slug: "hotel-a", booking_status: "checked_out", checked_out_at: "2026-10-21T12:30:00.000Z" },
            snapshot: {
              id: 100,
              hotel_slug: "hotel-a",
              invoice_number: "RCPT-HOTEL-A-99",
              snapshot_json: params.p_snapshot_json
            },
            settledOrderCount: 1
          }
        }],
        error: null
      };
    }
  });

  const result = await settleTask6RoomCheckout({
    supabaseClient: client,
    hotelSlug: "hotel-a",
    bookingId: "42",
    amount: 70,
    paymentMethod: "cash",
    idempotencyKey: "checkout:42:once",
    currency: "INR",
    actorUserId: "manager-1",
    actorRole: "manager",
    actorDisplayName: "Synthetic Manager"
  });

  assert.equal(result.ok, true);
  assert.equal(result.atomicFinalizer, true);
  assert.equal(result.idempotentReplay, true);
  assert.equal(result.receipt.id, 99);
  assert.equal(result.checkoutBill.invoiceNumber, "RCPT-HOTEL-A-99");
});

test("atomic checkout adapter accepts a text-form scalar tenant RPC result", async () => {
  const client = createFakeDatabase({
    rows: makeCheckoutRows({ orders: [roomServiceOrder] }),
    rpcResult: async (name, params) => {
      assert.equal(name, TASK6_CHECKOUT_RPC_NAME);
      return {
        data: [{
          result: JSON.stringify({
            idempotentReplay: true,
            receipt: { id: 99, booking_id: 42, payment_status: "paid", amount: 70 },
            booking: { id: 42, hotel_slug: "hotel-a", booking_status: "checked_out", checked_out_at: "2026-10-21T12:30:00.000Z" },
            snapshot: {
              id: 100,
              hotel_slug: "hotel-a",
              invoice_number: "RCPT-HOTEL-A-99",
              snapshot_json: params.p_snapshot_json
            },
            settledOrderCount: 1
          })
        }],
        error: null
      };
    }
  });

  const result = await settleTask6RoomCheckout({
    supabaseClient: client,
    hotelSlug: "hotel-a",
    bookingId: "42",
    amount: 70,
    paymentMethod: "cash",
    idempotencyKey: "checkout:42:once",
    currency: "INR",
    actorUserId: "manager-1",
    actorRole: "manager",
    actorDisplayName: "Synthetic Manager"
  });

  assert.equal(result.ok, true);
  assert.equal(result.idempotentReplay, true);
  assert.equal(result.receipt.id, 99);
  assert.equal(result.checkoutBill.invoiceNumber, "RCPT-HOTEL-A-99");
});

test("Task 2 provider checkout errors fail closed and changed-key replay is a conflict", () => {
  assert.deepEqual(
    mapTask6CheckoutFinalizerError({
      code: "22023",
      message: "TASK6_CHECKOUT_PAYMENT_METADATA_INVALID_OR_PROVIDER_PAYMENT"
    }),
    {
      ok: false,
      status: 400,
      schemaReady: true,
      code: "checkout_payment_method_unsupported",
      message: "External provider payments must use the payment flow, not offline checkout"
    }
  );
  assert.equal(
    mapTask6CheckoutFinalizerError({
      code: "23505",
      message: "TASK6_CHECKOUT_IDEMPOTENCY_CONFLICT"
    }).code,
    "checkout_idempotency_conflict"
  );
});

test("atomic finalizer stays default-off and admin/staff routes preserve existing authorization guards", () => {
  const envSource = read("config/env.js");
  const server = read("server.js");
  const handler = read("utils/room-combined-checkout-handler.js");
  const adminRoute = read("routes/admin-room-booking.js");
  const staffRoute = read("routes/staff-room-booking.js");
  const tenantMutationClient = read("utils/tenant-mutation-client.js");
  const liveProbe = read("scripts/verify-task6-checkout-live.js");

  assert.match(envSource, /TASK6_ROOM_CHECKOUT_FINALIZER_ENABLED",\s*"false"\)\s*===\s*"true"/);
  assert.match(server, /"task6_room_checkout_finalizer"[\s\S]*?env\.task6RoomCheckoutFinalizerEnabled/);
  assert.match(handler, /useAtomicFinalizer\(\)\s*\?\s*settleAtomicCheckout\s*:\s*settleCheckout/);
  assert.match(adminRoute, /useAtomicFinalizer:\s*\(\)\s*=>\s*env\.task6RoomCheckoutFinalizerEnabled/);
  assert.match(staffRoute, /useAtomicFinalizer:\s*\(\)\s*=>\s*env\.task6RoomCheckoutFinalizerEnabled/);
  assert.match(adminRoute, /requireAdminCombinedBilling[\s\S]*requireRoomCombinedCheckoutEnabled/);
  assert.match(staffRoute, /requireStaffManagerAccess[\s\S]*requireStaffCombinedBilling[\s\S]*requireRoomCombinedCheckoutEnabled/);
  assert.match(tenantMutationClient, /TENANT_RPCS[\s\S]*task6_finalize_room_checkout/);
  assert.match(server, /"task6_room_checkout_finalizer"[\s\S]*?env\.task6RoomCheckoutFinalizerEnabled/);
  assert.match(liveProbe, /TASK6_CHECKOUT_TEST_WRITES_CONFIRMED/);
  assert.match(liveProbe, /TASK6_CHECKOUT_LIVE_ENV[\s\S]*TEST/);
  assert.match(liveProbe, /flag\.enabled !== true/);
  assert.match(liveProbe, /Promise\.all\(\[/);
  assert.match(liveProbe, /checkout_idempotency_conflict/);
  assert.doesNotMatch(liveProbe, /\.delete\(|delete\s+from|refund/i);

  const workspaceRoot = path.resolve(backendRoot, "..");
  for (const relativePath of [
    ".env.example",
    "backend/.env.example",
    "backend/.env.production.example",
    "backend/.env.first-client.cloudflare-railway.example"
  ]) {
    const filePath = path.join(workspaceRoot, relativePath);
    assert.match(fs.readFileSync(filePath, "utf8"), /^TASK6_ROOM_CHECKOUT_FINALIZER_ENABLED=false$/m);
  }
});

test("checkout handler switches to the Task 6 finalizer only behind its explicit gate", async () => {
  const { createRoomCombinedCheckoutHandler } = require("../utils/room-combined-checkout-handler");
  let legacyCalls = 0;
  let atomicCalls = 0;
  const response = {
    statusCode: 200,
    payload: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.payload = value; return this; }
  };
  const handler = createRoomCombinedCheckoutHandler({
    supabaseClient: { rpc: async () => ({ data: null, error: null }) },
    resolveRequestContext: async () => ({
      ok: true,
      hotelSlug: "hotel-a",
      actorUserId: "manager-1",
      actorRole: "manager"
    }),
    useAtomicFinalizer: () => true,
    settleCheckout: async () => {
      legacyCalls += 1;
      throw new Error("Legacy settlement must not run when the Task 6 gate is enabled");
    },
    settleAtomicCheckout: async (context) => {
      atomicCalls += 1;
      assert.equal(context.hotelSlug, "hotel-a");
      assert.equal(context.actorUserId, "manager-1");
      return {
        ok: true,
        atomicFinalizer: true,
        idempotentReplay: false,
        receipt: { id: 99 },
        booking: { id: 42, booking_status: "checked_out" },
        checkoutBill: { invoiceNumber: "RCPT-HOTEL-A-99" },
        settledOrderCount: 1
      };
    }
  });

  await handler({
    params: { id: "42" },
    validatedBody: { amount: 70, paymentMethod: "cash", idempotencyKey: "checkout:42:once" }
  }, response);

  assert.equal(response.statusCode, 201);
  assert.equal(response.payload.atomicFinalizer, true);
  assert.equal(response.payload.checkoutBill.invoiceNumber, "RCPT-HOTEL-A-99");
  assert.equal(atomicCalls, 1);
  assert.equal(legacyCalls, 0);
});

test("bill reader overlays the final row invoice number without changing the hashed payload", () => {
  const bill = mapSnapshotBill({
    id: 100,
    hotel_slug: "hotel-a",
    invoice_number: "RCPT-HOTEL-A-99",
    reprint_count: 0,
    snapshot_json: { documentType: "guest_folio", invoiceNumber: "" }
  });
  assert.equal(bill.invoiceNumber, "RCPT-HOTEL-A-99");
  assert.equal(bill.immutable, true);
});
