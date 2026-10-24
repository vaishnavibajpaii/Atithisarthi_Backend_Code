"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, "scripts", name), "utf8");
const migration = read("task6-e-b-order-state-finality-guard.sql");
const verification = read("task6-e-b-order-state-finality-guard-verify.sql");
const rollback = read("task6-e-b-order-state-finality-guard-rollback.md");

assert.match(migration, /^begin;/im);
assert.match(migration, /set local search_path = pg_catalog, public;/i);
assert.match(migration, /create or replace function public\.task6_guard_order_state_and_finality\(\)/i);
assert.match(migration, /security invoker/i);
assert.match(migration, /search_path = pg_catalog, public/i);
assert.match(migration, /create trigger orders_10_task6_state_finality_guard/i);
assert.match(migration, /TASK6_ORDER_FINAL_FINANCIAL_SNAPSHOT_IMMUTABLE/i);
assert.match(migration, /TASK6_ORDER_FINAL_BILL_IMMUTABLE/i);
assert.match(migration, /TASK6_ORDER_FINAL_PAYMENT_IMMUTABLE/i);
assert.match(migration, /TASK6_ORDER_TERMINAL_STATE_IMMUTABLE/i);
assert.match(migration, /TASK6_ORDER_KITCHEN_TRANSITION_INVALID/i);
assert.match(migration, /v_verified_provider_recovery/i);
assert.match(migration, /revoke all on function public\.task6_guard_order_state_and_finality/i);
assert.match(migration, /grant execute on function public\.task6_guard_order_state_and_finality/i);
assert.doesNotMatch(migration, /\b(?:delete|update)\s+public\.(?:orders|food_order_bill_snapshots|food_order_bill_audit)\b/i);
assert.match(verification, /^begin transaction read only;/im);
assert.match(verification, /guard_trigger_enabled/i);
assert.match(verification, /required_relations_force_rls_missing/i);
assert.match(verification, /untrusted_execute_grants/i);
assert.match(rollback, /drop trigger if exists orders_10_task6_state_finality_guard/i);
assert.match(rollback, /does not delete or change business records/i);

console.log("Task 6-E-B order state/finality guard migration contract: PASS");
