"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const checks = [];

function verify(name, work) {
  work();
  checks.push(name);
  process.stdout.write(`✓ ${name}\n`);
}

const publicWriters = Object.freeze([
  "backend/routes/contact-submissions.js",
  "backend/routes/inquiries.js",
  "backend/routes/order-tracking.js",
  "backend/routes/orders.js",
  "backend/routes/public-qr.js",
  "backend/routes/public-room-booking.js",
  "backend/routes/reservations.js",
  "backend/routes/testimonials.js"
]);
const staffWriters = Object.freeze([
  "backend/routes/staff.js",
  "backend/routes/staff-food-order-bill.js",
  "backend/routes/staff-notifications.js",
  "backend/routes/staff-qr-corrections.js",
  "backend/routes/staff-qr-management.js",
  "backend/routes/staff-room-booking.js",
  "backend/routes/staff-room-checkout-bill.js",
  "backend/routes/staff-room-management.js",
  "backend/routes/staff-tables.js"
]);

verify("Write runtime is explicitly gated and represented in readiness", () => {
  const envSource = read("backend/config/env.js");
  const serverSource = read("backend/server.js");
  assert.match(envSource, /TENANT_RUNTIME_WRITES_ENABLED/);
  assert.match(serverSource, /tenant_runtime_writes/);
  assert.match(serverSource, /tenantRuntimeWritesReady/);
});

verify("Every reviewed public writer uses the restricted mutation boundary", () => {
  for (const file of publicWriters) {
    assert.match(read(file), /getTenantMutationClient/, `${file} has no tenant mutation boundary`);
  }
});

verify("Every reviewed staff writer uses a restricted or injected mutation boundary", () => {
  for (const file of staffWriters) {
    assert.match(
      read(file),
      /getStaffTenantMutationClient|tenantMutationDatabase|resolveDatabaseClient/,
      `${file} has no staff tenant mutation boundary`
    );
  }
});

verify("Staff post-login audit write uses canonical restricted ownership", () => {
  const source = read("backend/routes/staff.js");
  assert.match(source, /loginAuditDatabase = env\.tenantRuntimeWritesEnabled/);
  assert.match(source, /createTenantMutationClient\(\{[\s\S]*matchedStaffAccess\.tenant_id/);
  assert.match(source, /propertyId: matchedStaffAccess\.property_id/);
  assert.match(source, /propertySlug: matchedStaffAccess\.hotel_slug/);
});

verify("Notification side effects inherit the route-scoped database client", () => {
  const notificationSource = read("backend/utils/notifications.js");
  for (const file of [
    "backend/routes/contact-submissions.js",
    "backend/routes/inquiries.js",
    "backend/routes/reservations.js",
    "backend/routes/testimonials.js"
  ]) {
    assert.match(read(file), /createNotificationEventSafely\(\{[\s\S]*databaseClient: database/);
  }
  assert.match(notificationSource, /input\.databaseClient \|\| supabase/);
});

verify("Restricted adapter fails closed on tables, ownership columns, and RPCs", () => {
  const source = read("backend/utils/tenant-mutation-client.js");
  assert.match(source, /TENANT_TABLES = new Set/);
  assert.match(source, /TENANT_RPCS = new Set/);
  assert.match(source, /TENANT_MUTATION_TABLE_FORBIDDEN/);
  assert.match(source, /TENANT_MUTATION_OWNERSHIP_IMMUTABLE/);
  assert.match(source, /TENANT_MUTATION_UNSCOPED_DELETE/);
  assert.match(source, /TENANT_RPC_FORBIDDEN/);
  assert.match(source, /withTenantTransaction/);
});

verify("Restricted transactions require non-bypass runtime role and local scope", () => {
  const source = read("backend/utils/tenant-database.js");
  assert.match(source, /identity\.rolname !== "app_tenant_runtime"/);
  assert.match(source, /identity\.rolsuper !== false/);
  assert.match(source, /identity\.rolbypassrls !== false/);
  assert.match(source, /set_config\('app\.tenant_id'/);
  assert.match(source, /set_config\('app\.property_id'/);
});

verify("Privileged bypass writers remain limited to explicit boundaries", () => {
  const qrSource = read("backend/routes/public-qr.js");
  const paymentSource = read("backend/routes/payments.js");
  const adminSource = read("backend/routes/admin.js");
  assert.match(qrSource, /function recordSecurityEvent/);
  assert.match(qrSource, /supabase\.from\("qr_security_events"\)\.insert/);
  assert.match(paymentSource, /PaymentIntentStore/);
  assert.match(paymentSource, /paymentIntentStore = new PaymentIntentStore\(supabase\)/);
  assert.match(adminSource, /requireAdminAuth|requirePlatformAdmin/);
});

verify("Room-image canonical paths preserve legacy compatibility without FORCE RLS", () => {
  const migration = read("backend/scripts/task3g-room-image-storage-path-compatibility.sql");
  assert.match(migration, /v_canonical_prefix/);
  assert.match(migration, /v_legacy_prefix/);
  assert.match(migration, /ROOM_IMAGE_OWNER_NOT_VISIBLE/);
  assert.doesNotMatch(migration, /force row level security/i);
});

verify("Synthetic write canary is guarded, side-effect isolated, and self-cleaning", () => {
  const source = read("backend/scripts/verify-tenant-runtime-writes.js");
  assert.match(source, /TASK3G_WRITE_RUNTIME_SYNTHETIC/);
  assert.match(source, /NOTIFICATION_DELIVERY_ENABLED = "false"/);
  assert.match(source, /PAYMENT_WEBHOOK_WORKER_ENABLED = "false"/);
  assert.match(source, /TEST_TASK3G_/);
  assert.match(source, /verifyCrossTenantIsolation/);
  assert.match(source, /verifyCrossTenantParentBinding/);
  assert.match(source, /verifyAtomicRollback/);
  assert.match(source, /finally/);
  assert.match(source, /cleanupFixture/);
  const liveSource = read("backend/scripts/verify-tenant-runtime-writes-live.js");
  assert.match(liveSource, /TASK3G_LIVE_HTTP_WRITES_SYNTHETIC/);
  assert.match(liveSource, /requireEnabledReadyCheck\(readiness, "tenant_runtime_writes"\)/);
  assert.match(liveSource, /TEST_TASK3G_HTTP_/);
  assert.match(liveSource, /notificationDelivery: "DISABLED"/);
  assert.match(liveSource, /cleanupFixture/);
});

process.stdout.write(`\nTenant write-boundary verification passed (${checks.length}/${checks.length}).\n`);
process.stdout.write("This verifier is source-only and made no database writes.\n");
