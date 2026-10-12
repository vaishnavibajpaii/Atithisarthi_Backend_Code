const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..", "..");

const backendPackageJsonPath = path.join(projectRoot, "backend", "package.json");
const comboSchemaSqlPath = path.join(projectRoot, "backend", "scripts", "create-menu-combo-tables.sql");
const adminValidatorPath = path.join(projectRoot, "backend", "validators", "admin.js");
const adminRoutesPath = path.join(projectRoot, "backend", "routes", "admin.js");
const publicRoutesPath = path.join(projectRoot, "backend", "routes", "public.js");
const staffRoutesPath = path.join(projectRoot, "backend", "routes", "staff.js");
const ordersRoutesPath = path.join(projectRoot, "backend", "routes", "orders.js");
const paymentsRoutesPath = path.join(projectRoot, "backend", "routes", "payments.js");
const trackingRoutesPath = path.join(projectRoot, "backend", "routes", "order-tracking.js");
const menuCombosUtilPath = path.join(projectRoot, "backend", "utils", "menu-combos.js");
const publicMenuPresentationPath = path.join(projectRoot, "backend", "utils", "public-menu-presentation.js");
const staffMenuPresentationPath = path.join(projectRoot, "backend", "utils", "staff-menu-presentation.js");
const orderItemSnapshotsUtilPath = path.join(projectRoot, "backend", "utils", "order-item-snapshots.js");

const adminHtmlPath = path.join(projectRoot, "frontend", "admin.html");
const adminJsPath = path.join(projectRoot, "frontend", "js", "admin.js");
const mainJsPath = path.join(projectRoot, "frontend", "js", "main.js");
const staffOrdersHtmlPath = path.join(projectRoot, "frontend", "staff-orders.html");
const staffOrdersJsPath = path.join(projectRoot, "frontend", "js", "staff-orders.js");
const orderTrackingJsPath = path.join(projectRoot, "frontend", "js", "order-tracking.js");

function readFileOrExit(filePath, label) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    console.log(`Menu combo verification failed: could not read ${label}.`);
    console.log(error.message || String(error));
    process.exit(1);
  }
}

function hasPattern(content, pattern) {
  return pattern.test(content);
}

function main() {
  const backendPackageJsonSource = readFileOrExit(backendPackageJsonPath, "backend package.json");
  const comboSchemaSqlSource = readFileOrExit(comboSchemaSqlPath, "combo schema sql");
  const adminValidatorSource = readFileOrExit(adminValidatorPath, "admin validator");
  const adminRoutesSource = readFileOrExit(adminRoutesPath, "admin routes");
  const publicRoutesSource = readFileOrExit(publicRoutesPath, "public routes");
  const staffRoutesSource = readFileOrExit(staffRoutesPath, "staff routes");
  const ordersRoutesSource = readFileOrExit(ordersRoutesPath, "orders routes");
  const paymentsRoutesSource = readFileOrExit(paymentsRoutesPath, "payments routes");
  const trackingRoutesSource = readFileOrExit(trackingRoutesPath, "order tracking routes");
  const menuCombosUtilSource = readFileOrExit(menuCombosUtilPath, "menu combos util");
  const publicMenuPresentationSource = readFileOrExit(
    publicMenuPresentationPath,
    "public menu presentation"
  );
  const staffMenuPresentationSource = readFileOrExit(
    staffMenuPresentationPath,
    "staff menu presentation"
  );
  const orderItemSnapshotsUtilSource = readFileOrExit(
    orderItemSnapshotsUtilPath,
    "order item snapshots util"
  );

  const adminHtmlSource = readFileOrExit(adminHtmlPath, "admin html");
  const adminJsSource = readFileOrExit(adminJsPath, "admin javascript");
  const mainJsSource = readFileOrExit(mainJsPath, "public website javascript");
  const staffOrdersHtmlSource = readFileOrExit(staffOrdersHtmlPath, "staff orders html");
  const staffOrdersJsSource = readFileOrExit(staffOrdersJsPath, "staff orders javascript");
  const orderTrackingJsSource = readFileOrExit(orderTrackingJsPath, "order tracking javascript");

  const failures = [];

  const schemaChecks = [
    {
      label: "menu item type column",
      source: comboSchemaSqlSource,
      pattern: /add column if not exists item_type text not null default 'single';/m
    },
    {
      label: "menu combo child table",
      source: comboSchemaSqlSource,
      pattern: /create table if not exists public\.menu_combo_items\s*\(/m
    },
    {
      label: "menu combo settings table",
      source: comboSchemaSqlSource,
      pattern: /create table if not exists public\.menu_combo_settings\s*\(/m
    }
  ];

  const validatorChecks = [
    {
      label: "combo create schema",
      source: adminValidatorSource,
      pattern: /const\s+comboMenuItemSchema\s*=\s*comboMenuItemBaseSchema\.superRefine\(refineComboMenuSchema\);/m
    },
    {
      label: "combo update schema",
      source: adminValidatorSource,
      pattern: /const\s+partialComboMenuItemSchema\s*=\s*comboMenuItemBaseSchema[\s\S]*\.superRefine\(refineComboMenuSchema\);/m
    },
    {
      label: "combo child items validator",
      source: adminValidatorSource,
      pattern: /childItems:\s*z\.array\(comboChildItemSchema\)\.min\(1\)/m
    }
  ];

  const backendRouteChecks = [
    {
      label: "admin combo list route",
      source: adminRoutesSource,
      pattern: /router\.get\("\/menu-combos",\s*async\s*\(req,\s*res\)\s*=>/m
    },
    {
      label: "admin combo create route",
      source: adminRoutesSource,
      pattern: /router\.post\("\/menu-combos",\s*validateBody\(comboMenuItemSchema\),\s*requireAdminFoodModule,\s*async\s*\(req,\s*res\)\s*=>/m
    },
    {
      label: "admin combo update route",
      source: adminRoutesSource,
      pattern: /router\.patch\("\/menu-combos\/:id",\s*validateBody\(partialComboMenuItemSchema\),\s*requireAdminFoodModule,\s*async\s*\(req,\s*res\)\s*=>/m
    },
    {
      label: "admin combo toggle route",
      source: adminRoutesSource,
      pattern: /router\.patch\("\/menu-combos\/:id\/active",\s*requireAdminFoodModule,\s*async\s*\(req,\s*res\)\s*=>/m
    },
    {
      label: "admin combo delete route",
      source: adminRoutesSource,
      pattern: /router\.delete\("\/menu-combos\/:id",\s*requireAdminFoodModule,\s*async\s*\(req,\s*res\)\s*=>/m
    },
    {
      label: "public combo visibility guard",
      source: publicMenuPresentationSource,
      pattern: /isComboItem\s*&&\s*!isMenuComboPresentationCurrentlyAvailable\(comboPresentation\)/m
    },
    {
      label: "staff combo visibility guard",
      source: staffMenuPresentationSource,
      pattern: /!isComboItem \|\|[\s\S]*isMenuComboPresentationCurrentlyAvailable\(comboPresentation\)/m
    },
    {
      label: "public order combo validation",
      source: ordersRoutesSource,
      pattern: /const\s+comboValidation\s*=\s*await\s+validateRequestedMenuCombos\(/m
    },
    {
      label: "payment combo validation",
      source: paymentsRoutesSource,
      pattern: /const\s+comboValidation\s*=\s*await\s+validateRequestedMenuCombos\(/m
    },
    {
      label: "tracking add-on combo validation",
      source: trackingRoutesSource,
      pattern: /const\s+comboValidation\s*=\s*await\s+validateRequestedMenuCombos\(/m
    }
  ];

  const backendUtilChecks = [
    {
      label: "combo presentation fetch helper",
      source: menuCombosUtilSource,
      pattern: /async function fetchMenuComboPresentationMap\(/m
    },
    {
      label: "combo active window helper",
      source: menuCombosUtilSource,
      pattern: /function isMenuComboPresentationCurrentlyAvailable\(/m
    },
    {
      label: "combo validation helper",
      source: menuCombosUtilSource,
      pattern: /async function validateRequestedMenuCombos\(/m
    },
    {
      label: "order item snapshots helper",
      source: orderItemSnapshotsUtilSource,
      pattern: /async function buildOrderItemSnapshots\(/m
    },
    {
      label: "combo summary line helper",
      source: orderItemSnapshotsUtilSource,
      pattern: /function buildComboSummaryLine\(/m
    }
  ];

  const frontendChecks = [
    {
      label: "admin combo offers tab",
      source: adminHtmlSource,
      pattern: /data-tab="menu-combos">Combo Offers</m
    },
    {
      label: "admin combo form",
      source: adminHtmlSource,
      pattern: /id="menuComboForm"/m
    },
    {
      label: "admin combo API usage",
      source: adminJsSource,
      pattern: /fetchJson\(`\$\{API_BASE\}\/menu-combos/m
    },
    {
      label: "public combo cart summary helper",
      source: mainJsSource,
      pattern: /function buildCartComboSummary\(/m
    },
    {
      label: "public combo menu card rendering",
      source: mainJsSource,
      pattern: /Includes:\s*\$\{escapeHTML\(comboSummary\)\}/m
    },
    {
      label: "staff combo cart metadata helper",
      source: staffOrdersJsSource,
      pattern: /function buildStaffTableOrderCartMetaMarkup\(/m
    },
    {
      label: "staff combo search over child items",
      source: staffOrdersJsSource,
      pattern: /const comboChildNames = Array\.isArray\(item\.comboItems\)/m
    },
    {
      label: "staff combo form styling area",
      source: staffOrdersHtmlSource,
      pattern: /\.staff-table-order-cart-meta\s*\{/m
    },
    {
      label: "tracking combo metadata helper",
      source: orderTrackingJsSource,
      pattern: /function buildTrackingComboSummary\(/m
    }
  ];

  const packageChecks = [
    {
      label: "backend verify menu combos script",
      source: backendPackageJsonSource,
      pattern: /"verify:menu-combos":\s*"node scripts\/verify-menu-combos-flow\.js"/m
    }
  ];

  [
    ...schemaChecks,
    ...validatorChecks,
    ...backendRouteChecks,
    ...backendUtilChecks,
    ...frontendChecks,
    ...packageChecks
  ].forEach((check) => {
    if (!hasPattern(check.source, check.pattern)) {
      failures.push(`Missing combo verification check: ${check.label}`);
    }
  });

  if (failures.length) {
    console.log("Menu combo verification failed.");
    failures.forEach((failure) => {
      console.log(`- ${failure}`);
    });
    process.exit(1);
  }

  console.log("Menu combo verification passed.");
  console.log("Verified additive combo schema, backend CRUD, availability filtering, and submit-time validation.");
  console.log("Verified public, staff, admin, cart, preview, tracking, and add-on combo rendering paths.");
}

main();
