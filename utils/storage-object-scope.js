"use strict";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,119}$/;
const RESOURCE_PATTERN = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/;

function normalizeHotelSlug(value = "") {
  const slug = String(value || "").trim().toLowerCase();
  return SLUG_PATTERN.test(slug) ? slug : "";
}

function normalizePropertyScope(scope = {}) {
  const tenantId = String(scope.tenantId || scope.tenant_id || "").trim().toLowerCase();
  const propertyId = Number(scope.propertyId ?? scope.property_id ?? scope.id);
  const propertySlug = normalizeHotelSlug(scope.propertySlug || scope.slug || scope.hotelSlug);
  if (!UUID_PATTERN.test(tenantId) || !Number.isSafeInteger(propertyId) || propertyId <= 0 || !propertySlug) {
    throw Object.assign(new Error("Canonical property storage scope is incomplete"), {
      code: "STORAGE_SCOPE_INVALID",
      statusCode: 409
    });
  }
  return { tenantId, propertyId, propertySlug };
}

function assertSafeResource(resource = "") {
  const value = String(resource || "").trim().toLowerCase();
  if (!RESOURCE_PATTERN.test(value)) {
    throw Object.assign(new Error("Storage resource path is invalid"), {
      code: "STORAGE_RESOURCE_INVALID",
      statusCode: 400
    });
  }
  return value;
}

function isSafeObjectPath(value = "") {
  const objectPath = String(value || "");
  if (!objectPath || objectPath !== objectPath.trim() || objectPath.length > 1000) return false;
  if (objectPath.startsWith("/") || objectPath.endsWith("/") || objectPath.includes("\\") || objectPath.includes("//")) return false;
  if (/[?#\u0000-\u001f]/.test(objectPath) || /%(?:2e|2f|5c)/i.test(objectPath)) return false;
  const segments = objectPath.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== ".." && !segment.includes(".."));
}

function assertSafeFileName(value = "") {
  const name = String(value || "").trim();
  if (!name || name.includes("/") || !isSafeObjectPath(name)) {
    throw Object.assign(new Error("Storage object name is invalid"), {
      code: "STORAGE_OBJECT_NAME_INVALID",
      statusCode: 400
    });
  }
  return name;
}

function propertyStoragePrefix(scope) {
  const canonical = normalizePropertyScope(scope);
  return `tenants/${canonical.tenantId}/properties/${canonical.propertyId}/`;
}

function buildPropertyStoragePath(scope, resource, fileName) {
  return `${propertyStoragePrefix(scope)}${assertSafeResource(resource)}/${assertSafeFileName(fileName)}`;
}

function buildPlatformStoragePath(resource, fileName) {
  return `platform/${assertSafeResource(resource)}/${assertSafeFileName(fileName)}`;
}

function isPlatformStoragePath(storagePath, resource = "") {
  if (!isSafeObjectPath(storagePath)) return false;
  const expected = resource ? `platform/${assertSafeResource(resource)}/` : "platform/";
  return storagePath.startsWith(expected) && storagePath.length > expected.length;
}

function isPropertyStoragePath(storagePath, scope, options = {}) {
  if (!isSafeObjectPath(storagePath)) return false;
  const canonical = normalizePropertyScope(scope);
  const resource = options.resource ? `${assertSafeResource(options.resource)}/` : "";
  const canonicalPrefix = `${propertyStoragePrefix(canonical)}${resource}`;
  if (storagePath.startsWith(canonicalPrefix) && storagePath.length > canonicalPrefix.length) return true;
  if (options.allowLegacy !== true) return false;
  const legacyPrefix = `${canonical.propertySlug}/${resource}`;
  return storagePath.startsWith(legacyPrefix) && storagePath.length > legacyPrefix.length;
}

async function resolvePropertyStorageScope(supabaseClient, hotelSlug) {
  const slug = normalizeHotelSlug(hotelSlug);
  if (!slug) {
    throw Object.assign(new Error("Hotel storage scope is invalid"), {
      code: "STORAGE_HOTEL_SCOPE_INVALID",
      statusCode: 400
    });
  }
  const { data, error } = await supabaseClient
    .from("hotels")
    .select("id,tenant_id,slug")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw Object.assign(new Error("Hotel storage scope was not found"), {
      code: "STORAGE_HOTEL_SCOPE_NOT_FOUND",
      statusCode: 404
    });
  }
  return normalizePropertyScope({
    tenantId: data.tenant_id,
    propertyId: data.id,
    propertySlug: data.slug
  });
}

async function authorizePlatformAdminStoragePath(supabaseClient, storagePath) {
  if (!isSafeObjectPath(storagePath)) return null;
  if (isPlatformStoragePath(storagePath)) return { kind: "platform" };
  const parts = storagePath.split("/");
  if (parts[0] === "tenants" && parts[2] === "properties" && parts.length >= 6) {
    const tenantId = String(parts[1] || "").toLowerCase();
    const propertyId = Number(parts[3]);
    if (!UUID_PATTERN.test(tenantId) || !Number.isSafeInteger(propertyId) || propertyId <= 0) return null;
    const { data, error } = await supabaseClient
      .from("hotels")
      .select("id,tenant_id,slug")
      .eq("id", propertyId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const scope = normalizePropertyScope({ tenantId: data.tenant_id, propertyId: data.id, propertySlug: data.slug });
    return isPropertyStoragePath(storagePath, scope) ? { kind: "property", scope, legacy: false } : null;
  }
  const slug = normalizeHotelSlug(parts[0]);
  if (!slug || parts.length < 3) return null;
  try {
    const scope = await resolvePropertyStorageScope(supabaseClient, slug);
    return isPropertyStoragePath(storagePath, scope, { allowLegacy: true })
      ? { kind: "property", scope, legacy: true }
      : null;
  } catch (error) {
    if (error?.code === "STORAGE_HOTEL_SCOPE_NOT_FOUND") return null;
    throw error;
  }
}

module.exports = {
  authorizePlatformAdminStoragePath,
  buildPlatformStoragePath,
  buildPropertyStoragePath,
  isPlatformStoragePath,
  isPropertyStoragePath,
  isSafeObjectPath,
  normalizePropertyScope,
  propertyStoragePrefix,
  resolvePropertyStorageScope
};
