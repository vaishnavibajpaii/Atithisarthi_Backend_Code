"use strict";

require("dotenv").config({ quiet: true });

process.env.TENANT_RUNTIME_ENABLED = "true";
process.env.TENANT_RUNTIME_PUBLIC_MENU_ENABLED = "true";
process.env.PAYMENT_WEBHOOK_WORKER_ENABLED = "false";
process.env.NOTIFICATION_DELIVERY_ENABLED = "false";
process.env.SUPABASE_URL ||= "https://tenant-public-menu-verifier.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const express = require("express");
const crypto = require("crypto");
const publicRouter = require("../routes/public");
const { supabase } = require("../utils/supabase");
const { closeTenantPool } = require("../utils/tenant-database");
const {
  fetchHotelMenuCategories
} = require("../utils/menu-categories");
const {
  fetchMenuComboPresentationMap,
  isMissingMenuComboSchemaError
} = require("../utils/menu-combos");
const {
  buildPublicMenuPayload
} = require("../utils/public-menu-presentation");
const {
  normalizePropertySlug
} = require("../utils/tenant-request-context");
const {
  validateTenantDatabaseUrl
} = require("./verify-tenant-runtime-connection");

const EXPECTED_CONFIRMATION = "TASK3E_PUBLIC_MENU_READ_ONLY";
const DEFAULT_ITERATIONS = 10;
const PUBLIC_MENU_FIELDS = [
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
      "TASK3_PUBLIC_MENU_ITERATIONS_INVALID",
      "TASK3_PUBLIC_ROUTE_CONCURRENCY_ITERATIONS must be from 1 to 50"
    );
  }
  return parsed;
}

function readInputs() {
  if (process.env.TASK3_PUBLIC_MENU_VERIFY_CONFIRM !== EXPECTED_CONFIRMATION) {
    throw createVerifierError(
      "TASK3_PUBLIC_MENU_CONFIRMATION_MISSING",
      `Set TASK3_PUBLIC_MENU_VERIFY_CONFIRM=${EXPECTED_CONFIRMATION}`
    );
  }
  validateTenantDatabaseUrl(process.env.TENANT_DATABASE_URL);

  const tenantAId = String(process.env.TASK3_TEST_TENANT_A_ID || "").trim();
  const tenantBId = String(process.env.TASK3_TEST_TENANT_B_ID || "").trim();
  const propertyAId = String(process.env.TASK3_TEST_PROPERTY_A_ID || "").trim();
  const propertyBId = String(process.env.TASK3_TEST_PROPERTY_B_ID || "").trim();
  const slugA = normalizePropertySlug(process.env.TASK3_TEST_PROPERTY_A_SLUG);
  const slugB = normalizePropertySlug(process.env.TASK3_TEST_PROPERTY_B_SLUG);

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
      "TASK3_PUBLIC_MENU_CONTEXTS_INVALID",
      "Two distinct canonical tenant/property test contexts are required"
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
      process.env.TASK3_PUBLIC_ROUTE_CONCURRENCY_ITERATIONS,
      DEFAULT_ITERATIONS
    )
  };
}

function startLocalApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use("/api/public", publicRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(createVerifierError(
          "TASK3_PUBLIC_MENU_SERVER_INVALID",
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
    const response = await fetch(url, { ...options, signal: controller.signal });
    let body;
    try {
      body = await response.json();
    } catch {
      throw createVerifierError(
        "TASK3_PUBLIC_MENU_RESPONSE_INVALID",
        "Public menu route did not return JSON"
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
    ([key, nestedValue]) =>
      forbiddenKeys.has(key) || hasInternalContext(nestedValue)
  );
}

function verifySuccessfulMenuResponse(result) {
  const categories = result.body?.categories;
  const menu = result.body?.menu;
  if (
    result.status !== 200 ||
    result.body?.success !== true ||
    result.body?.categorySource !== "menu-categories" ||
    !Array.isArray(categories) ||
    !menu ||
    typeof menu !== "object" ||
    !/^[0-9a-f]{16}$/.test(String(result.body?.menuVersion || ""))
  ) {
    throw createVerifierError(
      "TASK3_PUBLIC_MENU_RESPONSE_MISMATCH",
      "Public menu route did not return the expected response contract"
    );
  }
  if (hasInternalContext(result.body)) {
    throw createVerifierError(
      "TASK3_PUBLIC_MENU_CONTEXT_EXPOSED",
      "Public menu response exposed internal ownership fields"
    );
  }
  return {
    httpStatus: result.status,
    categoryCount: categories.length,
    itemCount: Object.values(menu).reduce(
      (total, items) => total + (Array.isArray(items) ? items.length : 0),
      0
    ),
    internalContextExposed: false
  };
}

async function probeMenu(baseUrl, context) {
  const query = new URLSearchParams({
    tenant_id: context.forgedTenantId,
    property_id: context.forgedPropertyId
  });
  const result = await requestJson(
    `${baseUrl}/api/public/menu/${encodeURIComponent(context.slug)}?${query}`,
    {
      headers: {
        "x-tenant-id": context.forgedTenantId,
        "x-property-id": context.forgedPropertyId
      }
    }
  );
  return {
    evidence: verifySuccessfulMenuResponse(result),
    payload: result.body
  };
}

async function fetchLegacyMenuPayload(hotelSlug) {
  const { data, error } = await supabase
    .from("menu_items")
    .select(PUBLIC_MENU_FIELDS)
    .eq("hotel_slug", hotelSlug)
    .eq("is_available", true)
    .eq("is_archived", false)
    .order("category", { ascending: true })
    .order("sort_order", { ascending: true })
    .order("item_id", { ascending: true });
  if (error) throw error;
  const menuItems = data || [];
  const categoryResult = await fetchHotelMenuCategories({
    supabase,
    hotelSlug,
    consumer: "website",
    menuItems
  });
  let comboPresentationMap = new Map();
  try {
    comboPresentationMap = await fetchMenuComboPresentationMap({
      hotelSlug,
      menuItems
    });
  } catch (comboError) {
    if (!isMissingMenuComboSchemaError(comboError)) throw comboError;
  }
  return buildPublicMenuPayload({
    menuItems,
    categoryResult,
    comboPresentationMap
  });
}

function verifyLegacyCompatibility(legacyPayload, restrictedPayload) {
  const legacyJson = JSON.stringify(legacyPayload);
  const restrictedJson = JSON.stringify(restrictedPayload);
  if (legacyJson !== restrictedJson) {
    const findDifference = (left, right, path = "$", seen = new Set()) => {
      if (Object.is(left, right)) return null;
      if (
        left === null ||
        right === null ||
        typeof left !== "object" ||
        typeof right !== "object"
      ) {
        return {
          path,
          leftType: left === null ? "null" : typeof left,
          rightType: right === null ? "null" : typeof right
        };
      }
      if (seen.has(left) || seen.has(right)) {
        return { path, leftType: "repeated-object", rightType: "repeated-object" };
      }
      seen.add(left);
      seen.add(right);
      if (Array.isArray(left) !== Array.isArray(right)) {
        return {
          path,
          leftType: Array.isArray(left) ? "array" : "object",
          rightType: Array.isArray(right) ? "array" : "object"
        };
      }
      const leftKeys = Object.keys(left);
      const rightKeys = Object.keys(right);
      if (
        leftKeys.length !== rightKeys.length ||
        leftKeys.some((key, index) => key !== rightKeys[index])
      ) {
        return {
          path: `${path}.[keys]`,
          leftType: `keys:${leftKeys.join(",")}`,
          rightType: `keys:${rightKeys.join(",")}`
        };
      }
      for (const key of leftKeys) {
        const nestedPath = findDifference(
          left[key],
          right[key],
          Array.isArray(left) ? `${path}[${key}]` : `${path}.${key}`,
          seen
        );
        if (nestedPath) return nestedPath;
      }
      return null;
    };
    const comparableLegacy = { ...legacyPayload, menuVersion: "<ignored>" };
    const comparableRestricted = { ...restrictedPayload, menuVersion: "<ignored>" };
    const nonVersionDifference = findDifference(
      comparableLegacy,
      comparableRestricted
    );
    throw createVerifierError(
      "TASK3_PUBLIC_MENU_COMPATIBILITY_FAILED",
      `Restricted public menu output differs from the current legacy output at ${nonVersionDifference?.path || "$.menuVersion"} (${nonVersionDifference?.leftType || "version"} vs ${nonVersionDifference?.rightType || "version"})`
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
  const code = error?.code ? String(error.code) : "TASK3_PUBLIC_MENU_FAILED";
  return {
    success: false,
    code,
    message:
      code.startsWith("TASK3_") || code.startsWith("TENANT_")
        ? String(error?.message || "Tenant public menu verification failed")
        : "Tenant public menu connection or query failed"
  };
}

async function main() {
  const inputs = readInputs();
  let localServer;
  try {
    const local = await startLocalApp();
    localServer = local.server;
    const tenantAResult = await probeMenu(local.baseUrl, inputs.contextA);
    const tenantBResult = await probeMenu(local.baseUrl, inputs.contextB);
    const legacyA = await fetchLegacyMenuPayload(inputs.contextA.slug);
    const legacyB = await fetchLegacyMenuPayload(inputs.contextB.slug);
    const compatibility = {
      tenantA: verifyLegacyCompatibility(legacyA, tenantAResult.payload),
      tenantB: verifyLegacyCompatibility(legacyB, tenantBResult.payload)
    };
    const unknown = await requestJson(
      `${local.baseUrl}/api/public/menu/task3e-property-does-not-exist`
    );
    if (unknown.status !== 404 || unknown.body?.success !== false) {
      throw createVerifierError(
        "TASK3_PUBLIC_MENU_UNKNOWN_SLUG_FAILED",
        "Unknown public menu slug did not fail closed"
      );
    }

    let concurrentPasses = 0;
    for (let index = 0; index < inputs.iterations; index += 1) {
      const pair = await Promise.all([
        probeMenu(local.baseUrl, inputs.contextA),
        probeMenu(local.baseUrl, inputs.contextB)
      ]);
      concurrentPasses += pair.length;
    }
    const expectedPasses = inputs.iterations * 2;
    if (concurrentPasses !== expectedPasses) {
      throw createVerifierError(
        "TASK3_PUBLIC_MENU_CONCURRENCY_FAILED",
        "Concurrent public menu probes did not all pass"
      );
    }

    process.stdout.write(`${JSON.stringify({
      success: true,
      mode: "READ_ONLY_MENU_ROUTE_PILOT",
      route: "/api/public/menu/:slug",
      runtimeRole: "app_tenant_runtime",
      tenantA: tenantAResult.evidence,
      tenantB: tenantBResult.evidence,
      legacyCompatibility: compatibility,
      forgedTenantInputsIgnored: true,
      unknownSlug: { httpStatus: unknown.status, result: "PASS" },
      concurrency: {
        iterations: inputs.iterations,
        expectedPasses,
        actualPasses: concurrentPasses,
        result: "PASS"
      },
      result: "PASS",
      timestamp: new Date().toISOString()
    }, null, 2)}\n`);
  } finally {
    await stopLocalApp(localServer);
    await closeTenantPool();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(safeFailure(error), null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  fetchLegacyMenuPayload,
  hasInternalContext,
  readInputs,
  readPositiveInteger,
  verifyLegacyCompatibility,
  verifySuccessfulMenuResponse
};
