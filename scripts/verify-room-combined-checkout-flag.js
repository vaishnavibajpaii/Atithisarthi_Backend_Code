"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");

const backendRoot = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(backendRoot, relativePath), "utf8");
}

function main() {
  const packageJson = read("package.json");
  const envConfig = read(path.join("config", "env.js"));
  const productionVerifier = read(path.join("scripts", "verify-production-config.js"));
  const productionFlagMatrix = read(path.join("scripts", "verify-room-combined-checkout-production-flags.js"));
  const firstClientVerifier = read(path.join("scripts", "verify-first-client-launch-profile.js"));
  const prepareRuntimeConfig = read(path.join("scripts", "prepare-frontend-runtime-config.js"));
  const verifyRuntimeConfig = read(path.join("scripts", "verify-frontend-runtime-config.js"));
  const verifyNeutralRuntimeConfig = read(path.join("scripts", "verify-frontend-runtime-config-neutral.js"));
  const appConfig = fs.readFileSync(path.join(backendRoot, "..", "frontend", "js", "app-config.js"), "utf8");
  const adminRoute = read(path.join("routes", "admin-room-booking.js"));
  const staffRoute = read(path.join("routes", "staff-room-booking.js"));

  assert.match(
    envConfig,
    /roomCombinedCheckoutEnabled:\s*\n?\s*getEnv\("ROOM_COMBINED_CHECKOUT_ENABLED",\s*"false"\)\s*===\s*"true"/
  );
  assert.match(
    envConfig,
    /task6RoomCheckoutFinalizerEnabled:\s*\n?\s*getEnv\("TASK6_ROOM_CHECKOUT_FINALIZER_ENABLED",\s*"false"\)\s*===\s*"true"/
  );
  assert.match(
    productionVerifier,
    /function checkRoomCombinedCheckoutEnv\(issues,\s*warnings\)/
  );
  assert.match(
    productionVerifier,
    /checkRoomCombinedCheckoutEnv\(issues,\s*warnings\);/
  );
  assert.match(
    productionVerifier,
    /APP_ROOM_COMBINED_CHECKOUT_FRONTEND_ENABLED cannot be true unless ROOM_COMBINED_CHECKOUT_ENABLED is also true/
  );
  assert.match(
    productionVerifier,
    /TASK6_ROOM_CHECKOUT_FINALIZER_ENABLED cannot be true unless ROOM_COMBINED_CHECKOUT_ENABLED is also true/
  );
  assert.match(
    productionVerifier,
    /APP_ROOM_COMBINED_CHECKOUT_FRONTEND_ENABLED cannot be true until TASK6_ROOM_CHECKOUT_FINALIZER_ENABLED is true/
  );
  assert.match(
    productionVerifier,
    /APP_ROOM_COMBINED_CHECKOUT_FRONTEND_ENABLED is false\. Admin\/staff combined checkout buttons will remain disabled/
  );
  assert.match(
    productionVerifier,
    /APP_ROOM_COMBINED_CHECKOUT_FRONTEND_ENABLED is true\. Confirm production enablement was separately approved after staging checkout verification/
  );
  assert.match(
    packageJson,
    /"verify:room-checkout-production-flags":\s*"node scripts\/verify-room-combined-checkout-production-flags\.js"/
  );
  assert.match(productionFlagMatrix, /frontend-only flag/);
  assert.match(productionFlagMatrix, /backend-only flag/);
  assert.match(productionFlagMatrix, /both flags/);
  assert.match(
    productionFlagMatrix,
    /APP_ROOM_COMBINED_CHECKOUT_FRONTEND_ENABLED cannot be true unless ROOM_COMBINED_CHECKOUT_ENABLED is also true/
  );
  assert.match(
    productionFlagMatrix,
    /APP_ROOM_COMBINED_CHECKOUT_FRONTEND_ENABLED is false\. Admin\/staff combined checkout buttons will remain disabled/
  );
  assert.match(
    productionFlagMatrix,
    /APP_ROOM_COMBINED_CHECKOUT_FRONTEND_ENABLED is true\. Confirm production enablement was separately approved after staging checkout verification/
  );
  assert.match(
    firstClientVerifier,
    /ROOM_COMBINED_CHECKOUT_ENABLED should remain false for first-client launch/
  );

  [
    ".env.example",
    ".env.production.example",
    ".env.first-client.cloudflare-railway.example"
  ].forEach((relativePath) => {
    const source = read(relativePath);
    assert.match(
      source,
      /^ROOM_COMBINED_CHECKOUT_ENABLED=false$/m,
      `${relativePath} must default combined checkout to false`
    );
    assert.match(
      source,
      /^APP_ROOM_COMBINED_CHECKOUT_FRONTEND_ENABLED=false$/m,
      `${relativePath} must default frontend combined checkout to false`
    );
    assert.match(
      source,
      /^TASK6_ROOM_CHECKOUT_FINALIZER_ENABLED=false$/m,
      `${relativePath} must default the Task 6 finalizer to false`
    );
  });

  assert.match(appConfig, /"app-room-combined-checkout-frontend-enabled"/);
  assert.match(appConfig, /ROOM_COMBINED_CHECKOUT_FRONTEND_ENABLED:\s*cleanBoolean\([\s\S]*?cleanBoolean\(metaRoomCombinedCheckoutFrontendEnabled, false\)/);
  assert.match(prepareRuntimeConfig, /APP_ROOM_COMBINED_CHECKOUT_FRONTEND_ENABLED/);
  assert.match(prepareRuntimeConfig, /"app-room-combined-checkout-frontend-enabled"/);
  assert.match(verifyRuntimeConfig, /APP_ROOM_COMBINED_CHECKOUT_FRONTEND_ENABLED/);
  assert.match(verifyNeutralRuntimeConfig, /app-room-combined-checkout-frontend-enabled should be false in the neutral repo state/);

  assert.match(adminRoute, /isEnabled:\s*\(\)\s*=>\s*env\.roomCombinedCheckoutEnabled/);
  assert.match(staffRoute, /isEnabled:\s*\(\)\s*=>\s*env\.roomCombinedCheckoutEnabled/);
  assert.match(
    adminRoute,
    /requireRoomCombinedCheckoutEnabled,\s*validateBody\(roomCombinedCheckoutSchema\),\s*adminRoomCombinedCheckoutHandler/m
  );
  assert.match(
    staffRoute,
    /requireStaffManagerAccess,\s*requireStaffCombinedBilling,\s*requireRoomCombinedCheckoutEnabled,\s*validateBody\(roomCombinedCheckoutSchema\)/m
  );

  console.log("Combined checkout feature-flag verification passed.");
  console.log("Verified default-off backend/frontend config, environment templates, runtime config stamping, production warnings, and first-client launch blocking.");
  console.log("Verified admin and staff routes are ordered behind the default-off gate.");
}

main();
