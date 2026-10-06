"use strict";

const { normalizeHotelFeatureConfig } = require("./hotel-feature-settings");
const { withTenantTransaction } = require("./tenant-database");
const { normalizePropertySlug } = require("./tenant-request-context");

function createTenantStaffSessionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeStaffSessionScope(scope = {}, requestedSlug = "") {
  const propertySlug = normalizePropertySlug(scope.propertySlug);
  const staffSlug = normalizePropertySlug(requestedSlug);
  if (propertySlug !== staffSlug) {
    throw createTenantStaffSessionError(
      "TENANT_STAFF_SESSION_SCOPE_CONFLICT",
      "Staff hotel does not match canonical tenant request context"
    );
  }

  return {
    tenantId: scope.tenantId,
    propertyId: scope.propertyId,
    propertySlug
  };
}

function getSingleFeaturePayload(result) {
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  if (rows.length > 1) {
    throw createTenantStaffSessionError(
      "TENANT_STAFF_SESSION_DATA_CONFLICT",
      "Multiple canonical hotel feature settings rows were returned"
    );
  }
  const payload = rows[0]?.payload;
  return payload && typeof payload === "object" ? payload : null;
}

async function fetchTenantStaffSessionFeatures(
  inputScope,
  requestedSlug,
  options = {}
) {
  const scope = normalizeStaffSessionScope(inputScope, requestedSlug);
  const transactionRunner =
    options.transactionRunner || withTenantTransaction;

  return transactionRunner(
    {
      tenantId: scope.tenantId,
      propertyId: scope.propertyId
    },
    async (client) => {
      const result = await client.query(
        `SELECT to_jsonb(feature) AS payload
           FROM public.hotel_feature_settings AS feature
          WHERE feature.tenant_id = $1::uuid
            AND feature.property_id = $2::bigint
            AND feature.hotel_slug = $3
          LIMIT 2`,
        [
          scope.tenantId,
          scope.propertyId,
          scope.propertySlug
        ]
      );

      return normalizeHotelFeatureConfig(
        getSingleFeaturePayload(result) || {},
        scope.propertySlug
      );
    },
    { readOnly: true }
  );
}

module.exports = {
  fetchTenantStaffSessionFeatures,
  normalizeStaffSessionScope
};
