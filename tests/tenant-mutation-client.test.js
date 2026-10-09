"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL ||= "https://tenant-mutations.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const {
  createTenantMutationClient
} = require("../utils/tenant-mutation-client");

const SCOPE = {
  tenantId: "ce77cfbd-40ea-4257-b78f-756ef5a0ec56",
  propertyId: "1",
  propertySlug: "hotel-sai-raj"
};

function createRunner(rows = []) {
  const calls = [];
  return {
    calls,
    runner: async (context, work, options) => {
      calls.push({ context, options });
      return work({
        async query(sql, params) {
          calls.push({ sql, params });
          return { rows };
        }
      });
    }
  };
}

test("scoped insert uses the restricted writable transaction and returns one row", async () => {
  const fake = createRunner([{ id: 7, hotel_slug: SCOPE.propertySlug }]);
  const client = createTenantMutationClient(SCOPE, { transactionRunner: fake.runner });
  const result = await client
    .from("inquiries")
    .insert([{
      tenant_id: SCOPE.tenantId,
      property_id: SCOPE.propertyId,
      hotel_slug: SCOPE.propertySlug,
      name: "TASK3G TEST"
    }])
    .select("id,hotel_slug")
    .single();

  assert.equal(result.error, null);
  assert.deepEqual(result.data, { id: 7, hotel_slug: SCOPE.propertySlug });
  assert.deepEqual(fake.calls[0], {
    context: { tenantId: SCOPE.tenantId, propertyId: SCOPE.propertyId },
    options: { readOnly: false }
  });
  assert.match(fake.calls[1].sql, /^INSERT INTO public\."inquiries"/);
  assert.match(fake.calls[1].sql, /RETURNING "id", "hotel_slug"$/);
});

test("insert derives ownership from canonical scope and rejects conflicts", async () => {
  const fake = createRunner([{ id: 8, hotel_slug: SCOPE.propertySlug }]);
  const client = createTenantMutationClient(SCOPE, { transactionRunner: fake.runner });
  const result = await client
    .from("inquiries")
    .insert({ name: "TASK3G OWNERSHIP" })
    .select("id,hotel_slug")
    .single();

  assert.equal(result.error, null);
  assert.deepEqual(fake.calls[1].params.slice(-3), [
    SCOPE.tenantId,
    SCOPE.propertyId,
    SCOPE.propertySlug
  ]);
  assert.throws(
    () => client.from("inquiries").insert({
      name: "TASK3G CONFLICT",
      hotel_slug: "the-food-garden"
    }),
    { code: "TENANT_MUTATION_SCOPE_CONFLICT" }
  );
});

test("scoped select uses a read-only restricted transaction", async () => {
  const fake = createRunner([{ id: 3, hotel_slug: SCOPE.propertySlug }]);
  const client = createTenantMutationClient(SCOPE, { transactionRunner: fake.runner });
  const result = await client
    .from("notification_events")
    .select("id,hotel_slug")
    .eq("hotel_slug", SCOPE.propertySlug)
    .limit(1)
    .maybeSingle();
  assert.equal(result.error, null);
  assert.equal(result.data.id, 3);
  assert.deepEqual(fake.calls[0].options, { readOnly: true });
  assert.match(fake.calls[1].sql, /^SELECT "id", "hotel_slug" FROM public\."notification_events"/);
  assert.match(fake.calls[1].sql, /LIMIT 1$/);
});

test("scoped update cannot alter ownership and compiles reviewed filters", async () => {
  const fake = createRunner([{ id: 9, status: "resolved" }]);
  const client = createTenantMutationClient(SCOPE, { transactionRunner: fake.runner });
  const result = await client
    .from("inquiries")
    .update({ status: "resolved" })
    .eq("id", 9)
    .eq("hotel_slug", SCOPE.propertySlug)
    .select("id,status")
    .maybeSingle();

  assert.equal(result.error, null);
  assert.match(fake.calls[1].sql, /^UPDATE public\."inquiries" SET "status" = \$1 WHERE "id" = \$2 AND "hotel_slug" = \$3/);
  assert.deepEqual(fake.calls[1].params, ["resolved", 9, SCOPE.propertySlug]);

  const forbidden = await client
    .from("inquiries")
    .update({ tenant_id: "01d26c08-4fea-44f2-837a-61f546aa31c2" })
    .eq("id", 9);
  assert.equal(forbidden.data, null);
  assert.equal(forbidden.error.code, "TENANT_MUTATION_OWNERSHIP_IMMUTABLE");
});

test("unscoped deletes and non-manifest tables fail closed", async () => {
  const fake = createRunner([]);
  const client = createTenantMutationClient(SCOPE, { transactionRunner: fake.runner });
  const deletion = await client.from("gallery_items").delete();
  assert.equal(deletion.error.code, "TENANT_MUTATION_UNSCOPED_DELETE");
  assert.throws(
    () => client.from("admin_users"),
    { code: "TENANT_MUTATION_TABLE_FORBIDDEN" }
  );
});

test("upsert excludes ownership columns from conflict updates", async () => {
  const fake = createRunner([{ hotel_slug: SCOPE.propertySlug }]);
  const client = createTenantMutationClient(SCOPE, { transactionRunner: fake.runner });
  const result = await client
    .from("hotel_ordering_settings")
    .upsert([{
      tenant_id: SCOPE.tenantId,
      property_id: SCOPE.propertyId,
      hotel_slug: SCOPE.propertySlug,
      secure_online_payment_enabled: true
    }], { onConflict: "hotel_slug" })
    .select("hotel_slug")
    .single();

  assert.equal(result.error, null);
  assert.match(fake.calls[1].sql, /ON CONFLICT \("hotel_slug"\) DO UPDATE SET "secure_online_payment_enabled" = EXCLUDED\."secure_online_payment_enabled"/);
  assert.doesNotMatch(fake.calls[1].sql, /SET[^]*"tenant_id" = EXCLUDED/);
  assert.doesNotMatch(fake.calls[1].sql, /SET[^]*"property_id" = EXCLUDED/);
});

test("reviewed RPCs execute with named arguments inside the restricted transaction", async () => {
  const fake = createRunner([{ acknowledged_through_id: 42 }]);
  const client = createTenantMutationClient(SCOPE, { transactionRunner: fake.runner });
  const result = await client.rpc("acknowledge_notification_card", {
    p_hotel_slug: SCOPE.propertySlug,
    p_staff_id: "staff-test",
    p_card_key: "orders",
    p_acknowledged_through_id: 42
  });
  assert.equal(result.error, null);
  assert.equal(result.data[0].acknowledged_through_id, 42);
  assert.deepEqual(fake.calls[0].options, { readOnly: false });
  assert.match(fake.calls[1].sql, /^SELECT \* FROM public\."acknowledge_notification_card"\("p_hotel_slug" => \$1/);
  assert.throws(
    () => client.rpc("unreviewed_function", {}),
    { code: "TENANT_RPC_FORBIDDEN" }
  );
  assert.throws(
    () => client.rpc("acknowledge_notification_card", {
      p_hotel_slug: "the-food-garden"
    }),
    { code: "TENANT_RPC_SCOPE_CONFLICT" }
  );
});
