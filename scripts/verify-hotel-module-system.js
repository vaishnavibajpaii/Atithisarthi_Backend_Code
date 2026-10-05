const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  buildHotelFeatureSettingsRow,
  isHotelFeatureEnabled,
  normalizeHotelFeatureConfig
} = require("../utils/hotel-feature-settings");
const {
  calculateAdr,
  calculateCombinedRevenue,
  calculateOccupancyRate,
  calculateOverlappingRoomNights
} = require("../utils/hotel-report-accounting");
const { requireHotelFeature } = require("../middleware/require-hotel-feature");

const root = path.resolve(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const restaurantOnly = normalizeHotelFeatureConfig({
  hotel_slug: "restaurant-a",
  enable_food_module: true,
  enable_room_module: false,
  enable_food_ordering: true,
  enable_room_booking: true,
  enable_room_service: true,
  enable_food_reports: true,
  enable_room_reports: true,
  enable_combined_reports: true,
  enable_combined_billing: true
});
assert.equal(restaurantOnly.businessType, "restaurant_only");
assert.equal(restaurantOnly.canUseFood, true);
assert.equal(restaurantOnly.canUseRooms, false);
assert.equal(restaurantOnly.enableRoomBooking, false);
assert.equal(restaurantOnly.canUseRoomService, false);
assert.equal(restaurantOnly.canUseCombinedReports, false);

const hotelOnly = normalizeHotelFeatureConfig({
  hotel_slug: "hotel-b",
  enable_food_module: false,
  enable_room_module: true,
  enable_food_ordering: true,
  enable_room_booking: true,
  enable_room_service: true,
  enable_food_reports: true,
  enable_room_reports: true,
  enable_combined_reports: true
});
assert.equal(hotelOnly.businessType, "hotel_only");
assert.equal(hotelOnly.canUseFood, false);
assert.equal(hotelOnly.canUseRooms, true);
assert.equal(hotelOnly.canUseFoodReports, false);
assert.equal(hotelOnly.canUseRoomReports, true);
assert.equal(hotelOnly.canUseRoomService, false);

const combined = normalizeHotelFeatureConfig({
  hotel_slug: "combined-c",
  enable_food_module: true,
  enable_room_module: true,
  enable_food_ordering: true,
  enable_room_booking: true,
  enable_room_service: true,
  enable_food_reports: true,
  enable_room_reports: true,
  enable_combined_reports: true,
  enable_combined_billing: true
});
assert.equal(combined.businessType, "hotel_restaurant");
assert.equal(isHotelFeatureEnabled(combined, "combined_reports"), true);
assert.equal(isHotelFeatureEnabled(combined, "combined_billing"), true);

const normalizedRow = buildHotelFeatureSettingsRow({
  hotelSlug: "safe-hotel",
  enableFoodModule: false,
  enableRoomModule: true,
  enableFoodOrdering: true,
  enableRoomBooking: true,
  enableRoomService: true,
  enableFoodReports: true,
  enableRoomReports: true,
  enableCombinedReports: true,
  enableCombinedBilling: true
});
assert.equal(normalizedRow.enable_food_ordering, false);
assert.equal(normalizedRow.enable_food_reports, false);
assert.equal(normalizedRow.enable_room_service, false);
assert.equal(normalizedRow.enable_combined_reports, false);
assert.equal(normalizedRow.enable_combined_billing, false);

assert.equal(calculateOverlappingRoomNights({
  checkInDate: "2026-07-01",
  checkOutDate: "2026-07-05",
  fromDate: "2026-07-02",
  toDate: "2026-07-04"
}), 2);
assert.equal(calculateOccupancyRate(5, 10), 50);
assert.equal(calculateAdr(500, 5), 100);
assert.equal(calculateCombinedRevenue({
  foodNetRevenue: 100,
  roomNetRevenue: 250,
  roomServiceRevenue: 40
}), 350, "Room Service must not be added to combined revenue a second time");

const migration = read("backend/scripts/upgrade-hotel-module-features.sql");
const baseRoomSchema = read("backend/scripts/create-room-booking-tables.sql");
[
  "enable_food_module",
  "enable_room_module",
  "enable_food_reports",
  "enable_room_reports",
  "enable_combined_reports",
  "enable_combined_billing",
  "hotel_feature_setting_audit",
  "hotel_feature_settings_core_module_check",
  "hotel_feature_settings_combined_dependencies"
].forEach((contract) => assert(migration.includes(contract), `Missing migration contract: ${contract}`));
assert.match(migration, /^begin;/m, "Module migration must be transactional");
assert.match(migration, /^commit;/m, "Module migration must commit atomically");
assert(baseRoomSchema.includes("hotel_feature_setting_audit"), "Fresh installs must include feature audit history");

const staffRoute = read("backend/routes/staff.js");
[
  'router.get("/menu", requireStaffAuth, requireStaffFoodModule',
  'router.get("/kds/orders", requireStaffAuth, requireStaffFoodModule',
  'router.post("/orders", requireStaffAuth, requireStaffFoodModule',
  'router.post("/room-service-orders", requireStaffAuth, requireStaffRoomService',
  'food: "food_reports"',
  'rooms: "room_reports"',
  'combined: "combined_reports"',
  "Combined revenue = Food revenue (including Room Service once) + Room revenue."
].forEach((contract) => assert(staffRoute.includes(contract), `Missing staff contract: ${contract}`));

const staffRoomRoute = read("backend/routes/staff-room-booking.js");
assert(staffRoomRoute.includes("router.use(requireStaffRoomModule)"));
assert(staffRoomRoute.includes("requireStaffCombinedBilling"));

// Platform admins must be able to inspect all current and historical data even
// when no single hotel is selected. Mutations remain feature-gated.
const adminRoute = read("backend/routes/admin.js");
assert(adminRoute.includes("requireAdminFoodModule"));
assert(adminRoute.includes('router.get("/orders", async'));
assert(adminRoute.includes('router.get("/menu-items", async'));
assert(adminRoute.includes('router.get("/reservations", async'));
assert(!adminRoute.includes('router.get("/orders", requireAdminFoodModule'));
assert(!adminRoute.includes('router.get("/menu-items", requireAdminFoodModule'));
assert(!adminRoute.includes('router.get("/reservations", requireAdminFoodModule'));
assert(adminRoute.includes('router.patch("/orders/:id/status", requireAdminFoodModule'));
assert(adminRoute.includes('router.post("/menu-items", validateBody(menuItemSchema), requireAdminFoodModule'));

const adminRoomRoute = read("backend/routes/admin-room-booking.js");
assert(adminRoomRoute.includes('req.method === "GET" || req.method === "HEAD"'));
assert(adminRoomRoute.includes("return requireAdminRoomModule(req, res, next);"));
assert(adminRoomRoute.includes("requireAdminCombinedBilling"));

const publicRoomRoute = read("backend/routes/public-room-booking.js");
assert(publicRoomRoute.includes("ensureHotelFeatureEnabled"));
assert(publicRoomRoute.includes('featureKey: "rooms"'));

const publicContracts = [
  "backend/routes/orders.js",
  "backend/routes/reservations.js",
  "backend/routes/payments.js",
  "backend/routes/public.js"
];
publicContracts.forEach((file) => {
  assert(read(file).includes("ensureHotelFeatureEnabled"), `${file} does not enforce hotel features`);
});

const orderTrackingRoute = read("backend/routes/order-tracking.js");
assert(orderTrackingRoute.includes("requirePublicFoodModule"));
assert(orderTrackingRoute.includes("requirePublicFoodTrackingRead"));
assert(orderTrackingRoute.includes("env.tenantRuntimePublicOrderTrackingEnabled"));
assert(orderTrackingRoute.includes('router.get("/:hotelSlug/:orderId", trackingViewLimiter, requirePublicFoodTrackingRead'));
assert(orderTrackingRoute.includes('router.post("/:hotelSlug/:orderId/support-requests", trackingSupportLimiter, requirePublicFoodModule'));
assert(orderTrackingRoute.includes('router.post("/:hotelSlug/:orderId/add-items", requirePublicFoodModule'));

const staffHtml = read("frontend/staff-orders.html");
[
  'data-staff-requires-feature="food"',
  'data-staff-requires-feature="rooms"',
  'data-staff-requires-feature="food_reports"',
  'data-staff-requires-feature="room_reports"',
  'data-staff-requires-feature="combined_reports"',
  'id="staffReportsCsvBtn"',
  'id="staffReportsExcelBtn"'
].forEach((contract) => assert(staffHtml.includes(contract), `Missing staff UI contract: ${contract}`));

const staffJs = read("frontend/js/staff-orders.js");
[
  "function normalizeStaffFeatureConfig",
  "function getAllowedStaffViews",
  "function renderStaffRoomBusinessReport",
  "function renderStaffCombinedBusinessReport",
  "function downloadStaffBusinessReport",
  '/^[\\s\\u0000-\\u001f]*[=+\\-@]/',
  'canStaffUseFeature("room_service")'
].forEach((contract) => assert(staffJs.includes(contract), `Missing staff JS contract: ${contract}`));

const adminHtml = read("frontend/admin.html");
const adminJs = read("frontend/js/admin.js");
assert(adminHtml.includes("Hotel Modules and Features"));
assert(adminHtml.includes('id="hotelBusinessTypeInput"'));
assert(adminJs.includes("syncHotelFeatureDependencies"));
assert(adminJs.includes("Historical records will not be deleted"));

function createFeatureClient(data = {}) {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  return { data, error: null };
                }
              };
            }
          };
        }
      };
    }
  };
}

function createResponseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

async function verifyFeatureMiddleware() {
  let nextCalled = false;
  const enabledMiddleware = requireHotelFeature("food", {
    resolveHotelSlug: () => "restaurant-a",
    supabaseClient: createFeatureClient({ enable_food_module: true })
  });
  await enabledMiddleware({}, createResponseRecorder(), () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true, "Enabled hotel module must reach the controller");

  const disabledResponse = createResponseRecorder();
  const disabledMiddleware = requireHotelFeature("rooms", {
    resolveHotelSlug: () => "restaurant-a",
    supabaseClient: createFeatureClient({
      enable_food_module: true,
      enable_room_module: false
    })
  });
  await disabledMiddleware({}, disabledResponse, () => {
    throw new Error("Disabled hotel module reached the controller");
  });
  assert.equal(disabledResponse.statusCode, 403);
  assert.equal(disabledResponse.body?.code, "FEATURE_DISABLED");
  assert.equal(disabledResponse.body?.feature, "rooms");
}

verifyFeatureMiddleware()
  .then(() => {
    console.log("Verified restaurant-only, hotel-only, and combined dependency normalization.");
    console.log("Verified executable backend feature middleware, module-aware staff UI, report formulas, exports, audit migration, and Room Service single-count accounting.");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
