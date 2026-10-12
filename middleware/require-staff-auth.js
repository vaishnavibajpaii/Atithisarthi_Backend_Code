"use strict";

const { env } = require("../config/env");
const {
  verifyStaffToken,
  normalizeStaffRole,
  isStaffManagerRole,
  normalizeStaffKdsRole
} = require("../utils/auth");
const {
  PRINCIPAL_HOTEL_STAFF,
  assertAccessPrincipalBinding,
  isVersionTwoAccessToken,
  validateSession,
  verifyAccessToken
} = require("../utils/auth-session");
const { attachTenantRequestContext } = require("../utils/tenant-request-context");
const { getEffectivePermissions } = require("../utils/permissions");
const { enforceRoutePermission } = require("./enforce-route-permission");

function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function attachStaffCompatibilityFields(req, principal, decoded) {
  assertAccessPrincipalBinding(decoded, principal);
  const role = normalizeStaffRole(principal.role);
  const kdsRole = normalizeStaffKdsRole(principal.kds_role, role);
  const isManager = isStaffManagerRole(role);
  const hotelSlug = String(principal.hotel_slug || "").trim().toLowerCase();

  req.authSession = Object.freeze({
    session_id: String(principal.session_id),
    version: Number(principal.version)
  });
  req.authPrincipal = Object.freeze({ ...principal });
  req.authPermissions = getEffectivePermissions(principal);
  req.staffUser = Object.freeze({
    sub: String(principal.principal_id),
    scope: "hotel_staff",
    principalType: PRINCIPAL_HOTEL_STAFF,
    sessionId: String(principal.session_id),
    hotelSlug,
    displayName: principal.display_name || "Staff",
    role,
    isManager,
    kdsRole
  });
  req.staffHotelSlug = hotelSlug;
  req.staffRole = role;
  req.staffKdsRole = kdsRole;
  req.staffCanViewManagerData = isManager;

  attachTenantRequestContext(req, {
    tenantId: principal.tenant_id,
    propertyId: principal.property_id,
    propertySlug: hotelSlug,
    source: "staff_jwt_hotel"
  });

}

async function requireStaffAuth(req, res, next) {
  try {
    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Missing or invalid authorization header"
      });
    }

    if (isVersionTwoAccessToken(token)) {
      const decoded = verifyAccessToken(token);
      if (decoded.principal_type !== PRINCIPAL_HOTEL_STAFF) {
        throw new Error("Hotel staff principal required");
      }
      const principal = await validateSession(decoded);
      attachStaffCompatibilityFields(req, principal, decoded);
      return enforceRoutePermission(req, res, next);
    }

    if (!env.authLegacyTokenAccepted) {
      throw new Error("Legacy access tokens are disabled");
    }
    const decoded = verifyStaffToken(token);
    const normalizedRole = normalizeStaffRole(decoded.role);
    const normalizedKdsRole = normalizeStaffKdsRole(decoded.kdsRole, normalizedRole);
    req.staffUser = {
      ...decoded,
      role: normalizedRole,
      isManager: isStaffManagerRole(normalizedRole),
      kdsRole: normalizedKdsRole
    };
    req.staffHotelSlug = decoded.hotelSlug;
    req.staffRole = normalizedRole;
    req.staffKdsRole = normalizedKdsRole;
    req.staffCanViewManagerData = isStaffManagerRole(normalizedRole);
    return enforceRoutePermission(req, res, next);
  } catch (error) {
    return res.status(401).json({
      success: false,
      code: error?.code || "staff_auth_invalid",
      message: "Invalid or expired staff token"
    });
  }
}

function requireStaffManagerAccess(req, res, next) {
  if (req.staffCanViewManagerData || req.staffUser?.isManager) {
    return next();
  }
  return res.status(403).json({
    success: false,
    code: "manager_access_required",
    message: "Manager access is required for this staff section"
  });
}

module.exports = { requireStaffAuth, requireStaffManagerAccess };
