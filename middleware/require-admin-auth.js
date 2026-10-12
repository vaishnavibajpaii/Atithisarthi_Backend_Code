"use strict";

const { env } = require("../config/env");
const { verifyAdminToken } = require("../utils/auth");
const {
  PRINCIPAL_PLATFORM_ADMIN,
  assertAccessPrincipalBinding,
  isVersionTwoAccessToken,
  validateSession,
  verifyAccessToken
} = require("../utils/auth-session");
const { getEffectivePermissions } = require("../utils/permissions");
const { enforceRoutePermission } = require("./enforce-route-permission");

function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

async function requireAdminAuth(req, res, next) {
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
      if (decoded.principal_type !== PRINCIPAL_PLATFORM_ADMIN) {
        throw new Error("Platform administrator principal required");
      }
      const principal = await validateSession(decoded);
      assertAccessPrincipalBinding(decoded, principal);
      req.authSession = Object.freeze({
        session_id: String(principal.session_id),
        version: Number(principal.version)
      });
      req.authPrincipal = Object.freeze({ ...principal });
      req.authPermissions = getEffectivePermissions(principal);
      req.adminUser = Object.freeze({
        sub: String(principal.principal_id),
        scope: "admin",
        principalType: PRINCIPAL_PLATFORM_ADMIN,
        sessionId: String(principal.session_id),
        email: principal.email,
        fullName: principal.full_name || ""
      });
      return enforceRoutePermission(req, res, next);
    }

    if (!env.authLegacyTokenAccepted) {
      throw new Error("Legacy access tokens are disabled");
    }
    req.adminUser = verifyAdminToken(token);
    return enforceRoutePermission(req, res, next);
  } catch (error) {
    return res.status(401).json({
      success: false,
      code: error?.code || "admin_auth_invalid",
      message: "Invalid or expired token"
    });
  }
}

module.exports = { requireAdminAuth };
