"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function countMatches(source, pattern) {
  return (source.match(pattern) || []).length;
}

function assertIncludes(source, text, label) {
  assert.ok(source.includes(text), `${label} must include ${text}`);
}

function assertRouteOverlapGuard({ label, source, createRouteMarker }) {
  assertIncludes(source, "../utils/room-availability", `${label} shared availability import`);
  assertIncludes(source, "async function hasBlockingBooking", `${label} overlap helper`);
  assertIncludes(source, "applyActiveBookingOverlapFilter", `${label} shared overlap filter`);
  assertIncludes(source, "isRoomBookingOverlapError(error)", `${label} database overlap error handler`);
  assertIncludes(source, "return res.status(409).json", `${label} conflict response`);
  assertIncludes(source, "code: ROOM_BOOKING_CONFLICT_CODE", `${label} stable conflict code`);
  assertIncludes(source, createRouteMarker, `${label} create route`);
}

function main() {
  const migration = read("backend/scripts/create-room-booking-tables.sql");
  const availabilityUtil = read("backend/utils/room-availability.js");
  const publicRoute = read("backend/routes/public-room-booking.js");
  const adminRoute = read("backend/routes/admin-room-booking.js");
  const staffRoute = read("backend/routes/staff-room-booking.js");
  const conflictContract = read("backend/scripts/room-booking-conflict-contract.md");
  const validators = read("backend/validators/rooms.js");
  const packageJson = read("backend/package.json");
  const publicFrontend = read("frontend/js/main.js");
  const adminFrontend = read("frontend/js/admin.js");
  const staffFrontend = read("frontend/js/staff-orders.js");

  assertIncludes(migration, "create extension if not exists btree_gist;", "room booking migration");
  assertIncludes(migration, "room_bookings_no_active_overlap", "room booking migration");
  assertIncludes(migration, "exclude using gist", "room booking migration");
  assertIncludes(migration, "daterange(check_in_date, check_out_date, '[)')", "room booking migration");
  assertIncludes(migration, "where (booking_status in ('pending', 'confirmed', 'checked_in'))", "room booking migration");
  assertIncludes(migration, "constraint room_bookings_date_range_check check (check_out_date > check_in_date)", "room booking migration");

  assertIncludes(
    availabilityUtil,
    'const ACTIVE_BLOCKING_BOOKING_STATUSES = ["pending", "confirmed", "checked_in"];',
    "shared room availability utility"
  );
  assertIncludes(
    availabilityUtil,
    'const ROOM_STATUSES_BLOCKING_BOOKING = ["maintenance", "inactive"];',
    "shared room availability utility"
  );
  assertIncludes(availabilityUtil, 'const ROOM_BOOKING_CONFLICT_CODE = "ROOM_ALREADY_BOOKED";', "shared room availability utility");
  assertIncludes(availabilityUtil, "function applyActiveBookingOverlapFilter", "shared room availability utility");
  assertIncludes(availabilityUtil, '.lt("check_in_date", checkOutDate)', "shared room availability utility");
  assertIncludes(availabilityUtil, '.gt("check_out_date", checkInDate)', "shared room availability utility");
  assertIncludes(availabilityUtil, "function isRoomBookingOverlapError", "shared room availability utility");

  assertRouteOverlapGuard({
    label: "public room booking route",
    source: publicRoute,
    createRouteMarker: '"/:slug/bookings"'
  });
  assertRouteOverlapGuard({
    label: "admin room booking route",
    source: adminRoute,
    createRouteMarker: 'router.post("/bookings"'
  });
  assertRouteOverlapGuard({
    label: "staff room booking route",
    source: staffRoute,
    createRouteMarker: 'router.post("/bookings"'
  });

  assertIncludes(publicRoute, '.eq("hotel_slug", hotelSlug)', "public legacy tenant scope");
  assertIncludes(publicRoute, "getTenantMutationClient(req, supabase)", "public restricted mutation boundary");
  assertIncludes(publicRoute, "getTenantRequestScope(req)", "public canonical tenant context");
  assertIncludes(publicRoute, "tenant_id: scope.tenantId", "public canonical tenant ownership");
  assertIncludes(publicRoute, "property_id: scope.propertyId", "public canonical property ownership");
  assertIncludes(adminRoute, '.eq("hotel_slug", hotelSlug)', "admin tenant scope");
  assertIncludes(staffRoute, "const hotelSlug = normalizeText(req.staffHotelSlug, 120);", "staff tenant scope");
  assertIncludes(staffRoute, '.eq("hotel_slug", hotelSlug)', "staff tenant scope");

  assertIncludes(publicRoute, '.eq("status", "available")', "public operational room status filter");
  assertIncludes(adminRoute, "ROOM_STATUSES_BLOCKING_BOOKING", "admin operational room status guard");
  assertIncludes(staffRoute, "ROOM_STATUSES_BLOCKING_BOOKING", "staff operational room status guard");

  assertIncludes(validators, "function refineDateRange", "room validators");
  assertIncludes(validators, "Check-out date must be after check-in date", "room validators");
  assertIncludes(validators, "const bookingStatusSchema = z.enum", "room validators");
  assertIncludes(validators, "const bookingSourceSchema = z.enum", "room validators");

  const publicConflictBlocks = countMatches(publicRoute, /ROOM_BOOKING_CONFLICT_MESSAGE/g);
  const publicConflictCodeBlocks = countMatches(publicRoute, /ROOM_BOOKING_CONFLICT_CODE/g);
  assert.ok(publicConflictBlocks >= 3, "public route should use a generic conflict message in availability/create conflict paths");
  assert.ok(publicConflictCodeBlocks >= 3, "public route should include a stable ROOM_ALREADY_BOOKED conflict code in availability/create conflict paths");
  assert.doesNotMatch(
    publicRoute,
    /conflict[\s\S]{0,300}guest_(name|phone|email)|guest(Name|Phone|Email)[\s\S]{0,300}conflict/,
    "public conflict responses must not expose guest data"
  );

  assertIncludes(conflictContract, "ROOM_ALREADY_BOOKED", "room booking conflict contract");
  assertIncludes(conflictContract, "HTTP `409 Conflict`", "room booking conflict contract");
  assertIncludes(conflictContract, "Frontend code must check `code === \"ROOM_ALREADY_BOOKED\"`", "room booking conflict contract");
  assertIncludes(conflictContract, "Public responses must not expose", "room booking conflict contract");
  assertIncludes(conflictContract, "Do not implement separate online and offline room inventory.", "room booking conflict contract");

  assertIncludes(publicFrontend, 'const ROOM_BOOKING_CONFLICT_CODE = "ROOM_ALREADY_BOOKED";', "public room booking frontend conflict handling");
  assertIncludes(publicFrontend, "function getRoomBookingErrorMessage", "public room booking frontend conflict handling");
  assertIncludes(publicFrontend, 'error.code = result?.code || "";', "public room booking frontend conflict handling");
  assertIncludes(publicFrontend, 'setPublicBookingStatus(getRoomBookingErrorMessage(error), "error");', "public room booking frontend conflict handling");

  assertIncludes(adminFrontend, "function getAdminRoomBookingErrorMessage", "admin room booking frontend conflict handling");
  assertIncludes(adminFrontend, 'error.code = data.code || "";', "admin room booking frontend conflict handling");
  assertIncludes(adminFrontend, "const message = getAdminRoomBookingErrorMessage(error);", "admin room booking frontend conflict handling");

  assertIncludes(staffFrontend, "function getStaffRoomBookingErrorMessage", "staff room booking frontend conflict handling");
  assertIncludes(staffFrontend, 'error.code = data.code || "";', "staff room booking frontend conflict handling");
  assertIncludes(staffFrontend, "setStaffRoomBookingStatus(getStaffRoomBookingErrorMessage(error), true);", "staff room booking frontend conflict handling");

  assert.match(
    packageJson,
    /"verify:room-double-booking-safety":\s*"node scripts\/verify-room-double-booking-safety\.js"/,
    "package.json must expose the double-booking safety verifier"
  );

  console.log("Room double-booking safety verification passed.");
  console.log("Verified DB overlap constraint, shared overlap helper, stable conflict codes, frontend conflict handling, tenant scoping, generic public conflicts, and date-range validation.");
  console.log("Advisory: route-specific room loading and response shaping remain separate; next safe step can focus on booking status/payment action permissions.");
}

main();
