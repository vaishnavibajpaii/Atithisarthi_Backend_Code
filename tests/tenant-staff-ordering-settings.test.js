"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL ||= "https://tenant-staff-ordering.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const {
  fetchTenantStaffOrderingSettingsBundle,
  updateTenantStaffPaymentMethods
} = require("../utils/tenant-staff-ordering-settings");
const {
  buildStaffOrderingSettingsPayload
} = require("../utils/staff-ordering-settings-presentation");

const SCOPE = {
  tenantId: "ce77cfbd-40ea-4257-b78f-756ef5a0ec56",
  propertyId: "1",
  propertySlug: "hotel-sai-raj",
  source: "staff_jwt_hotel"
};

function createTransactionRunner(responses = []) {
  const calls = [];
  let index = 0;
  const runner = async (context, work, options) => {
    calls.push({ type: "transaction", context, options });
    return work({
      async query(sql, params) {
        calls.push({ type: "query", sql, params });
        return responses[index++] || { rows: [] };
      }
    });
  };
  return { calls, runner };
}

test("staff ordering settings use one canonical read-only transaction", async () => {
  const fake = createTransactionRunner([
    {
      rows: [{
        payload: {
          hotel_slug: SCOPE.propertySlug,
          enable_food_module: true
        }
      }]
    },
    {
      rows: [{
        payload: {
          hotel_slug: SCOPE.propertySlug,
          staff_ordering_enabled: false,
          enforce_table_master: true,
          secure_online_payment_enabled: true,
          cash_on_delivery_enabled: false,
          manual_upi_payment_enabled: true,
          disabled_title: "Paused",
          disabled_message: "Ask manager",
          disabled_icon: "pause"
        }
      }]
    }
  ]);

  const result = await fetchTenantStaffOrderingSettingsBundle(
    SCOPE,
    SCOPE.propertySlug,
    { transactionRunner: fake.runner }
  );

  assert.equal(result.featureConfig.canUseFood, true);
  assert.equal(result.settings.staffOrderingEnabled, false);
  assert.equal(result.settings.enforceTableMaster, true);
  assert.equal(result.settings.cashOnDeliveryEnabled, false);
  assert.equal(result.settings.disabledTitle, "Paused");
  assert.deepEqual(fake.calls[0], {
    type: "transaction",
    context: {
      tenantId: SCOPE.tenantId,
      propertyId: SCOPE.propertyId
    },
    options: { readOnly: true }
  });
  const queries = fake.calls.filter((call) => call.type === "query");
  assert.equal(queries.length, 2);
  for (const query of queries) {
    assert.deepEqual(query.params, [
      SCOPE.tenantId,
      SCOPE.propertyId,
      SCOPE.propertySlug
    ]);
    assert.match(query.sql, /\.tenant_id = \$1::uuid/);
    assert.match(query.sql, /\.property_id = \$2::bigint/);
    assert.match(query.sql, /\.hotel_slug = \$3/);
    assert.match(query.sql, /LIMIT 2/);
  }
});

test("food-disabled property stops before ordering-settings read", async () => {
  const fake = createTransactionRunner([{
    rows: [{
      payload: {
        hotel_slug: SCOPE.propertySlug,
        enable_food_module: false
      }
    }]
  }]);
  const result = await fetchTenantStaffOrderingSettingsBundle(
    SCOPE,
    SCOPE.propertySlug,
    { transactionRunner: fake.runner }
  );
  assert.equal(result.featureConfig.canUseFood, false);
  assert.equal(
    fake.calls.filter((call) => call.type === "query").length,
    1
  );
});

test("missing settings row preserves existing defaults", async () => {
  const fake = createTransactionRunner([
    {
      rows: [{
        payload: {
          hotel_slug: SCOPE.propertySlug,
          enable_food_module: true
        }
      }]
    },
    { rows: [] }
  ]);
  const result = await fetchTenantStaffOrderingSettingsBundle(
    SCOPE,
    SCOPE.propertySlug,
    { transactionRunner: fake.runner }
  );
  assert.equal(result.settings.exists, false);
  assert.equal(result.settings.staffOrderingEnabled, true);
  assert.equal(result.settings.secureOnlinePaymentEnabled, true);
  assert.equal(result.settings.cashOnDeliveryEnabled, true);
  assert.equal(result.settings.manualUpiPaymentEnabled, true);
});

test("staff ordering presenter preserves the existing response contract", () => {
  const payload = buildStaffOrderingSettingsPayload({
    hotelSlug: SCOPE.propertySlug,
    settings: {
      staffOrderingEnabled: false,
      enforceTableMaster: true,
      secureOnlinePaymentEnabled: true,
      cashOnDeliveryEnabled: false,
      manualUpiPaymentEnabled: true,
      disabledTitle: "Paused",
      disabledMessage: "Ask manager",
      disabledIcon: "pause",
      tenant_id: SCOPE.tenantId,
      property_id: 1
    }
  });
  assert.deepEqual(payload, {
    success: true,
    hotelSlug: SCOPE.propertySlug,
    ordering: {
      staffOrderingEnabled: false,
      enforceTableMaster: true,
      secureOnlinePaymentEnabled: true,
      cashOnDeliveryEnabled: false,
      manualUpiPaymentEnabled: true,
      title: "Paused",
      message: "Ask manager",
      icon: "pause"
    }
  });
  assert.equal("tenant_id" in payload.ordering, false);
  assert.equal("property_id" in payload.ordering, false);
});

test("staff ordering settings reject JWT/context mismatch before DB use", async () => {
  let called = false;
  await assert.rejects(
    fetchTenantStaffOrderingSettingsBundle(
      SCOPE,
      "the-food-garden",
      {
        transactionRunner: async () => {
          called = true;
        }
      }
    ),
    { code: "TENANT_STAFF_ORDERING_SCOPE_CONFLICT" }
  );
  assert.equal(called, false);
});

test("duplicate canonical settings rows fail closed", async () => {
  const fake = createTransactionRunner([
    {
      rows: [{
        payload: {
          hotel_slug: SCOPE.propertySlug,
          enable_food_module: true
        }
      }]
    },
    {
      rows: [
        { payload: { hotel_slug: SCOPE.propertySlug } },
        { payload: { hotel_slug: SCOPE.propertySlug } }
      ]
    }
  ]);
  await assert.rejects(
    fetchTenantStaffOrderingSettingsBundle(
      SCOPE,
      SCOPE.propertySlug,
      { transactionRunner: fake.runner }
    ),
    { code: "TENANT_STAFF_ORDERING_DATA_CONFLICT" }
  );
});

test("payment-method update uses one canonical writable tenant transaction", async () => {
  const fake = createTransactionRunner([{
    rows: [{
      hotel_slug: SCOPE.propertySlug,
      secure_online_payment_enabled: true,
      cash_on_delivery_enabled: false,
      manual_upi_payment_enabled: true,
      updated_at: "2026-10-07T00:00:00.000Z"
    }]
  }]);

  const result = await updateTenantStaffPaymentMethods(
    SCOPE,
    SCOPE.propertySlug,
    {
      secureOnlinePaymentEnabled: true,
      cashOnDeliveryEnabled: false,
      manualUpiPaymentEnabled: true
    },
    { transactionRunner: fake.runner }
  );

  assert.equal(result.hotel_slug, SCOPE.propertySlug);
  assert.equal(result.cash_on_delivery_enabled, false);
  assert.deepEqual(fake.calls[0], {
    type: "transaction",
    context: {
      tenantId: SCOPE.tenantId,
      propertyId: SCOPE.propertyId
    },
    options: undefined
  });
  const query = fake.calls.find((call) => call.type === "query");
  assert.deepEqual(query.params, [
    SCOPE.tenantId,
    SCOPE.propertyId,
    SCOPE.propertySlug,
    true,
    false,
    true
  ]);
  assert.match(query.sql, /INSERT INTO public\.hotel_ordering_settings/);
  assert.match(query.sql, /ON CONFLICT \(hotel_slug\) DO UPDATE/);
  assert.match(query.sql, /hotel_ordering_settings\.tenant_id = \$1::uuid/);
  assert.match(query.sql, /hotel_ordering_settings\.property_id = \$2::bigint/);
  assert.match(query.sql, /RETURNING hotel_slug/);
});

test("payment-method update rejects context mismatch before DB use", async () => {
  let called = false;
  await assert.rejects(
    updateTenantStaffPaymentMethods(
      SCOPE,
      "the-food-garden",
      {},
      {
        transactionRunner: async () => {
          called = true;
        }
      }
    ),
    { code: "TENANT_STAFF_ORDERING_SCOPE_CONFLICT" }
  );
  assert.equal(called, false);
});

test("payment-method update fails closed when scoped upsert returns no row", async () => {
  const fake = createTransactionRunner([{ rows: [] }]);
  await assert.rejects(
    updateTenantStaffPaymentMethods(
      SCOPE,
      SCOPE.propertySlug,
      {
        secureOnlinePaymentEnabled: true,
        cashOnDeliveryEnabled: true,
        manualUpiPaymentEnabled: true
      },
      { transactionRunner: fake.runner }
    ),
    { code: "TENANT_STAFF_ORDERING_WRITE_CONFLICT" }
  );
});
