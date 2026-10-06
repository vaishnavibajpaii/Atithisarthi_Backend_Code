"use strict";

process.env.SUPABASE_URL ||= "https://tenant-staff-session-test.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "tenant-staff-session-test-only-secret";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildStaffSessionPayload
} = require("../utils/staff-session-presentation");
const {
  fetchTenantStaffSessionFeatures
} = require("../utils/tenant-staff-session");

const SCOPE = Object.freeze({
  tenantId: "ce77cfbd-40ea-4257-b78f-756ef5a0ec56",
  propertyId: "1",
  propertySlug: "hotel-sai-raj"
});

function createRunner(rows, evidence = {}) {
  return async (scope, work, options) => {
    evidence.scope = scope;
    evidence.options = options;
    return work({
      async query(sql, params) {
        evidence.sql = sql;
        evidence.params = params;
        return { rows };
      }
    });
  };
}

test("staff session features use one canonical read-only transaction", async () => {
  const evidence = {};
  const features = await fetchTenantStaffSessionFeatures(
    SCOPE,
    SCOPE.propertySlug,
    {
      transactionRunner: createRunner([
        {
          payload: {
            hotel_slug: SCOPE.propertySlug,
            enable_food_module: true,
            enable_room_module: false,
            version: 4
          }
        }
      ], evidence)
    }
  );

  assert.deepEqual(evidence.scope, {
    tenantId: SCOPE.tenantId,
    propertyId: SCOPE.propertyId
  });
  assert.deepEqual(evidence.options, { readOnly: true });
  assert.match(evidence.sql, /feature\.tenant_id = \$1::uuid/);
  assert.match(evidence.sql, /feature\.property_id = \$2::bigint/);
  assert.match(evidence.sql, /feature\.hotel_slug = \$3/);
  assert.deepEqual(evidence.params, [
    SCOPE.tenantId,
    SCOPE.propertyId,
    SCOPE.propertySlug
  ]);
  assert.equal(features.hotelSlug, SCOPE.propertySlug);
  assert.equal(features.canUseFood, true);
  assert.equal(features.canUseRooms, false);
  assert.equal(features.version, 4);
});

test("missing staff session feature row preserves legacy defaults", async () => {
  const features = await fetchTenantStaffSessionFeatures(
    SCOPE,
    SCOPE.propertySlug,
    { transactionRunner: createRunner([]) }
  );

  assert.equal(features.hotelSlug, SCOPE.propertySlug);
  assert.equal(features.enableFoodModule, true);
  assert.equal(features.enableRoomModule, false);
  assert.equal(features.businessType, "restaurant_only");
});

test("staff session presenter preserves the existing response contract", () => {
  const payload = buildStaffSessionPayload({
    staffUser: {
      sub: "TASK3E_SESSION_TEST",
      hotelSlug: SCOPE.propertySlug,
      displayName: "Synthetic Staff",
      role: "staff",
      kdsRole: "general",
      tenant_id: "must-not-appear",
      property_id: 999
    },
    features: {
      hotelSlug: SCOPE.propertySlug,
      enableFoodModule: true,
      enableRoomModule: false
    }
  });

  assert.equal(payload.success, true);
  assert.equal(payload.staffUser.id, "TASK3E_SESSION_TEST");
  assert.equal(payload.staffUser.hotelSlug, SCOPE.propertySlug);
  assert.equal(payload.staffUser.role, "staff");
  assert.equal(payload.staffUser.isManager, false);
  assert.equal(payload.features.hotelSlug, SCOPE.propertySlug);
  assert.equal("tenant_id" in payload.staffUser, false);
  assert.equal("property_id" in payload.staffUser, false);
});

test("staff session rejects JWT/context mismatch before database use", async () => {
  let transactionCalled = false;
  await assert.rejects(
    fetchTenantStaffSessionFeatures(
      SCOPE,
      "the-food-garden",
      {
        transactionRunner: async () => {
          transactionCalled = true;
        }
      }
    ),
    { code: "TENANT_STAFF_SESSION_SCOPE_CONFLICT" }
  );
  assert.equal(transactionCalled, false);
});

test("duplicate canonical staff feature rows fail closed", async () => {
  await assert.rejects(
    fetchTenantStaffSessionFeatures(
      SCOPE,
      SCOPE.propertySlug,
      {
        transactionRunner: createRunner([
          { payload: { hotel_slug: SCOPE.propertySlug } },
          { payload: { hotel_slug: SCOPE.propertySlug } }
        ])
      }
    ),
    { code: "TENANT_STAFF_SESSION_DATA_CONFLICT" }
  );
});
