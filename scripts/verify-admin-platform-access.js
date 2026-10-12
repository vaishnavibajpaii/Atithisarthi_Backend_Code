"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function assertIncludes(source, value, label) {
  assert.ok(source.includes(value), `${label} must include ${value}`);
}

function assertNotIncludes(source, value, label) {
  assert.ok(!source.includes(value), `${label} must not include ${value}`);
}

function main() {
  const adminRoute = read("backend/routes/admin.js");
  const adminRoomRoute = read("backend/routes/admin-room-booking.js");
  const staffRoute = read("backend/routes/staff.js");
  const staffRoomRoute = read("backend/routes/staff-room-booking.js");
  const adminFrontend = read("frontend/js/admin.js");
  const adminHtml = read("frontend/admin.html");
  const packageJson = read("backend/package.json");

  assertIncludes(adminRoute, "router.use(requireAdminAuth);", "platform admin authentication");
  assertIncludes(adminRoomRoute, "router.use(requireAdminAuth);", "Room platform admin authentication");

  [
    'router.get("/orders", async',
    'router.get("/reservations", async',
    'router.get("/menu-items", async',
    'router.get("/menu-combos", async',
    'router.get("/menu-combos/:id", async'
  ].forEach((route) => assertIncludes(adminRoute, route, "cross-hotel Admin read route"));

  [
    'router.get("/orders", requireAdminFoodModule',
    'router.get("/reservations", requireAdminFoodModule',
    'router.get("/menu-items", requireAdminFoodModule',
    'router.get("/menu-combos", requireAdminFoodModule',
    'router.get("/menu-combos/:id", requireAdminFoodModule'
  ].forEach((route) => assertNotIncludes(adminRoute, route, "cross-hotel Admin read route"));

  [
    'router.patch("/orders/:id/status", requireAdminFoodModule',
    'router.patch("/orders/:id/billing", requireAdminFoodModule',
    'router.post("/menu-items", validateBody(menuItemSchema), requireAdminFoodModule',
    'router.patch("/menu-items/:id", validateBody(partialMenuItemSchema), requireAdminFoodModule',
    'router.delete("/menu-items/:id", requireAdminFoodModule',
    'router.post("/menu-combos", validateBody(comboMenuItemSchema), requireAdminFoodModule',
    'router.patch("/menu-combos/:id/active", requireAdminFoodModule',
    'router.delete("/menu-combos/:id", requireAdminFoodModule'
  ].forEach((route) => assertIncludes(adminRoute, route, "hotel-scoped Admin mutation"));

  assert.match(
    adminRoute,
    /const \{ hotelName, hotelSlug \} = req\.query;[\s\S]*?if \(hotelSlug\) \{\s*query = query\.eq\("hotel_slug", hotelSlug\);\s*\} else if \(hotelName\)/,
    "Orders and Reservations must prefer stable hotel-slug filtering"
  );

  assert.match(
    adminRoomRoute,
    /router\.use\(\(req, res, next\) => \{\s*if \(req\.method === "GET" \|\| req\.method === "HEAD"\) \{\s*return next\(\);\s*\}\s*return requireAdminRoomModule\(req, res, next\);\s*\}\);/,
    "Room reads must support platform-wide inspection while mutations remain module-gated"
  );
  assertIncludes(adminRoomRoute, 'router.get("/room-types", async', "Admin Room Type list");
  assertIncludes(adminRoomRoute, 'router.get("/rooms", async', "Admin Room list");
  assertIncludes(adminRoomRoute, 'router.get("/bookings", async', "Admin Room Booking list");
  assertIncludes(adminRoomRoute, "requireAdminCombinedBilling", "Admin combined billing guard");

  assert.match(
    adminFrontend,
    /function buildUrl\(endpoint\) \{[\s\S]*?params\.set\("hotelSlug", hotelSlug\);[\s\S]*?params\.set\("hotelName", hotelName\);/,
    "Admin shared list query must send stable slug plus compatibility name"
  );

  [
    'buildUrl("orders")',
    'buildUrl("reservations")',
    'buildUrl("inquiries")',
    '`${API_BASE}/room-booking/room-types${queryString}`',
    '`${API_BASE}/room-booking/rooms${queryString}`',
    '`${API_BASE}/room-booking/bookings${bookingQueryString}`',
    '`${API_BASE}/menu-items?hotelSlug=${encodeURIComponent(hotelSlug)}`',
    '`${API_BASE}/menu-combos?hotelSlug=${encodeURIComponent(hotelSlug)}`'
  ].forEach((contract) => assertIncludes(adminFrontend, contract, "Admin panel loader"));

  [
    'data-tab="orders"',
    'data-tab="reservations"',
    'data-tab="rooms"',
    'data-tab="menu-items"',
    'data-tab="menu-combos"'
  ].forEach((tab) => assertIncludes(adminHtml, tab, "Admin panel tab"));

  assertIncludes(staffRoute, "requireStaffFoodModule", "Staff food scope isolation");
  assertIncludes(staffRoomRoute, "router.use(requireStaffRoomModule)", "Staff Room scope isolation");
  assert.match(
    packageJson,
    /"verify:admin-platform-access":\s*"node scripts\/verify-admin-platform-access\.js"/,
    "package.json Admin access verifier"
  );

  console.log("Admin platform access verification passed.");
  console.log("Verified all-hotel reads, stable hotel filtering, guarded mutations, and unchanged Staff tenant isolation.");
}

main();
