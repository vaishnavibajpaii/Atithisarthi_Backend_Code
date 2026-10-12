"use strict";

const { supabase } = require("./supabase");
const {
  attachTenantRequestContext,
  getTenantRequestScope,
  normalizePropertySlug
} = require("./tenant-request-context");

const STAFF_HOTEL_CONTEXT_FIELDS = [
  "id",
  "tenant_id",
  "slug"
].join(",");

function createStaffTenantContextError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function fetchCanonicalStaffHotel(
  hotelSlug = "",
  { supabaseClient = supabase } = {}
) {
  const slug = normalizePropertySlug(hotelSlug);
  const { data, error } = await supabaseClient
    .from("hotels")
    .select(STAFF_HOTEL_CONTEXT_FIELDS)
    .eq("slug", slug)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  if (!data.tenant_id || !data.id || data.slug !== slug) {
    throw createStaffTenantContextError(
      "TENANT_STAFF_CONTEXT_INVALID",
      "Staff hotel does not have a complete canonical tenant mapping"
    );
  }
  return data;
}

async function attachCanonicalStaffTenantContext(
  req,
  options = {}
) {
  if (req?.tenant && req?.property && req?.tenantContext) {
    const scope = getTenantRequestScope(req);
    const staffSlug = normalizePropertySlug(
      req?.staffHotelSlug || req?.staffUser?.hotelSlug
    );
    if (scope.propertySlug !== staffSlug) {
      throw createStaffTenantContextError(
        "TENANT_STAFF_CONTEXT_CONFLICT",
        "Staff hotel does not match the authenticated session context"
      );
    }
    return {
      id: scope.propertyId,
      tenant_id: scope.tenantId,
      slug: scope.propertySlug
    };
  }
  const hotel = await fetchCanonicalStaffHotel(
    req?.staffHotelSlug || req?.staffUser?.hotelSlug,
    options
  );
  if (!hotel) return null;

  attachTenantRequestContext(req, {
    tenantId: hotel.tenant_id,
    propertyId: hotel.id,
    propertySlug: hotel.slug,
    source: "staff_jwt_hotel"
  });
  return hotel;
}

module.exports = {
  STAFF_HOTEL_CONTEXT_FIELDS,
  attachCanonicalStaffTenantContext,
  fetchCanonicalStaffHotel
};
