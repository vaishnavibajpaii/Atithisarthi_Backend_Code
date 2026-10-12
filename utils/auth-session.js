"use strict";

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { env } = require("../config/env");
const { withAuthTransaction } = require("./tenant-database");
const { getConfiguredTenantAliasOrigins } = require("./public-hotel-access");

const ACCESS_TOKEN_VERSION = 2;
const ACCESS_TOKEN_ALGORITHM = "HS256";
const PRINCIPAL_PLATFORM_ADMIN = "platform_admin";
const PRINCIPAL_HOTEL_STAFF = "hotel_staff";
const REFRESH_INTENT_HEADER = "x-auth-intent";
const REFRESH_INTENT_VALUE = "session-refresh";
const LOGOUT_INTENT_VALUE = "session-logout";

function securityError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function positiveInteger(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw securityError("AUTH_CONFIG_INVALID", `${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function assertSessionConfig() {
  if (!env.tenantRuntimeEnabled || !String(env.tenantDatabaseUrl || "").trim()) {
    throw securityError(
      "AUTH_SESSION_DATABASE_UNAVAILABLE",
      "Session security requires the restricted tenant database runtime"
    );
  }
  if (String(env.accessTokenSecret || "").length < 32) {
    throw securityError("AUTH_ACCESS_SECRET_INVALID", "ACCESS_TOKEN_SECRET must contain at least 32 characters");
  }
  if (String(env.refreshTokenHmacSecret || "").length < 32) {
    throw securityError(
      "AUTH_REFRESH_SECRET_INVALID",
      "REFRESH_TOKEN_HMAC_SECRET must contain at least 32 characters"
    );
  }
  positiveInteger(env.authAccessTokenTtlSeconds, "AUTH_ACCESS_TOKEN_TTL_SECONDS", {
    min: 60,
    max: 1200
  });
  positiveInteger(env.authRefreshTokenTtlSeconds, "AUTH_REFRESH_TOKEN_TTL_SECONDS", {
    min: 300,
    max: 691200
  });
  if (!String(env.authTokenIssuer || "").trim() || !String(env.authTokenAudience || "").trim()) {
    throw securityError("AUTH_TOKEN_IDENTITY_INVALID", "Token issuer and audience are required");
  }
}

function normalizePrincipalType(value) {
  const principalType = String(value || "").trim().toLowerCase();
  if (![PRINCIPAL_PLATFORM_ADMIN, PRINCIPAL_HOTEL_STAFF].includes(principalType)) {
    throw securityError("AUTH_PRINCIPAL_TYPE_INVALID", "Unsupported authentication principal type");
  }
  return principalType;
}

function normalizePrincipalId(value) {
  const id = String(value || "").trim();
  if (!/^[1-9][0-9]*$/.test(id)) {
    throw securityError("AUTH_PRINCIPAL_ID_INVALID", "Authentication principal ID is invalid");
  }
  return id;
}

function createRefreshCredential(sessionId, principalType, principalId) {
  const type = normalizePrincipalType(principalType);
  const id = normalizePrincipalId(principalId);
  if (!/^[0-9a-f-]{36}$/i.test(String(sessionId || ""))) {
    throw securityError("AUTH_SESSION_ID_INVALID", "Session ID is invalid");
  }
  return ["r1", sessionId, type, id, crypto.randomBytes(32).toString("base64url")].join(".");
}

function parseRefreshCredential(value) {
  const parts = String(value || "").split(".");
  if (parts.length !== 5 || parts[0] !== "r1" || !/^[0-9a-f-]{36}$/i.test(parts[1])) {
    throw securityError("AUTH_REFRESH_INVALID", "Refresh credential is invalid");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(parts[4])) {
    throw securityError("AUTH_REFRESH_INVALID", "Refresh credential is invalid");
  }
  return Object.freeze({
    sessionId: parts[1].toLowerCase(),
    principalType: normalizePrincipalType(parts[2]),
    principalId: normalizePrincipalId(parts[3]),
    credential: parts.join(".")
  });
}

function hashRefreshCredential(value) {
  assertSessionConfig();
  return crypto
    .createHmac("sha256", env.refreshTokenHmacSecret)
    .update(String(value || ""), "utf8")
    .digest();
}

function hashUserAgent(value) {
  const normalized = String(value || "").trim();
  return normalized ? crypto.createHash("sha256").update(normalized).digest() : null;
}

function accessExpiryDate(now = Date.now()) {
  assertSessionConfig();
  return new Date(now + env.authAccessTokenTtlSeconds * 1000);
}

function refreshExpiryDate(now = Date.now()) {
  assertSessionConfig();
  return new Date(now + env.authRefreshTokenTtlSeconds * 1000);
}

function buildAccessClaims(principal, sessionId) {
  const principalType = normalizePrincipalType(principal?.principal_type);
  const claims = {
    sub: normalizePrincipalId(principal?.principal_id),
    sid: String(sessionId || "").toLowerCase(),
    ver: ACCESS_TOKEN_VERSION,
    typ: "access",
    principal_type: principalType
  };
  if (principalType === PRINCIPAL_HOTEL_STAFF) {
    claims.tenant_id = String(principal?.tenant_id || "").toLowerCase();
    claims.property_id = normalizePrincipalId(principal?.property_id);
  }
  return claims;
}

function signAccessToken(principal, sessionId) {
  assertSessionConfig();
  return jwt.sign(buildAccessClaims(principal, sessionId), env.accessTokenSecret, {
    algorithm: ACCESS_TOKEN_ALGORITHM,
    expiresIn: env.authAccessTokenTtlSeconds,
    issuer: env.authTokenIssuer,
    audience: env.authTokenAudience,
    jwtid: crypto.randomUUID()
  });
}

function verifyAccessToken(token) {
  assertSessionConfig();
  const decoded = jwt.verify(token, env.accessTokenSecret, {
    algorithms: [ACCESS_TOKEN_ALGORITHM],
    issuer: env.authTokenIssuer,
    audience: env.authTokenAudience
  });
  if (
    decoded?.ver !== ACCESS_TOKEN_VERSION ||
    decoded?.typ !== "access" ||
    !decoded?.sid ||
    !decoded?.sub
  ) {
    throw securityError("AUTH_ACCESS_TOKEN_INVALID", "Access token claims are invalid");
  }
  for (const forbiddenClaim of ["role", "kdsRole", "kds_role", "hotelSlug", "hotel_slug", "permissions"]) {
    if (Object.prototype.hasOwnProperty.call(decoded, forbiddenClaim)) {
      throw securityError(
        "AUTH_ACCESS_TOKEN_FORBIDDEN_CLAIM",
        "Access token contains a server-authoritative claim"
      );
    }
  }
  decoded.principal_type = normalizePrincipalType(decoded.principal_type);
  decoded.sub = normalizePrincipalId(decoded.sub);
  return decoded;
}

function assertAccessPrincipalBinding(decoded, principal) {
  if (
    normalizePrincipalType(decoded?.principal_type) !== normalizePrincipalType(principal?.principal_type) ||
    normalizePrincipalId(decoded?.sub) !== normalizePrincipalId(principal?.principal_id) ||
    String(decoded?.sid || "").toLowerCase() !== String(principal?.session_id || "").toLowerCase()
  ) {
    throw securityError("AUTH_PRINCIPAL_BINDING_MISMATCH", "Access token principal binding is invalid");
  }
  if (decoded.principal_type === PRINCIPAL_HOTEL_STAFF && (
    String(decoded.tenant_id || "").toLowerCase() !== String(principal.tenant_id || "").toLowerCase() ||
    String(decoded.property_id || "") !== String(principal.property_id || "")
  )) {
    throw securityError(
      "AUTH_TENANT_CLAIM_MISMATCH",
      "Access-token tenant context does not match the active principal"
    );
  }
  return true;
}

function isVersionTwoAccessToken(token) {
  const decoded = jwt.decode(String(token || ""));
  return decoded?.ver === ACCESS_TOKEN_VERSION || decoded?.typ === "access" || !!decoded?.sid;
}

async function queryJsonFunction(sql, params = [], { readOnly = false } = {}) {
  return withAuthTransaction(async (client) => {
    const result = await client.query(sql, params);
    return result.rows?.[0]?.result ?? null;
  }, { readOnly });
}

async function getAdminLoginPrincipal(email) {
  return queryJsonFunction(
    "SELECT public.task4_get_admin_login_principal($1) AS result",
    [String(email || "").trim().toLowerCase()],
    { readOnly: true }
  );
}

async function getStaffLoginCandidates(hotelSlug) {
  const result = await queryJsonFunction(
    "SELECT public.task4_get_staff_login_candidates($1) AS result",
    [String(hotelSlug || "").trim().toLowerCase()],
    { readOnly: true }
  );
  return Array.isArray(result) ? result : [];
}

async function recordSecurityEvent({
  eventType,
  outcome,
  principalType = null,
  principalId = null,
  sessionId = null,
  tenantId = null,
  propertyId = null,
  requestId = null,
  safeContext = {}
}) {
  return queryJsonFunction(
    `SELECT public.task4_record_auth_security_event(
      $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb
    ) AS result`,
    [
      eventType, outcome, principalType, principalId, sessionId,
      tenantId, propertyId, requestId, JSON.stringify(safeContext || {})
    ]
  );
}

async function createSession({ principalType, principalId, userAgent = "", requestId = null }) {
  assertSessionConfig();
  const type = normalizePrincipalType(principalType);
  const id = normalizePrincipalId(principalId);
  const sessionId = crypto.randomUUID();
  const refreshFamilyId = crypto.randomUUID();
  const refreshCredential = createRefreshCredential(sessionId, type, id);
  const accessExpiresAt = accessExpiryDate();
  const refreshExpiresAt = refreshExpiryDate();
  const principal = await queryJsonFunction(
    `SELECT public.task4_create_auth_session(
      $1,$2,$3,$4,$5,$6,$7,$8,$9
    ) AS result`,
    [
      sessionId, type, id, refreshFamilyId,
      hashRefreshCredential(refreshCredential), accessExpiresAt,
      refreshExpiresAt, hashUserAgent(userAgent), requestId
    ]
  );
  if (principal?.status !== "created") {
    throw securityError("AUTH_SESSION_CREATE_FAILED", "Authentication session could not be created");
  }
  return {
    accessToken: signAccessToken(principal, sessionId),
    refreshCredential,
    accessExpiresAt,
    refreshExpiresAt,
    principal
  };
}

async function validateSession(decoded) {
  const result = await queryJsonFunction(
    "SELECT public.task4_validate_auth_session($1,$2,$3) AS result",
    [decoded.sid, decoded.principal_type, decoded.sub]
  );
  if (result?.status !== "active") {
    throw securityError(
      result?.status === "revoked" ? "AUTH_SESSION_REVOKED" : "AUTH_SESSION_INVALID",
      "Authentication session is not active"
    );
  }
  return result;
}

async function rotateRefreshCredential(value, requestId = null) {
  assertSessionConfig();
  const parsed = parseRefreshCredential(value);
  const nextCredential = createRefreshCredential(
    parsed.sessionId,
    parsed.principalType,
    parsed.principalId
  );
  const accessExpiresAt = accessExpiryDate();
  const principal = await queryJsonFunction(
    `SELECT public.task4_rotate_auth_refresh(
      $1,$2,$3,$4,$5,$6,$7
    ) AS result`,
    [
      parsed.sessionId, parsed.principalType, parsed.principalId,
      hashRefreshCredential(parsed.credential), hashRefreshCredential(nextCredential),
      accessExpiresAt, requestId
    ]
  );
  if (principal?.status !== "rotated") {
    throw securityError(
      principal?.status === "refresh_replay" ? "AUTH_REFRESH_REPLAY" : "AUTH_REFRESH_REJECTED",
      "Refresh credential was rejected"
    );
  }
  return {
    accessToken: signAccessToken(principal, parsed.sessionId),
    refreshCredential: nextCredential,
    accessExpiresAt,
    principal
  };
}

async function revokeSession(decoded, reason = "logout", requestId = null) {
  return queryJsonFunction(
    "SELECT public.task4_revoke_auth_session($1,$2,$3,$4,$5) AS result",
    [decoded.sid, decoded.principal_type, decoded.sub, reason, requestId]
  );
}

function refreshCookieName(principalType) {
  const suffix = normalizePrincipalType(principalType) === PRINCIPAL_PLATFORM_ADMIN
    ? "admin_refresh"
    : "staff_refresh";
  return env.isProduction ? `__Secure-atithi_${suffix}` : `atithi_${suffix}`;
}

function refreshCookiePath(principalType) {
  return normalizePrincipalType(principalType) === PRINCIPAL_PLATFORM_ADMIN
    ? "/api/auth"
    : "/api/staff";
}

function refreshCookieOptions(principalType) {
  return {
    httpOnly: true,
    secure: env.authRefreshCookieSecure,
    sameSite: env.authRefreshCookieSameSite,
    path: refreshCookiePath(principalType),
    maxAge: env.authRefreshTokenTtlSeconds * 1000
  };
}

function parseCookies(req) {
  return String(req?.headers?.cookie || "")
    .split(";")
    .reduce((result, part) => {
      const index = part.indexOf("=");
      if (index <= 0) return result;
      const key = part.slice(0, index).trim();
      try {
        result[key] = decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        result[key] = "";
      }
      return result;
    }, {});
}

function getRefreshCookie(req, principalType) {
  return parseCookies(req)[refreshCookieName(principalType)] || "";
}

function setRefreshCookie(res, principalType, credential) {
  res.cookie(refreshCookieName(principalType), credential, refreshCookieOptions(principalType));
}

function clearRefreshCookie(res, principalType) {
  res.clearCookie(refreshCookieName(principalType), refreshCookieOptions(principalType));
}

function normalizedOrigin(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

function allowedMutationOrigins() {
  return [
    env.frontendUrl,
    env.adminUrl,
    ...String(env.frontendOrigins || "").split(","),
    ...getConfiguredTenantAliasOrigins()
  ].map(normalizedOrigin).filter(Boolean);
}

function requireAuthMutationIntent(req, expectedIntent) {
  const intent = String(req?.headers?.[REFRESH_INTENT_HEADER] || "").trim();
  const origin = normalizedOrigin(req?.headers?.origin);
  if (intent !== expectedIntent || !origin || !allowedMutationOrigins().includes(origin)) {
    throw securityError("AUTH_MUTATION_ORIGIN_REJECTED", "Authentication request origin was rejected");
  }
}

module.exports = {
  ACCESS_TOKEN_VERSION,
  LOGOUT_INTENT_VALUE,
  PRINCIPAL_HOTEL_STAFF,
  PRINCIPAL_PLATFORM_ADMIN,
  REFRESH_INTENT_VALUE,
  assertSessionConfig,
  assertAccessPrincipalBinding,
  buildAccessClaims,
  clearRefreshCookie,
  createRefreshCredential,
  createSession,
  getAdminLoginPrincipal,
  getRefreshCookie,
  getStaffLoginCandidates,
  hashRefreshCredential,
  isVersionTwoAccessToken,
  parseRefreshCredential,
  recordSecurityEvent,
  requireAuthMutationIntent,
  revokeSession,
  rotateRefreshCredential,
  setRefreshCookie,
  signAccessToken,
  validateSession,
  verifyAccessToken
};
