const express = require("express");
const bcrypt = require("bcryptjs");
const { supabase } = require("../utils/supabase");
const { signAdminToken } = require("../utils/auth");
const { env } = require("../config/env");
const {
  PRINCIPAL_PLATFORM_ADMIN,
  createSession,
  getAdminLoginPrincipal,
  recordSecurityEvent,
  setRefreshCookie
} = require("../utils/auth-session");
const { logoutHandler, refreshHandler } = require("../utils/auth-session-controller");
const { requireAdminAuth } = require("../middleware/require-admin-auth");
const { validateBody } = require("../validators/common");
const { loginSchema } = require("../validators/auth");
const rateLimit = require("express-rate-limit");
const router = express.Router();


const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many login attempts. Please try again later."
  }
});

router.post(
  "/login", loginLimiter,
  validateBody(loginSchema),
  async (req, res) => {
    try {
      const { email, password } = req.validatedBody;

      const normalizedEmail = String(email).trim().toLowerCase();

      let adminUser;
      if (env.authSessionIssuanceEnabled) {
        const principal = await getAdminLoginPrincipal(normalizedEmail);
        adminUser = principal ? {
          id: principal.principal_id,
          email: principal.email,
          full_name: principal.full_name,
          password_hash: principal.password_hash
        } : null;
      } else {
        const result = await supabase
          .from("admin_users")
          .select("*")
          .eq("email", normalizedEmail)
          .eq("is_active", true)
          .maybeSingle();
        if (result.error) throw result.error;
        adminUser = result.data;
      }

      if (!adminUser) {
        if (env.authSessionIssuanceEnabled) {
          await recordSecurityEvent({
            eventType: "login_failure",
            outcome: "failure",
            requestId: req.requestId || null,
            safeContext: { principal_kind: PRINCIPAL_PLATFORM_ADMIN }
          }).catch(() => undefined);
        }
        return res.status(401).json({
          success: false,
          message: "Invalid email or password"
        });
      }

      const passwordMatches = await bcrypt.compare(
        password,
        adminUser.password_hash
      );

      if (!passwordMatches) {
        if (env.authSessionIssuanceEnabled) {
          await recordSecurityEvent({
            eventType: "login_failure",
            outcome: "failure",
            principalType: PRINCIPAL_PLATFORM_ADMIN,
            principalId: adminUser.id,
            requestId: req.requestId || null,
            safeContext: { principal_kind: PRINCIPAL_PLATFORM_ADMIN }
          }).catch(() => undefined);
        }
        return res.status(401).json({
          success: false,
          message: "Invalid email or password"
        });
      }

      let token;
      let accessExpiresAt;
      if (env.authSessionIssuanceEnabled) {
        const session = await createSession({
          principalType: PRINCIPAL_PLATFORM_ADMIN,
          principalId: adminUser.id,
          userAgent: req.headers["user-agent"] || "",
          requestId: req.requestId || null
        });
        token = session.accessToken;
        accessExpiresAt = session.accessExpiresAt.toISOString();
        setRefreshCookie(res, PRINCIPAL_PLATFORM_ADMIN, session.refreshCredential);
      } else {
        token = signAdminToken(adminUser);
      }

      res.json({
        success: true,
        token,
        ...(accessExpiresAt ? { accessExpiresAt } : {}),
        adminUser: {
          id: adminUser.id,
          email: adminUser.email,
          fullName: adminUser.full_name || ""
        }
      });
    } catch (error) {
      console.error("Admin login error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to login"
      });
    }
  }
);

router.post("/refresh", refreshHandler(PRINCIPAL_PLATFORM_ADMIN));
router.post(
  "/logout",
  requireAdminAuth,
  logoutHandler(PRINCIPAL_PLATFORM_ADMIN)
);

router.get("/me", requireAdminAuth, async (req, res) => {
  res.json({
    success: true,
    adminUser: req.adminUser
  });
});


module.exports = router;
