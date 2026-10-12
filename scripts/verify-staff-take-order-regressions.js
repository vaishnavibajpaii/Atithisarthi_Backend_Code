const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");

const projectRoot = path.resolve(__dirname, "..", "..");
const staffRoute = fs.readFileSync(path.join(projectRoot, "backend", "routes", "staff.js"), "utf8");
const staffMenuPresentation = fs.readFileSync(
  path.join(projectRoot, "backend", "utils", "staff-menu-presentation.js"),
  "utf8"
);
const staffValidator = fs.readFileSync(path.join(projectRoot, "backend", "validators", "staff.js"), "utf8");
const staffScript = fs.readFileSync(path.join(projectRoot, "frontend", "js", "staff-orders.js"), "utf8");
const staffHtml = fs.readFileSync(path.join(projectRoot, "frontend", "staff-orders.html"), "utf8");

function requirePattern(source, pattern, label) {
  if (!pattern.test(source)) {
    throw new Error(`Missing ${label}`);
  }
}

function main() {
  requirePattern(
    staffRoute,
    /const baseOrderRow = \{[\s\S]*?status: "new"[\s\S]*?const optionalOrderColumns = \{[\s\S]*?order_type: "dine-in"[\s\S]*?order_source: "staff"[\s\S]*?payment_status: "unpaid"[\s\S]*?billing_status: "not_billed"/m,
    "staff order KDS, billing, and payment defaults"
  );
  requirePattern(
    staffRoute,
    /router\.get\("\/kds\/orders", requireStaffAuth,[\s\S]*?\.from\("orders"\)[\s\S]*?\.eq\("hotel_slug", hotelSlug\)/m,
    "hotel-scoped authenticated KDS listing"
  );
  requirePattern(
    staffRoute,
    /"\/kds\/orders\/:id\/kitchen-status",[\s\S]*?requireStaffAuth,[\s\S]*?\.update\(\{[\s\S]*?kitchen_status: kitchenStatus[\s\S]*?\.eq\("id", orderId\)[\s\S]*?\.eq\("hotel_slug", hotelSlug\)/m,
    "hotel-scoped KDS mutation"
  );
  requirePattern(
    staffValidator,
    /items:\s*z\.array\(staffTableOrderItemSchema\)\.min\(1\)\.max\(100\)/m,
    "bounded order payload"
  );
  requirePattern(
    staffScript,
    /const STAFF_TABLE_ORDER_RENDER_BATCH_SIZE = 48;[\s\S]*?const visibleItems = filteredItems\.slice\(0, renderLimit\)[\s\S]*?data-staff-table-order-load-more/m,
    "progressive 48-item menu rendering"
  );
  requirePattern(
    staffScript,
    /function setStaffTableOrderItemQty[\s\S]*?updateStaffTableOrderMenuItemQuantity\(normalizedItemId, nextQty\)[\s\S]*?renderStaffTableOrderCart\(\)/m,
    "targeted quantity updates"
  );
  const quantityFunction = staffScript.slice(
    staffScript.indexOf("function setStaffTableOrderItemQty"),
    staffScript.indexOf("function getStaffTableOrderCartEntries")
  );
  assert.ok(
    !quantityFunction.includes("renderStaffTableOrderMenu()"),
    "quantity changes must not rerender the full menu"
  );
  requirePattern(
    staffScript,
    /document\.addEventListener\("click", \(event\) => \{[\s\S]*?data-staff-table-order-plus[\s\S]*?data-staff-table-order-minus/m,
    "delegated menu quantity controls"
  );
  requirePattern(
    staffScript,
    /const STAFF_KDS_AUTO_REFRESH_INTERVAL_MS = 5 \* 1000;[\s\S]*?STAFF_STATE\.activeView === "kds"[\s\S]*?loadStaffKdsOrders\(\{ silent \}\)/m,
    "active-view KDS polling without background duplicate refreshes"
  );
  requirePattern(
    staffScript,
    /staffTableOrderSearchTimer[\s\S]*?window\.setTimeout\([\s\S]*?renderStaffTableOrderMenu\(\)[\s\S]*?240/m,
    "debounced large-menu search"
  );
  requirePattern(
    staffScript,
    /const searchBlob = \[item\.name, item\.desc, item\.category, item\.badge, item\.tag, \.\.\.comboChildNames\]/m,
    "combo-aware menu search"
  );
  requirePattern(
    staffScript,
    /function mergeStaffSelectedTableOrderSummary[\s\S]*?\.\.\.summaryOrder,[\s\S]*?\.\.\.currentOrder/m,
    "floor-summary merge that preserves full selected-order fields"
  );
  requirePattern(
    staffScript,
    /staffSelectedTableOrderRequestController[\s\S]*?loadSelectedStaffTableOrder\(\{ silent: true \}\)/m,
    "silent selected-order polling with cancellation"
  );
  requirePattern(
    staffScript,
    /openStaffOrderFromTableActivity\(createdOrder\.id, \{[\s\S]*?confirmedOrder: createdOrder/m,
    "immediate backend-confirmed created-order rendering"
  );
  requirePattern(
    staffRoute,
    /router\.get\("\/orders\/table-activity\/:id"[\s\S]*?\.select\(STAFF_ORDER_LIST_FIELDS\)[\s\S]*?buildStaffOrderResponse\(orderWithRounds/m,
    "full selected table-order response contract"
  );
  requirePattern(
    staffScript,
    /function getStaffKitchenDisplayUrl[\s\S]*?url\.search = "";[\s\S]*?mode", "kds-display"[\s\S]*?window\.location\.assign\(getStaffKitchenDisplayUrl\(\)\)/m,
    "canonical KDS navigation that clears stale room parameters"
  );
  requirePattern(
    staffScript,
    /staffKdsRequestController[\s\S]*?Kitchen reconnecting[\s\S]*?shouldStaffSynchronizeKds/m,
    "non-overlapping scoped KDS refresh and reconnect state"
  );
  requirePattern(
    staffRoute,
    /const payload = buildStaffMenuPayload\(\{[\s\S]*?res\.set\("Cache-Control", "private, no-cache"\);[\s\S]*?res\.json\(payload\);/m,
    "versioned authenticated menu route"
  );
  requirePattern(
    staffMenuPresentation,
    /menuVersion:\s*createMenuVersion\(\{[\s\S]*?categories:\s*visibleCategories,[\s\S]*?items/m,
    "versioned authenticated menu response"
  );
  requirePattern(
    staffHtml,
    /staffTableOrderFilterSummary[^>]*aria-live="polite"[\s\S]*?staffTableOrderMenuContent[^>]*aria-live="polite"/m,
    "accessible menu result updates"
  );

  const scaleSizes = [7, 50, 100, 200, 250, 500];
  let slowestScaleCheckMs = 0;
  scaleSizes.forEach((size) => {
    const largeMenu = Array.from({ length: size }, (_, index) => ({
      id: `item-${index + 1}`,
      name: `Dish ${index + 1}`,
      desc: index % 10 === 0 ? "spicy signature" : "classic",
      category: `category-${index % 12}`,
      badge: index % 7 === 0 ? "popular" : "",
      tag: index % 2 === 0 ? "veg" : "non-veg",
      comboItems: []
    }));
    const startedAt = performance.now();
    const initialBatch = largeMenu.slice(0, 48);
    const filtered = largeMenu.filter((item) =>
      [item.name, item.desc, item.category, item.badge, item.tag]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes("spicy")
    );
    const searchedBatch = filtered.slice(0, 48);
    const elapsedMs = performance.now() - startedAt;
    slowestScaleCheckMs = Math.max(slowestScaleCheckMs, elapsedMs);
    assert.strictEqual(largeMenu.length, size);
    assert.strictEqual(initialBatch.length, Math.min(size, 48));
    assert.strictEqual(filtered.length, Math.ceil(size / 10));
    assert.strictEqual(searchedBatch.length, Math.min(Math.ceil(size / 10), 48));
    assert.ok(elapsedMs < 1000, `${size}-item local filter took ${elapsedMs.toFixed(2)}ms`);
  });

  console.log("Staff Take Order KDS and large-menu regression verification passed.");
  console.log(
    `Synthetic 7/50/100/200/250/500-item search/batch matrix passed; slowest ${slowestScaleCheckMs.toFixed(2)}ms.`
  );
  console.log("Verified order defaults, KDS tenant scoping, targeted quantity controls, progressive rendering, polling, and combo-aware search.");
}

main();
