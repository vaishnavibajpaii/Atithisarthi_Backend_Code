"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL ||= "https://tenant-public-menu.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const {
  fetchTenantPublicMenuData,
  fetchTenantPublicMenuFeature
} = require("../utils/tenant-public-menu");
const {
  buildPublicMenuPayload
} = require("../utils/public-menu-presentation");

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

test("tenant public menu feature lookup is canonical and read only", async () => {
  const fake = createTransactionRunner([{
    rows: [{
      payload: {
        hotel_slug: SCOPE.propertySlug,
        enable_food_module: true
      }
    }]
  }]);

  const result = await fetchTenantPublicMenuFeature(
    SCOPE,
    SCOPE.propertySlug,
    { transactionRunner: fake.runner }
  );

  assert.equal(result.canUseFood, true);
  assert.deepEqual(fake.calls[0], {
    type: "transaction",
    context: {
      tenantId: SCOPE.tenantId,
      propertyId: SCOPE.propertyId
    },
    options: { readOnly: true }
  });
  assert.deepEqual(fake.calls[1].params, [
    SCOPE.tenantId,
    SCOPE.propertyId,
    SCOPE.propertySlug
  ]);
  assert.match(fake.calls[1].sql, /settings\.tenant_id = \$1::uuid/);
  assert.match(fake.calls[1].sql, /settings\.property_id = \$2::bigint/);
  assert.match(fake.calls[1].sql, /settings\.hotel_slug = \$3/);
});

test("tenant public menu data scopes every database read", async () => {
  const menuItem = {
    item_id: "TEST_TASK3_MENU_1",
    item_type: "single",
    name: "Synthetic Tea",
    description: "",
    price: 50,
    image: "",
    alt: "",
    badge: "",
    tag: "",
    category: "drinks",
    sort_order: 1
  };
  const category = {
    id: "TEST_TASK3_CATEGORY_1",
    hotel_slug: SCOPE.propertySlug,
    category_key: "drinks",
    name: "Drinks",
    display_order: 1,
    is_active: true,
    is_published: true,
    website_enabled: true
  };
  const fake = createTransactionRunner([
    { rows: [{ payload: menuItem }] },
    { rows: [{ payload: category }] }
  ]);

  const result = await fetchTenantPublicMenuData(
    SCOPE,
    SCOPE.propertySlug,
    { transactionRunner: fake.runner }
  );

  assert.deepEqual(result.menuItems, [menuItem]);
  assert.equal(result.categoryResult.source, "menu-categories");
  assert.equal(result.categoryResult.categories.length, 1);
  assert.equal(result.comboPresentationMap.size, 0);
  assert.equal(fake.calls[0].options.readOnly, true);
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
  }
  assert.match(queries[0].sql, /item\.item_id ASC/);
});

test("tenant public menu loads combo dependencies inside one scoped transaction", async () => {
  const fake = createTransactionRunner([
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
          id: "category-1",
          hotel_slug: SCOPE.propertySlug,
          category_key: "combos",
          name: "Combos",
          display_order: 1,
          is_active: true,
          is_published: true,
          website_enabled: true
        }
      }]
    },
    {
      rows: [{
        payload: {
          id: "combo-child-1",
          hotel_slug: SCOPE.propertySlug,
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
          hotel_slug: SCOPE.propertySlug,
          combo_item_id: "combo-1"
        }
      }]
    },
    {
      rows: [{
        payload: {
          hotel_slug: SCOPE.propertySlug,
          item_id: "child-1",
          name: "Child",
          price: 120,
          category: "mains",
          image: ""
        }
      }]
    }
  ]);

  await fetchTenantPublicMenuData(
    SCOPE,
    SCOPE.propertySlug,
    { transactionRunner: fake.runner }
  );

  const queries = fake.calls.filter((call) => call.type === "query");
  assert.equal(queries.length, 5);
  for (const query of queries.slice(2)) {
    assert.equal(query.params[0], SCOPE.tenantId);
    assert.equal(query.params[1], SCOPE.propertyId);
    assert.equal(query.params[2], SCOPE.propertySlug);
    assert.match(query.sql, /\.tenant_id = \$1::uuid/);
    assert.match(query.sql, /\.property_id = \$2::bigint/);
    assert.match(query.sql, /\.hotel_slug = \$3/);
  }
});

test("shared public-menu presenter preserves the existing response contract", () => {
  const payload = buildPublicMenuPayload({
    menuItems: [{
      item_id: "tea-1",
      item_type: "single",
      name: "Tea",
      description: "Hot tea",
      price: "50",
      category: "drinks",
      sort_order: 1
    }],
    categoryResult: {
      source: "menu-categories",
      categories: [{
        id: "category-1",
        category_key: "drinks",
        name: "Drinks",
        display_order: 1,
        is_active: true,
        is_published: true,
        website_enabled: true
      }]
    }
  });

  assert.equal(payload.success, true);
  assert.equal(payload.categorySource, "menu-categories");
  assert.equal(payload.categories.length, 1);
  assert.equal(payload.menu.drinks.length, 1);
  assert.equal(payload.menu.drinks[0].id, "tea-1");
  assert.equal(payload.menu.drinks[0].price, 50);
  assert.equal(typeof payload.menuVersion, "string");
  assert.equal(payload.menuVersion.length, 16);
  assert.equal("tenant_id" in payload.menu.drinks[0], false);
  assert.equal("property_id" in payload.menu.drinks[0], false);
});

test("tenant public menu rejects slug/context mismatch before database use", async () => {
  let runnerCalled = false;
  await assert.rejects(
    fetchTenantPublicMenuData(
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
