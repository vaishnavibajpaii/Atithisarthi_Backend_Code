"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const sql = fs.readFileSync(
  path.join(root, "scripts", "task6-e-b-pos-state-finality-preflight.sql"),
  "utf8"
);
const design = fs.readFileSync(
  path.resolve(root, "..", "docs", "transactions", "TASK6-E-STATE-FINALITY-DESIGN.md"),
  "utf8"
);

assert.match(sql, /^begin transaction read only;/im);
assert.match(sql, /set local search_path = pg_catalog, public;/i);
assert.match(sql, /commit;/i);
const executableSql = sql.replace(/^\s*--.*$/gm, "");
assert.doesNotMatch(
  executableSql,
  /^\s*(?:insert|update|delete|alter|create|drop|grant|revoke)\b/im
);
assert.match(sql, /required_relations_force_rls_missing/i);
assert.match(sql, /food_snapshot_immutability_trigger_enabled/i);
assert.match(sql, /task6_billing_finalizer_security_invoker/i);
assert.match(sql, /final_snapshot_source_finality_mismatch/i);
assert.match(sql, /finalized_orders_with_cancelled_or_failed_operational_status/i);
assert.match(sql, /paid_terminal_order_state_combinations/i);
assert.match(sql, /\('orders', 'order_version', 'bigint'\)/i);
assert.match(sql, /orders_trigger_inventory/i);
assert.match(sql, /order_status_values/i);
assert.match(design, /Task 2 payment finalization/i);
assert.match(design, /FORCE RLS/i);

console.log("Task 6-E-B POS state/finality preflight static contract: PASS");
