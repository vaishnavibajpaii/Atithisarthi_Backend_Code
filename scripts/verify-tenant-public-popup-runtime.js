"use strict";

require("dotenv").config({ quiet: true });

process.env.TENANT_RUNTIME_ENABLED = "true";
process.env.TENANT_RUNTIME_PUBLIC_POPUP_ENABLED = "true";
process.env.PAYMENT_WEBHOOK_WORKER_ENABLED = "false";
process.env.NOTIFICATION_DELIVERY_ENABLED = "false";
process.env.SUPABASE_URL ||= "https://tenant-public-popup-verifier.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used";
process.env.JWT_SECRET ||= "not-used";

const crypto = require("crypto");
const express = require("express");
const publicRouter = require("../routes/public");
const { supabase } = require("../utils/supabase");
const { closeTenantPool } = require("../utils/tenant-database");
const { normalizePropertySlug } = require("../utils/tenant-request-context");
const { buildPublicPopupNotificationPayload } = require("../utils/public-popup-notification-presentation");
const { validateTenantDatabaseUrl } = require("./verify-tenant-runtime-connection");

const EXPECTED_CONFIRMATION = "TASK3E_PUBLIC_POPUP_READ_ONLY";
const DEFAULT_ITERATIONS = 10;
const PUBLIC_FIELDS = [
  "id", "hotel_slug", "title", "description", "image_url", "storage_path",
  "cta_text", "cta_link", "display_mode", "start_at", "end_at", "priority", "created_at"
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
      "TASK3_PUBLIC_POPUP_ITERATIONS_INVALID",
      "TASK3_PUBLIC_ROUTE_CONCURRENCY_ITERATIONS must be from 1 to 50"
    );
  }
  return parsed;
}

function readInputs() {
  if (process.env.TASK3_PUBLIC_POPUP_VERIFY_CONFIRM !== EXPECTED_CONFIRMATION) {
    throw createVerifierError(
      "TASK3_PUBLIC_POPUP_CONFIRMATION_MISSING",
      `Set TASK3_PUBLIC_POPUP_VERIFY_CONFIRM=${EXPECTED_CONFIRMATION}`
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
    !tenantAId || !tenantBId || !propertyAId || !propertyBId ||
    tenantAId === tenantBId || propertyAId === propertyBId || slugA === slugB
  ) {
    throw createVerifierError(
      "TASK3_PUBLIC_POPUP_CONTEXTS_INVALID",
      "Two distinct canonical tenant/property test contexts are required"
    );
  }
  return {
    contextA: { slug: slugA, forgedTenantId: tenantBId, forgedPropertyId: propertyBId },
    contextB: { slug: slugB, forgedTenantId: tenantAId, forgedPropertyId: propertyAId },
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
          "TASK3_PUBLIC_POPUP_SERVER_INVALID",
          "Local verification server did not expose a TCP port"
        ));
        return;
      }
      resolve({ baseUrl: `http://127.0.0.1:${address.port}`, server });
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
    try { body = await response.json(); } catch {
      throw createVerifierError(
        "TASK3_PUBLIC_POPUP_RESPONSE_INVALID",
        "Public popup route did not return JSON"
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
  const forbidden = new Set(["tenant_id", "property_id", "tenantId", "propertyId"]);
  return Object.entries(value).some(
    ([key, nested]) => forbidden.has(key) || hasInternalContext(nested)
  );
}

function verifyPopup(result, expectedSlug) {
  const notifications = result.body?.notifications;
  if (
    result.status !== 200 ||
    result.body?.success !== true ||
    !Array.isArray(notifications) ||
    notifications.some((item) => item?.hotelSlug !== expectedSlug) ||
    (notifications.length === 0 && result.body?.notification !== null) ||
    (notifications.length > 0 && result.body?.notification?.id !== notifications[0]?.id)
  ) {
    throw createVerifierError(
      "TASK3_PUBLIC_POPUP_RESPONSE_MISMATCH",
      "Public popup route did not return the expected property contract"
    );
  }
  if (hasInternalContext(result.body)) {
    throw createVerifierError(
      "TASK3_PUBLIC_POPUP_CONTEXT_EXPOSED",
      "Public popup response exposed internal ownership fields"
    );
  }
  return {
    httpStatus: result.status,
    itemCount: notifications.length,
    matchedSlug: expectedSlug,
    internalContextExposed: false
  };
}

async function probePopup(baseUrl, context) {
  const query = new URLSearchParams({
    tenant_id: context.forgedTenantId,
    property_id: context.forgedPropertyId
  });
  const result = await requestJson(
    `${baseUrl}/api/public/popup-notification/${encodeURIComponent(context.slug)}?${query}`,
    {
      headers: {
        "x-tenant-id": context.forgedTenantId,
        "x-property-id": context.forgedPropertyId
      }
    }
  );
  return { evidence: verifyPopup(result, context.slug), payload: result.body };
}

async function fetchLegacyPayload(hotelSlug) {
  const { data, error } = await supabase
    .from("hotel_popup_notifications")
    .select(PUBLIC_FIELDS)
    .eq("hotel_slug", hotelSlug)
    .eq("is_active", true)
    .order("priority", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return buildPublicPopupNotificationPayload(data || []);
}

function verifyLegacyCompatibility(legacyPayload, restrictedPayload) {
  const legacyJson = JSON.stringify(legacyPayload);
  const restrictedJson = JSON.stringify(restrictedPayload);
  if (legacyJson !== restrictedJson) {
    throw createVerifierError(
      "TASK3_PUBLIC_POPUP_COMPATIBILITY_FAILED",
      "Restricted public popup output differs from the current legacy output"
    );
  }
  return {
    result: "PASS",
    payloadDigest: crypto.createHash("sha256").update(restrictedJson).digest("hex").slice(0, 16)
  };
}

function safeFailure(error) {
  const code = error?.code ? String(error.code) : "TASK3_PUBLIC_POPUP_FAILED";
  return {
    success: false,
    code,
    message: code.startsWith("TASK3_") || code.startsWith("TENANT_")
      ? String(error?.message || "Tenant public popup verification failed")
      : "Tenant public popup connection or query failed"
  };
}

async function main() {
  const inputs = readInputs();
  let localServer;
  try {
    const local = await startLocalApp();
    localServer = local.server;
    const tenantAResult = await probePopup(local.baseUrl, inputs.contextA);
    const tenantBResult = await probePopup(local.baseUrl, inputs.contextB);
    const compatibility = {
      tenantA: verifyLegacyCompatibility(await fetchLegacyPayload(inputs.contextA.slug), tenantAResult.payload),
      tenantB: verifyLegacyCompatibility(await fetchLegacyPayload(inputs.contextB.slug), tenantBResult.payload)
    };
    const unknown = await requestJson(
      `${local.baseUrl}/api/public/popup-notification/task3e-property-does-not-exist`
    );
    if (unknown.status !== 404 || unknown.body?.success !== false) {
      throw createVerifierError(
        "TASK3_PUBLIC_POPUP_UNKNOWN_SLUG_FAILED",
        "Unknown public popup slug did not fail closed"
      );
    }
    let concurrentPasses = 0;
    for (let index = 0; index < inputs.iterations; index += 1) {
      const pair = await Promise.all([
        probePopup(local.baseUrl, inputs.contextA),
        probePopup(local.baseUrl, inputs.contextB)
      ]);
      concurrentPasses += pair.length;
    }
    const expectedPasses = inputs.iterations * 2;
    if (concurrentPasses !== expectedPasses) {
      throw createVerifierError(
        "TASK3_PUBLIC_POPUP_CONCURRENCY_FAILED",
        "Concurrent public popup probes did not all pass"
      );
    }
    process.stdout.write(`${JSON.stringify({
      success: true,
      mode: "READ_ONLY_POPUP_ROUTE_PILOT",
      route: "/api/public/popup-notification/:slug",
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
  hasInternalContext,
  readPositiveInteger,
  verifyLegacyCompatibility,
  verifyPopup
};
