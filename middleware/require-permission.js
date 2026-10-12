"use strict";

const { env } = require("../config/env");
const logger = require("../utils/logger");
const { hasPermission } = require("../utils/permissions");
const { recordSecurityEvent } = require("../utils/auth-session");

function requirePermission(requiredPermission) {
  if (typeof requiredPermission !== "string" || !requiredPermission.trim()) {
    throw new Error("A required permission must be provided");
  }

  return function enforcePermission(req, res, next) {
    if (!env.authRbacEnforcementEnabled) return next();

    const principal = req.authPrincipal;
    if (principal && hasPermission(principal, requiredPermission)) return next();

    if (principal) {
      void recordSecurityEvent({
        eventType: "privileged_denied",
        outcome: "denied",
        principalType: principal.principal_type,
        principalId: principal.principal_id,
        sessionId: req.authSession?.session_id || null,
        tenantId: principal.tenant_id || null,
        propertyId: principal.property_id || null,
        requestId: req.requestId || null,
        safeContext: { permission: requiredPermission }
      }).catch((error) => logger.warn("Security denial audit failed", {
        code: error?.code || "AUTH_AUDIT_FAILED"
      }));
    }

    return res.status(403).json({
      success: false,
      code: "permission_denied",
      message: "You do not have permission to perform this action"
    });
  };
}

module.exports = { requirePermission };
