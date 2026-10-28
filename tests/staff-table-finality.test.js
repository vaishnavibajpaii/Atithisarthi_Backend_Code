"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL ||= "https://staff-table-finality.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const staffTables = require("../routes/staff-tables");

const activeTable = { isActive: true, operationalStatus: "active" };

test("served paid order remains active until its bill is finalized", () => {
  const order = {
    status: "completed",
    kitchen_status: "served",
    payment_status: "paid",
    billing_status: "not_billed"
  };

  assert.equal(staffTables.blocksTable(order), true);
  assert.equal(staffTables.liveStatus(activeTable, order), "billing_pending");
});

test("served paid and billed order releases its table", () => {
  const order = {
    status: "completed",
    kitchen_status: "served",
    payment_status: "paid",
    billing_status: "billed"
  };

  assert.equal(staffTables.blocksTable(order), false);
  assert.equal(staffTables.liveStatus(activeTable, order), "available");
});

test("new unpaid table order remains active", () => {
  const order = {
    status: "new",
    kitchen_status: "new",
    payment_status: "unpaid",
    billing_status: "not_billed"
  };

  assert.equal(staffTables.blocksTable(order), true);
  assert.equal(staffTables.liveStatus(activeTable, order), "new");
});
