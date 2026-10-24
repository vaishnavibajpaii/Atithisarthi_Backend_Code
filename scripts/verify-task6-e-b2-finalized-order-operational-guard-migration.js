"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, "scripts", name), "utf8");
const migration = read("task6-e-b2-finalized-order-operational-guard.sql");
const verification = read("task6-e-b2-finalized-order-operational-guard-verify.sql");
const rollback = read("task6-e-b2-finalized-order-operational-guard-rollback.md");

assert.match(migration, /^begin;/im);
assert.match(migration, /task6_guard_order_state_and_finality/i);
assert.match(migration, /create or replace function public\.task6_guard_finalized_order_operational_state\(\)/i);
assert.match(migration, /security invoker/i);
assert.match(migration, /search_path = pg_catalog, public/i);
assert.match(migration, /create trigger orders_11_task6_finalized_operational_guard/i);
assert.match(migration, /TASK6_ORDER_FINAL_OPERATIONAL_STATE_IMMUTABLE/i);
assert.doesNotMatch(migration, /\b(?:delete|update)\s+public\.(?:orders|food_order_bill_snapshots|food_order_bill_audit)\b/i);
assert.match(verification, /^begin transaction read only;/im);
assert.match(verification, /orders_force_rls_preserved/i);
assert.match(verification, /final_operational_guard_trigger_enabled/i);
assert.match(verification, /untrusted_execute_grants/i);
assert.match(rollback, /drop trigger if exists orders_11_task6_finalized_operational_guard/i);

console.log("Task 6-E-B2 finalized operational guard migration contract: PASS");
