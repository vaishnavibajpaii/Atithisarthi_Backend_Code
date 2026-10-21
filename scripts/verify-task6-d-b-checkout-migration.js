"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const migration = fs.readFileSync(path.join(root, "scripts", "task6-d-b-atomic-checkout-finalizer.sql"), "utf8");
const verifier = fs.readFileSync(path.join(root, "scripts", "task6-d-b-atomic-checkout-finalizer-verify.sql"), "utf8");
const rollback = fs.readFileSync(path.join(root, "..", "docs", "transactions", "TASK6-D-B-ROLLBACK-NOTES.md"), "utf8");

const requirements = [
  ["new dormant finalizer", /create or replace function public\.task6_finalize_room_checkout\(/i],
  ["transactional invoker", /language plpgsql\s+security invoker\s+set search_path = pg_catalog, public/i],
  ["canonical hotel read", /from public\.hotels[\s\S]*?where slug = v_slug/i],
  ["tenant/property-bound booking lock", /from public\.room_bookings[\s\S]*?tenant_id = v_hotel\.tenant_id[\s\S]*?property_id = v_hotel\.id[\s\S]*?for update/i],
  ["key and request fingerprint", /p_request_fingerprint text[\s\S]*?request_fingerprint is distinct from v_fingerprint/i],
  ["external provider payments remain Task 2 controlled", /razorpay\|gateway\|online[\s\S]*?PAYMENT_METADATA_INVALID_OR_PROVIDER_PAYMENT/i],
  ["order row lock and strict versioned payable", /from public\.orders[\s\S]*?for update[\s\S]*?task6_order_payable_total/i],
  ["atomic receipt, final snapshot, and audit inserts", /insert into public\.room_checkout_receipts[\s\S]*?insert into public\.room_checkout_bill_snapshots[\s\S]*?insert into public\.room_checkout_bill_audit/i],
  ["receipt and snapshot share canonical owner", /tenant_id, property_id, hotel_slug, booking_id, idempotency_key,[\s\S]*?tenant_id, property_id, hotel_slug, booking_id, checkout_receipt_id/i],
  ["runtime and service-role grants only", /to app_tenant_runtime, service_role/i],
  ["untrusted execute revoked", /from public, anon, authenticated/i],
  ["safe owner transfer and membership cleanup", /alter function public\.task6_finalize_room_checkout[\s\S]*?owner to app_tenant_rpc_owner[\s\S]*?revoke app_tenant_rpc_owner from/i],
  ["existing routine is not replaced", !/create or replace function public\.settle_room_combined_checkout/i.test(migration)],
  ["no historical financial deletes", !/delete\s+from\s+public\.(room_bookings|room_booking_payments|room_checkout_receipts|room_checkout_bill_snapshots|orders)/i.test(migration)]
];

for (const [label, expression] of requirements) {
  if (expression instanceof RegExp) {
    assert.match(migration, expression, label);
  } else {
    assert.equal(expression, true, label);
  }
}

assert.match(verifier, /\nwith public_schema as/i);
assert.match(verifier, /from pg_catalog\.pg_namespace/i);
assert.doesNotMatch(verifier, /^\s*(begin|commit|rollback|set)\b/im);
assert.match(verifier, /order by check_name;\s*$/i);
assert.match(verifier, /finalizer_security_invoker/i);
assert.match(verifier, /finalizer_owner_safe/i);
assert.match(verifier, /finalizer_checks_request_digest/i);
assert.match(verifier, /finalizer_writes_receipt_snapshot_audit_atomically/i);
assert.match(verifier, /required_force_rls_missing/i);
assert.match(rollback, /drop function if exists public\.task6_finalize_room_checkout/i);
assert.match(rollback, /Never delete checkout receipts/i);

console.log("TASK6-D-B checkout migration contract verification passed.");
console.log("Verified the dormant RPC, transaction boundary, ownership/grants, tenant checks, digest and snapshot guards, read-only verifier, and evidence-safe rollback notes.");
