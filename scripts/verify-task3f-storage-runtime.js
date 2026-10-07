"use strict";

const crypto = require("crypto");

const CONFIRMATION = "TASK3F_STORAGE_RUNTIME_SYNTHETIC";
const DEFAULT_BASE_URL = "https://atithisarthibackendcode-production-f8d1.up.railway.app";
const TEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7KsAAAAASUVORK5CYII=",
  "base64"
);

function normalizeApprovedBaseUrl(value = "") {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error("TASK3F_STORAGE_BASE_URL_INVALID");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("TASK3F_STORAGE_BASE_URL_INVALID");
  }
  const normalized = parsed.origin;
  if (normalized !== DEFAULT_BASE_URL) throw new Error("TASK3F_STORAGE_BASE_URL_NOT_APPROVED");
  return normalized;
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function uploadFixture(baseUrl, token, hotelSlug, label) {
  const form = new FormData();
  form.append("hotelSlug", hotelSlug);
  form.append("folder", "task3f-runtime");
  form.append("file", new Blob([TEST_PNG], { type: "image/png" }), `task3f-${label}.png`);
  const { response, payload } = await requestJson(`${baseUrl}/api/admin/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });
  if (response.status !== 201 || payload?.success !== true || !payload?.file?.path || !payload?.file?.publicUrl) {
    throw new Error(`TASK3F_STORAGE_UPLOAD_FAILED_${response.status}`);
  }
  return payload.file;
}

async function deleteFixture(baseUrl, token, storagePath) {
  const { response, payload } = await requestJson(`${baseUrl}/api/admin/upload`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ storagePath })
  });
  if (response.status !== 200 || payload?.success !== true) {
    throw new Error(`TASK3F_STORAGE_CLEANUP_FAILED_${response.status}`);
  }
}

async function run() {
  if (process.env.TASK3F_STORAGE_RUNTIME_CONFIRM !== CONFIRMATION) {
    throw new Error("TASK3F_STORAGE_RUNTIME_CONFIRMATION_REQUIRED");
  }
  const baseUrl = normalizeApprovedBaseUrl(process.env.TASK3F_STORAGE_RUNTIME_BASE_URL || DEFAULT_BASE_URL);
  const [health, readiness] = await Promise.all([
    requestJson(`${baseUrl}/`),
    requestJson(`${baseUrl}/api/readiness`)
  ]);
  if (health.response.status !== 200 || health.payload?.success !== true) {
    throw new Error("TASK3F_STORAGE_HEALTH_FAILED");
  }
  if (readiness.response.status !== 200 || readiness.payload?.success !== true || readiness.payload?.ready !== true) {
    throw new Error("TASK3F_STORAGE_READINESS_FAILED");
  }
  const { supabase } = require("../utils/supabase");
  const { signAdminToken } = require("../utils/auth");
  const { isPropertyStoragePath, resolvePropertyStorageScope } = require("../utils/storage-object-scope");
  const hotelA = String(process.env.TASK3F_STORAGE_TENANT_A_SLUG || "hotel-sai-raj").trim().toLowerCase();
  const hotelB = String(process.env.TASK3F_STORAGE_TENANT_B_SLUG || "the-food-garden").trim().toLowerCase();
  if (!hotelA || !hotelB || hotelA === hotelB) throw new Error("TASK3F_STORAGE_TWO_DISTINCT_HOTELS_REQUIRED");

  const [scopeA, scopeB] = await Promise.all([
    resolvePropertyStorageScope(supabase, hotelA),
    resolvePropertyStorageScope(supabase, hotelB)
  ]);
  if (scopeA.tenantId === scopeB.tenantId || scopeA.propertyId === scopeB.propertyId) {
    throw new Error("TASK3F_STORAGE_TWO_DISTINCT_OWNERS_REQUIRED");
  }

  const token = signAdminToken({
    id: "task3f-storage-runtime",
    email: "task3f-storage-runtime@example.invalid",
    full_name: "Task 3F verifier"
  });
  const created = [];
  try {
    const [fileA, fileB] = await Promise.all([
      uploadFixture(baseUrl, token, hotelA, "a"),
      uploadFixture(baseUrl, token, hotelB, "b")
    ]);
    created.push(fileA.path, fileB.path);

    if (!isPropertyStoragePath(fileA.path, scopeA, { resource: "task3f-runtime" })) {
      throw new Error("TASK3F_STORAGE_TENANT_A_PATH_INVALID");
    }
    if (!isPropertyStoragePath(fileB.path, scopeB, { resource: "task3f-runtime" })) {
      throw new Error("TASK3F_STORAGE_TENANT_B_PATH_INVALID");
    }
    if (isPropertyStoragePath(fileA.path, scopeB) || isPropertyStoragePath(fileB.path, scopeA)) {
      throw new Error("TASK3F_STORAGE_CROSS_TENANT_PATH_ACCEPTED");
    }

    const publicReads = await Promise.all([
      fetch(fileA.publicUrl, { signal: AbortSignal.timeout(15000) }),
      fetch(fileB.publicUrl, { signal: AbortSignal.timeout(15000) })
    ]);
    if (publicReads.some((response) => !response.ok)) throw new Error("TASK3F_STORAGE_PUBLIC_COMPATIBILITY_FAILED");

    const orphanProbe = await requestJson(`${baseUrl}/api/admin/upload`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ storagePath: "chai-chaska-ujjain/task3f-runtime/must-not-delete.png" })
    });
    if (orphanProbe.response.status !== 403 || orphanProbe.payload?.success !== false) {
      throw new Error("TASK3F_STORAGE_ORPHAN_PREFIX_NOT_DENIED");
    }

    await Promise.all(created.map((storagePath) => deleteFixture(baseUrl, token, storagePath)));
    created.length = 0;
    console.log(JSON.stringify({
      success: true,
      mode: "LIVE_SYNTHETIC_STORAGE_CANARY",
      bucket: "hotel-assets",
      health: "PASS",
      readiness: "PASS",
      publicDeliveryPreserved: true,
      canonicalTenantA: true,
      canonicalTenantB: true,
      crossTenantPathBinding: "PASS",
      orphanPrefixDelete: "DENIED",
      cleanup: "PASS",
      fixtureDigests: [digest(fileA.path), digest(fileB.path)],
      tokensLogged: false,
      objectPathsLogged: false,
      result: "PASS",
      timestamp: new Date().toISOString()
    }, null, 2));
  } finally {
    for (const storagePath of created) {
      try {
        await deleteFixture(baseUrl, token, storagePath);
      } catch {
        console.error(JSON.stringify({ success: false, code: "TASK3F_STORAGE_CLEANUP_RETRY_REQUIRED", fixtureDigest: digest(storagePath) }));
      }
    }
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(JSON.stringify({
      success: false,
      code: String(error?.message || "TASK3F_STORAGE_RUNTIME_FAILED").slice(0, 160),
      message: "Task 3F synthetic storage verification failed"
    }, null, 2));
    process.exitCode = 1;
  });
}

module.exports = { CONFIRMATION, DEFAULT_BASE_URL, digest, normalizeApprovedBaseUrl };

