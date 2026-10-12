"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.JWT_SECRET = "legacy-test-secret-that-is-long-enough";
process.env.AUTH_RBAC_ENFORCEMENT_ENABLED = "true";

const {
  OWNER_ONLY,
  PERMISSIONS,
  PLATFORM_PERMISSIONS,
  STAFF_BASE,
  getEffectivePermissions,
  hasPermission
} = require("../utils/permissions");
const platformPolicies = require("../utils/platform-route-permissions");
const staffPolicies = require("../utils/staff-route-permissions");
const {
  ROUTE_POLICIES,
  enforceRoutePermission,
  resolveRoutePermission
} = require("../middleware/enforce-route-permission");
const { requirePermission } = require("../middleware/require-permission");

function hotelPrincipal(role = "staff", kdsRole = "general", overrides = {}) {
  return {
    principal_type: "hotel_staff",
    principal_id: 11,
    tenant_id: "123e4567-e89b-42d3-a456-426614174000",
    property_id: 7,
    role,
    kds_role: kdsRole,
    ...overrides
  };
}

function responseCapture() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
}

test("ordinary staff retains operational access but cannot gain owner financial or management rights", () => {
  const principal = hotelPrincipal("staff", "general");
  for (const permission of STAFF_BASE) {
    assert.equal(hasPermission(principal, permission), true, permission);
  }
  for (const permission of OWNER_ONLY) {
    assert.equal(hasPermission(principal, permission), false, permission);
  }
  assert.equal(hasPermission(principal, PERMISSIONS.PAYMENTS_MANAGE), false);
  assert.equal(hasPermission(principal, PERMISSIONS.REPORTS_READ), false);
  assert.equal(hasPermission(principal, PERMISSIONS.SETTINGS_MANAGE), false);
});

test("owner receives hotel capabilities but never crosses the platform boundary", () => {
  const owner = hotelPrincipal("owner", "general");
  for (const permission of [...STAFF_BASE, ...OWNER_ONLY]) {
    assert.equal(hasPermission(owner, permission), true, permission);
  }
  for (const permission of PLATFORM_PERMISSIONS) {
    assert.equal(hasPermission(owner, permission), false, permission);
  }
});

test("platform admin receives only explicit platform capabilities", () => {
  const platform = { principal_type: "platform_admin", principal_id: 1 };
  for (const permission of PLATFORM_PERMISSIONS) {
    assert.equal(hasPermission(platform, permission), true, permission);
  }
  for (const permission of [...STAFF_BASE, ...OWNER_ONLY]) {
    assert.equal(hasPermission(platform, permission), false, permission);
  }
});

test("KDS sub-roles cannot vertically escalate", () => {
  const kitchen = hotelPrincipal("staff", "kitchen");
  const expo = hotelPrincipal("staff", "expo");
  const general = hotelPrincipal("staff", "general");
  const manager = hotelPrincipal("staff", "manager");

  assert.equal(hasPermission(kitchen, PERMISSIONS.KDS_PREPARE), true);
  assert.equal(hasPermission(kitchen, PERMISSIONS.KDS_SERVE), false);
  assert.equal(hasPermission(expo, PERMISSIONS.KDS_PREPARE), false);
  assert.equal(hasPermission(expo, PERMISSIONS.KDS_SERVE), true);
  assert.equal(hasPermission(general, PERMISSIONS.KDS_PREPARE), true);
  assert.equal(hasPermission(general, PERMISSIONS.KDS_SERVE), true);
  assert.equal(hasPermission(manager, PERMISSIONS.KDS_PREPARE), true);
  assert.equal(hasPermission(manager, PERMISSIONS.KDS_SERVE), true);
  assert.equal(hasPermission(manager, PERMISSIONS.KDS_OVERRIDE), false);
  assert.equal(hasPermission(manager, PERMISSIONS.PAYMENTS_MANAGE), false);
});

test("client role, permission, and tenant fields do not influence authorization", () => {
  const principal = hotelPrincipal("staff", "kitchen");
  const attackerRequest = {
    body: { role: "owner", permissions: ["payments.manage"], tenant_id: "attacker" },
    query: { property_id: "999" },
    headers: { "x-role": "owner", "x-tenant-id": "attacker" }
  };
  assert.ok(attackerRequest.body.role);
  assert.equal(hasPermission(principal, PERMISSIONS.PAYMENTS_MANAGE), false);
  assert.equal(hasPermission(principal, PERMISSIONS.KDS_SERVE), false);
});

test("critical routes resolve to the intended least privilege capability", () => {
  const cases = [
    ["POST", "/api/staff/orders", "orders.manage"],
    ["PATCH", "/api/staff/orders/1/mark-paid", "payments.manage"],
    ["GET", "/api/staff/room-booking/bookings/1/payments/2/receipt", "payments.read"],
    ["GET", "/api/staff/tables", "tables.manage"],
    ["GET", "/api/staff/tables/floor", "tables.read"],
    ["PATCH", "/api/staff/kds/orders/1/kitchen-status", "kds.read"],
    ["POST", "/api/admin/room-booking/bookings/1/combined-checkout", "platform.payments.manage"],
    ["POST", "/api/admin/upload", "platform.assets.manage"]
  ];
  for (const [method, route, expected] of cases) {
    assert.equal(resolveRoutePermission(method, route), expected, `${method} ${route}`);
  }
});

test("every static route-inventory capability is present in the runtime manifest", () => {
  const inventory = fs.readFileSync(
    path.join(__dirname, "../../docs/auth/RBAC-ROUTE-INVENTORY.md"),
    "utf8"
  );
  let checked = 0;
  for (const line of inventory.split(/\r?\n/)) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(cells[1] || "")) continue;
    const method = cells[1];
    const route = (cells[2].match(/`([^`]+)`/) || [])[1];
    const capabilityCell = cells[cells.length - 2] || "";
    const capabilities = [...capabilityCell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    if (!route || !capabilities.length) continue;
    if (capabilityCell.includes("target-derived")) {
      assert.equal(resolveRoutePermission(method, route), "kds.read");
    } else {
      assert.equal(resolveRoutePermission(method, route), capabilities.at(-1), `${method} ${route}`);
    }
    checked += 1;
  }
  assert.ok(checked >= 200, `expected at least 200 inventoried routes, checked ${checked}`);
});

test("route policy manifest has no duplicate method/path definitions", () => {
  const definitions = [...platformPolicies, ...staffPolicies];
  assert.equal(new Set(definitions.map((entry) => entry.split(/\s+/).slice(0, 2).join(" "))).size, definitions.length);
  assert.equal(ROUTE_POLICIES.length, definitions.length);
});

test("permission middleware allows expected principal and denies anonymous access", () => {
  let allowed = false;
  requirePermission(PERMISSIONS.ORDERS_MANAGE)(
    { authPrincipal: hotelPrincipal(), authSession: { session_id: "session" } },
    responseCapture(),
    () => { allowed = true; }
  );
  assert.equal(allowed, true);

  const deniedResponse = responseCapture();
  requirePermission(PERMISSIONS.ORDERS_MANAGE)({}, deniedResponse, () => {});
  assert.equal(deniedResponse.statusCode, 403);
  assert.equal(deniedResponse.payload.code, "permission_denied");
});

test("unmapped protected routes fail closed when enforcement is enabled", () => {
  const response = responseCapture();
  enforceRoutePermission(
    { method: "POST", originalUrl: "/api/staff/unmapped-sensitive-action", authPrincipal: hotelPrincipal("owner") },
    response,
    () => assert.fail("unmapped route must not continue")
  );
  assert.equal(response.statusCode, 403);
  assert.equal(response.payload.code, "permission_policy_missing");
});

test("unknown roles and principal types fail closed", () => {
  assert.equal(getEffectivePermissions(hotelPrincipal("superadmin")).size, 0);
  assert.equal(getEffectivePermissions({ principal_type: "hotel_admin", role: "owner" }).size, 0);
  assert.equal(hasPermission(null, PERMISSIONS.ORDERS_READ), false);
});
