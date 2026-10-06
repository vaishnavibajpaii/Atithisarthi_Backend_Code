"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL ||= "https://tenant-staff-menu.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const {
  attachCanonicalStaffTenantContext,
  fetchCanonicalStaffHotel
} = require("../utils/tenant-staff-context");
const {
  getTenantRequestScope
} = require("../utils/tenant-request-context");
const {
  fetchTenantStaffMenuBundle
} = require("../utils/tenant-staff-menu");
const {
  buildStaffMenuPayload
} = require("../utils/staff-menu-presentation");

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

function createSupabaseHotelMock(data) {
  const calls = [];
  const chain = {
    select(fields) {
      calls.push(["select", fields]);
      return chain;
    },
    eq(column, value) {
      calls.push(["eq", column, value]);
      return chain;
    },
    async maybeSingle() {
      calls.push(["maybeSingle"]);
      return { data, error: null };
    }
  };
  return {
    calls,
    client: {
      from(table) {
        calls.push(["from", table]);
        return chain;
      }
    }
  };
}

test("staff JWT hotel slug resolves to immutable canonical tenant context", async () => {
  const mock = createSupabaseHotelMock({
    id: 1,
    tenant_id: SCOPE.tenantId,
    slug: SCOPE.propertySlug
  });
  const req = {
    staffHotelSlug: SCOPE.propertySlug,
    staffUser: { hotelSlug: SCOPE.propertySlug }
  };
  const hotel = await attachCanonicalStaffTenantContext(req, {
    supabaseClient: mock.client
  });

  assert.equal(hotel.slug, SCOPE.propertySlug);
  assert.deepEqual(getTenantRequestScope(req), SCOPE);
  assert.deepEqual(mock.calls[0], ["from", "hotels"]);
  assert.deepEqual(mock.calls[2], ["eq", "slug", SCOPE.propertySlug]);
  assert.equal(Object.isFrozen(req.tenant), true);
  assert.equal(Object.isFrozen(req.property), true);
});

test("canonical staff hotel lookup rejects incomplete ownership mapping", async () => {
  const mock = createSupabaseHotelMock({
    id: 1,
    tenant_id: null,
    slug: SCOPE.propertySlug
  });
  await assert.rejects(
    fetchCanonicalStaffHotel(SCOPE.propertySlug, {
      supabaseClient: mock.client
    }),
    { code: "TENANT_STAFF_CONTEXT_INVALID" }
  );
});

test("tenant staff menu scopes every enabled-food read in one read-only transaction", async () => {
  const menuItem = {
    item_id: "tea-1",
    item_type: "single",
    name: "Tea",
    price: 50,
    category: "drinks",
    sort_order: 1
  };
  const visibleCategory = {
    id: "cat-1",
    category_key: "drinks",
    name: "Drinks",
    display_order: 1,
    is_active: true,
    staff_enabled: true
  };
  const hiddenCategory = {
    id: "cat-2",
    category_key: "hidden",
    name: "Hidden",
    display_order: 2,
    is_active: true,
    staff_enabled: false
  };
  const fake = createTransactionRunner([
    {
      rows: [{
        payload: {
          hotel_slug: SCOPE.propertySlug,
          enable_food_module: true
        }
      }]
    },
    { rows: [{ payload: menuItem }] },
    {
      rows: [
        { payload: visibleCategory },
        { payload: hiddenCategory }
      ]
    }
  ]);

  const result = await fetchTenantStaffMenuBundle(
    SCOPE,
    SCOPE.propertySlug,
    { transactionRunner: fake.runner }
  );

  assert.equal(result.featureConfig.canUseFood, true);
  assert.deepEqual(result.menuItems, [menuItem]);
  assert.deepEqual(result.categoryResult.categories, [visibleCategory]);
  assert.equal(result.comboPresentationMap.size, 0);
  assert.deepEqual(fake.calls[0], {
    type: "transaction",
    context: {
      tenantId: SCOPE.tenantId,
      propertyId: SCOPE.propertyId
    },
    options: { readOnly: true }
  });
  const queries = fake.calls.filter((call) => call.type === "query");
  assert.equal(queries.length, 3);
  for (const query of queries) {
    assert.deepEqual(query.params, [
      SCOPE.tenantId,
      SCOPE.propertyId,
      SCOPE.propertySlug
    ]);
    assert.match(query.sql, /\.tenant_id = \$1::uuid/);
    assert.match(query.sql, /\.property_id = \$2::bigint/);
    assert.match(query.sql, /\.hotel_slug = \$3/);
  }
});

test("disabled food module stops before menu data reads", async () => {
  const fake = createTransactionRunner([{
    rows: [{
      payload: {
        hotel_slug: SCOPE.propertySlug,
        enable_food_module: false
      }
    }]
  }]);

  const result = await fetchTenantStaffMenuBundle(
    SCOPE,
    SCOPE.propertySlug,
    { transactionRunner: fake.runner }
  );

  assert.equal(result.featureConfig.canUseFood, false);
  assert.equal(result.menuItems.length, 0);
  assert.equal(
    fake.calls.filter((call) => call.type === "query").length,
    1
  );
});

test("tenant staff menu scopes combo dependencies in the same transaction", async () => {
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
          item_id: "combo-1",
          item_type: "combo",
          name: "Combo",
          price: 100,
          category: "combos",
          sort_order: 1
        }
      }]
    },
    {
      rows: [{
        payload: {
          id: "cat-combos",
          category_key: "combos",
          name: "Combos",
          display_order: 1,
          is_active: true,
          staff_enabled: true
        }
      }]
    },
    {
      rows: [{
        payload: {
          id: "combo-child-1",
          combo_item_id: "combo-1",
          child_item_id: "child-1",
          quantity: 1,
          sort_order: 1
        }
      }]
    },
    {
      rows: [{
        payload: {
          combo_item_id: "combo-1"
        }
      }]
    },
    {
      rows: [{
        payload: {
          item_id: "child-1",
          name: "Child",
          price: 120,
          category: "mains",
          image: ""
        }
      }]
    }
  ]);

  const result = await fetchTenantStaffMenuBundle(
    SCOPE,
    SCOPE.propertySlug,
    { transactionRunner: fake.runner }
  );

  assert.equal(result.comboPresentationMap.size, 1);
  const queries = fake.calls.filter((call) => call.type === "query");
  assert.equal(queries.length, 6);
  for (const query of queries.slice(3)) {
    assert.equal(query.params[0], SCOPE.tenantId);
    assert.equal(query.params[1], SCOPE.propertyId);
    assert.equal(query.params[2], SCOPE.propertySlug);
    assert.match(query.sql, /\.tenant_id = \$1::uuid/);
    assert.match(query.sql, /\.property_id = \$2::bigint/);
    assert.match(query.sql, /\.hotel_slug = \$3/);
  }
});

test("staff-menu presenter preserves the existing safe response contract", () => {
  const payload = buildStaffMenuPayload({
    hotelSlug: SCOPE.propertySlug,
    menuItems: [{
      item_id: "tea-1",
      item_type: "single",
      name: "Tea",
      description: "Hot tea",
      price: "50",
      category: "drinks",
      sort_order: 1,
      tenant_id: SCOPE.tenantId,
      property_id: 1
    }],
    categoryResult: {
      source: "menu-categories",
      categories: [{
        id: "cat-1",
        category_key: "drinks",
        name: "Drinks",
        display_order: 1,
        is_active: true,
        staff_enabled: true
      }]
    }
  });

  assert.equal(payload.success, true);
  assert.equal(payload.hotelSlug, SCOPE.propertySlug);
  assert.equal(payload.count, 1);
  assert.equal(payload.items[0].id, "tea-1");
  assert.equal(payload.items[0].price, 50);
  assert.equal(payload.menu.drinks.length, 1);
  assert.match(payload.menuVersion, /^[0-9a-f]{16}$/);
  assert.equal("tenant_id" in payload.items[0], false);
  assert.equal("property_id" in payload.items[0], false);
});

test("tenant staff menu rejects JWT/context slug mismatch before database use", async () => {
  let called = false;
  await assert.rejects(
    fetchTenantStaffMenuBundle(
      SCOPE,
      "the-food-garden",
      {
        transactionRunner: async () => {
          called = true;
        }
      }
    ),
    { code: "TENANT_STAFF_MENU_SCOPE_CONFLICT" }
  );
  assert.equal(called, false);
});
