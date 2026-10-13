const fs = require("fs");
const path = require("path");
const vm = require("vm");

const projectRoot = path.resolve(__dirname, "..", "..");
const staffHtmlPath = path.join(projectRoot, "frontend", "staff-orders.html");
const staffJsPath = path.join(projectRoot, "frontend", "js", "staff-orders.js");
const staffRoutesPath = path.join(projectRoot, "backend", "routes", "staff.js");
const staffTrendPath = path.join(projectRoot, "backend", "utils", "staff-order-trend.js");

function readSource(filePath, label) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    console.error(`Staff Orders UI verification failed: could not read ${label}.`);
    console.error(error.message || String(error));
    process.exit(1);
  }
}

function checkPatterns(source, label, checks, failures) {
  checks.forEach(({ name, pattern }) => {
    if (!pattern.test(source)) {
      failures.push(`${label}: ${name}`);
    }
  });
}

function verifyReferenceSidebarContracts(html, frontend, failures) {
  const start = html.indexOf('<aside id="staffSidebarNavigation"');
  const end = html.indexOf("</aside>", start);
  if (start < 0 || end < 0) {
    failures.push("HTML reference sidebar: panel boundaries are missing");
    return;
  }

  const sidebar = html.slice(start, end + "</aside>".length);
  const expectedViews = [
    "dashboard", "reports", "table-order", "orders", "kds", "support",
    "rooms", "reservations", "inquiries", "contacts", "testimonials", "gateway"
  ];
  const actualViews = Array.from(
    sidebar.matchAll(/data-staff-view="([^"]+)"/g),
    (match) => match[1]
  );
  if (actualViews.join(",") !== expectedViews.join(",")) {
    failures.push("HTML reference sidebar: destination order changed");
  }

  const iconCount = (sidebar.match(/class="staff-sidebar-nav-icon"/g) || []).length;
  if (iconCount !== expectedViews.length) {
    failures.push("HTML reference sidebar: expected " + expectedViews.length + " navigation icons, found " + iconCount);
  }

  [
    "staffOrdersTabCount",
    "staffKdsTabCount",
    "staffSupportTabCount",
    "staffRoomsTabCount",
    "staffReservationsTabCount",
    "staffInquiriesTabCount",
    "staffContactsTabCount",
    "staffTestimonialsTabCount",
    "staffSidebarCloseBtn",
    "staffSidebarHotelName",
    "staffSidebarRoleBadge"
  ].forEach((id) => {
    const count = (sidebar.match(new RegExp('id="' + id + '"', "g")) || []).length;
    if (count !== 1) {
      failures.push("HTML reference sidebar: expected one #" + id + ", found " + count);
    }
  });

  checkPatterns(sidebar, "HTML reference sidebar", [
    { name: "Hotel Access product name", pattern: /staff-sidebar-product-copy[\s\S]*?<strong>Hotel Access<\/strong>/m },
    { name: "Staff workspace label", pattern: /staff-sidebar-product-copy[\s\S]*?<strong>Hotel Access<\/strong>[\s\S]*?<small>Copyright[\s\S]*?2026 AtithiSarthi\. All Rights Reserved\.<\/small>/m },
    { name: "inline product mark", pattern: /class="staff-sidebar-product-mark"[^>]*aria-hidden="true"[\s\S]*?<svg/m },
    { name: "tablist semantics", pattern: /class="staff-view-tabs"[^>]*role="tablist"/m },
    { name: "close control preserved", pattern: /id="staffSidebarCloseBtn"[^>]*type="button"[^>]*aria-label="Close dashboard sections"/m },
    { name: "hotel-scoped footer label", pattern: /class="staff-sidebar-scope-label">Hotel-scoped access<\/p>/m },
    { name: "real hotel footer target", pattern: /id="staffSidebarHotelName"[^>]*>this hotel<\/strong>/m },
    { name: "real role footer target", pattern: /id="staffSidebarRoleBadge"[^>]*>Staff access<\/span>/m }
  ], failures);

  checkPatterns(html, "Reference sidebar CSS", [
    { name: "reference shell scope", pattern: /id="staffDashboardWrap"[^>]*staff-reference-shell/m },
    { name: "264px desktop rail", pattern: /\.staff-reference-shell\s+\.staff-dashboard-layout\s*\{[\s\S]*?grid-template-columns:\s*264px\s+minmax\(0,\s*1fr\)/m },
    { name: "full-height desktop rail", pattern: /\.staff-reference-shell\s+\.staff-dashboard-sidebar\s*\{[\s\S]*?min-height:\s*calc\(100vh\s*-\s*72px\)/m },
    { name: "three-row sidebar layout", pattern: /\.staff-reference-shell\s+\.staff-dashboard-sidebar\s*\{[\s\S]*?grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/m },
    { name: "46px navigation targets", pattern: /\.staff-reference-shell\s+\.staff-dashboard-sidebar\s+\.staff-view-tab\s*\{[\s\S]*?min-height:\s*46px/m },
    { name: "terracotta active navigation", pattern: /\.staff-reference-shell\s+\.staff-dashboard-sidebar\s+\.staff-view-tab\.is-active\s*\{[\s\S]*?linear-gradient\(135deg,\s*#b95f46,\s*#ce8052\)/m },
    { name: "tablet sidebar adaptation", pattern: /@media\s*\(max-width:\s*1080px\)[\s\S]*?\.staff-reference-shell\s+\.staff-dashboard-layout/m },
    { name: "mobile fixed drawer", pattern: /@media\s*\(max-width:\s*760px\)[\s\S]*?\.staff-reference-shell\s+\.staff-dashboard-sidebar\s*\{[\s\S]*?position:\s*fixed[\s\S]*?min-height:\s*100dvh/m },
    { name: "sidebar reduced motion", pattern: /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.staff-reference-shell\s+\.staff-dashboard-sidebar\s+\.staff-view-tab/m }
  ], failures);

  checkPatterns(frontend, "Frontend reference sidebar", [
    { name: "hotel footer update", pattern: /function\s+updateStaffWorkspaceHotelBadge[\s\S]*?staffSidebarHotelName[\s\S]*?sidebarHotelName\.textContent\s*=\s*hotelSlug/m },
    { name: "role footer update", pattern: /function\s+updateStaffWorkspaceHotelBadge[\s\S]*?staffSidebarRoleBadge[\s\S]*?Owner access[\s\S]*?Staff access[\s\S]*?classList\.toggle\("is-owner",\s*isManager\)/m },
    { name: "role-based destinations preserved", pattern: /function\s+applyStaffRoleWorkspaceAccess[\s\S]*?allowedViews\.includes\(view\)[\s\S]*?button\.hidden\s*=\s*!isAllowed/m },
    { name: "gateway destination remains owner-only", pattern: /function\s+applyStaffRoleWorkspaceAccess[\s\S]*?data-staff-owner-only[\s\S]*?isStaffOwnerSession/m },
    { name: "mobile focus restoration preserved", pattern: /function\s+setStaffSidebarExpanded[\s\S]*?restoreFocus[\s\S]*?staffSidebarLastFocusedElement/m }
  ], failures);
}

function verifyReferenceHeaderContracts(html, frontend, failures) {
  const start = html.indexOf('<header class="staff-workspace-topbar staff-reference-topbar"');
  const end = html.indexOf("</header>", start);
  if (start < 0 || end < 0) {
    failures.push("HTML reference header: boundaries are missing");
    return;
  }

  const header = html.slice(start, end + "</header>".length);
  [
    "staffSidebarToggleBtn",
    "staffHeaderGreeting",
    "staffHeaderSearchForm",
    "staffHeaderSearchInput",
    "staffHeaderSearchOptions",
    "staffSoundAlertToggleBtn",
    "staffSoundVolumeSelect",
    "staffBrowserAlertToggleBtn",
    "staffProfileMenuButton",
    "staffHeaderAvatarInitials",
    "staffHeaderDisplayName",
    "staffHeaderRoleLabel",
    "staffProfileMenu",
    "staffWorkspaceHotelBadge",
    "staffLogoutBtn",
    "staffWorkspaceOrderingBadge"
  ].forEach((id) => {
    const count = (header.match(new RegExp('id="' + id + '"', "g")) || []).length;
    if (count !== 1) {
      failures.push("HTML reference header: expected one #" + id + ", found " + count);
    }
  });

  checkPatterns(header, "HTML reference header", [
    { name: "dynamic greeting target", pattern: /id="staffHeaderGreeting"[^>]*>Good afternoon, this hotel<\/h2>/m },
    { name: "attention subtitle", pattern: /class="staff-reference-greeting-subtitle">Here is what needs attention today<\/p>/m },
    { name: "functional search form", pattern: /id="staffHeaderSearchForm"[^>]*role="search"/m },
    { name: "search datalist linkage", pattern: /id="staffHeaderSearchInput"[^>]*list="staffHeaderSearchOptions"[^>]*autocomplete="off"/m },
    { name: "search options target", pattern: /<datalist id="staffHeaderSearchOptions"><\/datalist>/m },
    { name: "sound toggle preserved", pattern: /id="staffSoundAlertToggleBtn"[^>]*type="button"[^>]*aria-pressed="false"/m },
    { name: "sound controls grouped", pattern: /class="staff-reference-sound-settings"[^>]*role="group"[^>]*aria-label="Sound notification settings"/m },
    { name: "sound volume select labeled", pattern: /id="staffSoundVolumeSelect"[^>]*aria-label="Notification sound volume"/m },
    { name: "browser-alert toggle preserved", pattern: /id="staffBrowserAlertToggleBtn"[^>]*type="button"[^>]*aria-pressed="false"/m },
    { name: "profile menu disclosure", pattern: /id="staffProfileMenuButton"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"[^>]*aria-controls="staffProfileMenu"/m },
    { name: "profile menu semantics", pattern: /id="staffProfileMenu"[^>]*role="menu"[^>]*hidden/m },
    { name: "logout action preserved", pattern: /id="staffLogoutBtn"[^>]*type="button"[^>]*role="menuitem"/m },
    { name: "accessible search helper", pattern: /<label class="staff-sr-only"[^>]*for="staffHeaderSearchInput">[\s\S]*?<button class="staff-sr-only" type="submit">Open workspace section<\/button>/m }
  ], failures);

  const heroStart = html.indexOf('<div class="staff-dashboard-hero">');
  const heroEnd = html.indexOf('<section id="staffHomePanel"', heroStart);
  const hero = heroStart >= 0 && heroEnd > heroStart ? html.slice(heroStart, heroEnd) : "";
  ["staffSoundAlertToggleBtn", "staffBrowserAlertToggleBtn", "staffLogoutBtn"].forEach((id) => {
    if (hero.includes('id="' + id + '"')) {
      failures.push("HTML reference header: #" + id + " still exists in the old hero actions");
    }
  });

  checkPatterns(html, "Reference header CSS", [
    { name: "authenticated page header removal", pattern: /body\.is-staff-dashboard-active\s+\.staff-header\s*\{[\s\S]*?display:\s*none/m },
    { name: "authenticated full-width shell", pattern: /body\.is-staff-dashboard-active\s+\.staff-wrap\s*\{[\s\S]*?width:\s*100%[\s\S]*?padding:\s*0/m },
    { name: "82px compact desktop header", pattern: /\.staff-reference-shell\s+\.staff-workspace-topbar\.staff-reference-topbar\s*\{[\s\S]*?grid-template-columns:[\s\S]*?min-height:\s*82px/m },
    { name: "reference header divider", pattern: /\.staff-reference-shell\s+\.staff-workspace-topbar\.staff-reference-topbar\s*\{[\s\S]*?border-bottom:\s*1px\s+solid/m },
    { name: "reference-shell screen-reader helper", pattern: /\.staff-reference-shell\s+\.staff-sr-only,[\s\S]*?clip:\s*rect\(0,\s*0,\s*0,\s*0\)/m },
    { name: "ordering badge removed from visual header", pattern: /#staffWorkspaceOrderingBadge\s*\{[\s\S]*?display:\s*none\s*!important/m },
    { name: "search focus treatment", pattern: /#staffHeaderSearchInput:focus-visible\s*\{[\s\S]*?border-color:\s*#a95c45/m },
    { name: "42px desktop header controls", pattern: /\.staff-reference-shell\s+\.staff-reference-alert-control\s*\{[\s\S]*?min-height:\s*42px/m },
    { name: "bounded sound settings grid", pattern: /\.staff-reference-shell\s+\.staff-reference-sound-settings\s*\{[\s\S]*?grid-template-columns:\s*auto\s+minmax\(82px,\s*92px\)[\s\S]*?min-width:\s*0/m },
    { name: "480px no-overlap header grid", pattern: /@media\s*\(max-width:\s*480px\)[\s\S]*?\.staff-reference-topbar-controls\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s+44px\s+44px/m },
    { name: "hidden profile menu contract", pattern: /\.staff-reference-shell\s+\.staff-reference-profile-menu\[hidden\]\s*\{[\s\S]*?display:\s*none/m },
    { name: "tablet header adaptation", pattern: /@media\s*\(max-width:\s*900px\)[\s\S]*?\.staff-reference-search\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1/m },
    { name: "mobile touch targets", pattern: /@media\s*\(max-width:\s*560px\)[\s\S]*?\.staff-reference-alert-control\s*\{[\s\S]*?width:\s*44px/m },
    { name: "small-phone header adaptation", pattern: /@media\s*\(max-width:\s*390px\)[\s\S]*?staff-reference-topbar/m },
    { name: "header reduced motion", pattern: /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?#staffHeaderSearchInput[\s\S]*?transition:\s*none/m }
  ], failures);

  checkPatterns(frontend, "Frontend reference header", [
    { name: "time-aware greeting", pattern: /function\s+getStaffHeaderGreetingPeriod[\s\S]*?getHours\(\)[\s\S]*?Good morning[\s\S]*?Good afternoon[\s\S]*?Good evening/m },
    { name: "trusted session display target", pattern: /function\s+getStaffHeaderDisplayTarget[\s\S]*?staffUser\?\.displayName[\s\S]*?staffUser\?\.hotelSlug/m },
    { name: "role-aware profile label", pattern: /function\s+updateStaffReferenceHeader[\s\S]*?isStaffManagerSession\(staffUser\)[\s\S]*?Owner access[\s\S]*?Staff access/m },
    { name: "role-filtered search options", pattern: /function\s+updateStaffHeaderSearchOptions[\s\S]*?getAllowedStaffViews\(staffUser\)[\s\S]*?getStaffViewMeta\(view\)\.badge/m },
    { name: "existing view navigation reuse", pattern: /function\s+submitStaffHeaderSearch[\s\S]*?resolveStaffHeaderSearchView\(query\)[\s\S]*?openStaffView\(view\)/m },
    { name: "search invalid-state feedback", pattern: /Choose an available workspace section\.[\s\S]*?reportValidity\(\)/m },
    { name: "profile disclosure state", pattern: /function\s+setStaffProfileMenuExpanded[\s\S]*?aria-expanded[\s\S]*?menu\.hidden\s*=\s*!expanded/m },
    { name: "profile Escape handling", pattern: /function\s+bindStaffReferenceHeader[\s\S]*?event\.key\s*!==\s*"Escape"[\s\S]*?returnFocus:\s*true/m },
    { name: "authenticated shell state", pattern: /function\s+showStaffLoginView[\s\S]*?classList\.remove\("is-staff-dashboard-active"\)[\s\S]*?function\s+showStaffDashboardView[\s\S]*?classList\.add\("is-staff-dashboard-active"\)/m },
    { name: "header binding initialization", pattern: /function\s+initStaffOrdersPage[\s\S]*?bindStaffReferenceHeader\(\)[\s\S]*?bindStaffLogout\(\)/m },
    { name: "sound handler preserved", pattern: /function\s+bindStaffSoundAlertToggle[\s\S]*?#staffSoundAlertToggleBtn/m },
    { name: "browser-alert handler preserved", pattern: /function\s+bindStaffBrowserAlertToggle[\s\S]*?#staffBrowserAlertToggleBtn/m }
  ], failures);
}
function verifyReferenceOverviewHeaderContracts(html, frontend, failures) {
  const start = html.indexOf('<header class="staff-dashboard-home-header staff-reference-overview-header"');
  const end = html.indexOf("</header>", start);
  if (start < 0 || end < 0) {
    failures.push("HTML reference Overview header: boundaries are missing");
    return;
  }

  const overviewHeader = html.slice(start, end + "</header>".length);
  [
    "staffDashboardOverviewHeading",
    "staffDashboardLastUpdated",
    "staffDashboardDateButton",
    "staffDashboardDateLabel",
    "staffDashboardNewOrderBtn"
  ].forEach((id) => {
    const count = (overviewHeader.match(new RegExp('id="' + id + '"', "g")) || []).length;
    if (count !== 1) {
      failures.push("HTML reference Overview header: expected one #" + id + ", found " + count);
    }
  });

  checkPatterns(overviewHeader, "HTML reference Overview header", [
    { name: "reference heading", pattern: /id="staffDashboardOverviewHeading"[^>]*>Dashboard overview<\/h3>/m },
    { name: "reference supporting copy", pattern: /A compact view of orders, payments, kitchen activity, reports and guest operations\.<\/p>/m },
    { name: "polite refresh status preserved", pattern: /id="staffDashboardLastUpdated"[^>]*aria-live="polite"/m },
    { name: "date-filter action", pattern: /id="staffDashboardDateButton"[^>]*type="button"[^>]*aria-label="Open report date filters"/m },
    { name: "dynamic date label", pattern: /id="staffDashboardDateLabel">Today<\/span>/m },
    { name: "existing New Order action", pattern: /id="staffDashboardNewOrderBtn"[^>]*type="button"[^>]*>New order<\/button>/m },
    { name: "calendar icon", pattern: /staffDashboardDateButton[\s\S]*?<svg[\s\S]*?<path d="M7 3v3M17 3v3/m }
  ], failures);

  if (overviewHeader.includes("staff-kicker")) {
    failures.push("HTML reference Overview header: old kicker is still present");
  }
  if (overviewHeader.includes("staff-dashboard-home-scope")) {
    failures.push("HTML reference Overview header: old scope pill is still present");
  }

  checkPatterns(html, "Reference Overview header CSS", [
    { name: "panel-only scope", pattern: /#staffHomePanel\s+\.staff-dashboard-home-header\.staff-reference-overview-header\s*\{/m },
    { name: "flat reference header", pattern: /#staffHomePanel\s+\.staff-dashboard-home-header\.staff-reference-overview-header\s*\{[\s\S]*?border:\s*0[\s\S]*?background:\s*transparent[\s\S]*?box-shadow:\s*none/m },
    { name: "44px controls", pattern: /#staffHomePanel\s+\.staff-reference-date-button,[\s\S]*?#staffHomePanel\s+\.staff-reference-new-order-button\s*\{[\s\S]*?min-height:\s*44px/m },
    { name: "terracotta New Order action", pattern: /#staffHomePanel\s+\.staff-reference-new-order-button\s*\{[\s\S]*?linear-gradient\(135deg,\s*#b95f46,\s*#a9533e\)/m },
    { name: "tablet Overview layout", pattern: /@media\s*\(max-width:\s*760px\)[\s\S]*?#staffHomePanel\s+\.staff-dashboard-home-header\.staff-reference-overview-header\s*\{[\s\S]*?display:\s*grid/m },
    { name: "mobile Overview actions", pattern: /@media\s*\(max-width:\s*560px\)[\s\S]*?#staffHomePanel\s+\.staff-dashboard-home-refresh\.staff-reference-overview-actions\s*\{[\s\S]*?grid-template-columns:/m },
    { name: "Overview reduced motion", pattern: /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?#staffHomePanel\s+\.staff-reference-date-button[\s\S]*?transition:\s*none/m }
  ], failures);

  checkPatterns(frontend, "Frontend reference Overview header", [
    { name: "real current-date formatting", pattern: /function\s+updateStaffDashboardOverviewDateLabel[\s\S]*?#staffDashboardDateLabel[\s\S]*?Intl\.DateTimeFormat[\s\S]*?label\.textContent\s*=\s*compactLabel/m },
    { name: "accessible current date", pattern: /Open report date filters\. Today is \$\{accessibleLabel\}\./m },
    { name: "existing Reports date flow", pattern: /function\s+openStaffDashboardReportDateFilters[\s\S]*?canStaffAccessView\("reports"\)[\s\S]*?openStaffView\("reports"\)[\s\S]*?#staffReportsRangeInput[\s\S]*?focus\(\)/m },
    { name: "existing Take Order flow", pattern: /staffDashboardNewOrderBtn[\s\S]*?addEventListener\("click",\s*\(\)\s*=>\s*openStaffView\("table-order"\)\)/m },
    { name: "single guarded action binding", pattern: /function\s+bindStaffDashboardOverviewActions[\s\S]*?dataset\.boundClick[\s\S]*?updateStaffDashboardOverviewDateLabel\(\)/m },
    { name: "Overview binding initialization", pattern: /function\s+initStaffOrdersPage[\s\S]*?bindStaffReferenceHeader\(\)[\s\S]*?bindStaffDashboardOverviewActions\(\)[\s\S]*?bindStaffLogout\(\)/m },
    { name: "date refresh on dashboard navigation", pattern: /function\s+updateStaffWorkspaceContext[\s\S]*?view\s*===\s*"dashboard"[\s\S]*?updateStaffDashboardOverviewDateLabel\(\)/m }
  ], failures);
}
function verifyReferenceKpiContracts(html, frontend, failures) {
  const dashboardStart = html.indexOf('<section id="staffHomePanel"');
  const dashboardEnd = html.indexOf('<section id="staffReportsPanel"', dashboardStart);
  const dashboard = dashboardStart >= 0 && dashboardEnd > dashboardStart
    ? html.slice(dashboardStart, dashboardEnd)
    : "";

  checkPatterns(dashboard, "HTML reference KPIs", [
    { name: "existing summary target", pattern: /id="staffDashboardSummary"[^>]*class="staff-summary-grid"[^>]*aria-busy="false"[^>]*hidden/m },
    { name: "accessible KPI state", pattern: /id="staffDashboardEmpty"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/m }
  ], failures);

  const renderStart = frontend.indexOf("function renderStaffDashboardPrimaryKpis");
  const renderEnd = frontend.indexOf("function renderStaffDashboardRecentOrders", renderStart);
  if (renderStart < 0 || renderEnd < 0) {
    failures.push("Frontend reference KPIs: render function boundaries are missing");
    return;
  }
  const renderBody = frontend.slice(renderStart, renderEnd);
  const cardCount = (renderBody.match(/buildStaffDashboardKpiCard\(\{/g) || []).length;
  if (cardCount !== 4) {
    failures.push("Frontend reference KPIs: expected four KPI cards, found " + cardCount);
  }

  checkPatterns(renderBody, "Frontend reference KPIs", [
    { name: "manager permission gate", pattern: /if\s*\(!isStaffManagerSession\(\)\)[\s\S]*?Manager access required/m },
    { name: "today report with truthful fallback", pattern: /reports\?\.today[\s\S]*?todaySummary\s*\|\|\s*loadedSummary/m },
    { name: "order count mapping", pattern: /label:\s*orderCountLabel[\s\S]*?value:\s*String\(periodSummary\.totalOrders\s*\|\|\s*0\)[\s\S]*?className:\s*"is-orders"/m },
    { name: "active order mapping", pattern: /label:\s*"Active orders"[\s\S]*?value:\s*String\(activeSummary\.total\)[\s\S]*?className:\s*"is-active-orders"/m },
    { name: "pending amount mapping", pattern: /label:\s*paymentLabel[\s\S]*?value:\s*formatMoney\(periodSummary\.unpaidEarnings\s*\|\|\s*0\)[\s\S]*?periodSummary\.unpaidOrders[\s\S]*?className:\s*"is-pending-payments"/m },
    { name: "total value mapping", pattern: /label:\s*valueLabel[\s\S]*?value:\s*formatMoney\(periodSummary\.totalEarnings\s*\|\|\s*0\)[\s\S]*?className:\s*"is-order-value"/m }
  ], failures);

  checkPatterns(frontend, "Frontend reference KPI states", [
    { name: "semantic KPI structure", pattern: /function\s+buildStaffDashboardKpiCard[\s\S]*?<article[\s\S]*?staff-dashboard-kpi-icon[\s\S]*?staff-summary-label[\s\S]*?staff-summary-value[\s\S]*?staff-summary-note/m },
    { name: "four-card loading skeleton", pattern: /function\s+setStaffDashboardSummaryEmpty[\s\S]*?\{\s*length:\s*4\s*\}[\s\S]*?staff-dashboard-kpi-card is-skeleton/m },
    { name: "summary render chain preserved", pattern: /function\s+renderStaffOrdersSummary[\s\S]*?renderStaffDashboardPrimaryKpis\(orders,\s*STAFF_STATE\.dashboardReports\)/m }
  ], failures);

  checkPatterns(html, "Reference KPI CSS", [
    { name: "four-column desktop grid", pattern: /#staffHomePanel\s+#staffDashboardSummary\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)[\s\S]*?gap:\s*14px/m },
    { name: "compact card geometry", pattern: /#staffHomePanel\s+#staffDashboardSummary\s+\.staff-dashboard-kpi-card\s*\{[\s\S]*?min-height:\s*136px[\s\S]*?border-radius:\s*12px/m },
    { name: "bottom accent", pattern: /#staffHomePanel\s+#staffDashboardSummary\s+\.staff-dashboard-kpi-card::after\s*\{[\s\S]*?bottom:\s*0[\s\S]*?height:\s*4px[\s\S]*?var\(--staff-kpi-accent\)/m },
    { name: "orders accent", pattern: /staff-dashboard-kpi-card\.is-orders\s*\{[\s\S]*?#ad5b47/m },
    { name: "active accent", pattern: /staff-dashboard-kpi-card\.is-active-orders\s*\{[\s\S]*?#7c906e/m },
    { name: "pending accent", pattern: /staff-dashboard-kpi-card\.is-pending-payments\s*\{[\s\S]*?#d09a47/m },
    { name: "value accent", pattern: /staff-dashboard-kpi-card\.is-order-value\s*\{[\s\S]*?#a85d6b/m },
    { name: "reference KPI typography", pattern: /staff-dashboard-kpi-card\s+\.staff-summary-label\s*\{[\s\S]*?font-size:\s*13px[\s\S]*?text-transform:\s*none/m },
    { name: "two-column tablet layout", pattern: /@media\s*\(max-width:\s*1100px\)[\s\S]*?#staffHomePanel\s+#staffDashboardSummary\s*\{[\s\S]*?repeat\(2,\s*minmax\(0,\s*1fr\)\)/m },
    { name: "two-column mobile layout", pattern: /@media\s*\(max-width:\s*760px\)[\s\S]*?#staffHomePanel\s+#staffDashboardSummary\s*\{[\s\S]*?repeat\(2,\s*minmax\(0,\s*1fr\)\)[\s\S]*?overflow:\s*visible/m },
    { name: "small-phone single column", pattern: /@media\s*\(max-width:\s*360px\)[\s\S]*?#staffHomePanel\s+#staffDashboardSummary\s*\{[\s\S]*?grid-template-columns:\s*1fr/m },
    { name: "KPI reduced motion", pattern: /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?#staffHomePanel\s+#staffDashboardSummary\s+\.staff-dashboard-kpi-card\s*\{[\s\S]*?transition:\s*none/m }
  ], failures);
}
function verifyReferenceSourceBarsContracts(html, frontend, failures) {
  const dashboardStart = html.indexOf('<section id="staffHomePanel"');
  const dashboardEnd = html.indexOf('<section id="staffReportsPanel"', dashboardStart);
  const dashboard = dashboardStart >= 0 && dashboardEnd > dashboardStart
    ? html.slice(dashboardStart, dashboardEnd)
    : "";

  checkPatterns(dashboard, "HTML reference source bars", [
    { name: "source heading", pattern: /id="staffDashboardOrderSourcesHeading">Orders by source<\/h4>/m },
    { name: "loaded-range disclosure", pattern: /id="staffDashboardOrderSourcesHeading"[\s\S]*?currently loaded Orders range/m },
    { name: "existing busy target", pattern: /id="staffDashboardOrderSources"[^>]*aria-busy="false"[^>]*hidden/m },
    { name: "accessible empty state", pattern: /id="staffDashboardOrderSourcesEmpty"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"[^>]*hidden/m }
  ], failures);

  const summaryStart = frontend.indexOf("function getStaffDashboardOrderSourceSummary");
  const summaryEnd = frontend.indexOf("function formatStaffDashboardSourceShare", summaryStart);
  const renderStart = frontend.indexOf("function renderStaffDashboardOrderSources");
  const renderEnd = frontend.indexOf("function renderStaffDashboardPrimaryKpis", renderStart);
  if (summaryStart < 0 || summaryEnd < 0 || renderStart < 0 || renderEnd < 0) {
    failures.push("Frontend reference source bars: function boundaries are missing");
    return;
  }

  const summaryBody = frontend.slice(summaryStart, summaryEnd);
  const renderBody = frontend.slice(renderStart, renderEnd);
  checkPatterns(summaryBody, "Frontend reference source summary", [
    { name: "reference presentation order", pattern: /website[\s\S]*?staff-table[\s\S]*?qr-table[\s\S]*?room-service/m },
    { name: "existing normalized source key", pattern: /getStaffOrderSourceKey\(order\)/m },
    { name: "exact count accumulation", pattern: /counts\[normalizedKey\]\s*\+=\s*1/m },
    { name: "exact share formula", pattern: /share:\s*total\s*\?\s*\(counts\[definition\.key\]\s*\/\s*total\)\s*\*\s*100\s*:\s*0/m }
  ], failures);

  checkPatterns(renderBody, "Frontend reference source bars", [
    { name: "manager permission gate", pattern: /if\s*\(!isStaffManagerSession\(\)\)[\s\S]*?sourceWrap\.hidden\s*=\s*true/m },
    { name: "empty source state", pattern: /if\s*\(!summary\.total\)[\s\S]*?sourceEmpty\.hidden\s*=\s*false/m },
    { name: "accessible figure label", pattern: /staff-dashboard-source-figure is-horizontal-bars" aria-label="\$\{escapeHTML\(chartLabel\)\}"/m },
    { name: "horizontal source list", pattern: /staff-dashboard-source-bars[\s\S]*?summary\.entries[\s\S]*?staff-dashboard-source-bar-row/m },
    { name: "proportional fill", pattern: /staff-dashboard-source-bar-fill[\s\S]*?--staff-source-share:\s*\$\{escapeHTML\(entry\.share\.toFixed\(4\)\)\}%/m },
    { name: "accessible row values", pattern: /rowLabel[\s\S]*?entry\.count[\s\S]*?shareLabel[\s\S]*?aria-label="\$\{escapeHTML\(rowLabel\)\}"/m },
    { name: "truthful loaded-range caption", pattern: /proportions use the current Orders range\./m }
  ], failures);

  if (/staff-dashboard-source-track|staff-dashboard-source-segment/.test(renderBody)) {
    failures.push("Frontend reference source bars: old stacked source track is still rendered");
  }

  checkPatterns(html, "Reference source-bar CSS", [
    { name: "reference source card", pattern: /#staffHomePanel\s+\.staff-dashboard-source-card\s*\{[\s\S]*?border-radius:\s*12px[\s\S]*?background:\s*#fffdf9/m },
    { name: "compact source rows", pattern: /#staffHomePanel\s+\.staff-dashboard-source-bar-track\s*\{[\s\S]*?min-height:\s*35px[\s\S]*?border-radius:\s*7px/m },
    { name: "share-driven bar width", pattern: /#staffHomePanel\s+\.staff-dashboard-source-bar-fill\s*\{[\s\S]*?width:\s*var\(--staff-source-share,\s*0%\)/m },
    { name: "website blue-gray", pattern: /staff-dashboard-source-bar-fill\.is-website\s*\{[\s\S]*?background:\s*#86a3ad/m },
    { name: "staff sage", pattern: /staff-dashboard-source-bar-fill\.is-staff-table\s*\{[\s\S]*?background:\s*#9caf90/m },
    { name: "QR gold", pattern: /staff-dashboard-source-bar-fill\.is-qr-table\s*\{[\s\S]*?background:\s*#dfa954/m },
    { name: "room-service rose", pattern: /staff-dashboard-source-bar-fill\.is-room-service\s*\{[\s\S]*?background:\s*#bc8790/m },
    { name: "mobile source rows", pattern: /@media\s*\(max-width:\s*560px\)[\s\S]*?#staffHomePanel\s+\.staff-dashboard-source-bar-track\s*\{[\s\S]*?min-height:\s*38px/m },
    { name: "source reduced motion", pattern: /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?#staffHomePanel\s+\.staff-dashboard-source-bar-fill\s*\{[\s\S]*?transition:\s*none/m }
  ], failures);
}
function verifyReferenceRecentOrdersContracts(html, frontend, failures) {
  const dashboardStart = html.indexOf('<section id="staffHomePanel"');
  const dashboardEnd = html.indexOf('<section id="staffReportsPanel"', dashboardStart);
  const dashboard = dashboardStart >= 0 && dashboardEnd > dashboardStart
    ? html.slice(dashboardStart, dashboardEnd)
    : "";

  [
    'id="staffDashboardRecentOrdersHeading">Recent Orders</h3>',
    'staff-dashboard-recent-view-all"',
    'data-staff-view="orders">View all orders</button>',
    'id="staffDashboardRecentOrders" aria-busy="false" hidden',
    'id="staffDashboardRecentOrdersEmpty"',
    'role="status"',
    'aria-live="polite"',
    'Newest five records from the currently loaded Orders range.'
  ].forEach((contract) => {
    if (!dashboard.includes(contract)) {
      failures.push("HTML reference Recent Orders: missing " + contract);
    }
  });

  const renderStart = frontend.indexOf("function renderStaffDashboardRecentOrders");
  const renderEnd = frontend.indexOf("function setStaffDashboardSummaryEmpty", renderStart);
  const emptyStart = frontend.indexOf("function setStaffDashboardSummaryEmpty");
  const emptyEnd = frontend.indexOf("function renderStaffOrdersSummary", emptyStart);
  if (renderStart < 0 || renderEnd < 0 || emptyStart < 0 || emptyEnd < 0) {
    failures.push("Frontend reference Recent Orders: function boundaries are missing");
    return;
  }

  const renderBody = frontend.slice(renderStart, renderEnd);
  const emptyBody = frontend.slice(emptyStart, emptyEnd);
  const columnCount = renderBody.split('scope="col"').length - 1;
  if (columnCount !== 6) {
    failures.push("Frontend reference Recent Orders: expected six table columns, found " + columnCount);
  }

  [
    "if (!isStaffManagerSession())",
    "Array.isArray(orders) ? [...orders] : []",
    ".sort(compareStaffOrdersNewestFirst)",
    ".slice(0, 5)",
    '<table class="staff-dashboard-recent-table">',
    '<caption class="staff-sr-only">',
    "<thead>",
    "<tbody>",
    'scope="row" data-label="Order"',
    'data-label="Source"',
    'data-label="Table / room"',
    'data-label="Status"',
    'data-label="Time"',
    'data-label="Total"',
    "getStaffOrderSourceMeta(order)",
    'sourceMeta.key === "website" ? "—" : sourceDetail',
    'getStaffRecordStatusLabel(orderStatus, "order")',
    'getStaffRecordStatusBadgeClass(orderStatus, "order")',
    "formatOrderDate(createdAt)",
    "canStaffViewOrderFinancials(order)",
    "formatMoney(getStaffOrderTotal(order))",
    'aria-label="Total restricted">—</span>',
    "escapeHTML(sourceMeta.label)",
    "escapeHTML(locationLabel)",
    "escapeHTML(orderStatusLabel)"
  ].forEach((contract) => {
    if (!renderBody.includes(contract)) {
      failures.push("Frontend reference Recent Orders: missing " + contract);
    }
  });

  if (renderBody.includes('<ol class="staff-dashboard-recent-list">')) {
    failures.push("Frontend reference Recent Orders: old card list is still rendered");
  }
  if (renderBody.includes("addEventListener(") || renderBody.includes("fetch(")) {
    failures.push("Frontend reference Recent Orders: renderer gained a side effect");
  }

  [
    'recentOrdersWrap.setAttribute("aria-busy", String(!!isLoading))',
    "recentOrdersWrap.hidden = !isLoading",
    "staff-dashboard-recent-skeleton"
  ].forEach((contract) => {
    if (!emptyBody.includes(contract)) {
      failures.push("Frontend Recent Orders loading state: missing " + contract);
    }
  });

  const cssStart = html.indexOf("#staffHomePanel .staff-dashboard-home-module.is-recent-orders {");
  const cssEnd = html.indexOf("#staffHomePanel .staff-dashboard-operations-card {", cssStart);
  const recentCss = cssStart >= 0 && cssEnd > cssStart ? html.slice(cssStart, cssEnd) : "";
  [
    "grid-column: 1 / -1",
    "border-radius: 12px",
    "#staffHomePanel .staff-dashboard-recent-table {",
    "border-collapse: collapse",
    "table-layout: fixed",
    "padding: 10px 14px",
    "width: 12%",
    "width: 23%",
    ".staff-dashboard-recent-table .staff-badge",
    ".staff-dashboard-recent-total.is-restricted",
    "@media (max-width: 760px)",
    ".staff-dashboard-recent-table thead",
    ".staff-dashboard-recent-table tbody tr",
    "grid-template-columns: 88px minmax(0, 1fr)",
    "content: attr(data-label)",
    "@media (max-width: 420px)",
    "@media (prefers-reduced-motion: reduce)",
    "transition: none"
  ].forEach((contract) => {
    if (!recentCss.includes(contract)) {
      failures.push("Reference Recent Orders CSS: missing " + contract);
    }
  });
}
function verifyReferenceManagerInsightsContracts(html, frontend, failures) {
  const dashboardStart = html.indexOf('<section id="staffHomePanel"');
  const dashboardEnd = html.indexOf('<section id="staffReportsPanel"', dashboardStart);
  const dashboard = dashboardStart >= 0 && dashboardEnd > dashboardStart
    ? html.slice(dashboardStart, dashboardEnd)
    : "";

  [
    'class="staff-dashboard-home-module is-insights" aria-label="Manager insights"',
    'id="staffDashboardAiInsightsCopy"',
    'id="staffDashboardAiInsights"',
    'aria-busy="false"',
    'hidden aria-label="Manager insights"'
  ].forEach((contract) => {
    if (!dashboard.includes(contract)) {
      failures.push("HTML reference Manager Insights: missing " + contract);
    }
  });

  if (dashboard.includes("Manager AI insights")) {
    failures.push("HTML reference Manager Insights: unsupported AI label returned");
  }

  const renderStart = frontend.indexOf("function renderStaffDashboardAiInsights");
  const renderEnd = frontend.indexOf("function getStaffItemSalesReportSummary", renderStart);
  const emptyStart = frontend.indexOf("function setStaffDashboardSummaryEmpty");
  const emptyEnd = frontend.indexOf("function renderStaffOrdersSummary", emptyStart);
  if (renderStart < 0 || renderEnd < 0 || emptyStart < 0 || emptyEnd < 0) {
    failures.push("Frontend reference Manager Insights: function boundaries are missing");
    return;
  }

  const renderBody = frontend.slice(renderStart, renderEnd);
  const emptyBody = frontend.slice(emptyStart, emptyEnd);
  [
    "if (!isStaffManagerSession())",
    'insightsWrap.setAttribute("aria-busy", "false")',
    "getStaffDashboardAiInsightItems(reports, itemSalesReports)",
    "getStaffDashboardAiFeaturedLabel(reports, itemSalesReports)",
    "insightItems.findIndex",
    "insightItems.filter",
    "getStaffDashboardAiFeaturedBadgeLabel(featuredInsight.label)",
    "getStaffDashboardAiConfidenceNote(reports, itemSalesReports)",
    "getStaffDashboardAiFreshnessNote(reports, itemSalesReports)",
    "getPreferredStaffItemSalesPeriod(itemSalesReports)",
    "getStaffItemSalesReportSummary(itemSalesReports, sellerPeriod.key)",
    "sellerSummary?.topItems",
    ".slice(0, 2)",
    "quantitySold",
    "escapeHTML(itemName)",
    "<h3>Manager Insights</h3>",
    "Rule-based summary from the manager reports already loaded for this hotel.",
    '<span class="staff-manager-insights-rule-badge">Rule-based summary</span>',
    'class="staff-manager-insights-featured"',
    'class="staff-manager-insights-seller-list"',
    'class="staff-manager-insights-more"',
    "<summary>More verified insights",
    "secondaryInsights.length",
    "buildStaffDashboardAiInsightLine(label, copy)",
    'class="staff-manager-insights-footer"'
  ].forEach((contract) => {
    if (!renderBody.includes(contract)) {
      failures.push("Frontend reference Manager Insights: missing " + contract);
    }
  });

  if (
    renderBody.includes("staffFetchJson(") ||
    renderBody.includes("fetch(") ||
    renderBody.includes("addEventListener(") ||
    renderBody.includes("setInterval(")
  ) {
    failures.push("Frontend reference Manager Insights: renderer gained a side effect");
  }

  if (
    frontend.includes("Manager AI Insights") ||
    frontend.includes("Smart Waiter is waiting before calling out") ||
    frontend.includes("Smart Waiter is keeping the summary cautious") ||
    frontend.includes("current AI summary should be read")
  ) {
    failures.push("Frontend reference Manager Insights: unsupported AI-facing copy returned");
  }

  [
    'insightsWrap.setAttribute("aria-busy", String(!!isLoading))',
    "insightsWrap.hidden = !isLoading",
    "staff-manager-insights-skeleton"
  ].forEach((contract) => {
    if (!emptyBody.includes(contract)) {
      failures.push("Frontend Manager Insights loading state: missing " + contract);
    }
  });

  const cssStart = html.indexOf("#staffHomePanel #staffDashboardAiInsights {");
  const cssEnd = html.indexOf("#staffHomePanel .staff-dashboard-home-actions {", cssStart);
  const insightsCss = cssStart >= 0 && cssEnd > cssStart ? html.slice(cssStart, cssEnd) : "";
  [
    "border-radius: 12px",
    ".staff-manager-insights-head",
    ".staff-manager-insights-rule-badge",
    ".staff-manager-insights-featured",
    ".staff-manager-insights-seller-list",
    "grid-template-columns: minmax(0, 1fr) auto",
    ".staff-manager-insights-more summary",
    "min-height: 44px",
    ".staff-manager-insights-more summary:focus-visible",
    ".staff-manager-insights-footer",
    ".staff-manager-insights-skeleton",
    "@media (max-width: 560px)",
    "@media (prefers-reduced-motion: reduce)",
    "transition: none"
  ].forEach((contract) => {
    if (!insightsCss.includes(contract)) {
      failures.push("Reference Manager Insights CSS: missing " + contract);
    }
  });
}
function verifyReferenceOperationalAttentionContracts(html, frontend, failures) {
  const dashboardStart = html.indexOf('<section id="staffHomePanel"');
  const dashboardEnd = html.indexOf('<section id="staffReportsPanel"', dashboardStart);
  const dashboard = dashboardStart >= 0 && dashboardEnd > dashboardStart
    ? html.slice(dashboardStart, dashboardEnd)
    : "";

  [
    'id="staffDashboardSupportSummary"',
    'class="staff-summary-grid"',
    'aria-busy="false"',
    "Operational attention overview"
  ].forEach((contract) => {
    if (!dashboard.includes(contract)) {
      failures.push("HTML reference Operational Attention: missing " + contract);
    }
  });

  const renderStart = frontend.indexOf("function renderStaffDashboardSupportSummary");
  const renderEnd = frontend.indexOf("function renderStaffSupportSummary", renderStart);
  const emptyStart = frontend.indexOf("function setStaffDashboardSummaryEmpty");
  const emptyEnd = frontend.indexOf("function renderStaffOrdersSummary", emptyStart);
  const helperStart = frontend.indexOf("function getStaffDashboardPreparingCount");
  const helperEnd = frontend.indexOf("function renderStaffDashboardSupportSummary", helperStart);
  if (
    renderStart < 0 || renderEnd < 0 ||
    emptyStart < 0 || emptyEnd < 0 ||
    helperStart < 0 || helperEnd < 0
  ) {
    failures.push("Frontend reference Operational Attention: function boundaries are missing");
    return;
  }

  const renderBody = frontend.slice(renderStart, renderEnd);
  const emptyBody = frontend.slice(emptyStart, emptyEnd);
  const helperBody = frontend.slice(helperStart, helperEnd);
  const metricCount = renderBody.split('className: "is-').length - 1;
  if (metricCount !== 4) {
    failures.push("Frontend reference Operational Attention: expected four real metric definitions, found " + metricCount);
  }

  [
    "if (!isStaffManagerSession())",
    "value: String(orderStatusCounts.new || 0)",
    "value: String((orderStatusCounts.confirmed || 0) + (orderStatusCounts.preparing || 0))",
    "value: String(orderSummary.unbilledOrders || 0)",
    "STAFF_STATE.supportRequestsLoaded && supportRequests === STAFF_STATE.supportRequests",
    'value: supportDataAvailable ? String(openCount) : "—"',
    '<ul class="staff-dashboard-operations-metrics" aria-label="Operational attention values">',
    '<li class="staff-dashboard-operation-metric',
    'class="staff-dashboard-operation-dot" aria-hidden="true"',
    'class="staff-sr-only"',
    'id="staffDashboardOperationsLiveStatus"',
    'id="staffDashboardOperationsKitchenStatus"',
    "updateStaffDashboardOperationalStatusMirrors();"
  ].forEach((contract) => {
    if (!renderBody.includes(contract)) {
      failures.push("Frontend reference Operational Attention: missing " + contract);
    }
  });

  [
    "STAFF_STATE.kdsOrdersLoaded",
    "getStaffKdsStatusCounts(STAFF_STATE.kdsOrders).preparing",
    "getStaffOrderStatusNavigationCounts(STAFF_STATE.orders).preparing",
    'const liveSource = $("#staffLiveRefreshStatus")',
    "liveTarget.textContent = liveSource?.textContent",
    'const kitchenSource = $("#staffKitchenDisplayFreshness")',
    "kitchenTarget.textContent"
  ].forEach((contract) => {
    if (!helperBody.includes(contract)) {
      failures.push("Frontend Operational Attention mirrors: missing " + contract);
    }
  });

  const liveSetterStart = frontend.indexOf("function setStaffLiveRefreshStatus");
  const liveSetterEnd = frontend.indexOf("function updateStaffKitchenDisplayAlert", liveSetterStart);
  const freshnessStart = frontend.indexOf("function updateStaffKitchenDisplayFreshness");
  const freshnessEnd = frontend.indexOf("function stopStaffKitchenDisplayClock", freshnessStart);
  const liveSetterBody = liveSetterStart >= 0 && liveSetterEnd > liveSetterStart
    ? frontend.slice(liveSetterStart, liveSetterEnd)
    : "";
  const freshnessBody = freshnessStart >= 0 && freshnessEnd > freshnessStart
    ? frontend.slice(freshnessStart, freshnessEnd)
    : "";
  if (!liveSetterBody.includes("updateStaffDashboardOperationalStatusMirrors()")) {
    failures.push("Frontend Operational Attention mirrors: live setter does not refresh the mirror");
  }
  if (!freshnessBody.includes("updateStaffDashboardOperationalStatusMirrors()")) {
    failures.push("Frontend Operational Attention mirrors: kitchen freshness setter does not refresh the mirror");
  }

  [
    'supportSummaryWrap.setAttribute("aria-busy", String(!!isLoading))',
    "supportSummaryWrap.hidden = !isLoading",
    "staff-dashboard-operations-card is-skeleton",
    "staff-dashboard-operation-skeleton-row"
  ].forEach((contract) => {
    if (!emptyBody.includes(contract)) {
      failures.push("Frontend Operational Attention loading state: missing " + contract);
    }
  });

  const cssStart = html.indexOf("#staffHomePanel .staff-dashboard-operations-card {");
  const cssEnd = html.indexOf("#staffHomePanel #staffDashboardAiInsights {", cssStart);
  const operationsCss = cssStart >= 0 && cssEnd > cssStart ? html.slice(cssStart, cssEnd) : "";
  [
    "border-radius: 12px",
    "grid-template-columns: 12px minmax(0, 1fr) auto",
    "background: #63838e",
    ".is-in-progress .staff-dashboard-operation-dot",
    "background: #7f9673",
    ".is-billing-pending .staff-dashboard-operation-dot",
    "background: #d09a47",
    ".is-open-support .staff-dashboard-operation-dot",
    "background: #a85d6b",
    ".staff-dashboard-operation-status {",
    "border-radius: 999px",
    "@media (max-width: 560px)",
    "grid-template-columns: 1fr",
    "@media (prefers-reduced-motion: reduce)",
    "transition: none"
  ].forEach((contract) => {
    if (!operationsCss.includes(contract)) {
      failures.push("Reference Operational Attention CSS: missing " + contract);
    }
  });
}
function verifyDashboardContracts(html, frontend, failures) {
  const start = html.indexOf('<section id="staffHomePanel"');
  const end = html.indexOf('<section id="staffReportsPanel"', start);
  if (start < 0 || end < 0) {
    failures.push("HTML dashboard: panel boundaries are missing");
    return;
  }
  const dashboard = html.slice(start, end);
  const requiredIds = [
    "staffHomePanel", "staffDashboardLastUpdated", "staffDashboardSummary",
    "staffDashboardEmpty", "staffDashboardTrendHeading", "staffDashboardTrendSummary",
    "staffDashboardTrendComparison", "staffDashboardTrend", "staffDashboardTrendEmpty",
    "staffDashboardTrendError", "staffDashboardAiInsightsCopy", "staffDashboardAiInsights",
    "staffDashboardSupportSummary", "staffDashboardOrderSourcesHeading",
    "staffDashboardOrderSources", "staffDashboardOrderSourcesEmpty",
    "staffDashboardRecentOrdersHeading", "staffDashboardRecentOrders",
    "staffDashboardRecentOrdersEmpty"
  ];
  requiredIds.forEach((id) => {
    const count = (dashboard.match(new RegExp('id="' + id + '"', "g")) || []).length;
    if (count !== 1) failures.push("HTML dashboard: expected one #" + id + ", found " + count);
  });

  if (/Sold-item patterns|staffDashboardItemSales|staff-dashboard-home-actions|staff-dashboard-shortcuts/.test(dashboard)) {
    failures.push("HTML dashboard: duplicate sold-item or Quick Actions block remains in the Dashboard layout");
  }

  if (/buildStaffDashboardTrendPath|staff-dashboard-trend-svg/.test(frontend)) {
    failures.push("Frontend dashboard: legacy SVG trend renderer remains beside Chart.js");
  }

  checkPatterns(dashboard, "HTML dashboard", [
    { name: "scoped shell", pattern: /id="staffHomePanel"[^>]*staff-dashboard-home/m },
    { name: "KPI busy state", pattern: /id="staffDashboardSummary"[^>]*aria-busy="false"/m },
    { name: "source busy state", pattern: /id="staffDashboardOrderSources"[^>]*aria-busy="false"/m },
    { name: "recent busy state", pattern: /id="staffDashboardRecentOrders"[^>]*aria-busy="false"/m },
    { name: "trend busy state", pattern: /id="staffDashboardTrend"[^>]*aria-busy="false"/m },
    { name: "KPI status region", pattern: /id="staffDashboardEmpty"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/m },
    { name: "source status region", pattern: /id="staffDashboardOrderSourcesEmpty"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/m },
    { name: "recent status region", pattern: /id="staffDashboardRecentOrdersEmpty"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/m },
    { name: "trend status region", pattern: /id="staffDashboardTrendEmpty"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/m },
    { name: "trend retry state", pattern: /id="staffDashboardTrendError"[^>]*role="alert"[\s\S]*?data-staff-dashboard-trend-retry/m },
    { name: "source loaded range", pattern: /id="staffDashboardOrderSourcesHeading"[\s\S]*?currently loaded Orders range/m },
    { name: "recent loaded range", pattern: /id="staffDashboardRecentOrdersHeading"[\s\S]*?currently loaded Orders range/m },
    { name: "View all orders", pattern: /data-staff-view="orders"[^>]*>\s*View all orders\s*</m },
    { name: "analytics and source composition", pattern: /class="staff-dashboard-analytics-card"[\s\S]*?class="staff-dashboard-trend-card"[\s\S]*?class="staff-dashboard-source-card"/m },
    { name: "operational attention follows analytics", pattern: /is-analytics[\s\S]*?is-support[\s\S]*?is-recent-orders[\s\S]*?is-insights/m }
  ], failures);

  checkPatterns(html, "Dashboard CSS", [
    { name: "scoped tokens", pattern: /#staffHomePanel\.staff-dashboard-home\s*\{[\s\S]*?--dashboard-home-gap/m },
    { name: "reference desktop grid", pattern: /#staffHomePanel\s+\.staff-dashboard-home-data-grid\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*3\.15fr\)\s+minmax\(238px,\s*1fr\)/m },
    { name: "combined analytics grid", pattern: /#staffHomePanel\s+\.staff-dashboard-analytics-card\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1\.72fr\)\s+minmax\(230px,\s*0\.95fr\)/m },
    { name: "source share", pattern: /#staffHomePanel\s+\.staff-dashboard-source-bar-fill\s*\{[\s\S]*?--staff-source-share/m },
    { name: "KPI cards", pattern: /#staffHomePanel\s+\.staff-dashboard-kpi-card\s*\{/m },
    { name: "operations", pattern: /#staffHomePanel\s+\.staff-dashboard-operations-card\s*\{/m },
    { name: "recent table", pattern: /#staffHomePanel\s+\.staff-dashboard-recent-table\s*\{/m },
    { name: "compact Chart.js canvas", pattern: /#staffHomePanel\s+\.staff-dashboard-trend-visual\s+canvas\s*\{[\s\S]*?height:\s*170px\s*!important/m },
    { name: "dashboard hidden states win", pattern: /#staffHomePanel\s+\.staff-empty\[hidden\],[\s\S]*?staff-dashboard-recent-empty\[hidden\][\s\S]*?display:\s*none/m },
    { name: "mobile analytics stack", pattern: /@media\s*\(max-width:\s*680px\)[\s\S]*?#staffHomePanel\s+\.staff-dashboard-analytics-card\s*\{[\s\S]*?grid-template-columns:\s*1fr/m },
    { name: "44px View all", pattern: /#staffHomePanel\s+\.staff-dashboard-recent-view-all\s*\{[\s\S]*?min-height:\s*44px/m },
    { name: "900px breakpoint", pattern: /@media\s*\(max-width:\s*900px\)[\s\S]*?#staffHomePanel/m },
    { name: "414px breakpoint", pattern: /@media\s*\(max-width:\s*414px\)[\s\S]*?#staffHomePanel/m },
    { name: "reduced motion", pattern: /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?#staffHomePanel/m }
  ], failures);

  const renderers = [
    "renderStaffDashboardPrimaryKpis", "renderStaffDashboardOrderSources",
    "renderStaffDashboardRecentOrders", "renderStaffDashboardSupportSummary",
    "renderStaffDashboardReports", "renderStaffDashboardAiInsights",
    "renderStaffDashboardTrend", "renderStaffOrdersSummary"
  ];
  renderers.forEach((name) => {
    const functionStart = frontend.indexOf("function " + name + "(");
    const functionEnd = frontend.indexOf("\nfunction ", functionStart + 1);
    if (functionStart < 0) {
      failures.push("Frontend dashboard: missing " + name);
      return;
    }
    const body = frontend.slice(functionStart, functionEnd < 0 ? frontend.length : functionEnd);
    ["staffFetchJson(", "fetch(", "setInterval(", "addEventListener("].forEach((effect) => {
      if (body.includes(effect)) failures.push("Frontend dashboard: " + name + " gained side effect " + effect);
    });
  });
  [
    "renderStaffDashboardPrimaryKpis", "renderStaffDashboardOrderSources",
    "renderStaffDashboardRecentOrders", "renderStaffDashboardSupportSummary",
    "renderStaffDashboardTrend", "renderStaffOrdersSummary"
  ].forEach((name) => {
    const functionStart = frontend.indexOf("function " + name + "(");
    const functionEnd = frontend.indexOf("\nfunction ", functionStart + 1);
    const body = functionStart < 0 ? "" : frontend.slice(functionStart, functionEnd < 0 ? frontend.length : functionEnd);
    if (!/isStaffManagerSession\(\)/.test(body)) failures.push("Frontend dashboard: " + name + " lost its manager gate");
  });

  checkPatterns(frontend, "Frontend dashboard", [
    { name: "today report reuse", pattern: /function\s+renderStaffDashboardPrimaryKpis[\s\S]*?reports\?\.today/m },
    { name: "reference source order", pattern: /function\s+getStaffDashboardOrderSourceSummary[\s\S]*?website[\s\S]*?staff-table[\s\S]*?qr-table[\s\S]*?room-service/m },
    { name: "recent copied newest five", pattern: /function\s+renderStaffDashboardRecentOrders[\s\S]*?\[\.\.\.orders\][\s\S]*?\.sort\(compareStaffOrdersNewestFirst\)[\s\S]*?\.slice\(0,\s*5\)/m },
    { name: "recent financial gate", pattern: /function\s+renderStaffDashboardRecentOrders[\s\S]*?canStaffViewOrderFinancials/m },
    { name: "support identity guard", pattern: /function\s+renderStaffDashboardSupportSummary[\s\S]*?supportRequestsLoaded\s*&&\s*supportRequests\s*===\s*STAFF_STATE\.supportRequests/m },
    { name: "render chain", pattern: /function\s+renderStaffOrdersSummary[\s\S]*?renderStaffDashboardPrimaryKpis\([\s\S]*?renderStaffDashboardOrderSources\([\s\S]*?renderStaffDashboardRecentOrders\([\s\S]*?renderStaffDashboardSupportSummary\(/m },
    { name: "single Chart.js canvas renderer", pattern: /function\s+renderStaffDashboardTrend\([\s\S]*?staffDashboardTrendCanvas[\s\S]*?new\s+window\.Chart/m },
    { name: "responsive fixed-container chart", pattern: /new\s+window\.Chart[\s\S]*?responsive:\s*true[\s\S]*?maintainAspectRatio:\s*false/m },
    { name: "interactive chart tooltip", pattern: /new\s+window\.Chart[\s\S]*?interaction:\s*\{\s*mode:\s*"index",\s*intersect:\s*false\s*\}[\s\S]*?tooltip:/m },
    { name: "chart lifecycle cleanup", pattern: /function\s+destroyStaffDashboardTrendChart[\s\S]*?\.destroy\(\)[\s\S]*?function\s+renderStaffDashboardTrend[\s\S]*?destroyStaffDashboardTrendChart\(\)/m },
    { name: "isolated trend retry", pattern: /data-staff-dashboard-trend-retry[\s\S]*?loadStaffDashboardTrend\(\)/m },
    { name: "isolated order widget retry", pattern: /data-staff-dashboard-orders-retry[\s\S]*?loadStaffOrders\(\)/m }
  ], failures);

  checkPatterns(html, "Dashboard scripts", [
    { name: "deployable local Chart.js and review notification dependencies load before Staff Orders", pattern: /<script src="vendor\/chart\.umd\.js" defer><\/script>\s*<script src="js\/review-avatar\.js" defer><\/script>\s*<script src="js\/staff-notification-cards\.js" defer><\/script>\s*<script src="js\/staff-orders\.js" defer><\/script>/m }
  ], failures);
}


function verifyNewestFirstRuntime(frontend, failures) {
  try {
    const document = {
      addEventListener() {},
      documentElement: { clientHeight: 800 },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      visibilityState: "visible"
    };
    let scrollAdjustment = null;
    const window = {
      addEventListener() {},
      APP_RUNTIME_CONFIG: {},
      document,
      innerHeight: 800,
      innerWidth: 1440,
      pageYOffset: 500,
      requestAnimationFrame(callback) { callback(); },
      scrollBy(options) { scrollAdjustment = options; },
      scrollY: 500,
      location: {
        hostname: "localhost",
        origin: "http://localhost:5500",
        search: ""
      }
    };
    window.window = window;

    const context = vm.createContext({
      URLSearchParams,
      console: {
        error() {},
        log() {},
        warn() {}
      },
      document,
      window
    });

    vm.runInContext(frontend, context, {
      filename: "frontend/js/staff-orders.js"
    });
    vm.runInContext(
      "globalThis.__staffOrdersSortHooks = { normalizeStaffOrdersForDisplay, getStaffOrdersScrollAnchorState, restoreStaffOrdersScrollAnchorState, getStaffOrderSourceFreshCount, markStaffOrderSourcesFresh, clearStaffOrderSourceFreshCount, getStaffOrderSourceAsyncState, syncStaffOrderSourceCardSelection, revealStaffOrdersManagement, getStaffDashboardActiveOrderSummary, getStaffDashboardOrderSourceSummary, state: STAFF_STATE };",
      context
    );

    const activeSummary = context.__staffOrdersSortHooks.getStaffDashboardActiveOrderSummary([
      { status: "new" }, { status: "confirmed" }, { status: "preparing" },
      { status: "completed" }, { status: "cancelled" }
    ]);
    if (
      activeSummary.total !== 3 || activeSummary.new !== 1 ||
      activeSummary.confirmed !== 1 || activeSummary.preparing !== 1
    ) {
      failures.push("Frontend runtime: dashboard active-order summary changed");
    }

    const sourceSummary = context.__staffOrdersSortHooks.getStaffDashboardOrderSourceSummary([
      { orderSource: "qr", tableNumber: "T1" },
      { orderSource: "staff", tableNumber: "T2" },
      { orderSource: "room_service", orderType: "room_service" },
      { orderSource: "website" }
    ]);
    const sourceSignature = Array.from(
      sourceSummary.entries,
      (entry) => entry.key + ":" + entry.count + ":" + entry.share
    ).join(",");
    if (
      sourceSummary.total !== 4 ||
      sourceSignature !== "website:1:25,staff-table:1:25,qr-table:1:25,room-service:1:25"
    ) {
      failures.push("Frontend runtime: dashboard order-source arithmetic changed (" + sourceSignature + ")");
    }

    const fixtures = [
      { id: "2", createdAt: "2026-07-13T11:00:00.000Z", status: "new" },
      { id: "20", createdAt: "2026-07-13T12:00:00.000Z", status: "new" },
      { id: "10", createdAt: "2026-07-13T11:00:00.000Z", status: "completed" },
      { id: "20", createdAt: "2026-07-13T12:00:00.000Z", status: "preparing" },
      { id: "old", createdAt: "2026-07-12T09:00:00.000Z", status: "confirmed" }
    ];
    const originalIds = fixtures.map((order) => order.id).join(",");
    const normalized = context.__staffOrdersSortHooks.normalizeStaffOrdersForDisplay(fixtures);
    const normalizedIds = Array.from(normalized, (order) => String(order.id)).join(",");

    if (normalizedIds !== "20,10,2,old") {
      failures.push(`Frontend runtime: newest-first order mismatch (${normalizedIds})`);
    }

    if (normalized.length !== 4) {
      failures.push(`Frontend runtime: duplicate order IDs were not removed (${normalized.length})`);
    }

    if (fixtures.map((order) => order.id).join(",") !== originalIds) {
      failures.push("Frontend runtime: normalization mutated the API response array");
    }

    const statusOnlyChange = fixtures
      .filter((order, index) => index !== 3)
      .map((order) => order.id === "old" ? { ...order, status: "completed" } : order);
    const afterStatusChange = context.__staffOrdersSortHooks
      .normalizeStaffOrdersForDisplay(statusOnlyChange)
      .map((order) => String(order.id))
      .join(",");

    if (afterStatusChange !== "20,10,2,old") {
      failures.push("Frontend runtime: a status-only update changed creation-time ordering");
    }
    const asyncStateExpectations = {
      qr: "QR Orders",
      staff: "Staff Orders",
      website: "Website Orders"
    };
    Object.entries(asyncStateExpectations).forEach(([sourceCard, label]) => {
      const asyncState = context.__staffOrdersSortHooks.getStaffOrderSourceAsyncState(sourceCard);
      if (
        asyncState.loadingTitle !== `Loading ${label}...` ||
        asyncState.errorTitle !== `${label} could not be loaded` ||
        !asyncState.loadingCopy.includes(label) ||
        !asyncState.errorHint.includes(label)
      ) {
        failures.push(`Frontend runtime: ${sourceCard} loading/error state lost its source label`);
      }
    });
    const genericAsyncState = context.__staffOrdersSortHooks.getStaffOrderSourceAsyncState("");
    if (
      genericAsyncState.loadingTitle !== "Loading staff orders..." ||
      genericAsyncState.errorTitle !== "Orders could not be loaded"
    ) {
      failures.push("Frontend runtime: no-source loading/error fallback changed");
    }

    context.__staffOrdersSortHooks.state.selectedOrderSourceCard = "qr";
    context.__staffOrdersSortHooks.state.orderSourceFreshCounts = { qr: 0, staff: 0, website: 0 };
    context.__staffOrdersSortHooks.markStaffOrderSourcesFresh([
      { id: "fresh-qr", orderSource: "qr" },
      { id: "fresh-staff", orderSource: "staff" },
      { id: "fresh-room", orderSource: "room_service", orderType: "room_service" },
      { id: "fresh-web", orderSource: "website" }
    ]);
    const sourceFreshCounts = context.__staffOrdersSortHooks.state.orderSourceFreshCounts;
    if (
      sourceFreshCounts.qr !== 0 ||
      sourceFreshCounts.staff !== 2 ||
      sourceFreshCounts.website !== 1
    ) {
      failures.push("Frontend runtime: unseen orders were not assigned to the correct inactive source cards");
    }

    context.__staffOrdersSortHooks.clearStaffOrderSourceFreshCount("staff");
    if (
      context.__staffOrdersSortHooks.getStaffOrderSourceFreshCount("staff") !== 0 ||
      context.__staffOrdersSortHooks.getStaffOrderSourceFreshCount("website") !== 1
    ) {
      failures.push("Frontend runtime: opening one source cleared unrelated fresh-order counts");
    }

    const compactGridClasses = new Set();
    const sourceCardGrid = {
      classList: {
        toggle(className, force) {
          if (force) compactGridClasses.add(className);
          else compactGridClasses.delete(className);
        }
      }
    };
    let managementRevealOptions = null;
    const managementState = {
      hidden: true,
      scrollIntoView(options) {
        managementRevealOptions = options;
      }
    };
    const promptState = { hidden: false };
    const sourceButtons = ["qr", "staff", "website"].map((sourceCard) => ({
      sourceCard,
      pressed: "false",
      classList: { toggle() {} },
      getAttribute(name) {
        return name === "data-staff-order-source-card" ? this.sourceCard : "";
      },
      setAttribute(name, value) {
        if (name === "aria-pressed") this.pressed = value;
      }
    }));
    document.querySelector = (selector) => ({
      "#staffOrdersSourceCards": sourceCardGrid,
      "#staffOrdersManagement": managementState,
      "#staffOrdersSourcePrompt": promptState
    })[selector] || null;
    document.querySelectorAll = (selector) =>
      selector === "[data-staff-order-source-card]" ? sourceButtons : [];
    context.__staffOrdersSortHooks.state.selectedOrderSourceCard = "staff";
    context.__staffOrdersSortHooks.syncStaffOrderSourceCardSelection();
    if (
      !compactGridClasses.has("is-compact") ||
      managementState.hidden ||
      !promptState.hidden ||
      sourceButtons.find((button) => button.sourceCard === "staff")?.pressed !== "true"
    ) {
      failures.push("Frontend runtime: selected source did not enable the compact card state safely");
    }

    context.__staffOrdersSortHooks.revealStaffOrdersManagement("staff");
    if (
      managementRevealOptions?.behavior !== "smooth" ||
      managementRevealOptions?.block !== "start"
    ) {
      failures.push("Frontend runtime: explicit source selection did not reveal management safely");
    }

    managementRevealOptions = null;
    context.__staffOrdersSortHooks.state.selectedOrderSourceCard = "qr";
    context.__staffOrdersSortHooks.revealStaffOrdersManagement("staff");
    if (managementRevealOptions !== null) {
      failures.push("Frontend runtime: stale source reveal moved a different selected queue");
    }

    context.__staffOrdersSortHooks.state.selectedOrderSourceCard = "";
    context.__staffOrdersSortHooks.syncStaffOrderSourceCardSelection();
    if (
      compactGridClasses.has("is-compact") ||
      !managementState.hidden ||
      promptState.hidden
    ) {
      failures.push("Frontend runtime: returning to source selection did not restore the full card state");
    }

    let anchorTop = 100;
    let contentTop = -200;
    const anchorCard = {
      getBoundingClientRect() {
        return { top: anchorTop, bottom: anchorTop + 220 };
      }
    };
    const anchorDetails = {
      dataset: { orderId: "10" },
      closest(selector) {
        return selector === ".staff-order-card" ? anchorCard : null;
      }
    };
    const ordersContent = {
      getBoundingClientRect() {
        return { top: contentTop };
      },
      querySelectorAll(selector) {
        return selector === "[data-staff-order-details]" ? [anchorDetails] : [];
      }
    };
    document.querySelector = (selector) =>
      selector === "#staffOrdersContent" ? ordersContent : null;
    context.__staffOrdersSortHooks.state.activeView = "orders";
    context.__staffOrdersSortHooks.state.selectedOrderSourceCard = "qr";

    const scrollAnchorState = context.__staffOrdersSortHooks.getStaffOrdersScrollAnchorState();
    if (
      scrollAnchorState?.orderId !== "10" ||
      scrollAnchorState?.sourceCard !== "qr" ||
      scrollAnchorState?.top !== 100
    ) {
      failures.push("Frontend runtime: visible order scroll anchor was not captured");
    }

    anchorTop = 240;
    context.__staffOrdersSortHooks.restoreStaffOrdersScrollAnchorState(scrollAnchorState);
    if (scrollAdjustment?.top !== 140 || scrollAdjustment?.behavior !== "auto") {
      failures.push("Frontend runtime: silent refresh did not restore the visible order anchor");
    }

    scrollAdjustment = null;
    anchorTop = 100;
    const guardedScrollState = context.__staffOrdersSortHooks.getStaffOrdersScrollAnchorState();
    anchorTop = 240;
    window.scrollY = 540;
    context.__staffOrdersSortHooks.restoreStaffOrdersScrollAnchorState(guardedScrollState);
    if (scrollAdjustment !== null) {
      failures.push("Frontend runtime: scroll restoration overrode a newer user scroll");
    }

    window.scrollY = 500;
    contentTop = 20;
    if (context.__staffOrdersSortHooks.getStaffOrdersScrollAnchorState() !== null) {
      failures.push("Frontend runtime: scroll anchor was captured before the user entered the order list");
    }
  } catch (error) {
    failures.push(`Frontend runtime: newest-first verifier could not run (${error.message || error})`);
  }
}

function verifyStaffTrendRuntime(failures) {
  try {
    delete require.cache[require.resolve(staffTrendPath)];
    const {
      buildStaffOrderTrend,
      getStaffTrendPeriod,
      getZonedDateKey,
      normalizeStaffReportTimeZone
    } = require(staffTrendPath);
    const period = getStaffTrendPeriod({
      now: new Date("2026-07-13T18:45:00.000Z"),
      timeZone: "Asia/Kolkata"
    });

    if (period.from !== "2026-07-08" || period.to !== "2026-07-14" || period.days !== 7) {
      failures.push("Backend trend runtime: seven-day hotel-time period is incorrect");
    }
    if (period.queryStart?.toISOString() !== "2026-06-30T18:30:00.000Z") {
      failures.push("Backend trend runtime: comparison query boundary is not Asia/Kolkata midnight");
    }
    if (normalizeStaffReportTimeZone("Invalid/Timezone") !== "Asia/Kolkata") {
      failures.push("Backend trend runtime: invalid timezone does not fall back safely");
    }
    if (getZonedDateKey("2026-07-07T18:31:00.000Z", "Asia/Kolkata") !== "2026-07-08") {
      failures.push("Backend trend runtime: timezone boundary grouped into the wrong hotel day");
    }

    const orders = [
      { created_at: "2026-07-07T18:31:00.000Z", status: "completed", payment_status: "paid", total: 1000.25 },
      { created_at: "2026-07-09T06:00:00.000Z", status: "new", payment_status: "unpaid", total: 500 },
      { created_at: "2026-07-10T06:00:00.000Z", status: "cancelled", payment_status: "paid", total: 900 },
      { created_at: "2026-07-11T06:00:00.000Z", status: "completed", payment_status: "refunded", total: 700 },
      { created_at: "2026-07-12T06:00:00.000Z", status: "completed", payment_status: "paid", total: 99999999.99 },
      { created_at: "2026-07-06T06:00:00.000Z", status: "completed", payment_status: "paid", total: 500 },
      { created_at: "not-a-date", status: "completed", payment_status: "paid", total: 999 }
    ];
    const trend = buildStaffOrderTrend({
      orders,
      period,
      getOrderTotal: (order) => order.total
    });

    if (trend.points.length !== 7 || trend.points.some((point) => !Object.hasOwn(point, "revenue"))) {
      failures.push("Backend trend runtime: response is not a zero-filled seven-point series");
    }
    if (trend.summary.orderCount !== 4) {
      failures.push("Backend trend runtime: pending/refunded order counts or cancelled exclusion changed");
    }
    if (trend.summary.revenue !== 100001000.24) {
      failures.push("Backend trend runtime: paid revenue, refund exclusion, or large-value precision changed");
    }
    if (trend.summary.previousRevenue !== 500 || !Number.isFinite(trend.summary.comparisonPercent)) {
      failures.push("Backend trend runtime: previous-period comparison is inaccurate");
    }

    const emptyTrend = buildStaffOrderTrend({ orders: [], period, getOrderTotal: () => 0 });
    if (
      emptyTrend.points.length !== 7 ||
      emptyTrend.points.some((point) => point.orderCount !== 0 || point.revenue !== 0)
    ) {
      failures.push("Backend trend runtime: zero-data dates are not preserved");
    }
  } catch (error) {
    failures.push(`Backend trend runtime: verifier could not run (${error.message || error})`);
  }
}

function main() {
  const html = readSource(staffHtmlPath, "staff-orders.html");
  const frontend = readSource(staffJsPath, "staff-orders.js");
  const backend = readSource(staffRoutesPath, "backend staff routes");
  const failures = [];

  const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), (match) => match[1]);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicateIds.length) {
    failures.push(`HTML: duplicate ids found: ${Array.from(new Set(duplicateIds)).join(", ")}`);
  }

  verifyReferenceSidebarContracts(html, frontend, failures);
  verifyReferenceHeaderContracts(html, frontend, failures);
  verifyReferenceOverviewHeaderContracts(html, frontend, failures);
  verifyReferenceKpiContracts(html, frontend, failures);
  verifyReferenceSourceBarsContracts(html, frontend, failures);
  verifyReferenceRecentOrdersContracts(html, frontend, failures);
  verifyReferenceManagerInsightsContracts(html, frontend, failures);
  verifyReferenceOperationalAttentionContracts(html, frontend, failures);
  verifyDashboardContracts(html, frontend, failures);
  verifyStaffTrendRuntime(failures);

  const sourceFreshIndicatorCount = (html.match(/data-staff-order-source-fresh/g) || []).length;
  if (sourceFreshIndicatorCount !== 3) {
    failures.push(`HTML: expected 3 source fresh-order indicators, found ${sourceFreshIndicatorCount}`);
  }

  checkPatterns(html, "HTML", [
    { name: "scoped Staff Orders workspace", pattern: /id="staffOrdersPanel"[^>]*staff-orders-workspace/m },
    { name: "QR source card", pattern: /data-staff-order-source-card="qr"[^>]*aria-pressed="false"[^>]*aria-controls="staffOrdersManagement"/m },
    { name: "Staff source card", pattern: /data-staff-order-source-card="staff"[^>]*aria-pressed="false"[^>]*aria-controls="staffOrdersManagement"/m },
    { name: "Website source card", pattern: /data-staff-order-source-card="website"[^>]*aria-pressed="false"[^>]*aria-controls="staffOrdersManagement"/m },
    { name: "no-source prompt", pattern: /id="staffOrdersSourcePrompt"[^>]*role="status"[^>]*aria-busy="false"/m },
    { name: "source refresh action", pattern: /id="staffRefreshOrderSourcesBtn"[^>]*type="button"/m },
    { name: "fresh source indicator markup", pattern: /class="staff-orders-source-fresh-indicator"[^>]*data-staff-order-source-fresh[^>]*hidden>Unread<\/span>/m },
    { name: "source count semantics", pattern: /data-staff-order-source-count>0<\/strong><span>In range<\/span>[\s\S]*?data-staff-order-source-new-count>0<\/strong><span>Awaiting<\/span>/m },
    { name: "fresh source indicator scoped style", pattern: /\.staff-orders-workspace\s+\.staff-orders-source-fresh-indicator\s*\{/m },
    { name: "selected source compact card style", pattern: /\.staff-orders-workspace\s+\.staff-orders-source-grid\.is-compact\s+\.staff-orders-source-card\s*\{[\s\S]*?min-height:\s*152px;[\s\S]*?padding:\s*14px;/m },
    { name: "compact mobile card spacing", pattern: /@media\s*\(max-width:\s*760px\)[\s\S]*?\.staff-orders-source-grid\.is-compact\s+\.staff-orders-source-card\s*\{[\s\S]*?padding:\s*12px;[\s\S]*?gap:\s*8px;/m },
    { name: "compact narrow metrics remain visible", pattern: /@media\s*\(max-width:\s*380px\)[\s\S]*?\.staff-orders-source-grid\.is-compact\s+\.staff-orders-source-card-metrics\s*\{[\s\S]*?repeat\(2,[\s\S]*?\.staff-orders-source-card-metric\.is-latest\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1/m },
    { name: "source prompt retry action", pattern: /id="staffOrdersSourcePrompt"[\s\S]*?data-staff-orders-retry[^>]*hidden/m },
    { name: "source selection live region", pattern: /id="staffOrdersSourceSelectionStatus"[^>]*aria-live="polite"[^>]*aria-atomic="true"/m },
    { name: "management hidden until selection", pattern: /id="staffOrdersManagement"[^>]*hidden/m },
    { name: "back to sources action", pattern: /id="staffOrdersBackToSourcesBtn"[^>]*type="button"/m },
    { name: "search control preserved", pattern: /id="staffOrdersSearchInput"/m },
    { name: "range control preserved", pattern: /id="staffOrdersRangeInput"/m },
    { name: "source control preserved", pattern: /id="staffOrdersSourceInput"/m },
    { name: "status control preserved", pattern: /id="staffOrdersStatusInput"/m },
    { name: "order content container preserved", pattern: /id="staffOrdersContent"[^>]*aria-live="polite"[^>]*aria-busy="false"/m },
    { name: "action live region", pattern: /id="staffOrdersActionStatus"[^>]*aria-live="polite"[^>]*aria-atomic="true"/m },
    { name: "room-service filter", pattern: /option value="room-service">Room service orders<\/option>/m },
    { name: "payment-pending filter", pattern: /data-staff-order-status-filter="payment_pending"/m },
    { name: "payment-failed filter", pattern: /data-staff-order-status-filter="payment_failed"/m },
    { name: "mobile sidebar close control", pattern: /id="staffSidebarCloseBtn"/m },
    { name: "mobile sidebar backdrop", pattern: /id="staffSidebarBackdrop"/m },
    { name: "1080px breakpoint", pattern: /@media\s*\(max-width:\s*1080px\)/m },
    { name: "760px breakpoint", pattern: /@media\s*\(max-width:\s*760px\)/m },
    { name: "380px breakpoint", pattern: /@media\s*\(max-width:\s*380px\)/m },
    { name: "reduced-motion support", pattern: /@media\s*\(prefers-reduced-motion:\s*reduce\)/m },
    { name: "long-content wrapping", pattern: /overflow-wrap:\s*anywhere/m }
  ], failures);

  checkPatterns(frontend, "Frontend", [
    { name: "normal order statuses unchanged", pattern: /const\s+STAFF_ORDER_STATUS_OPTIONS\s*=\s*\["new",\s*"confirmed",\s*"preparing",\s*"completed",\s*"cancelled"\];/m },
    { name: "payment exceptions kept separate", pattern: /const\s+STAFF_ORDER_PAYMENT_EXCEPTION_STATUSES\s*=\s*\["payment_pending",\s*"payment_failed"\];/m },
    { name: "source card state", pattern: /selectedOrderSourceCard:\s*""/m },
    { name: "QR source mapping", pattern: /qr:\s*\{[\s\S]*?sourceKeys:\s*\["qr-table"\]/m },
    { name: "Staff and room-service source mapping", pattern: /staff:\s*\{[\s\S]*?sourceKeys:\s*\["staff-table",\s*"room-service"\]/m },
    { name: "Website source mapping", pattern: /website:\s*\{[\s\S]*?sourceKeys:\s*\["website"\]/m },
    { name: "source-card filtering helper", pattern: /function\s+getStaffOrdersForSourceCard\(sourceCard\s*=\s*"",\s*orders\s*=\s*STAFF_STATE\.orders\)/m },
    { name: "source-card selection controller", pattern: /function\s+selectStaffOrderSourceCard\(\s*sourceCard\s*=\s*""/m },
    { name: "selection toggles compact source cards", pattern: /function\s+syncStaffOrderSourceCardSelection[\s\S]*?sourceCardGrid\.classList\.toggle\("is-compact",\s*!!selectedSourceCard\)[\s\S]*?management\.hidden\s*=\s*!selectedSourceCard/m },
    { name: "source fresh-count state", pattern: /orderSourceFreshCounts:\s*\{\s*qr:\s*0,\s*staff:\s*0,\s*website:\s*0\s*\}/m },
    { name: "inactive-source fresh grouping", pattern: /function\s+markStaffOrderSourcesFresh[\s\S]*?sourceCard\s*===\s*selectedSourceCard[\s\S]*?nextFreshCounts\[sourceCard\]/m },
    { name: "source-open fresh clear", pattern: /function\s+selectStaffOrderSourceCard[\s\S]*?clearStaffOrderSourceFreshCount\(normalizedSourceCard\)[\s\S]*?renderStaffOrderSourceCards/m },
    { name: "polling reuses fresh order detection", pattern: /const\s+freshOrders\s*=\s*silent\s*\?\s*getNewStaffRecords\(previousOrders,\s*nextOrders\)\s*:\s*\[\];\s*markStaffOrderSourcesFresh\(freshOrders\);\s*handleStaffFreshRecords\("orders",\s*freshOrders\);/m },
    { name: "source fresh counts reset with session", pattern: /function\s+resetStaffDashboardState[\s\S]*?orderSourceFreshCounts\s*=\s*\{\s*qr:\s*0,\s*staff:\s*0,\s*website:\s*0\s*\}/m },
    { name: "source loading and error state", pattern: /function\s+setStaffOrderSourcePromptState\([\s\S]*?canRetry/m },
    { name: "source-specific async-state labels", pattern: /function\s+getStaffOrderSourceAsyncState[\s\S]*?Loading \$\{definition\.label\}[\s\S]*?\$\{definition\.label\} could not be loaded/m },
    { name: "source-specific loading state", pattern: /function\s+setStaffOrdersLoading[\s\S]*?getStaffOrderSourceAsyncState\(selectedSourceCard\)[\s\S]*?role",\s*"status"[\s\S]*?sourceState\.loadingCopy/m },
    { name: "source-specific error preserves retry and alert", pattern: /function\s+renderStaffOrdersLoadError[\s\S]*?getStaffOrderSourceAsyncState\(selectedSourceCard\)[\s\S]*?role",\s*"alert"[\s\S]*?sourceState\.errorTitle[\s\S]*?data-staff-orders-retry/m },
    { name: "source-card click binding", pattern: /sourceCardButtons\.forEach\(\(button\)\s*=>[\s\S]*selectStaffOrderSourceCard/m },
    { name: "pointer click requests management reveal", pattern: /sourceCardButtons\.forEach[\s\S]*?addEventListener\("click",\s*\(event\)[\s\S]*?\{\s*revealManagement:\s*event\.detail\s*>\s*0\s*\}[\s\S]*?\);/m },
    { name: "management reveal guards selected source", pattern: /function\s+revealStaffOrdersManagement[\s\S]*?management\.hidden[\s\S]*?getStaffSelectedOrderSourceCard\(\)\s*!==\s*normalizedSourceCard[\s\S]*?scrollIntoView/m },
    { name: "management reveal honors reduced motion", pattern: /management\.scrollIntoView\(\{\s*behavior:\s*getStaffPreferredScrollBehavior\(\),\s*block:\s*"start"\s*\}\)/m },
    { name: "non-click selection reveal defaults off", pattern: /\{\s*announce\s*=\s*true,\s*revealManagement\s*=\s*false\s*\}\s*=\s*\{\}/m },
    { name: "source refresh binding", pattern: /sourceRefreshButton\.addEventListener\("click"[\s\S]*?loadStaffOrders\(\)/m },
    { name: "primary source applied before secondary filters", pattern: /return\s+getStaffOrdersForSourceCard\([\s\S]*?STAFF_STATE\.orders[\s\S]*?\)\.filter\(\(order\)\s*=>/m },
    { name: "authoritative created-time comparator", pattern: /function\s+compareStaffOrdersNewestFirst[\s\S]*?getStaffOrderCreatedAtValue\(firstOrder\)[\s\S]*?getStaffOrderCreatedAtValue\(secondOrder\)/m },
    { name: "stable id tie-break", pattern: /function\s+compareStaffOrderSortValues[\s\S]*?localeCompare[\s\S]*?numeric:\s*true/m },
    { name: "duplicate order guard", pattern: /function\s+dedupeStaffOrdersById[\s\S]*?seenOrderIds\.has\(orderId\)/m },
    { name: "fetch normalized before signature", pattern: /const\s+nextOrders\s*=\s*normalizeStaffOrdersForDisplay\(result\.orders\);[\s\S]*?getStaffOrdersRenderSignature\(nextOrders\)/m },
    { name: "room-service source group", pattern: /buildStaffOrderSourceGroup\("room-service",\s*roomServiceOrders\)/m },
    { name: "progressive order details", pattern: /data-staff-order-details/m },
    { name: "expanded-card preservation", pattern: /expandedOrderIds:\s*new Set\(\)/m },
    { name: "silent refresh scroll-anchor capture", pattern: /const\s+scrollAnchorState\s*=\s*[\s\S]*?silent\s*&&\s*shouldRenderOrders\s*\?\s*getStaffOrdersScrollAnchorState\(\)\s*:\s*null/m },
    { name: "scroll anchor safe-list guard", pattern: /function\s+getStaffOrdersScrollAnchorState[\s\S]*?STAFF_STATE\.activeView\s*!==\s*"orders"[\s\S]*?contentRect\.top\s*>=\s*0/m },
    { name: "scroll restore source and user guard", pattern: /function\s+restoreStaffOrdersScrollAnchorState[\s\S]*?getStaffSelectedOrderSourceCard\(\)\s*!==\s*scrollAnchorState\.sourceCard[\s\S]*?Math\.abs\(currentScrollY\s*-\s*Number\(scrollAnchorState\.windowScrollY\s*\|\|\s*0\)\)\s*>\s*2/m },
    { name: "scroll restored after order render", pattern: /renderCurrentStaffOrders\(\);\s*restoreStaffOrdersScrollAnchorState\(scrollAnchorState\);\s*restoreStaffOrdersFocusState\(focusState\);/m },
    { name: "refresh render signature", pattern: /function\s+getStaffOrdersRenderSignature\(orders\s*=\s*\[\]\)/m },
    { name: "non-overlapping production polling intervals", pattern: /const\s+STAFF_AUTO_REFRESH_INTERVAL_MS\s*=\s*15\s*\*\s*1000;[\s\S]*?const\s+STAFF_KDS_AUTO_REFRESH_INTERVAL_MS\s*=\s*5\s*\*\s*1000;[\s\S]*?staffAutoRefreshInFlight/m },
    { name: "advance policy only after existing-session authentication", pattern: /function\s+checkExistingStaffSession[\s\S]*?staffFetchJson\(`\$\{STAFF_API_BASE\}\/me`\)[\s\S]*?loadStaffRoomAdvancePolicySafely\(\)/m },
    { name: "advance policy only after login token storage", pattern: /setStaffToken\(result\.token\)[\s\S]*?loadStaffRoomAdvancePolicySafely\(\)/m },
    { name: "rate-limited slow-request diagnostics", pattern: /STAFF_SLOW_REQUEST_WARNING_MS\s*=\s*3000[\s\S]*?STAFF_SLOW_REQUEST_WARNING_COOLDOWN_MS\s*=\s*60\s*\*\s*1000[\s\S]*?staffSlowRequestWarningAtByPath/m },
    { name: "loading skeleton", pattern: /staff-orders-skeleton-card/m },
    { name: "retry action", pattern: /data-staff-orders-retry/m },
    { name: "financial UI gate", pattern: /function\s+canStaffViewOrderFinancials\(order\s*=\s*\{\}\)/m },
    { name: "gateway-controlled status lock", pattern: /isGatewayControlledOrder[\s\S]*selectDisabled/m },
    { name: "delegated billed action", pattern: /target\.closest\("\[data-staff-mark-billed\]"\)/m },
    { name: "delegated paid action", pattern: /target\.closest\("\[data-staff-mark-paid\]"\)/m },
    { name: "delegated bill view", pattern: /target\.closest\("\[data-staff-view-bill\]"\)/m },
    { name: "delegated status update", pattern: /target\.closest\("\[data-staff-update-record-status\]"\)/m }
  ], failures);

  verifyNewestFirstRuntime(frontend, failures);

  checkPatterns(backend, "Backend", [
    { name: "normal backend statuses unchanged", pattern: /const\s+STAFF_ORDER_STATUSES\s*=\s*\["new",\s*"confirmed",\s*"preparing",\s*"completed",\s*"cancelled"\];/m },
    { name: "hotel-scoped order reads", pattern: /router\.get\("\/orders"[\s\S]*?\.eq\("hotel_slug",\s*hotelSlug\)/m },
    { name: "hotel-scoped status updates", pattern: /router\.patch\("\/orders\/:id\/status"[\s\S]*?\.eq\("hotel_slug",\s*hotelSlug\)/m },
    { name: "manager-only billed route", pattern: /router\.patch\("\/orders\/:id\/mark-billed",\s*requireStaffAuth,\s*requireStaffManagerAccess/m },
    { name: "manager-only paid route", pattern: /router\.patch\("\/orders\/:id\/mark-paid",\s*requireStaffAuth,\s*requireStaffManagerAccess/m },
    { name: "financial response gate", pattern: /function\s+canStaffViewOrderFinancials\(req\s*=\s*\{\}\)/m },
    { name: "item financial sanitization", pattern: /function\s+stripStaffOrderItemFinancials\(value\)/m },
    { name: "financial visibility marker", pattern: /financialsVisible:\s*!!includeFinancials/m },
    { name: "totals response shaping", pattern: /totals:[\s\S]*?includeFinancials\s*&&\s*order\.totals/m },
    { name: "route-transfer response shaping", pattern: /routeTransfer:\s*includeFinancials\s*\?/m }
    ,{ name: "manager-protected trend contract", pattern: /router\.get\("\/orders-reports",\s*requireStaffAuth,\s*requireStaffManagerAccess/m }
    ,{ name: "trusted tenant trend scope", pattern: /router\.get\("\/orders-reports"[\s\S]*?req\.staffHotelSlug[\s\S]*?fetchStaffOrdersForReports\(\{[\s\S]*?hotelSlug/m }
    ,{ name: "trend query selects status", pattern: /fetchStaffOrdersForReports[\s\S]*?\.select\("id, status,[^"]*created_at"\)/m }
    ,{ name: "additive trend response", pattern: /trend:\s*\{[\s\S]*?financialsVisible:\s*true[\s\S]*?buildStaffOrderTrend/m }
  ], failures);

  if (failures.length) {
    console.error("Staff Orders UI verification failed.");
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }

  console.log("Staff Orders UI verification passed.");
  console.log(`Verified ${ids.length} unique HTML ids, dashboard and responsive UI contracts, preserved actions, status separation, tenant scoping, and financial response shaping.`);
}

main();
