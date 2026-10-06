"use strict";

require("dotenv").config({ quiet: true });

process.env.TENANT_RUNTIME_ENABLED = "true";
process.env.TENANT_RUNTIME_STAFF_MENU_ENABLED = "true";
process.env.PAYMENT_WEBHOOK_WORKER_ENABLED = "false";
process.env.NOTIFICATION_DELIVERY_ENABLED = "false";
process.env.SUPABASE_URL ||= "https://tenant-staff-menu-verifier.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const express = require("express");
const crypto = require("crypto");
const staffRouter = require("../routes/staff");
const { supabase } = require("../utils/supabase");
const { signStaffToken } = require("../utils/auth");
const {
  closeTenantPool
} = require("../utils/tenant-database");
const {
  fetchHotelFeatureConfig,
  isHotelFeatureEnabled
} = require("../utils/hotel-feature-settings");
const {
  fetchHotelMenuCategories
} = require("../utils/menu-categories");
const {
  fetchMenuComboPresentationMap,
  isMissingMenuComboSchemaError
} = require("../utils/menu-combos");
const {
  buildStaffMenuPayload
} = require("../utils/staff-menu-presentation");
const {
  normalizePropertySlug
} = require("../utils/tenant-request-context");
const {
  validateTenantDatabaseUrl
} = require("./verify-tenant-runtime-connection");

const EXPECTED_CONFIRMATION = "TASK3E_STAFF_MENU_READ_ONLY";
const DEFAULT_ITERATIONS = 10;
const STAFF_MENU_FIELDS = [
  "item_id",
  "item_type",
  "name",
  "description",
  "price",
  "image",
  "alt",
  "badge",
  "tag",
  "category",
  "sort_order"
].join(",");

function createVerifierError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value || fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 50) {
    throw createVerifierError(
      "TASK3_STAFF_MENU_ITERATIONS_INVALID",
      "TASK3_STAFF_ROUTE_CONCURRENCY_ITERATIONS must be from 1 to 50"
    );
  }
  return parsed;
}

function readInputs() {
  if (
    process.env.TASK3_STAFF_MENU_VERIFY_CONFIRM !==
    EXPECTED_CONFIRMATION
  ) {
    throw createVerifierError(
      "TASK3_STAFF_MENU_CONFIRMATION_MISSING",
      `Set TASK3_STAFF_MENU_VERIFY_CONFIRM=${EXPECTED_CONFIRMATION}`
    );
  }
  validateTenantDatabaseUrl(process.env.TENANT_DATABASE_URL);

  const tenantAId = String(
    process.env.TASK3_TEST_TENANT_A_ID || ""
  ).trim();
  const tenantBId = String(
    process.env.TASK3_TEST_TENANT_B_ID || ""
  ).trim();
  const propertyAId = String(
    process.env.TASK3_TEST_PROPERTY_A_ID || ""
  ).trim();
  const propertyBId = String(
    process.env.TASK3_TEST_PROPERTY_B_ID || ""
  ).trim();
  const slugA = normalizePropertySlug(
    process.env.TASK3_TEST_PROPERTY_A_SLUG
  );
  const slugB = normalizePropertySlug(
    process.env.TASK3_TEST_PROPERTY_B_SLUG
  );

  if (
    !tenantAId ||
    !tenantBId ||
    !propertyAId ||
    !propertyBId ||
    tenantAId === tenantBId ||
    propertyAId === propertyBId ||
    slugA === slugB
  ) {
    throw createVerifierError(
      "TASK3_STAFF_MENU_CONTEXTS_INVALID",
      "Two distinct canonical tenant/property contexts are required"
    );
  }

  return {
    contextA: {
      slug: slugA,
      forgedTenantId: tenantBId,
      forgedPropertyId: propertyBId
    },
    contextB: {
      slug: slugB,
      forgedTenantId: tenantAId,
      forgedPropertyId: propertyAId
    },
    iterations: readPositiveInteger(
      process.env.TASK3_STAFF_ROUTE_CONCURRENCY_ITERATIONS,
      DEFAULT_ITERATIONS
    )
  };
}

function startLocalApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use("/api/staff", staffRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(createVerifierError(
          "TASK3_STAFF_MENU_SERVER_INVALID",
          "Local verification server did not expose a TCP port"
        ));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        server
      });
    });
    server.once("error", reject);
  });
}

async function stopLocalApp(server) {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    let body;
    try {
      body = await response.json();
    } catch {
      throw createVerifierError(
        "TASK3_STAFF_MENU_RESPONSE_INVALID",
        "Staff menu route did not return JSON"
      );
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

function hasInternalContext(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasInternalContext);
  const forbiddenKeys = new Set([
    "tenant_id",
    "property_id",
    "tenantId",
    "propertyId"
  ]);
  return Object.entries(value).some(
    ([key, nested]) =>
      forbiddenKeys.has(key) || hasInternalContext(nested)
  );
}

function verifyStaffMenuResponse(result, expectedSlug) {
  const categories = result.body?.categories;
  const items = result.body?.items;
  const menu = result.body?.menu;
  if (
    result.status !== 200 ||
    result.body?.success !== true ||
    result.body?.hotelSlug !== expectedSlug ||
    result.body?.categorySource !== "menu-categories" ||
    !Array.isArray(categories) ||
    !Array.isArray(items) ||
    !menu ||
    typeof menu !== "object" ||
    result.body?.count !== items.length ||
    !/^[0-9a-f]{16}$/.test(
      String(result.body?.menuVersion || "")
    )
  ) {
    throw createVerifierError(
      "TASK3_STAFF_MENU_RESPONSE_MISMATCH",
      "Staff menu route did not return the expected response contract"
    );
  }
  if (hasInternalContext(result.body)) {
    throw createVerifierError(
      "TASK3_STAFF_MENU_CONTEXT_EXPOSED",
      "Staff menu response exposed internal ownership fields"
    );
  }
  return {
    httpStatus: result.status,
    categoryCount: categories.length,
    itemCount: items.length,
    matchedSlug: result.body.hotelSlug,
    internalContextExposed: false
  };
}

function createStaffToken(slug) {
  return signStaffToken({
    id: `TASK3E_STAFF_MENU_${crypto
      .createHash("sha256")
      .update(slug)
      .digest("hex")
      .slice(0, 16)}`,
    hotel_slug: slug,
    display_name: "Task 3E Staff Menu Verifier",
    role: "staff",
    kds_role: "general"
  });
}

async function probeMenu(baseUrl, context) {
  const query = new URLSearchParams({
    hotelSlug:
      context.slug ===
      process.env.TASK3_TEST_PROPERTY_A_SLUG
        ? process.env.TASK3_TEST_PROPERTY_B_SLUG
        : process.env.TASK3_TEST_PROPERTY_A_SLUG,
    tenant_id: context.forgedTenantId,
    property_id: context.forgedPropertyId
  });
  const result = await requestJson(
    `${baseUrl}/api/staff/menu?${query}`,
    {
      headers: {
        authorization: `Bearer ${createStaffToken(context.slug)}`,
        "x-tenant-id": context.forgedTenantId,
        "x-property-id": context.forgedPropertyId
      }
    }
  );
  return {
    evidence: verifyStaffMenuResponse(result, context.slug),
    payload: result.body
  };
}

async function fetchLegacyStaffMenuPayload(hotelSlug) {
  const featureConfig = await fetchHotelFeatureConfig(
    supabase,
    hotelSlug
  );
  if (!isHotelFeatureEnabled(featureConfig, "food")) {
    throw createVerifierError(
      "TASK3_STAFF_MENU_FIXTURE_FEATURE_DISABLED",
      `Food feature is disabled for ${hotelSlug}`
    );
  }
  const { data, error } = await supabase
    .from("menu_items")
    .select(STAFF_MENU_FIELDS)
    .eq("hotel_slug", hotelSlug)
    .eq("is_available", true)
    .eq("is_archived", false)
    .order("category", { ascending: true })
    .order("sort_order", { ascending: true });
  if (error) throw error;

  const menuItems = data || [];
  const categoryResult = await fetchHotelMenuCategories({
    supabase,
    hotelSlug,
    consumer: "staff",
    menuItems
  });
  let comboPresentationMap = new Map();
  try {
    comboPresentationMap = await fetchMenuComboPresentationMap({
      hotelSlug,
      menuItems
    });
  } catch (error) {
    if (!isMissingMenuComboSchemaError(error)) throw error;
  }
  return buildStaffMenuPayload({
    hotelSlug,
    menuItems,
    categoryResult,
    comboPresentationMap
  });
}

function verifyLegacyCompatibility(legacy, restricted) {
  const legacyJson = JSON.stringify(legacy);
  const restrictedJson = JSON.stringify(restricted);
  if (legacyJson !== restrictedJson) {
    throw createVerifierError(
      "TASK3_STAFF_MENU_COMPATIBILITY_FAILED",
      "Restricted staff menu output differs from legacy output"
    );
  }
  return {
    result: "PASS",
    payloadDigest: crypto
      .createHash("sha256")
      .update(restrictedJson)
      .digest("hex")
      .slice(0, 16)
  };
}

function safeFailure(error) {
  const code = error?.code
    ? String(error.code)
    : "TASK3_STAFF_MENU_FAILED";
  return {
    success: false,
    code,
    message:
      code.startsWith("TASK3_") || code.startsWith("TENANT_")
        ? String(
            error?.message ||
              "Tenant staff menu verification failed"
          )
        : "Tenant staff menu connection or query failed"
  };
}

async function main() {
  const inputs = readInputs();
  let localServer;
  try {
    const local = await startLocalApp();
    localServer = local.server;

    const unauthenticated = await requestJson(
      `${local.baseUrl}/api/staff/menu`
    );
    if (
      unauthenticated.status !== 401 ||
      unauthenticated.body?.success !== false
    ) {
      throw createVerifierError(
        "TASK3_STAFF_MENU_AUTH_REQUIRED_FAILED",
        "Staff menu did not reject an anonymous request"
      );
    }

    const tenantAResult = await probeMenu(
      local.baseUrl,
      inputs.contextA
    );
    const tenantBResult = await probeMenu(
      local.baseUrl,
      inputs.contextB
    );
    const compatibility = {
      tenantA: verifyLegacyCompatibility(
        await fetchLegacyStaffMenuPayload(inputs.contextA.slug),
        tenantAResult.payload
      ),
      tenantB: verifyLegacyCompatibility(
        await fetchLegacyStaffMenuPayload(inputs.contextB.slug),
        tenantBResult.payload
      )
    };

    const unknown = await requestJson(
      `${local.baseUrl}/api/staff/menu`,
      {
        headers: {
          authorization:
            `Bearer ${createStaffToken(
              "task3e-property-does-not-exist"
            )}`
        }
      }
    );
    if (
      unknown.status !== 403 ||
      unknown.body?.success !== false
    ) {
      throw createVerifierError(
        "TASK3_STAFF_MENU_UNKNOWN_SLUG_FAILED",
        "Unknown staff hotel scope did not fail closed"
      );
    }

    let concurrentPasses = 0;
    for (
      let index = 0;
      index < inputs.iterations;
      index += 1
    ) {
      const pair = await Promise.all([
        probeMenu(local.baseUrl, inputs.contextA),
        probeMenu(local.baseUrl, inputs.contextB)
      ]);
      concurrentPasses += pair.length;
    }
    const expectedPasses = inputs.iterations * 2;
    if (concurrentPasses !== expectedPasses) {
      throw createVerifierError(
        "TASK3_STAFF_MENU_CONCURRENCY_FAILED",
        "Concurrent staff menu probes did not all pass"
      );
    }

    process.stdout.write(
      `${JSON.stringify({
        success: true,
        mode: "READ_ONLY_STAFF_MENU_ROUTE_PILOT",
        route: "/api/staff/menu",
        runtimeRole: "app_tenant_runtime",
        authentication: "SIGNED_SYNTHETIC_LOCAL_STAFF_TOKEN",
        anonymousRejected: true,
        tenantA: tenantAResult.evidence,
        tenantB: tenantBResult.evidence,
        legacyCompatibility: compatibility,
        forgedTenantInputsIgnored: true,
        unknownSlug: {
          httpStatus: unknown.status,
          result: "PASS"
        },
        concurrency: {
          iterations: inputs.iterations,
          expectedPasses,
          actualPasses: concurrentPasses,
          result: "PASS"
        },
        writesMigrated: false,
        result: "PASS",
        timestamp: new Date().toISOString()
      }, null, 2)}\n`
    );
  } finally {
    await stopLocalApp(localServer);
    await closeTenantPool();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify(safeFailure(error), null, 2)}\n`
    );
    process.exitCode = 1;
  });
}

module.exports = {
  hasInternalContext,
  readInputs,
  verifyLegacyCompatibility,
  verifyStaffMenuResponse
};
