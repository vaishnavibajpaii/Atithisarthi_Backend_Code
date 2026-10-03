const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL ||= "https://tenant-context.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const {
  attachTenantRequestContext,
  buildTenantRequestContext,
  getTenantRequestScope
} = require("../utils/tenant-request-context");

const TENANT_ID = "ce77cfbd-40ea-4257-b78f-756ef5a0ec56";

function canonicalInput(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    propertyId: "1",
    propertySlug: "hotel-sai-raj",
    source: "public_hotel_access",
    ...overrides
  };
}

test("builds an immutable canonical tenant request context", () => {
  const context = buildTenantRequestContext(canonicalInput());

  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.tenant), true);
  assert.equal(Object.isFrozen(context.property), true);
  assert.equal(Object.isFrozen(context.metadata), true);
  assert.deepEqual(context, {
    tenant: { id: TENANT_ID },
    property: { id: "1", slug: "hotel-sai-raj" },
    metadata: { source: "public_hotel_access" }
  });
});

test("rejects malformed canonical ownership and source values", () => {
  assert.throws(
    () => buildTenantRequestContext(canonicalInput({ tenantId: "client-value" })),
    { code: "TENANT_CONTEXT_INVALID" }
  );
  assert.throws(
    () => buildTenantRequestContext(canonicalInput({ propertyId: "0" })),
    { code: "TENANT_CONTEXT_INVALID" }
  );
  assert.throws(
    () => buildTenantRequestContext(canonicalInput({ propertySlug: "../other" })),
    { code: "TENANT_REQUEST_CONTEXT_INVALID" }
  );
  assert.throws(
    () => buildTenantRequestContext(canonicalInput({ source: "client/header" })),
    { code: "TENANT_REQUEST_CONTEXT_INVALID" }
  );
});

test("attaches non-enumerable non-writable request fields", () => {
  const req = {};
  attachTenantRequestContext(req, canonicalInput());

  assert.deepEqual(getTenantRequestScope(req), {
    tenantId: TENANT_ID,
    propertyId: "1",
    propertySlug: "hotel-sai-raj",
    source: "public_hotel_access"
  });
  assert.equal(Object.keys(req).includes("tenant"), false);
  assert.equal(Object.getOwnPropertyDescriptor(req, "tenant").writable, false);
  assert.equal(Object.getOwnPropertyDescriptor(req, "property").configurable, false);
});

test("allows an identical resolver result but rejects conflicting context", () => {
  const req = {};
  attachTenantRequestContext(req, canonicalInput());
  assert.doesNotThrow(() => attachTenantRequestContext(req, canonicalInput()));
  assert.throws(
    () => attachTenantRequestContext(
      req,
      canonicalInput({
        tenantId: "01d26c08-4fea-44f2-837a-61f546aa31c2",
        propertyId: "2",
        propertySlug: "the-food-garden"
      })
    ),
    { code: "TENANT_REQUEST_CONTEXT_CONFLICT" }
  );
});

test("rejects incomplete pre-existing request tenant fields", () => {
  const req = { tenant: { id: TENANT_ID } };
  assert.throws(
    () => attachTenantRequestContext(req, canonicalInput()),
    { code: "TENANT_REQUEST_CONTEXT_CONFLICT" }
  );
});

test("fails closed when request context is missing", () => {
  assert.throws(
    () => getTenantRequestScope({}),
    { code: "TENANT_REQUEST_CONTEXT_MISSING" }
  );
});
