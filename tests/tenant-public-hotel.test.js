const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL ||= "https://tenant-public-hotel.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const {
  fetchTenantPublicHotelBundle,
  fetchTenantPublicOrderingSettings,
  getSinglePayload,
  normalizeScope
} = require("../utils/tenant-public-hotel");

const SCOPE = {
  tenantId: "ce77cfbd-40ea-4257-b78f-756ef5a0ec56",
  propertyId: "1",
  propertySlug: "hotel-sai-raj",
  source: "public_hotel_access"
};

function createTransactionRunner(responses = []) {
  const calls = [];
  let responseIndex = 0;
  const runner = async (context, work, options) => {
    calls.push({ type: "transaction", context, options });
    const client = {
      async query(sql, params) {
        calls.push({ type: "query", sql, params });
        const response = responses[responseIndex] || { rows: [] };
        responseIndex += 1;
        return response;
      }
    };
    return work(client);
  };
  return { runner, calls };
}

test("tenant public hotel bundle uses one read-only canonical transaction", async () => {
  const profile = {
    hotel_slug: "hotel-sai-raj",
    hotel_name: "Hotel Sai Raj",
    gst_percent: 5,
    theme: { primary: "#000000" }
  };
  const settings = {
    hotel_slug: "hotel-sai-raj",
    customer_ordering_enabled: false,
    staff_ordering_enabled: true,
    whatsapp_ordering_enabled: true
  };
  const fake = createTransactionRunner([
    { rows: [{ payload: profile }] },
    { rows: [{ payload: settings }] }
  ]);

  const result = await fetchTenantPublicHotelBundle(
    SCOPE,
    "hotel-sai-raj",
    { transactionRunner: fake.runner }
  );

  assert.deepEqual(result.profile, profile);
  assert.equal(result.orderingSettings.customerOrderingEnabled, false);
  assert.equal(result.orderingSettings.staffOrderingEnabled, true);
  assert.deepEqual(fake.calls[0], {
    type: "transaction",
    context: {
      tenantId: SCOPE.tenantId,
      propertyId: SCOPE.propertyId
    },
    options: { readOnly: true }
  });
  assert.equal(fake.calls.filter((call) => call.type === "query").length, 2);
  assert.deepEqual(fake.calls[1].params, [
    SCOPE.tenantId,
    SCOPE.propertyId,
    SCOPE.propertySlug
  ]);
  assert.match(fake.calls[1].sql, /profile\.tenant_id = \$1::uuid/);
  assert.match(fake.calls[2].sql, /settings\.property_id = \$2::bigint/);
});

test("cached-profile ordering refresh remains tenant scoped and read only", async () => {
  const fake = createTransactionRunner([
    {
      rows: [{
        payload: {
          hotel_slug: "hotel-sai-raj",
          customer_ordering_enabled: true
        }
      }]
    }
  ]);

  const result = await fetchTenantPublicOrderingSettings(
    SCOPE,
    "hotel-sai-raj",
    { transactionRunner: fake.runner }
  );

  assert.equal(result.customerOrderingEnabled, true);
  assert.equal(fake.calls[0].options.readOnly, true);
  assert.equal(fake.calls.filter((call) => call.type === "query").length, 1);
});

test("tenant public hotel path rejects a slug/context mismatch before DB use", async () => {
  let runnerCalled = false;
  await assert.rejects(
    fetchTenantPublicHotelBundle(
      SCOPE,
      "the-food-garden",
      {
        transactionRunner: async () => {
          runnerCalled = true;
        }
      }
    ),
    { code: "TENANT_PUBLIC_HOTEL_SCOPE_CONFLICT" }
  );
  assert.equal(runnerCalled, false);
});

test("tenant public hotel path rejects duplicate canonical rows", () => {
  assert.throws(
    () => getSinglePayload(
      { rows: [{ payload: {} }, { payload: {} }] },
      "hotel profile"
    ),
    { code: "TENANT_PUBLIC_HOTEL_DATA_CONFLICT" }
  );
});

test("tenant public hotel scope normalizes canonical slug only", () => {
  assert.deepEqual(normalizeScope(SCOPE, " HOTEL-SAI-RAJ "), {
    tenantId: SCOPE.tenantId,
    propertyId: SCOPE.propertyId,
    propertySlug: "hotel-sai-raj"
  });
});
