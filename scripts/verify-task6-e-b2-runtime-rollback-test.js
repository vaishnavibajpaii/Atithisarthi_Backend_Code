"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.join(__dirname, "task6-e-b2-finalized-order-runtime-rollback-test.sql"),
  "utf8"
);
const postcheck = fs.readFileSync(
  path.join(__dirname, "task6-e-b2-finalized-order-runtime-postcheck.sql"),
  "utf8"
);

assert.match(source, /^begin;/im);
assert.match(source, /v_order_id bigint := 274/i);
assert.match(source, /v_hotel_slug text := 'hotel-sai-raj'/i);
assert.match(source, /TASK6_E_B2_RUNTIME_TEST_TARGET_NOT_FINALIZED/i);
assert.match(source, /TASK6_ORDER_FINAL_FINANCIAL_SNAPSHOT_IMMUTABLE/i);
assert.match(source, /TASK6_ORDER_FINAL_BILL_IMMUTABLE/i);
assert.match(source, /TASK6_ORDER_FINAL_OPERATIONAL_STATE_IMMUTABLE/i);
assert.match(source, /create temporary table/i);
assert.match(source, /rollback;/i);
assert.doesNotMatch(source, /\b(?:insert into|delete from)\s+public\./i);
assert.match(postcheck, /^begin transaction read only;/im);
assert.match(postcheck, /final_billing_identity_preserved/i);
assert.match(postcheck, /final_snapshot_preserved_once/i);
assert.match(postcheck, /final_bill_audit_preserved_once/i);

console.log("Task 6-E-B2 runtime rollback failure-injection contract: PASS");
