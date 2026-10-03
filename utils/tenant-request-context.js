"use strict";

const { normalizeTenantContext } = require("./tenant-database");

const PROPERTY_SLUG_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/;
const SOURCE_PATTERN = /^[a-z][a-z0-9_]{1,79}$/;

function createTenantContextError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizePropertySlug(value) {
  const slug = String(value || "").trim().toLowerCase();
  if (!PROPERTY_SLUG_PATTERN.test(slug)) {
    throw createTenantContextError(
      "TENANT_REQUEST_CONTEXT_INVALID",
      "A valid canonical property slug is required"
    );
  }
  return slug;
}

function normalizeContextSource(value) {
  const source = String(value || "").trim().toLowerCase();
  if (!SOURCE_PATTERN.test(source)) {
    throw createTenantContextError(
      "TENANT_REQUEST_CONTEXT_INVALID",
      "A valid server-controlled tenant context source is required"
    );
  }
  return source;
}

function buildTenantRequestContext({
  tenantId,
  propertyId,
  propertySlug,
  source
} = {}) {
  const scope = normalizeTenantContext({ tenantId, propertyId });
  const slug = normalizePropertySlug(propertySlug);
  const normalizedSource = normalizeContextSource(source);

  return Object.freeze({
    tenant: Object.freeze({ id: scope.tenantId }),
    property: Object.freeze({
      id: scope.propertyId,
      slug
    }),
    metadata: Object.freeze({ source: normalizedSource })
  });
}

function isSameContext(existing, next) {
  return (
    existing?.tenant?.id === next.tenant.id &&
    existing?.property?.id === next.property.id &&
    existing?.property?.slug === next.property.slug &&
    existing?.metadata?.source === next.metadata.source
  );
}

function getAttachedContext(req) {
  if (!req || typeof req !== "object") return null;
  if (!req.tenant || !req.property || !req.tenantContext) return null;
  return {
    tenant: req.tenant,
    property: req.property,
    metadata: req.tenantContext
  };
}

function attachTenantRequestContext(req, input) {
  if (!req || typeof req !== "object") {
    throw createTenantContextError(
      "TENANT_REQUEST_OBJECT_INVALID",
      "An Express request object is required"
    );
  }

  const context = buildTenantRequestContext(input);
  const existing = getAttachedContext(req);

  if (existing) {
    if (!isSameContext(existing, context)) {
      throw createTenantContextError(
        "TENANT_REQUEST_CONTEXT_CONFLICT",
        "Conflicting tenant context is already attached to this request"
      );
    }
    return context;
  }

  if (
    Object.prototype.hasOwnProperty.call(req, "tenant") ||
    Object.prototype.hasOwnProperty.call(req, "property") ||
    Object.prototype.hasOwnProperty.call(req, "tenantContext")
  ) {
    throw createTenantContextError(
      "TENANT_REQUEST_CONTEXT_CONFLICT",
      "Tenant request fields already exist without a complete canonical context"
    );
  }

  Object.defineProperties(req, {
    tenant: {
      configurable: false,
      enumerable: false,
      value: context.tenant,
      writable: false
    },
    property: {
      configurable: false,
      enumerable: false,
      value: context.property,
      writable: false
    },
    tenantContext: {
      configurable: false,
      enumerable: false,
      value: context.metadata,
      writable: false
    }
  });

  return context;
}

function getTenantRequestScope(req) {
  const attached = getAttachedContext(req);
  if (!attached) {
    throw createTenantContextError(
      "TENANT_REQUEST_CONTEXT_MISSING",
      "Canonical tenant context is missing from this request"
    );
  }

  const context = buildTenantRequestContext({
    tenantId: attached.tenant.id,
    propertyId: attached.property.id,
    propertySlug: attached.property.slug,
    source: attached.metadata.source
  });

  return Object.freeze({
    tenantId: context.tenant.id,
    propertyId: context.property.id,
    propertySlug: context.property.slug,
    source: context.metadata.source
  });
}

module.exports = {
  attachTenantRequestContext,
  buildTenantRequestContext,
  getTenantRequestScope,
  normalizeContextSource,
  normalizePropertySlug
};
