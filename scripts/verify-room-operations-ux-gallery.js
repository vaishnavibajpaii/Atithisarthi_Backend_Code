"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  roomImageMetadataSchema,
  roomImageReorderSchema,
  roomImageUpdateSchema
} = require("../validators/room-media");

const root = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const checks = [];
function verify(name, test) {
  test();
  checks.push(name);
  console.log(`✓ ${name}`);
}

const staffRoute = read("backend/routes/staff-room-management.js");
const publicRoute = read("backend/routes/public-room-booking.js");
const publicPresentation = read("backend/utils/public-room-presentation.js");
const migration = read("backend/scripts/upgrade-room-operations-ux-gallery.sql");
const task3StorageCompatibility = read(
  "backend/scripts/task3g-room-image-storage-path-compatibility.sql"
);
const rollback = read("backend/scripts/rollback-room-operations-ux-gallery.sql");
const staffHtml = read("frontend/staff-orders.html");
const staffController = read("frontend/js/staff-orders.js");
const managerController = read("frontend/js/room-operations-manager.js");
const inventoryController = read("frontend/js/room-inventory-manager.js");
const publicController = read("frontend/js/main.js");
const publicHtml = read("frontend/index.html");
const managerCss = read("frontend/css/room-operations-manager.css");
const publicCss = read("frontend/css/style.css");

verify("Manager authorization is installed before inventory and media routes", () => {
  const gate = staffRoute.indexOf("router.use(requireStaffManagerAccess)");
  assert(gate > 0);
  for (const marker of ['router.get("/inventory"', 'router.get("/media/', 'router.post("/media/', 'router.patch("/media/', 'router.delete("/media/']) {
    assert(staffRoute.indexOf(marker) > gate, `${marker} must follow Manager authorization`);
  }
});

verify("Inventory is server-paginated, bounded, sortable, and hotel-scoped", () => {
  assert.match(staffRoute, /Math\.min\(100,[\s\S]*pageSize/);
  assert.match(staffRoute, /\.eq\("hotel_slug", hotelSlug\)/);
  assert.match(staffRoute, /\.range\(from, to\)/);
  assert.match(staffRoute, /sortColumns/);
});

verify("Room-image uploads validate actual type, byte dimensions, size, and tenant path", () => {
  assert.match(staffRoute, /ROOM_IMAGE_TYPES/);
  assert.match(staffRoute, /fileSize: 8 \* 1024 \* 1024/);
  assert.match(staffRoute, /getImageDimensions\(req\.file\.buffer, req\.file\.mimetype\)/);
  assert.match(staffRoute, /resolvePropertyStorageScope\(supabase, hotelSlug\)/);
  assert.match(staffRoute, /buildPropertyStoragePath\([\s\S]*propertyScope,[\s\S]*room-images/);
  assert.match(staffRoute, /cacheControl: "31536000"/);
});

verify("Manager image responses omit storage paths and use scoped mutations", () => {
  const mapperStart = staffRoute.indexOf("function mapRoomImage");
  const mapperEnd = staffRoute.indexOf("function roomGallerySchemaUnavailable", mapperStart);
  const mapper = staffRoute.slice(mapperStart, mapperEnd);
  assert(!mapper.includes("storage_path"));
  assert.match(staffRoute, /\.eq\("hotel_slug", scope\(req\)\)\.eq\(target\.column, target\.targetId\)/);
});

verify("Database model enforces one target, tenant ownership, path scope, active primary, RLS, and service-only RPCs", () => {
  for (const marker of [
    "room_images_exactly_one_target",
    "ROOM_IMAGE_HOTEL_SCOPE_MISMATCH",
    "ROOM_IMAGE_STORAGE_SCOPE_MISMATCH",
    "room_images_primary_active",
    "enable row level security",
    "revoke all on public.room_images from anon,authenticated",
    "ROOM_IMAGE_REORDER_SET_MISMATCH",
    "pg_advisory_xact_lock"
  ]) assert(migration.includes(marker), `Missing migration guard: ${marker}`);
  assert.match(migration, /grant execute on function public\.reorder_room_images[\s\S]*to service_role/);
  assert.match(migration, /grant execute on function public\.delete_room_image[\s\S]*to service_role/);
  assert.match(task3StorageCompatibility, /security invoker/);
  assert.match(task3StorageCompatibility, /v_canonical_prefix/);
  assert.match(task3StorageCompatibility, /v_legacy_prefix/);
  assert.match(task3StorageCompatibility, /ROOM_IMAGE_OWNER_NOT_VISIBLE/);
});

verify("Rollback signatures match the migration RPC signatures", () => {
  assert(rollback.includes("reorder_room_images(text,text,bigint,bigint[],text,text)"));
  assert(rollback.includes("delete_room_image(text,bigint,text,text)"));
  assert(rollback.includes("drop table if exists public.room_images"));
});

verify("Image metadata and reorder validators reject unsafe or ambiguous input", () => {
  assert(roomImageMetadataSchema.safeParse({ altText: "Lobby-facing deluxe room", caption: "", isPrimary: true, isActive: true }).success);
  assert(!roomImageMetadataSchema.safeParse({ altText: "x", unknown: true }).success);
  assert(!roomImageMetadataSchema.safeParse({ altText: "Valid alt", isPrimary: true, isActive: false }).success);
  assert(roomImageUpdateSchema.safeParse({ caption: "Updated caption" }).success);
  assert(!roomImageUpdateSchema.safeParse({}).success);
  assert(!roomImageReorderSchema.safeParse({ imageIds: [1, 1] }).success);
  assert(roomImageReorderSchema.safeParse({ imageIds: [2, 1] }).success);
});

verify("Public gallery loads active managed images only and preserves legacy arrays", () => {
  assert.match(publicRoute, /from\("room_images"\)[\s\S]*\.eq\("hotel_slug", hotelSlug\)\.eq\("is_active", true\)/);
  assert.match(publicRoute, /combinePublicRoomImages/);
  assert.match(publicPresentation, /room\.images_json/);
  assert.match(publicPresentation, /roomType\?\.images_json/);
  assert(!publicRoute.includes("storage_path"));
  assert.match(publicPresentation, /galleryImages,[\s\S]*primaryImage/);
});

verify("Room shell uses role-aware sections and reload-free deep links", () => {
  assert(staffHtml.includes('data-room-shell-view="inventory" data-staff-manager-only'));
  assert(staffHtml.includes('data-staff-room-operations-view="inventory" data-staff-manager-only'));
  assert(managerController.includes('url.searchParams.set("roomView", view)'));
  assert(managerController.includes("pushState"));
  assert(inventoryController.includes('window.addEventListener("popstate"'));
  assert(!inventoryController.includes("location.reload"));
  assert(!managerController.includes("location.reload"));
});

verify("Configuration is divided into Masters, Rates, and GST without changing existing form IDs", () => {
  for (const id of ["staffFloorForm", "staffRoomTypeManagerForm", "staffRoomAmenityForm", "staffRoomInventoryForm", "staffRatePlanForm", "staffRoomTaxSettingsForm", "staffRoomTaxRuleForm"]) {
    assert(staffHtml.includes(`id="${id}"`), `Missing existing/config form ${id}`);
  }
  for (const section of ["masters", "pricing", "tax"]) assert(staffHtml.includes(`data-room-config-view="${section}"`));
  assert(inventoryController.includes("renderProfessionalRoomConfigurationSection"));
});

verify("Manager inventory supplies filters, table/cards, details, pagination, and accessible image controls", () => {
  for (const id of ["staffManagerInventorySearch", "staffManagerInventoryFloor", "staffManagerInventoryType", "staffManagerInventoryStatus", "staffManagerInventoryTableBody", "staffManagerInventoryCards", "staffManagerInventoryPrev", "staffManagerInventoryNext", "staffManagerRoomDetailDialog", "staffManagerRoomImageUploadForm"]) {
    assert(staffHtml.includes(`id="${id}"`), `Missing inventory control ${id}`);
  }
  assert(inventoryController.includes("300)"));
  assert(inventoryController.includes("showModal()"));
  assert(inventoryController.includes("selectedRoomTrigger"));
  assert(managerCss.includes("@media (max-width: 720px)"));
});

verify("Public gallery supports count, thumbnails, keyboard, swipe, fullscreen, focus return, and booking handoff without autoplay", () => {
  assert(publicHtml.includes('id="publicRoomGalleryDialog"'));
  for (const marker of ["data-room-gallery-open", "ArrowLeft", "ArrowRight", "touchstart", "touchend", "requestFullscreen", "trigger?.focus", "openPublicRoomBookingForm(room)"]) {
    assert(publicController.includes(marker), `Missing public gallery behavior: ${marker}`);
  }
  assert(!publicController.includes("galleryAutoplay"));
  assert(publicCss.includes(".public-room-gallery-stage"));
  assert(publicCss.includes(":focus-visible"));
  assert(publicCss.includes("prefers-reduced-motion"));
});

verify("Room controller remains loaded after the existing shared and Room Operations controllers", () => {
  const staff = staffHtml.indexOf('src="js/staff-orders.js"');
  const manager = staffHtml.indexOf('src="js/room-operations-manager.js"');
  const inventory = staffHtml.indexOf('src="js/room-inventory-manager.js"');
  assert(staff > 0 && manager > staff && inventory > manager);
  assert(staffController.includes("window.openProfessionalRoomDeepLink"));
});

console.log(`\nRoom Operations UX/gallery verification passed (${checks.length}/${checks.length}).`);
console.log("This verifier is source-only and made no database writes.");
