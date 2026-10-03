"use strict";

const { withTenantTransaction } = require("./tenant-database");
const {
  buildHotelOrderingSettings
} = require("./hotel-ordering-settings");
const {
  normalizePropertySlug
} = require("./tenant-request-context");

const PUBLIC_HOTEL_PROFILE_JSON_SQL = `
  jsonb_build_object(
    'hotel_slug', profile.hotel_slug,
    'hotel_name', profile.hotel_name,
    'tagline', profile.tagline,
    'owner_whatsapp_number', profile.owner_whatsapp_number,
    'owner_upi_id', profile.owner_upi_id,
    'gst_percent', profile.gst_percent,
    'contact', profile.contact,
    'branding', profile.branding,
    'theme', profile.theme,
    'hero', profile.hero,
    'about', profile.about,
    'features', profile.features,
    'events', profile.events,
    'reservation', profile.reservation,
    'contact_section', profile.contact_section,
    'location', profile.location,
    'footer', profile.footer,
    'social', profile.social
  )
`;

function createTenantPublicHotelError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeScope(scope = {}, requestedSlug = "") {
  const propertySlug = normalizePropertySlug(scope.propertySlug);
  const normalizedRequestedSlug = normalizePropertySlug(requestedSlug);
  if (propertySlug !== normalizedRequestedSlug) {
    throw createTenantPublicHotelError(
      "TENANT_PUBLIC_HOTEL_SCOPE_CONFLICT",
      "Requested hotel does not match canonical tenant request context"
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
    throw createTenantPublicHotelError(
      "TENANT_PUBLIC_HOTEL_DATA_CONFLICT",
      `Multiple canonical ${label} rows were returned`
    );
  }
  return rows[0]?.payload || null;
}

async function runReadOnlyScope(scope, work, options = {}) {
  const transactionRunner =
    options.transactionRunner || withTenantTransaction;
  return transactionRunner(
    {
      tenantId: scope.tenantId,
      propertyId: scope.propertyId
    },
    work,
    { readOnly: true }
  );
}

async function fetchTenantPublicOrderingSettings(
  inputScope,
  requestedSlug,
  options = {}
) {
  const scope = normalizeScope(inputScope, requestedSlug);
  return runReadOnlyScope(
    scope,
    async (client) => {
      const result = await client.query(
        `SELECT to_jsonb(settings) AS payload
           FROM public.hotel_ordering_settings AS settings
          WHERE settings.tenant_id = $1::uuid
            AND settings.property_id = $2::bigint
            AND settings.hotel_slug = $3
          LIMIT 2`,
        [scope.tenantId, scope.propertyId, scope.propertySlug]
      );
      return buildHotelOrderingSettings(
        getSinglePayload(result, "ordering settings"),
        scope.propertySlug
      );
    },
    options
  );
}

async function fetchTenantPublicHotelBundle(
  inputScope,
  requestedSlug,
  options = {}
) {
  const scope = normalizeScope(inputScope, requestedSlug);
  return runReadOnlyScope(
    scope,
    async (client) => {
      const profileResult = await client.query(
        `SELECT ${PUBLIC_HOTEL_PROFILE_JSON_SQL} AS payload
           FROM public.hotel_profiles AS profile
          WHERE profile.tenant_id = $1::uuid
            AND profile.property_id = $2::bigint
            AND profile.hotel_slug = $3
          LIMIT 2`,
        [scope.tenantId, scope.propertyId, scope.propertySlug]
      );
      const profile = getSinglePayload(profileResult, "hotel profile");

      if (!profile) {
        return {
          profile: null,
          orderingSettings: buildHotelOrderingSettings(
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
        [scope.tenantId, scope.propertyId, scope.propertySlug]
      );

      return {
        profile,
        orderingSettings: buildHotelOrderingSettings(
          getSinglePayload(settingsResult, "ordering settings"),
          scope.propertySlug
        )
      };
    },
    options
  );
}

module.exports = {
  fetchTenantPublicHotelBundle,
  fetchTenantPublicOrderingSettings,
  getSinglePayload,
  normalizeScope
};
