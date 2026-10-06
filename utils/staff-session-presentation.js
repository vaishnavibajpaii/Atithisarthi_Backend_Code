"use strict";

const {
  isStaffManagerRole,
  normalizeStaffKdsRole,
  normalizeStaffRole
} = require("./auth");
const {
  normalizeHotelFeatureConfig
} = require("./hotel-feature-settings");

function buildStaffSessionUser(staffUser = {}, features = null) {
  const role = normalizeStaffRole(staffUser.role);
  const kdsRole = normalizeStaffKdsRole(
    staffUser.kdsRole || staffUser.kds_role,
    role
  );
  const hotelSlug =
    staffUser.hotelSlug || staffUser.hotel_slug || "";

  return {
    id: staffUser.sub || staffUser.id || "",
    hotelSlug,
    displayName:
      staffUser.displayName || staffUser.display_name || "Staff",
    role,
    isManager: isStaffManagerRole(role),
    kdsRole,
    features: normalizeHotelFeatureConfig(
      features || staffUser.features || {},
      hotelSlug
    )
  };
}

function buildStaffSessionPayload({
  staffUser = {},
  features = null
} = {}) {
  const normalizedFeatures = normalizeHotelFeatureConfig(
    features || staffUser.features || {},
    staffUser.hotelSlug || staffUser.hotel_slug
  );

  return {
    success: true,
    staffUser: buildStaffSessionUser(staffUser, normalizedFeatures),
    features: normalizedFeatures
  };
}

module.exports = {
  buildStaffSessionPayload,
  buildStaffSessionUser
};
