"use strict";

const assert = require("assert").strict;
const path = require("path");
const { spawnSync } = require("child_process");

const backendRoot = path.resolve(__dirname, "..");
const productionVerifierPath = path.join(__dirname, "verify-production-config.js");

const baseProductionEnv = {
  NODE_ENV: "production",
  PORT: "5000",
  SUPABASE_URL: "https://hotel-prod.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service_role_key_for_room_checkout_flag_probe",
  JWT_SECRET: "abcdefghijklmnopqrstuvwxyz1234567890",
  FRONTEND_URL: "https://hotel-prod.test",
  FRONTEND_ORIGINS: "https://hotel-prod.test",
  ADMIN_URL: "https://hotel-prod.test/admin",
  APP_BACKEND_BASE_URL: "https://hotel-api.test",
  APP_API_BASE_URL: "https://hotel-api.test/api",
  APP_ALLOW_ORDER_WHATSAPP_FALLBACK_ON_SAVE_FAILURE: "false",
  APP_OPEN_WHATSAPP_AFTER_VERIFIED_ONLINE_PAYMENT: "true",
  PAYMENT_GATEWAY_ENABLED: "false",
  NOTIFICATION_DELIVERY_ENABLED: "false"
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runProductionVerifier({ backendEnabled, frontendEnabled, task6FinalizerEnabled = "false" }) {
  const result = spawnSync(process.execPath, [productionVerifierPath], {
    cwd: backendRoot,
    env: {
      ...process.env,
      ...baseProductionEnv,
      ROOM_COMBINED_CHECKOUT_ENABLED: backendEnabled,
      APP_ROOM_COMBINED_CHECKOUT_FRONTEND_ENABLED: frontendEnabled,
      TASK6_ROOM_CHECKOUT_FINALIZER_ENABLED: task6FinalizerEnabled
    },
    encoding: "utf8"
  });

  return `${result.stdout || ""}${result.stderr || ""}`;
}

function assertIncludes(output, expectedText, label) {
  assert.match(
    output,
    new RegExp(escapeRegExp(expectedText)),
    `${label} should include: ${expectedText}`
  );
}

function assertExcludes(output, unexpectedText, label) {
  assert.doesNotMatch(
    output,
    new RegExp(escapeRegExp(unexpectedText)),
    `${label} should not include: ${unexpectedText}`
  );
}

function main() {
  const mismatchBlocker =
    "APP_ROOM_COMBINED_CHECKOUT_FRONTEND_ENABLED cannot be true unless ROOM_COMBINED_CHECKOUT_ENABLED is also true.";
  const backendDisabledWarning =
    "ROOM_COMBINED_CHECKOUT_ENABLED is false or missing. Atomic combined checkout will stay disabled.";
  const backendEnabledWarning =
    "ROOM_COMBINED_CHECKOUT_ENABLED is true. Confirm the atomic checkout migration and staging verifier passed before mounting checkout routes.";
  const frontendDisabledWarning =
    "APP_ROOM_COMBINED_CHECKOUT_FRONTEND_ENABLED is false. Admin/staff combined checkout buttons will remain disabled.";
  const frontendEnabledWarning =
    "APP_ROOM_COMBINED_CHECKOUT_FRONTEND_ENABLED is true. Confirm production enablement was separately approved after staging checkout verification.";
  const legacyFinalizerWarning =
    "TASK6_ROOM_CHECKOUT_FINALIZER_ENABLED is false or missing. Legacy combined checkout settlement remains selected.";
  const atomicFinalizerWarning =
    "TASK6_ROOM_CHECKOUT_FINALIZER_ENABLED is true. Confirm the D-B migration, checkout concurrency probe, and TEST business-flow acceptance passed before production use.";
  const atomicRequiresBackendBlocker =
    "TASK6_ROOM_CHECKOUT_FINALIZER_ENABLED cannot be true unless ROOM_COMBINED_CHECKOUT_ENABLED is also true.";
  const frontendRequiresAtomicBlocker =
    "APP_ROOM_COMBINED_CHECKOUT_FRONTEND_ENABLED cannot be true until TASK6_ROOM_CHECKOUT_FINALIZER_ENABLED is true.";

  const disabled = runProductionVerifier({
    backendEnabled: "false",
    frontendEnabled: "false"
  });
  assertIncludes(disabled, backendDisabledWarning, "disabled flags");
  assertExcludes(disabled, legacyFinalizerWarning, "disabled flags");
  assertExcludes(disabled, mismatchBlocker, "disabled flags");

  const unsafeFrontendOnly = runProductionVerifier({
    backendEnabled: "false",
    frontendEnabled: "true"
  });
  assertIncludes(unsafeFrontendOnly, mismatchBlocker, "frontend-only flag");
  assertIncludes(unsafeFrontendOnly, backendDisabledWarning, "frontend-only flag");
  assertIncludes(unsafeFrontendOnly, frontendRequiresAtomicBlocker, "frontend-only flag");

  const backendOnly = runProductionVerifier({
    backendEnabled: "true",
    frontendEnabled: "false"
  });
  assertIncludes(backendOnly, backendEnabledWarning, "backend-only flag");
  assertIncludes(backendOnly, frontendDisabledWarning, "backend-only flag");
  assertIncludes(backendOnly, legacyFinalizerWarning, "backend-only flag");
  assertExcludes(backendOnly, mismatchBlocker, "backend-only flag");

  const bothEnabled = runProductionVerifier({
    backendEnabled: "true",
    frontendEnabled: "true"
  });
  assertIncludes(bothEnabled, backendEnabledWarning, "both flags");
  assertIncludes(bothEnabled, frontendRequiresAtomicBlocker, "both flags without atomic finalizer");
  assertExcludes(bothEnabled, frontendEnabledWarning, "both flags without atomic finalizer");
  assertExcludes(bothEnabled, mismatchBlocker, "both flags");

  const atomicBackendOnly = runProductionVerifier({
    backendEnabled: "true",
    frontendEnabled: "false",
    task6FinalizerEnabled: "true"
  });
  assertIncludes(atomicBackendOnly, atomicFinalizerWarning, "atomic backend-only flag");
  assertIncludes(atomicBackendOnly, frontendDisabledWarning, "atomic backend-only flag");
  assertExcludes(atomicBackendOnly, atomicRequiresBackendBlocker, "atomic backend-only flag");

  const atomicWithoutBase = runProductionVerifier({
    backendEnabled: "false",
    frontendEnabled: "false",
    task6FinalizerEnabled: "true"
  });
  assertIncludes(atomicWithoutBase, atomicRequiresBackendBlocker, "atomic-only flag");

  const allEnabled = runProductionVerifier({
    backendEnabled: "true",
    frontendEnabled: "true",
    task6FinalizerEnabled: "true"
  });
  assertIncludes(allEnabled, frontendEnabledWarning, "all flags enabled");
  assertIncludes(allEnabled, atomicFinalizerWarning, "all flags enabled");
  assertExcludes(allEnabled, frontendRequiresAtomicBlocker, "all flags enabled");

console.log("Combined checkout production flag matrix verification passed.");
console.log("Verified default-off, legacy selection warning, atomic-finalizer dependency, and TEST-acceptance warning across the production flag matrix.");
}

main();
