"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  buildAdvanceSummary,
  buildRoomAdvancePlan,
  hashRoomAdvanceRequest
} = require("../utils/room-advance-payment");

const root = path.resolve(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const managerPolicy = Object.freeze({
  advanceMode: "optional",
  minimumType: "fixed",
  minimumValue: 0,
  allowZeroAdvance: true,
  allowMultiplePayments: true,
  allowSplitPayments: true,
  allowStaffAdvance: false,
  allowedPaymentMethods: ["cash", "upi", "card", "bank_transfer"],
  currency: "INR",
  schemaReady: true,
  recordExists: false,
  version: 1
});

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code, `Expected ${code}`);
}

function verifyFinancialContract() {
  const none = buildRoomAdvancePlan({
    body: { advanceOption: "no_advance" },
    totalAmount: 1000,
    policy: managerPolicy,
    actorIsManager: true
  });
  assert.deepStrictEqual(
    [none.totalAmount, none.balanceAmount, none.paymentStatus, none.payments.length],
    [0, 1000, "unpaid", 0]
  );

  const partial = buildRoomAdvancePlan({
    body: { advanceOption: "partial", advanceAmount: 300, paymentMethod: "cash" },
    totalAmount: 1000,
    policy: managerPolicy,
    actorIsManager: true
  });
  assert.deepStrictEqual(
    [partial.totalAmount, partial.balanceAmount, partial.paymentStatus],
    [300, 700, "partial"]
  );

  const full = buildRoomAdvancePlan({
    body: { advanceOption: "full", paymentMethod: "upi" },
    totalAmount: 1000,
    policy: managerPolicy,
    actorIsManager: true
  });
  assert.deepStrictEqual(
    [full.totalAmount, full.balanceAmount, full.paymentStatus],
    [1000, 0, "paid"]
  );

  const split = buildRoomAdvancePlan({
    body: {
      advanceOption: "split",
      advancePayments: [
        { amount: 100, paymentMethod: "cash" },
        { amount: 200, paymentMethod: "upi", transactionId: "UPI-TEST-001" }
      ]
    },
    totalAmount: 1000,
    policy: managerPolicy,
    actorIsManager: true
  });
  assert.deepStrictEqual(
    [split.totalAmount, split.balanceAmount, split.payments.length],
    [300, 700, 2]
  );

  expectCode(() => buildRoomAdvancePlan({
    body: { advanceOption: "partial", advanceAmount: 1001, paymentMethod: "cash" },
    totalAmount: 1000,
    policy: managerPolicy,
    actorIsManager: true
  }), "ROOM_ADVANCE_EXCEEDS_TOTAL");

  expectCode(() => buildRoomAdvancePlan({
    body: { advanceOption: "partial", advanceAmount: 300, paymentMethod: "crypto" },
    totalAmount: 1000,
    policy: managerPolicy,
    actorIsManager: true
  }), "ROOM_ADVANCE_METHOD_DISABLED");

  expectCode(() => buildRoomAdvancePlan({
    body: { advanceOption: "partial", advanceAmount: 300, paymentMethod: "cash" },
    totalAmount: 1000,
    policy: managerPolicy,
    actorIsManager: false
  }), "ROOM_ADVANCE_STAFF_NOT_ALLOWED");

  expectCode(() => buildRoomAdvancePlan({
    body: { advanceOption: "no_advance" },
    totalAmount: 1000,
    policy: { ...managerPolicy, advanceMode: "required", allowZeroAdvance: false },
    actorIsManager: true
  }), "ROOM_ADVANCE_REQUIRED");

  expectCode(() => buildRoomAdvancePlan({
    body: { advanceOption: "partial", advanceAmount: 100, paymentMethod: "cash" },
    totalAmount: 1000,
    policy: { ...managerPolicy, minimumType: "percentage", minimumValue: 20 },
    actorIsManager: true
  }), "ROOM_ADVANCE_MINIMUM_NOT_MET");

  const refundSummary = buildAdvanceSummary({
    booking: {
      total_amount: 1000,
      advance_paid: 200,
      balance_amount: 800,
      payment_status: "partial"
    },
    payments: [{ amount: 300, payment_status: "paid" }]
  });
  assert.deepStrictEqual(
    [refundSummary.paidAmount, refundSummary.refundedAmount, refundSummary.balance],
    [200, 100, 800]
  );

  const firstFingerprint = hashRoomAdvanceRequest({
    booking: { room_id: 1, total_amount: 1000 },
    payments: [{ amount: 300, paymentMethod: "cash" }]
  });
  const reorderedFingerprint = hashRoomAdvanceRequest({
    payments: [{ paymentMethod: "cash", amount: 300 }],
    booking: { total_amount: 1000, room_id: 1 }
  });
  const changedFingerprint = hashRoomAdvanceRequest({
    booking: { room_id: 1, total_amount: 1000 },
    payments: [{ amount: 400, paymentMethod: "cash" }]
  });
  assert.strictEqual(firstFingerprint, reorderedFingerprint);
  assert.notStrictEqual(firstFingerprint, changedFingerprint);
}

function requireText(source, fragment, label) {
  assert(source.includes(fragment), `Missing contract: ${label}`);
}

function verifyImplementationContracts() {
  const migration = read("backend/scripts/upgrade-manual-room-booking-advance-payment.sql");
  const adminRoute = read("backend/routes/admin-room-booking.js");
  const staffRoute = read("backend/routes/staff-room-booking.js");
  const validators = read("backend/validators/rooms.js");
  const checkout = read("backend/utils/room-checkout-summary.js");
  const refundMigration = read("backend/scripts/upgrade-production-room-pricing-gst.sql");
  const adminHtml = read("frontend/admin.html");
  const staffHtml = read("frontend/staff-orders.html");
  const adminJs = read("frontend/js/admin.js");
  const staffJs = read("frontend/js/staff-orders.js");

  requireText(migration, "create_room_booking_with_advance", "atomic booking + advance RPC");
  requireText(migration, "pg_advisory_xact_lock", "concurrency lock");
  requireText(migration, "ROOM_ADVANCE_IDEMPOTENCY_CONFLICT", "changed retry rejection");
  requireText(migration, "trg_enforce_room_payment_hotel_scope", "payment tenant trigger");
  requireText(migration, "uq_room_booking_payment_provider_reference", "provider reference uniqueness");
  requireText(migration, "payment_group_id", "split payment grouping");
  requireText(migration, "receipt_reference", "immutable receipt reference");
  requireText(migration, "payment_type", "advance payment type");
  requireText(migration, "room_booking_refunds", "net payment calculation after refunds");
  requireText(migration, "allow_staff_advance", "Staff advance permission policy");
  requireText(migration, "automatic_cancellation_enabled boolean not null default false", "safe auto-cancel default");

  for (const [source, label] of [[adminRoute, "admin"], [staffRoute, "staff"]]) {
    requireText(source, "buildRoomAdvancePlan", `${label} backend validation`);
    requireText(source, "create_room_booking_with_advance", `${label} atomic creation`);
    requireText(source, "buildRoomBookingRequestFingerprint", `${label} canonical retry fingerprint`);
    requireText(source, "request_fingerprint", `${label} durable retry fingerprint`);
    requireText(source, "buildRoomAdvanceReceipt", `${label} advance receipt`);
    requireText(source, '"/bookings/:id/payments"', `${label} payment history`);
    requireText(source, "ROOM_ADVANCE_METHOD_DISABLED", `${label} disabled-method rejection`);
  }

  requireText(staffRoute, '"/advance-policy"', "hotel-scoped Manager policy route");
  requireText(staffRoute, "requireStaffManagerAccess", "Manager-only policy mutation");
  requireText(validators, "advancePayments", "split request validation");
  requireText(validators, "roomAdvancePolicySchema", "strict policy validation");
  requireText(checkout, "roomBalanceAmount + outstandingChargeToRoomAmount", "advance deducted once at checkout");
  requireText(checkout, ".filter((order) => isPaidOrder(order))", "paid Room Service not counted twice");
  requireText(refundMigration, "v_next_paid:=greatest(0,v_booking.advance_paid-p_amount)", "refund reduces net paid summary");
  assert(!refundMigration.includes("delete from public.room_booking_payments"), "Refund must preserve original payments");

  requireText(adminHtml, "No Advance / Pay Later", "Manager no-advance option");
  requireText(adminHtml, "Split Advance", "Manager split option");
  requireText(staffHtml, "Booking and Payment Policy", "Manager policy UI");
  requireText(staffHtml, "data-staff-room-advance-method", "permitted method settings");
  requireText(adminJs, "Creating booking and recording advance...", "Manager local loading state");
  requireText(staffJs, "Creating booking and recording advance...", "Staff local loading state");
  requireText(staffJs, "applyStaffRoomAdvanceMethodPolicy", "disabled methods hidden from Staff");
}

function verifyResponsiveContracts() {
  const adminHtml = read("frontend/admin.html");
  const staffHtml = read("frontend/staff-orders.html");
  requireText(adminHtml, "@media (max-width: 720px)", "Manager mobile one-column layout");
  requireText(staffHtml, "@media (max-width: 720px)", "Staff mobile one-column layout");
  requireText(adminHtml, 'aria-live="polite"', "Manager announced payment summary");
  requireText(staffHtml, 'id="staffRoomAdvanceSummary"', "Staff announced payment summary");
  requireText(staffHtml, 'inputmode="decimal"', "mobile decimal keypad");
}

const started = process.hrtime.bigint();
for (let index = 0; index < 5000; index += 1) {
  buildRoomAdvancePlan({
    body: { advanceOption: "partial", advanceAmount: 300, paymentMethod: "cash" },
    totalAmount: 1000,
    policy: managerPolicy,
    actorIsManager: true
  });
}
const utilityMs = Number(process.hrtime.bigint() - started) / 1e6;

verifyFinancialContract();
verifyImplementationContracts();
verifyResponsiveContracts();

console.log("Manual Room Booking Advance Payment verification passed.");
console.log(`Financial-plan validation micro-benchmark: ${utilityMs.toFixed(2)} ms / 5,000 runs.`);
console.log("Live database, authenticated two-hotel, browser, and endpoint latency checks remain deployment-stage gates.");
