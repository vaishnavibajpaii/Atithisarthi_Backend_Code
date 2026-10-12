"use strict";

const { env } = require("../config/env");
const {
  LOGOUT_INTENT_VALUE,
  REFRESH_INTENT_VALUE,
  clearRefreshCookie,
  getRefreshCookie,
  parseRefreshCredential,
  requireAuthMutationIntent,
  revokeSession,
  rotateRefreshCredential,
  setRefreshCookie
} = require("./auth-session");

function refreshHandler(expectedPrincipalType) {
  return async function handleRefresh(req, res) {
    try {
      if (!env.authRefreshEnabled) {
        return res.status(503).json({
          success: false,
          code: "auth_refresh_disabled",
          message: "Session refresh is not enabled"
        });
      }
      requireAuthMutationIntent(req, REFRESH_INTENT_VALUE);
      const currentCredential = getRefreshCookie(req, expectedPrincipalType);
      const parsed = parseRefreshCredential(currentCredential);
      if (parsed.principalType !== expectedPrincipalType) {
        throw new Error("Refresh credential principal mismatch");
      }
      const rotated = await rotateRefreshCredential(currentCredential, req.requestId || null);
      setRefreshCookie(res, expectedPrincipalType, rotated.refreshCredential);
      return res.json({
        success: true,
        token: rotated.accessToken,
        accessExpiresAt: rotated.accessExpiresAt.toISOString()
      });
    } catch (error) {
      clearRefreshCookie(res, expectedPrincipalType);
      return res.status(401).json({
        success: false,
        code: error?.code || "auth_refresh_rejected",
        message: "Session refresh was rejected"
      });
    }
  };
}

function logoutHandler(expectedPrincipalType) {
  return async function handleLogout(req, res) {
    try {
      requireAuthMutationIntent(req, LOGOUT_INTENT_VALUE);
      if (req.authPrincipal?.principal_type !== expectedPrincipalType) {
        if (req.authSession) throw new Error("Session principal mismatch");
      } else {
        await revokeSession(
          {
            sid: req.authSession.session_id,
            principal_type: req.authPrincipal.principal_type,
            sub: String(req.authPrincipal.principal_id)
          },
          "logout",
          req.requestId || null
        );
      }
      clearRefreshCookie(res, expectedPrincipalType);
      return res.json({ success: true, message: "Logged out" });
    } catch (error) {
      clearRefreshCookie(res, expectedPrincipalType);
      return res.status(403).json({
        success: false,
        code: error?.code || "auth_logout_rejected",
        message: "Logout request was rejected"
      });
    }
  };
}

module.exports = { logoutHandler, refreshHandler };
