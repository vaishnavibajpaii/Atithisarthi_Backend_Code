"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL ||= "https://public-qr-rpc-decoding.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const publicQrRoute = require("../routes/public-qr");

test("secure QR submit unwraps the scalar JSONB row returned by the tenant runtime", () => {
  const expected = { ok: true, duplicate: false, submission: { public_reference: "qr-test" } };
  const result = publicQrRoute.unwrapJsonRpcResult(
    [{ submit_secure_qr_table_order: expected }],
    "submit_secure_qr_table_order"
  );

  assert.deepEqual(result, expected);
});

test("secure QR edit unwraps the scalar JSONB row returned by the tenant runtime", () => {
  const expected = { ok: false, code: "QR_SUBMISSION_CHANGED", currentVersion: 2 };
  const result = publicQrRoute.unwrapJsonRpcResult(
    [{ edit_secure_qr_submission: expected }],
    "edit_secure_qr_submission"
  );

  assert.deepEqual(result, expected);
});

test("secure QR JSON RPC decoder preserves the direct Supabase response shape", () => {
  const expected = { ok: false, code: "INVALID_QR_TOKEN" };
  const result = publicQrRoute.unwrapJsonRpcResult(expected, "submit_secure_qr_table_order");

  assert.deepEqual(result, expected);
});
