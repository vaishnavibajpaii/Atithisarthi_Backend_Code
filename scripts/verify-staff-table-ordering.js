const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..", "..");
const staffRoutesPath = path.join(projectRoot, "backend", "routes", "staff.js");
const staffValidatorsPath = path.join(projectRoot, "backend", "validators", "staff.js");
const adminRoutesPath = path.join(projectRoot, "backend", "routes", "admin.js");
const orderStaffAttributionScriptPath = path.join(
  projectRoot,
  "backend",
  "scripts",
  "add-order-staff-attribution-columns.sql"
);
const staffOrdersHtmlPath = path.join(projectRoot, "frontend", "staff-orders.html");
const staffOrdersJsPath = path.join(projectRoot, "frontend", "js", "staff-orders.js");
const adminJsPath = path.join(projectRoot, "frontend", "js", "admin.js");

function readFileOrExit(filePath, label) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    console.log(`Staff table ordering verification failed: could not read ${label}.`);
    console.log(error.message || String(error));
    process.exit(1);
  }
}

function hasPattern(content, pattern) {
  return pattern.test(content);
}

function main() {
  const staffRoutesSource = readFileOrExit(staffRoutesPath, "backend staff routes");
  const staffValidatorsSource = readFileOrExit(staffValidatorsPath, "backend staff validators");
  const adminRoutesSource = readFileOrExit(adminRoutesPath, "backend admin routes");
  const orderStaffAttributionScriptSource = readFileOrExit(
    orderStaffAttributionScriptPath,
    "order staff attribution sql script"
  );
  const staffOrdersHtmlSource = readFileOrExit(staffOrdersHtmlPath, "staff orders html");
  const staffOrdersJsSource = readFileOrExit(staffOrdersJsPath, "staff orders javascript");
  const adminJsSource = readFileOrExit(adminJsPath, "admin javascript");
  const failures = [];

  const validatorChecks = [
    {
      label: "staff table order item schema",
      pattern: /const\s+staffTableOrderItemSchema\s*=\s*z\.object\(\s*\{/m
    },
    {
      label: "staff table order schema",
      pattern: /const\s+staffTableOrderSchema\s*=\s*z\.object\(\s*\{/m
    },
    {
      label: "table number validation",
      pattern: /tableNumber:\s*z\.string\(\)\.trim\(\)\.min\(1\)\.max\(80\)/m
    },
    {
      label: "items validation",
      pattern: /items:\s*z\.array\(staffTableOrderItemSchema\)\.min\(1\)\.max\(100\)/m
    }
  ];

  validatorChecks.forEach((check) => {
    if (!hasPattern(staffValidatorsSource, check.pattern)) {
      failures.push(`Missing validator check: ${check.label}`);
    }
  });

  const routeChecks = [
    {
      label: "staff menu route",
      pattern: /router\.get\(\s*"\/menu",\s*requireStaffAuth,\s*attachStaffMenuTenantContext,\s*requireStaffMenuFoodModule,\s*async\s*\(req,\s*res\)\s*=>/m
    },
    {
      label: "staff create order route",
      pattern:
        /router\.post\(\s*"\/orders",\s*requireStaffAuth,\s*requireStaffFoodModule,\s*validateBody\(staffTableOrderSchema\),\s*async\s*\(req,\s*res\)\s*=>/m
    },
    {
      label: "staff order validated body usage",
      pattern:
        /const\s+tableResolution\s*=\s*await\s+resolveTableForOrder\([\s\S]*req\.validatedBody\.tableNumber[\s\S]*const\s+tableNumber\s*=\s*tableResolution\.tableNumber;[\s\S]*const\s+items\s*=\s*req\.validatedBody\.items\s*\|\|\s*\[\];/m
    },
    {
      label: "staff order source",
      pattern: /order_source:\s*"staff"/m
    },
    {
      label: "staff order unpaid state",
      pattern: /payment_status:\s*"unpaid"/m
    },
    {
      label: "staff order not billed state",
      pattern: /billing_status:\s*"not_billed"/m
    }
  ];

  routeChecks.forEach((check) => {
    if (!hasPattern(staffRoutesSource, check.pattern)) {
      failures.push(`Missing route check: ${check.label}`);
    }
  });

  const attributionChecks = [
    {
      label: "staff attribution migration",
      pattern: /add column if not exists created_by_staff_id bigint;/m,
      source: orderStaffAttributionScriptSource
    },
    {
      label: "staff order creator column usage",
      pattern: /created_by_staff_id:/m,
      source: staffRoutesSource
    },
    {
      label: "staff order creator response",
      pattern: /createdByStaff:\s*getOrderCreatedByStaffResponse\(order,\s*staffById\)/m,
      source: staffRoutesSource
    },
    {
      label: "admin order creator response",
      pattern: /createdByStaff:\s*getOrderCreatedByStaffResponse\(order,\s*staffById\)/m,
      source: adminRoutesSource
    }
  ];

  attributionChecks.forEach((check) => {
    if (!hasPattern(check.source, check.pattern)) {
      failures.push(`Missing attribution check: ${check.label}`);
    }
  });

  const htmlChecks = [
    {
      label: "take order tab",
      pattern: /data-staff-view="table-order"[^>]*>[\s\S]*?<span class="staff-sidebar-nav-label">Take Order<\/span>[\s\S]*?<\/button>/m
    },
    {
      label: "table order panel",
      pattern: /id="staffTableOrderPanel"[^>]*data-staff-view-panel="table-order"/m
    },
    {
      label: "table order form",
      pattern: /id="staffTableOrderForm"/m
    },
    {
      label: "table number input",
      pattern: /id="staffTableOrderTableInput"[^>]*name="tableNumber"[^>]*required/m
    },
    {
      label: "menu content container",
      pattern: /id="staffTableOrderMenuContent"/m
    },
    {
      label: "menu search input",
      pattern: /id="staffTableOrderSearchInput"/m
    },
    {
      label: "menu category filter",
      pattern: /id="staffTableOrderCategoryFilter"/m
    },
    {
      label: "staff table order filter",
      pattern: /<option value="staff-table">Staff table orders<\/option>/m
    }
  ];

  htmlChecks.forEach((check) => {
    if (!hasPattern(staffOrdersHtmlSource, check.pattern)) {
      failures.push(`Missing frontend markup check: ${check.label}`);
    }
  });

  const jsChecks = [
    {
      label: "table order state",
      pattern:
        /tableOrderMenu:\s*\[\],[\s\S]*tableOrderCart:\s*\{\},[\s\S]*tableOrderMenuLoaded:\s*false[\s\S]*tableOrderMenuQuery:\s*""[\s\S]*tableOrderMenuCategory:\s*"all"/m
    },
    {
      label: "table order view metadata",
      pattern: /"table-order":\s*\{[\s\S]*title:\s*"Take table order"/m
    },
    {
      label: "table order menu loader",
      pattern: /async function loadStaffTableOrderMenu\(\{\s*silent = false\s*\} = \{\}\)/m
    },
    {
      label: "table order menu filters renderer",
      pattern: /function renderStaffTableOrderMenuFilters\(\{\s*visibleCount = null\s*\} = \{\}\)/m
    },
    {
      label: "table order filtered items helper",
      pattern: /function getFilteredStaffTableOrderMenuItems\(\)/m
    },
    {
      label: "table order submit handler",
      pattern: /async function handleStaffTableOrderSubmit\(event\)/m
    },
    {
      label: "table order submit endpoint",
      pattern: /staffFetchJson\(`\$\{STAFF_API_BASE\}\/orders`,\s*\{/m
    },
    {
      label: "lazy load Create New Order view",
      pattern: /if\s*\(nextView === "create"\)\s*\{[\s\S]*?if\s*\(!STAFF_STATE\.tableOrderMenuLoaded\)\s*\{[\s\S]*?void loadStaffTableOrderMenu\(\);[\s\S]*?\}/m
    },
    {
      label: "staff table order source grouping",
      pattern: /buildStaffOrderSourceGroup\("staff-table",\s*staffTableOrders\)/m
    },
    {
      label: "table order search binding",
      pattern: /tableOrderSearchInput\.addEventListener\("input",\s*\(\)\s*=>\s*\{[\s\S]*renderStaffTableOrderMenu\(\);/m
    },
    {
      label: "table order category binding",
      pattern: /tableOrderCategoryFilter\.addEventListener\("change",\s*\(\)\s*=>\s*\{[\s\S]*setStaffTableOrderMenuCategory\(/m
    },
    {
      label: "staff taken by label",
      pattern: /Taken By:\s*\$\{escapeHTML\(createdByLabel\)\}/m
    }
  ];

  const adminJsChecks = [
    {
      label: "admin taken by row",
      pattern: /<strong>Taken By:<\/strong>/m
    }
  ];

  jsChecks.forEach((check) => {
    if (!hasPattern(staffOrdersJsSource, check.pattern)) {
      failures.push(`Missing frontend behavior check: ${check.label}`);
    }
  });

  adminJsChecks.forEach((check) => {
    if (!hasPattern(adminJsSource, check.pattern)) {
      failures.push(`Missing admin behavior check: ${check.label}`);
    }
  });

  if (failures.length) {
    console.log("Staff table ordering verification failed.");
    failures.forEach((failure) => {
      console.log(`- ${failure}`);
    });
    process.exit(1);
  }

  console.log("Staff table ordering verification passed.");
  console.log("Verified backend validator and route wiring for staff-assisted dine-in orders.");
  console.log("Verified frontend Take Order workspace markup, menu loading, submit flow, and staff source grouping.");
  console.log("Verified additive staff attribution wiring for staff and admin order views.");
}

main();
