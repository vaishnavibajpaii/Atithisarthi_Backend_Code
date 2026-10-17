const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
}

function requirePattern(source, pattern, label) {
  if (!pattern.test(source)) {
    throw new Error(`Missing ${label}`);
  }
}

function main() {
  const routeSource = read("routes/staff.js");
  const publicOrderRouteSource = read("routes/orders.js");
  const migrationSource = read("scripts/create-staff-active-table-order-guard.sql");
  const task6MigrationSource = read("scripts/task6-c-order-atomic-idempotency.sql");

  requirePattern(
    routeSource,
    /const STAFF_ACTIVE_TABLE_ORDER_STATUSES = \["new", "confirmed", "preparing"\];/m,
    "documented active table status policy"
  );
  requirePattern(
    routeSource,
    /router\.get\("\/orders\/active-table", requireStaffAuth,[\s\S]*fetchStaffActiveTableOrder\([\s\S]*hotelSlug,[\s\S]*tableNumber/m,
    "authenticated hotel-scoped active table lookup"
  );
  requirePattern(
    routeSource,
    /executeTask6OrderAtomic\([\s\S]*ORDER_CREATION_SCOPES\.STAFF_TABLE[\s\S]*if \(conflict\)[\s\S]*status\(409\)[\s\S]*code: "TABLE_HAS_ACTIVE_ORDER"/m,
    "Task 6 atomic staff order conflict response"
  );
  requirePattern(
    routeSource,
    /code: "TASK6_ORDER_ATOMIC_CREATE_NOT_READY"/m,
    "fail-closed missing Task 6 migration response"
  );
  requirePattern(
    publicOrderRouteSource,
    /executeTask6OrderAtomic\([\s\S]*ORDER_CREATION_SCOPES\.PUBLIC[\s\S]*code === "TABLE_HAS_ACTIVE_ORDER"[\s\S]*status\(409\)/m,
    "atomic public root-order conflict response"
  );
  requirePattern(
    task6MigrationSource,
    /pg_advisory_xact_lock\([\s\S]*get_staff_active_table_order\([\s\S]*TABLE_HAS_ACTIVE_ORDER/m,
    "Task 6 transaction-scoped table lock and conflict lookup"
  );
  requirePattern(
    task6MigrationSource,
    /task6_order_snapshot_valid\([\s\S]*insert into public\.orders[\s\S]*returning \* into v_created/m,
    "Task 6 validated atomic order insert"
  );
  requirePattern(
    migrationSource,
    /pg_advisory_xact_lock\(hashtext\(v_hotel_key\), hashtext\(v_table_key\)\)/m,
    "transaction-scoped normalized hotel/table lock"
  );
  requirePattern(
    migrationSource,
    /orders\.parent_order_id is null/m,
    "QR add-on exclusion"
  );
  requirePattern(
    migrationSource,
    /create trigger orders_one_active_root_dine_in_table_guard[\s\S]*before insert or update of hotel_slug, table_number, order_type, parent_order_id, status[\s\S]*execute function public\.enforce_one_active_root_dine_in_order\(\)/m,
    "cross-channel active root-order trigger"
  );
  requirePattern(
    migrationSource,
    /enforce_one_active_root_dine_in_order[\s\S]*pg_advisory_xact_lock[\s\S]*orders\.parent_order_id is null[\s\S]*errcode = '23505'/m,
    "race-safe trigger conflict enforcement"
  );
  requirePattern(
    migrationSource,
    /coalesce\(orders\.status, 'new'\)[\s\S]*in \('new', 'confirmed', 'preparing'\)/m,
    "database active status policy"
  );
  requirePattern(
    migrationSource,
    /insert into public\.orders[\s\S]*returning \* into v_created_order/m,
    "atomic order insert"
  );
  requirePattern(
    migrationSource,
    /when unique_violation then[\s\S]*get_staff_active_table_order[\s\S]*'TABLE_HAS_ACTIVE_ORDER'/m,
    "cross-channel unique conflict translation"
  );
  requirePattern(
    migrationSource,
    /revoke all on function public\.create_staff_table_order_if_available\(jsonb\) from anon, authenticated;[\s\S]*grant execute on function public\.create_staff_table_order_if_available\(jsonb\) to service_role;/m,
    "service-role-only create guard permissions"
  );

  console.log("Staff active table ordering verification passed.");
  console.log("Verified active statuses, tenant-scoped lookup, atomic locking, QR add-on exclusion, and conflict responses.");
}

main();
