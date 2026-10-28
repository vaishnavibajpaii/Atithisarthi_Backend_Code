"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const projectRoot = path.resolve(__dirname, "..", "..");
const backendRoot = path.resolve(__dirname, "..");
const { supabase } = require("../utils/supabase");
const {
  decryptQrToken,
  encryptQrToken,
  generateCsrfToken,
  generateCustomerSessionToken,
  generateOpaqueQrToken,
  getCanonicalQrUrl,
  hashSecret
} = require("../utils/secure-qr");
const { secureQrEditSchema, secureQrOrderSchema } = require("../validators/secure-qr");
const { staffQrCorrectionSchema } = require("../validators/staff-qr");

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function includes(source, value, message = "") {
  assert.ok(source.includes(value), message || `Missing required contract: ${value}`);
}

function verifyCryptoAndContracts() {
  const tokens = new Set(Array.from({ length: 256 }, () => generateOpaqueQrToken()));
  assert.equal(tokens.size, 256, "QR token sample must be unique");
  for (const token of tokens) {
    assert.match(token, /^q1_[A-Za-z0-9_-]{43}$/, "QR token must contain 256 random bits");
    assert.match(hashSecret(token), /^[a-f0-9]{64}$/, "QR token storage key must be SHA-256");
    const encrypted = encryptQrToken(token);
    assert.ok(!encrypted.includes(token), "encrypted printable token must not contain raw token");
    assert.equal(decryptQrToken(encrypted), token, "encrypted printable token must round-trip");
  }
  const canonicalToken = "q1_" + "a".repeat(43);
  assert.equal(
    getCanonicalQrUrl(canonicalToken, "hotelsairaj.servehotels.xyz"),
    "https://hotelsairaj.servehotels.xyz/menu?q=" + canonicalToken,
    "secure QR links must use the hotel primary domain and clean /menu path"
  );
  assert.equal(
    getCanonicalQrUrl(canonicalToken, "https://hotelsairaj.servehotels.xyz/ignored"),
    "https://hotelsairaj.servehotels.xyz/menu?q=" + canonicalToken,
    "secure QR domain overrides must be reduced to a safe HTTP origin"
  );
  assert.notEqual(generateCustomerSessionToken(), generateCustomerSessionToken());
  assert.notEqual(generateCsrfToken(), generateCsrfToken());

  const safeOrder = {
    clientRequestId: "qr-request-123456789",
    expectedSessionVersion: 1,
    customerName: "Table Guest",
    customerPhone: "",
    paymentMethod: "COD",
    items: [{ menuItemId: "18", quantity: 2 }]
  };
  assert.equal(secureQrOrderSchema.safeParse(safeOrder).success, true);
  for (const untrusted of [
    { hotelSlug: "hotel-b" }, { hotel_id: 2 }, { tableId: 9 }, { orderId: 10 },
    { price: 1 }, { tax: 0 }, { total: 1 }, { status: "served" }
  ]) {
    assert.equal(secureQrOrderSchema.safeParse({ ...safeOrder, ...untrusted }).success, false,
      `Untrusted field must be rejected: ${Object.keys(untrusted)[0]}`);
  }
  assert.equal(secureQrEditSchema.safeParse({
    clientRequestId: "qr-edit-123456789",
    expectedRoundVersion: 3,
    items: [{ publicItemReference: "2e1e7ea2-0908-46f3-927a-3d463d708dca", menuItemId: "18", quantity: 2 }]
  }).success, true);
  assert.equal(staffQrCorrectionSchema.safeParse({
    action: "cancel",
    clientRequestId: "staff-cancel-123456",
    expectedVersion: 2,
    reason: "Guest ordered the wrong item"
  }).success, true);
  assert.equal(staffQrCorrectionSchema.safeParse({
    action: "cancel",
    clientRequestId: "staff-cancel-123456",
    expectedVersion: 2
  }).success, false, "controlled cancellation must require a reason");
}

function verifySourceContracts() {
  const createMigration = read("backend/scripts/create-secure-qr-table-ordering.sql").toLowerCase();
  const customerMigration = read("backend/scripts/upgrade-secure-qr-corrections.sql");
  const staffMigration = read("backend/scripts/upgrade-secure-qr-staff-corrections.sql");
  const lifecycleMigration = read("backend/scripts/upgrade-secure-qr-order-lifecycle.sql");
  const task6SecureQrRuntime = read("backend/scripts/task6-f-secure-qr-runtime-activate.sql");
  const publicRoute = read("backend/routes/public-qr.js");
  const staffRoute = read("backend/routes/staff-qr-corrections.js");
  const outbox = read("backend/utils/qr-outbox.js");
  const server = read("backend/server.js");
  const loader = read("frontend/js/data-loader.js");
  const appConfig = read("frontend/js/app-config.js");
  const checkout = read("frontend/js/main.js");
  const staffOrdersRoute = read("backend/routes/staff.js");
  const adminOrdersRoute = read("backend/routes/admin.js");
  const customerStatus = read("frontend/js/qr-order-status.js");
  const staffUi = read("frontend/js/staff-qr-corrections.js");
  const observability = read("backend/middleware/request-observability.js");

  ["restaurant_table_qr_tokens", "qr_customer_sessions", "qr_order_submissions",
    "qr_idempotency_records", "qr_security_events", "qr_event_outbox",
    "for update", "submit_secure_qr_table_order", "qr_order_created", "qr_items_added"]
    .forEach((value) => includes(createMigration, value));
  ["edit_secure_qr_submission", "QR_SUBMISSION_CHANGED", "QR_EDIT_LOCKED"]
    .forEach((value) => includes(customerMigration, value));
  ["correct_secure_qr_submission_staff", "MANAGER_REQUIRED", "REASON_REQUIRED",
    "QR_ITEM_EDITED_BY_STAFF", "QR_ROUND_CANCELLED", "qr_staff_idempotency_records"]
    .forEach((value) => includes(staffMigration, value));
  ["ensurePublicHotelAccess", "X-QR-CSRF-Token", "QR_SESSION_OWNERSHIP_FAILURE",
    "calculateVerifiedOrderPricing", "submit_secure_qr_table_order"]
    .forEach((value) => includes(publicRoute, value));
  ["is_dine_in_order_open", "sync_dine_in_order_terminal_lifecycle",
    "billing_status", "kitchen_status = 'served'", "notify pgrst"]
    .forEach((value) => includes(lifecycleMigration, value));
  ["TABLE_ORDER_CHANGED", "isActiveTableOrderUniqueConflict"]
    .forEach((value) => includes(publicRoute, value));
  ["merge_qr_order_totals", "replace_qr_order_totals", "task6_order_snapshot_valid",
    "financial_snapshot_version", "secure_qr_order_create", "qr_idempotency_records", "qr_event_outbox"]
    .forEach((value) => includes(task6SecureQrRuntime, value));
  includes(read("backend/routes/staff-tables.js"), 'billing === "billed"');
  ['new: "new"', 'confirmed: "accepted"', 'preparing: "preparing"',
    'completed: "served"', 'cancelled: "cancelled"']
    .forEach((value) => includes(staffOrdersRoute, value));
  includes(adminOrdersRoute, 'confirmed: "accepted"');
  const staffOrderStatusRouteIndex = staffOrdersRoute.indexOf('router.patch("/orders/:id/status"');
  const invalidStaffStatusGuardIndex = staffOrdersRoute.indexOf("if (!status) {", staffOrderStatusRouteIndex);
  const staffLifecycleUpdateIndex = staffOrdersRoute.indexOf("const lifecycleUpdate = {", invalidStaffStatusGuardIndex);
  const invalidStaffStatusGuardSource = staffOrdersRoute
    .slice(invalidStaffStatusGuardIndex, staffLifecycleUpdateIndex)
    .trimEnd();
  assert.ok(staffOrderStatusRouteIndex >= 0 && invalidStaffStatusGuardIndex > staffOrderStatusRouteIndex &&
    staffLifecycleUpdateIndex > invalidStaffStatusGuardIndex && invalidStaffStatusGuardSource.endsWith("}"),
    "staff lifecycle update must be declared after the invalid-status guard closes");
  ["correct_secure_qr_submission_staff", "calculateVerifiedOrderPricing", "MANAGER_REQUIRED"]
    .forEach((value) => includes(staffRoute, value));
  ["claimEvent", "qrOutboxDeduplicationKey", "processQrOutboxBatch"]
    .forEach((value) => includes(outbox, value));
  includes(server, "startQrOutboxWorker");
  includes(loader, 'params.get("q")');
  includes(loader, "resolvedHotelSlug");
  const sameHostLocalBackend = '`http://${hostname || "localhost"}:5000`';
  includes(appConfig, sameHostLocalBackend);
  includes(loader, sameHostLocalBackend);
  includes(checkout, sameHostLocalBackend);
  includes(loader, "const sessionResponse = await fetch");
  assert.ok(!loader.includes("getStoredQrCsrfToken"),
    "QR bootstrap must not trust a cached CSRF proof without a fresh bound HttpOnly session");
  includes(checkout, "X-QR-CSRF-Token");
  includes(checkout, "getSecureQrClientRequestId");
  const requestHelperIndex = checkout.indexOf("function getSecureQrClientRequestId");
  const toastFunctionIndex = checkout.indexOf("function showToast");
  assert.ok(requestHelperIndex >= 0 && requestHelperIndex < toastFunctionIndex,
    "secure QR idempotency helpers must remain at file scope before showToast");
  const secureQrDeclarationIndex = checkout.indexOf("const isSecureQrOrder =");
  const secureQrPaymentGuardIndex = checkout.indexOf("if ((isAddonOrder || isSecureQrOrder)");
  assert.ok(secureQrDeclarationIndex >= 0 &&
    secureQrPaymentGuardIndex >= 0 &&
    secureQrDeclarationIndex < secureQrPaymentGuardIndex,
    "secure QR checkout flag must be declared before its first use");
  includes(checkout, 'tracking = tracking && typeof tracking === "object" ? tracking : {}');
  includes(checkout, "function showSecureQrOrderStatusPrompt");
  includes(checkout, "qr-order-status.html?submission=");
  includes(checkout, 'secureQrSubmissionReference = String(result?.order?.publicReference || "").trim()');
  includes(checkout, "showSecureQrOrderStatusPrompt(secureQrSubmissionReference)");
  const secureQrStatusPromptIndex = checkout.indexOf("function showSecureQrOrderStatusPrompt");
  const secureQrStatusPromptEnd = checkout.indexOf("function flattenMenuData", secureQrStatusPromptIndex);
  const secureQrStatusPrompt = checkout.slice(secureQrStatusPromptIndex, secureQrStatusPromptEnd);
  assert.ok(!secureQrStatusPrompt.includes('target="_blank"'),
    "secure QR status must stay in the same tab so the session-scoped CSRF proof is retained");
  const checkoutSubmitIndex = checkout.indexOf("async function handleCheckoutSubmit");
  const trackingAssignmentIndex = checkout.indexOf("tracking = result?.trackingReady", checkoutSubmitIndex);
  const secureReferenceAssignmentIndex = checkout.indexOf("secureQrSubmissionReference = String", trackingAssignmentIndex);
  const checkoutSaveCatchIndex = checkout.indexOf("  } catch (error) {", trackingAssignmentIndex);
  assert.ok(checkoutSubmitIndex >= 0 && trackingAssignmentIndex > checkoutSubmitIndex &&
    secureReferenceAssignmentIndex > trackingAssignmentIndex &&
    checkoutSaveCatchIndex > secureReferenceAssignmentIndex,
    "secure QR public reference must be captured inside the successful checkout request block");
  assert.ok(!checkout.includes("showOrderTrackingPrompt(tracking);\n  showToast("),
    "secure QR checkout success must not pass a null legacy tracking object into the prompt");
  const checkoutFailureBlock = checkout.slice(
    checkoutSaveCatchIndex,
    checkout.indexOf("  // Clear cart", checkoutSaveCatchIndex)
  );
  includes(
    checkoutFailureBlock,
    "WhatsApp handoff skipped because no durable order exists",
    "a failed write must explicitly skip the WhatsApp side effect"
  );
  assert.ok(
    !checkoutFailureBlock.includes("ownerWhatsAppLink(summaryText)"),
    "a failed durable order write must never become a WhatsApp-only order"
  );
  includes(customerStatus, "expectedRoundVersion");
  const customerPatchRouteIndex = publicRoute.indexOf('router.patch("/submissions/:publicReference"');
  const customerStatusRouteIndex = publicRoute.indexOf('router.get("/submissions/:publicReference"');
  assert.ok(customerPatchRouteIndex >= 0 &&
    customerStatusRouteIndex > customerPatchRouteIndex,
    "customer edit and status routes must both be registered at router scope");
  includes(customerStatus, "/public/qr/submissions/");
  assert.ok(!customerStatus.includes("/api/public/qr/submissions/"),
    "status requests must not duplicate the configured /api prefix");
  includes(staffUi, "data-staff-qr-correction");
  includes(observability, "[redacted]");
  assert.ok(!publicRoute.includes("createNotificationEventSafely"), "QR route must not bypass durable outbox delivery");
  includes(read("frontend/js/staff-orders.js"), "STAFF_SLOW_REQUEST_WARNING_MS = 3000");
}

function verifySyntax() {
  const files = [
    "backend/utils/secure-qr.js", "backend/utils/qr-outbox.js",
    "backend/validators/secure-qr.js", "backend/validators/staff-qr.js",
    "backend/routes/public-qr.js", "backend/routes/staff-qr-management.js",
    "backend/routes/staff-qr-corrections.js", "backend/routes/orders.js",
    "backend/routes/staff.js", "backend/server.js", "frontend/js/data-loader.js",
    "frontend/js/main.js", "frontend/js/staff-orders.js",
    "frontend/js/qr-order-status.js", "frontend/js/staff-qr-corrections.js"
  ];
  for (const relativePath of files) {
    execFileSync(process.execPath, ["--check", path.join(projectRoot, relativePath)], { stdio: "pipe" });
  }
}

async function verifyLiveSchema() {
  const tables = [
    "restaurant_table_qr_tokens", "qr_customer_sessions", "qr_order_submissions",
    "qr_idempotency_records", "qr_security_events", "qr_event_outbox",
    "qr_staff_idempotency_records", "order_rounds"
  ];
  for (const table of tables) {
    const result = await supabase.from(table).select("*", { count: "exact", head: true });
    assert.ifError(result.error);
    console.log(`LIVE ${table}: OK (${Number(result.count || 0)} rows)`);
  }
  const submitProbe = await supabase.rpc("submit_secure_qr_table_order", {
    p_token_hash: "", p_session_hash: "", p_idempotency_key_hash: "",
    p_request_fingerprint: "", p_order: {}, p_request_id: "schema-probe"
  });
  assert.ifError(submitProbe.error);
  assert.equal(submitProbe.data?.code, "INVALID_SECURE_CONTEXT");
  const editProbe = await supabase.rpc("edit_secure_qr_submission", {
    p_session_hash: "", p_submission_reference: null, p_expected_version: 1,
    p_idempotency_key_hash: "", p_request_fingerprint: "", p_items: [],
    p_totals: {}, p_note: "", p_request_id: "schema-probe"
  });
  assert.ifError(editProbe.error);
  assert.equal(editProbe.data?.code, "INVALID_EDIT_REQUEST");
  const staffProbe = await supabase.rpc("correct_secure_qr_submission_staff", {
    p_hotel_slug: "", p_submission_reference: null, p_expected_version: 1,
    p_action: "edit", p_idempotency_key_hash: "", p_request_fingerprint: "",
    p_items: [], p_totals: {}, p_note: "", p_reason: "", p_actor_reference: "",
    p_actor_role: "staff", p_request_id: "schema-probe"
  });
  assert.ifError(staffProbe.error);
  assert.equal(staffProbe.data?.code, "INVALID_STAFF_CORRECTION");
  const closedLifecycleProbe = await supabase.rpc("is_dine_in_order_open", {
    p_status: "completed", p_kitchen_status: "new",
    p_payment_status: "paid", p_billing_status: "billed"
  });
  assert.ifError(closedLifecycleProbe.error);
  assert.equal(closedLifecycleProbe.data, false);
  const openLifecycleProbe = await supabase.rpc("is_dine_in_order_open", {
    p_status: "completed", p_kitchen_status: "served",
    p_payment_status: "unpaid", p_billing_status: "billed"
  });
  assert.ifError(openLifecycleProbe.error);
  assert.equal(openLifecycleProbe.data, true);
}


async function main() {
  verifyCryptoAndContracts();
  verifySourceContracts();
  verifySyntax();
  if (process.argv.includes("--live")) await verifyLiveSchema();
  console.log("Secure QR verification passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
