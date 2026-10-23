const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const migration = fs.readFileSync(path.join(root, "scripts", "task6-e-a-pos-billing-finalizer.sql"), "utf8");
const verifier = fs.readFileSync(path.join(root, "scripts", "task6-e-a-pos-billing-finalizer-verify.sql"), "utf8");
const design = fs.readFileSync(path.join(root, "..", "docs", "transactions", "TASK6-E-POS-FINALITY-DESIGN.md"), "utf8");
const rollback = fs.readFileSync(path.join(root, "..", "docs", "transactions", "TASK6-E-A-ROLLBACK-NOTES.md"), "utf8");

const requirements = [
  ["dormant finalizer", /create or replace function public\.task6_finalize_order_family\(/i],
  ["security invoker and pinned search path", /language plpgsql\s+security invoker\s+set search_path = pg_catalog, public/i],
  ["canonical hotel owner lookup", /from public\.hotels\s+where slug = v_slug/i],
  ["idempotency advisory lock", /pg_advisory_xact_lock[\s\S]*?task6-order-bill:/i],
  ["digest conflict rejection", /billing_request_fingerprint is distinct from v_fingerprint/i],
  ["deterministic family locks", /from public\.orders target[\s\S]*?for update/i],
  ["server price validation", /task6_order_payable_total[\s\S]*?TASK6_ORDER_BILL_SNAPSHOT_MISMATCH/i],
  ["atomic order snapshot audit write", /update public\.orders target[\s\S]*?insert into public\.food_order_bill_snapshots[\s\S]*?insert into public\.food_order_bill_audit/i],
  ["task2 payment boundary", /Payment finality is intentionally outside this routine/i],
  ["trusted execution grants only", /to app_tenant_runtime, service_role/i],
  ["untrusted execution revoked", /from public, anon, authenticated/i],
  ["safe owner transfer", /owner to app_tenant_rpc_owner[\s\S]*?revoke app_tenant_rpc_owner from/i],
  ["no historical financial delete", !/delete\s+from\s+public\.(orders|food_order_bill_snapshots|food_order_bill_audit)/i.test(migration)]
];

for (const [label, requirement] of requirements) {
  assert(requirement === true || requirement.test(migration), `Missing ${label}`);
}

[
  "finalizer_security_invoker",
  "finalizer_owner_safe",
  "finalizer_checks_digest_conflict",
  "finalizer_writes_order_snapshot_audit_atomically",
  "required_force_rls_missing"
].forEach((marker) => assert(verifier.includes(marker), `Verifier missing ${marker}`));

assert.match(design, /Task 2/i);
assert.match(rollback, /Do \*\*not\*\* run the structural rollback/i);
assert.match(rollback, /drop function if exists public\.task6_finalize_order_family/i);

console.log("TASK6-E-A POS billing finalizer migration contract verification passed.");
