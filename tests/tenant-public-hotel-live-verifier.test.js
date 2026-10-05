const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeBaseUrl,
  normalizeSlug,
  requireEnabledReadyCheck,
  requireReadyCheck,
  verifyHotel
} = require("../scripts/verify-tenant-public-hotel-live");

test("live verifier accepts only non-local HTTPS base URLs", () => {
  assert.equal(
    normalizeBaseUrl("https://backend.example.com/"),
    "https://backend.example.com"
  );
  assert.throws(
    () => normalizeBaseUrl("http://backend.example.com"),
    { code: "TASK3_PUBLIC_LIVE_URL_INVALID" }
  );
  assert.throws(
    () => normalizeBaseUrl("https://localhost:5000"),
    { code: "TASK3_PUBLIC_LIVE_URL_INVALID" }
  );
});

test("live verifier validates canonical property slugs", () => {
  assert.equal(normalizeSlug(" Hotel-Sai-Raj "), "hotel-sai-raj");
  assert.throws(
    () => normalizeSlug("../other"),
    { code: "TASK3_PUBLIC_LIVE_SLUG_INVALID" }
  );
});

test("live verifier requires explicit tenant readiness checks", () => {
  const readiness = {
    body: {
      checks: [
        { name: "tenant_runtime_database", ready: true }
      ]
    }
  };
  assert.equal(
    requireReadyCheck(readiness, "tenant_runtime_database"),
    true
  );
  assert.throws(
    () => requireReadyCheck(readiness, "tenant_runtime_public_hotel"),
    { code: "TASK3_PUBLIC_LIVE_RELEASE_MISSING" }
  );
  assert.throws(
    () => requireReadyCheck(
      {
        body: {
          checks: [{
            name: "tenant_runtime_public_hotel",
            ready: false,
            issue: "tenant_public_hotel_requires_tenant_runtime"
          }]
        }
      },
      "tenant_runtime_public_hotel"
    ),
    { code: "TASK3_PUBLIC_LIVE_READINESS_FAILED" }
  );
});

test("live verifier requires tenant runtime checks to be explicitly enabled", () => {
  assert.equal(
    requireEnabledReadyCheck(
      { body: { checks: [{ name: "tenant_runtime_database", ready: true, enabled: true }] } },
      "tenant_runtime_database"
    ),
    true
  );
  assert.throws(
    () => requireEnabledReadyCheck(
      { body: { checks: [{ name: "tenant_runtime_database", ready: true, enabled: false }] } },
      "tenant_runtime_database"
    ),
    { code: "TASK3_PUBLIC_LIVE_RUNTIME_DISABLED" }
  );
});

test("live verifier validates property identity and hides ownership fields", () => {
  assert.deepEqual(
    verifyHotel(
      {
        status: 200,
        body: {
          success: true,
          hotel: { hotel_slug: "hotel-sai-raj" }
        }
      },
      "hotel-sai-raj"
    ),
    {
      httpStatus: 200,
      matchedSlug: "hotel-sai-raj",
      internalContextExposed: false
    }
  );
  assert.throws(
    () => verifyHotel(
      {
        status: 200,
        body: {
          success: true,
          hotel: {
            hotel_slug: "hotel-sai-raj",
            tenant_id: "must-not-be-public"
          }
        }
      },
      "hotel-sai-raj"
    ),
    { code: "TASK3_PUBLIC_LIVE_CONTEXT_EXPOSED" }
  );
});
