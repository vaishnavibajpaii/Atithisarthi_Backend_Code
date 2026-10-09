"use strict";

const { env } = require("../config/env");
const { createTenantMutationClient } = require("./tenant-mutation-client");
const { getTenantRequestScope } = require("./tenant-request-context");
const {
  attachCanonicalStaffTenantContext
} = require("./tenant-staff-context");

function getTenantMutationClient(req, legacyClient, options = {}) {
  if (!env.tenantRuntimeWritesEnabled) return legacyClient;
  return createTenantMutationClient(
    getTenantRequestScope(req),
    options
  );
}

async function getStaffTenantMutationClient(req, legacyClient, options = {}) {
  if (!env.tenantRuntimeWritesEnabled) return legacyClient;
  let scope;
  try {
    scope = getTenantRequestScope(req);
  } catch (error) {
    if (error?.code !== "TENANT_REQUEST_CONTEXT_MISSING") throw error;
    const hotel = await attachCanonicalStaffTenantContext(req);
    if (!hotel) {
      const scopeError = new Error("Staff hotel scope is not mapped to a tenant");
      scopeError.code = "HOTEL_SCOPE_REQUIRED";
      throw scopeError;
    }
    scope = getTenantRequestScope(req);
  }
  return createTenantMutationClient(scope, options);
}

module.exports = {
  getStaffTenantMutationClient,
  getTenantMutationClient
};
