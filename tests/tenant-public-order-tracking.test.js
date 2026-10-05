"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL ||= "https://tenant-public-order-tracking.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const {
  fetchTenantPublicOrderTrackingBundle
} = require("../utils/tenant-public-order-tracking");

const SCOPE = {
  tenantId: "ce77cfbd-40ea-4257-b78f-756ef5a0ec56",
  propertyId: "1",
  propertySlug: "hotel-sai-raj"
};

function createRunner(handler) {
  const calls = [];
  const runner = async (context, work, options) => {
    calls.push({ type: "transaction", context, options });
    return work({
      async query(sql, params = []) {
        calls.push({ type: "query", sql, params });
        return handler(sql, params, calls);
      }
    });
  };
  return { runner, calls };
}

function buildOrder(overrides = {}) {
  return {
    id: "42",
    hotel_slug: SCOPE.propertySlug,
    hotel_name: "Hotel Sai Raj",
    order_type: "dine-in",
    table_number: "T1",
    order_source: "qr",
    payment_method: "COD",
    payment_status: "unpaid",
    billing_status: "not_billed",
    items: [{ id: "tea", name: "Tea", qty: 1, price: 30 }],
    totals: { total: 30 },
    status: "new",
    created_at: "2026-10-05T00:00:00.000Z",
    ...overrides
  };
}

test("tracking bundle uses one canonical read-only tenant transaction", async () => {
  const fake = createRunner((sql) => {
    if (sql.includes("hotel_feature_settings")) {
      return { rows: [{ payload: { hotel_slug: SCOPE.propertySlug, enable_food_module: true } }] };
    }
    if (sql.includes("target.tracking_token")) {
      return { rows: [{ payload: buildOrder() }] };
    }
    if (sql.includes("target.parent_order_id")) {
      return { rows: [{ payload: buildOrder({ id: "43", parent_order_id: "42", addon_sequence: 1 }) }] };
    }
    if (sql.includes("hotel_profiles")) {
      return { rows: [{ owner_whatsapp_number: "919999999999" }] };
    }
    if (sql.includes("public.hotels")) {
      return { rows: [{ whatsapp_number: "918888888888" }] };
    }
    return { rows: [] };
  });

  const result = await fetchTenantPublicOrderTrackingBundle(
    SCOPE,
    SCOPE.propertySlug,
    { orderId: "42", trackingToken: "opaque-token" },
    { transactionRunner: fake.runner }
  );

  assert.equal(result.featureConfig.canUseFood, true);
  assert.equal(result.order.id, "42");
  assert.equal(result.addOns.length, 1);
  assert.equal(result.ownerWhatsAppNumber, "919999999999");
  assert.deepEqual(fake.calls[0], {
    type: "transaction",
    context: { tenantId: SCOPE.tenantId, propertyId: SCOPE.propertyId },
    options: { readOnly: true }
  });

  const queries = fake.calls.filter((call) => call.type === "query");
  assert.ok(queries.every((call) => !/\b(insert|update|delete|truncate)\b/i.test(call.sql)));
  assert.ok(queries.every((call) => call.params[0] === SCOPE.tenantId));
  assert.ok(queries.every((call) => call.params[1] === SCOPE.propertyId));
  assert.ok(queries.every((call) => call.params[2] === SCOPE.propertySlug));
  assert.deepEqual(
    queries.find((call) => call.sql.includes("target.tracking_token")).params,
    [SCOPE.tenantId, SCOPE.propertyId, SCOPE.propertySlug, "42", "opaque-token"]
  );
});

test("wrong tracking evidence returns no order without secondary data reads", async () => {
  const fake = createRunner((sql) => {
    if (sql.includes("hotel_feature_settings")) {
      return { rows: [{ payload: { enable_food_module: true } }] };
    }
    return { rows: [] };
  });
  const result = await fetchTenantPublicOrderTrackingBundle(
    SCOPE,
    SCOPE.propertySlug,
    { orderId: "42", trackingToken: "wrong-token" },
    { transactionRunner: fake.runner }
  );
  assert.equal(result.order, null);
  assert.deepEqual(result.addOns, []);
  assert.equal(
    fake.calls.filter((call) => call.type === "query").length,
    2
  );
});

test("profile WhatsApp falls back to the canonical hotels row", async () => {
  const fake = createRunner((sql) => {
    if (sql.includes("hotel_feature_settings")) return { rows: [] };
    if (sql.includes("target.tracking_token")) return { rows: [{ payload: buildOrder() }] };
    if (sql.includes("target.parent_order_id")) return { rows: [] };
    if (sql.includes("hotel_profiles")) return { rows: [{ owner_whatsapp_number: "" }] };
    if (sql.includes("public.hotels")) return { rows: [{ whatsapp_number: "917777777777" }] };
    return { rows: [] };
  });
  const result = await fetchTenantPublicOrderTrackingBundle(
    SCOPE,
    SCOPE.propertySlug,
    { orderId: "42", trackingToken: "opaque-token" },
    { transactionRunner: fake.runner }
  );
  assert.equal(result.ownerWhatsAppNumber, "917777777777");
});

test("tracking lookup rejects slug/context mismatch before database use", async () => {
  let runnerCalled = false;
  await assert.rejects(
    fetchTenantPublicOrderTrackingBundle(
      SCOPE,
      "the-food-garden",
      { orderId: "42", trackingToken: "opaque-token" },
      { transactionRunner: async () => { runnerCalled = true; } }
    ),
    { code: "TENANT_PUBLIC_HOTEL_SCOPE_CONFLICT" }
  );
  assert.equal(runnerCalled, false);
});

test("tracking lookup rejects missing opaque evidence before database use", async () => {
  let runnerCalled = false;
  await assert.rejects(
    fetchTenantPublicOrderTrackingBundle(
      SCOPE,
      SCOPE.propertySlug,
      { orderId: "42", trackingToken: "" },
      { transactionRunner: async () => { runnerCalled = true; } }
    ),
    { code: "TENANT_PUBLIC_ORDER_TRACKING_INPUT_INVALID" }
  );
  assert.equal(runnerCalled, false);
});
