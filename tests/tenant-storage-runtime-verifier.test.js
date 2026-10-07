"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CONFIRMATION,
  DEFAULT_BASE_URL,
  digest,
  normalizeApprovedBaseUrl
} = require("../scripts/verify-task3f-storage-runtime");

test("runtime verifier uses an explicit synthetic-write confirmation", () => {
  assert.equal(CONFIRMATION, "TASK3F_STORAGE_RUNTIME_SYNTHETIC");
});

test("runtime verifier accepts only the approved HTTPS backend origin", () => {
  assert.equal(normalizeApprovedBaseUrl(`${DEFAULT_BASE_URL}/`), DEFAULT_BASE_URL);
  for (const value of [
    "http://atithisarthibackendcode-production-f8d1.up.railway.app",
    "https://example.com",
    `${DEFAULT_BASE_URL}?unsafe=true`,
    "http://localhost:5000"
  ]) assert.throws(() => normalizeApprovedBaseUrl(value));
});

test("runtime evidence uses stable redacted digests", () => {
  assert.equal(digest("fixture-a"), digest("fixture-a"));
  assert.notEqual(digest("fixture-a"), digest("fixture-b"));
  assert.equal(digest("fixture-a").length, 16);
});

