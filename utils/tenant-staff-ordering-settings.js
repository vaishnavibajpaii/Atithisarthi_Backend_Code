"use strict";

const { withTenantTransaction } = require("./tenant-database");
const {
  normalizeHotelFeatureConfig
} = require("./hotel-feature-settings");
const {
  buildHotelOrderingSettings
} = require("./hotel-ordering-settings");
const {
  normalizePropertySlug
} = require("./tenant-request-context");

function createTenantStaffOrderingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeStaffOrderingScope(
  scope = {},
  requestedSlug = ""
) {
  const propertySlug = normalizePropertySlug(scope.propertySlug);
  const staffSlug = normalizePropertySlug(requestedSlug);
  if (propertySlug !== staffSlug) {
    throw createTenantStaffOrderingError(
      "TENANT_STAFF_ORDERING_SCOPE_CONFLICT",
      "Staff hotel does not match canonical tenant request context"
    );
  }
  return {
    tenantId: scope.tenantId,
    propertyId: scope.propertyId,
    propertySlug
  };
}

function getSinglePayload(result, label) {
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  if (rows.length > 1) {
    throw createTenantStaffOrderingError(
      "TENANT_STAFF_ORDERING_DATA_CONFLICT",
      `Multiple canonical ${label} rows were returned`
    );
  }
  const payload = rows[0]?.payload;
  return payload && typeof payload === "object" ? payload : null;
}

async function fetchTenantStaffOrderingSettingsBundle(
  inputScope,
  requestedSlug,
  options = {}
) {
  const scope = normalizeStaffOrderingScope(
    inputScope,
    requestedSlug
  );
  const transactionRunner =
    options.transactionRunner || withTenantTransaction;

  return transactionRunner(
    {
      tenantId: scope.tenantId,
      propertyId: scope.propertyId
    },
    async (client) => {
      const params = [
        scope.tenantId,
        scope.propertyId,
        scope.propertySlug
      ];
      const featureResult = await client.query(
        `SELECT to_jsonb(feature) AS payload
           FROM public.hotel_feature_settings AS feature
          WHERE feature.tenant_id = $1::uuid
            AND feature.property_id = $2::bigint
            AND feature.hotel_slug = $3
          LIMIT 2`,
        params
      );
      const featureConfig = normalizeHotelFeatureConfig(
        getSinglePayload(featureResult, "hotel feature settings") || {},
        scope.propertySlug
      );
      if (featureConfig.canUseFood !== true) {
        return {
          featureConfig,
          settings: buildHotelOrderingSettings(
            null,
            scope.propertySlug
          )
        };
      }

      const settingsResult = await client.query(
        `SELECT to_jsonb(settings) AS payload
           FROM public.hotel_ordering_settings AS settings
          WHERE settings.tenant_id = $1::uuid
            AND settings.property_id = $2::bigint
            AND settings.hotel_slug = $3
          LIMIT 2`,
        params
      );
      return {
        featureConfig,
        settings: buildHotelOrderingSettings(
          getSinglePayload(
            settingsResult,
            "hotel ordering settings"
          ),
          scope.propertySlug
        )
      };
    },
    { readOnly: true }
  );
}

module.exports = {
  fetchTenantStaffOrderingSettingsBundle,
  normalizeStaffOrderingScope
};
