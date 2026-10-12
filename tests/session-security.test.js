"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const jwt = require("jsonwebtoken");

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.JWT_SECRET = "legacy-test-secret-that-is-long-enough";
process.env.TENANT_RUNTIME_ENABLED = "true";
process.env.TENANT_DATABASE_URL = "postgresql://runtime:secret@db.example.com:5432/postgres?sslmode=verify-full";
process.env.ACCESS_TOKEN_SECRET = "access-test-secret-with-at-least-thirty-two-characters";
process.env.REFRESH_TOKEN_HMAC_SECRET = "refresh-test-secret-with-at-least-thirty-two-characters";
process.env.AUTH_ACCESS_TOKEN_TTL_SECONDS = "900";
process.env.AUTH_REFRESH_TOKEN_TTL_SECONDS = "604800";
process.env.AUTH_TOKEN_ISSUER = "task4-test-api";
process.env.AUTH_TOKEN_AUDIENCE = "task4-test-web";
process.env.AUTH_RBAC_ENFORCEMENT_ENABLED = "false";
process.env.FRONTEND_URL = "https://hotel.example.com";
process.env.ADMIN_URL = "https://admin.example.com";

const TENANT_A = "123e4567-e89b-42d3-a456-426614174000";
const TENANT_B = "123e4567-e89b-42d3-a456-426614174001";
const STAFF_ID = "11";

const state = {
  sessions: new Map(),
  history: [],
  staff: new Map()
};

function resetState() {
  state.sessions.clear();
  state.history.length = 0;
  state.staff.clear();
  state.staff.set(STAFF_ID, {
    principal_type: "hotel_staff",
    principal_id: Number(STAFF_ID),
    display_name: "Test Staff",
    role: "staff",
    kds_role: "general",
    hotel_slug: "hotel-a",
    tenant_id: TENANT_A,
    property_id: 7,
    active: true,
    credentialVersion: 1
  });
}

function sameHash(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right);
}

function publicPrincipal(principal) {
  if (!principal?.active) return null;
  const { active, credentialVersion, ...safe } = principal;
  return { ...safe };
}

function validateFakeSession(sessionId, principalType, principalId) {
  const session = state.sessions.get(String(sessionId));
  if (!session || session.principalType !== principalType || session.principalId !== String(principalId)) {
    return { status: "unknown" };
  }
  if (session.revoked) return { status: "revoked" };
  const principal = state.staff.get(session.principalId);
  if (!principal?.active) {
    session.revoked = "principal_inactive";
    return { status: "revoked" };
  }
  if (session.credentialVersion !== principal.credentialVersion) {
    session.revoked = "credential_changed";
    return { status: "revoked" };
  }
  if (session.role !== principal.role || session.kdsRole !== principal.kds_role) {
    session.revoked = "role_changed";
    return { status: "revoked" };
  }
  return {
    status: "active",
    session_id: session.id,
    version: session.version,
    refresh_family_id: session.familyId,
    ...publicPrincipal(principal)
  };
}

async function fakeQuery(sql, params) {
  if (sql.includes("task4_create_auth_session")) {
    const [id, principalType, principalId, familyId, refreshHash] = params;
    const principal = state.staff.get(String(principalId));
    assert.equal(principalType, "hotel_staff");
    assert.ok(Buffer.isBuffer(refreshHash), "only a refresh digest reaches persistence");
    const session = {
      id: String(id), principalType, principalId: String(principalId), familyId: String(familyId),
      refreshHash: Buffer.from(refreshHash), version: 1, revoked: "",
      role: principal.role, kdsRole: principal.kds_role,
      credentialVersion: principal.credentialVersion
    };
    state.sessions.set(session.id, session);
    return { rows: [{ result: { status: "created", session_id: session.id, version: 1, ...publicPrincipal(principal) } }] };
  }
  if (sql.includes("task4_validate_auth_session")) {
    return { rows: [{ result: validateFakeSession(params[0], params[1], params[2]) }] };
  }
  if (sql.includes("task4_rotate_auth_refresh")) {
    const [id, type, principalId, presentedHash, nextHash] = params;
    const validation = validateFakeSession(id, type, principalId);
    if (validation.status !== "active") return { rows: [{ result: validation }] };
    const session = state.sessions.get(String(id));
    if (!sameHash(session.refreshHash, presentedHash)) {
      if (state.history.some((entry) => entry.sessionId === session.id && sameHash(entry.hash, presentedHash))) {
        session.revoked = "refresh_replay";
        return { rows: [{ result: { status: "refresh_replay" } }] };
      }
      return { rows: [{ result: { status: "invalid" } }] };
    }
    state.history.push({ sessionId: session.id, hash: Buffer.from(session.refreshHash) });
    session.refreshHash = Buffer.from(nextHash);
    session.version += 1;
    return { rows: [{ result: { ...validation, status: "rotated", version: session.version } }] };
  }
  if (sql.includes("task4_revoke_auth_session")) {
    const session = state.sessions.get(String(params[0]));
    if (session) session.revoked = String(params[3]);
    return { rows: [{ result: !!session }] };
  }
  if (sql.includes("task4_record_auth_security_event")) {
    return { rows: [{ result: crypto.randomUUID() }] };
  }
  throw new Error(`Unexpected test query: ${sql}`);
}

const tenantDatabase = require("../utils/tenant-database");
tenantDatabase.withAuthTransaction = async (work) => work({ query: fakeQuery });
delete require.cache[require.resolve("../utils/auth-session")];
const auth = require("../utils/auth-session");
const { requireAdminAuth } = require("../middleware/require-admin-auth");
const { requireStaffAuth } = require("../middleware/require-staff-auth");

test.beforeEach(resetState);

async function loginStaff() {
  return auth.createSession({
    principalType: auth.PRINCIPAL_HOTEL_STAFF,
    principalId: STAFF_ID,
    userAgent: "Task4 test",
    requestId: "request-test"
  });
}

test("login creates a revocable server session and 15-minute access token", async () => {
  const login = await loginStaff();
  assert.equal(state.sessions.size, 1);
  assert.equal(typeof login.refreshCredential, "string");
  assert.equal([...state.sessions.values()][0].refreshHash.length, 32);
  assert.notEqual([...state.sessions.values()][0].refreshHash.toString("hex"), login.refreshCredential);
  const decoded = auth.verifyAccessToken(login.accessToken);
  assert.equal(decoded.exp - decoded.iat, 900);
  assert.equal(decoded.principal_type, "hotel_staff");
  assert.equal(decoded.role, undefined);
});

test("valid access is accepted; expired and invalid-signature tokens are rejected", async () => {
  const login = await loginStaff();
  const decoded = auth.verifyAccessToken(login.accessToken);
  const principal = await auth.validateSession(decoded);
  assert.equal(principal.status, "active");
  assert.equal(auth.assertAccessPrincipalBinding(decoded, principal), true);

  const baseClaims = auth.buildAccessClaims(principal, principal.session_id);
  const expired = jwt.sign(baseClaims, process.env.ACCESS_TOKEN_SECRET, {
    algorithm: "HS256", expiresIn: -1, issuer: process.env.AUTH_TOKEN_ISSUER,
    audience: process.env.AUTH_TOKEN_AUDIENCE
  });
  assert.throws(() => auth.verifyAccessToken(expired), /expired/i);
  const invalid = jwt.sign(baseClaims, "different-signing-secret-that-is-long-enough", {
    algorithm: "HS256", expiresIn: 900, issuer: process.env.AUTH_TOKEN_ISSUER,
    audience: process.env.AUTH_TOKEN_AUDIENCE
  });
  assert.throws(() => auth.verifyAccessToken(invalid), /signature/i);
});

test("unknown and revoked sessions are rejected", async () => {
  const login = await loginStaff();
  const decoded = auth.verifyAccessToken(login.accessToken);
  await assert.rejects(auth.validateSession({ ...decoded, sid: crypto.randomUUID() }), { code: "AUTH_SESSION_INVALID" });
  await auth.revokeSession(decoded, "logout", "logout-request");
  await assert.rejects(auth.validateSession(decoded), { code: "AUTH_SESSION_REVOKED" });
});

test("refresh works once, rotates, and replay revokes the token family", async () => {
  const login = await loginStaff();
  const rotated = await auth.rotateRefreshCredential(login.refreshCredential, "refresh-1");
  assert.notEqual(rotated.refreshCredential, login.refreshCredential);
  assert.equal(auth.verifyAccessToken(rotated.accessToken).sid, auth.verifyAccessToken(login.accessToken).sid);
  await assert.rejects(
    auth.rotateRefreshCredential(login.refreshCredential, "refresh-replay"),
    { code: "AUTH_REFRESH_REPLAY" }
  );
  await assert.rejects(
    auth.rotateRefreshCredential(rotated.refreshCredential, "after-replay"),
    { code: "AUTH_REFRESH_REJECTED" }
  );
});

test("parallel refresh requests cannot create uncontrolled valid chains", async () => {
  const login = await loginStaff();
  const results = await Promise.allSettled([
    auth.rotateRefreshCredential(login.refreshCredential, "parallel-a"),
    auth.rotateRefreshCredential(login.refreshCredential, "parallel-b")
  ]);
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(results.filter((entry) => entry.status === "rejected").length, 1);
  assert.equal([...state.sessions.values()][0].revoked, "refresh_replay");
});

test("disabled staff and credential or role changes invalidate previous sessions", async () => {
  const disabledLogin = await loginStaff();
  state.staff.get(STAFF_ID).active = false;
  await assert.rejects(auth.rotateRefreshCredential(disabledLogin.refreshCredential), { code: "AUTH_REFRESH_REJECTED" });

  resetState();
  const passwordLogin = await loginStaff();
  state.staff.get(STAFF_ID).credentialVersion += 1;
  await assert.rejects(auth.validateSession(auth.verifyAccessToken(passwordLogin.accessToken)), { code: "AUTH_SESSION_REVOKED" });

  resetState();
  const roleLogin = await loginStaff();
  state.staff.get(STAFF_ID).role = "owner";
  await assert.rejects(auth.validateSession(auth.verifyAccessToken(roleLogin.accessToken)), { code: "AUTH_SESSION_REVOKED" });
});

test("forged role and tenant claims are rejected and cross-tenant binding fails", async () => {
  const login = await loginStaff();
  const decoded = auth.verifyAccessToken(login.accessToken);
  const principal = await auth.validateSession(decoded);

  assert.throws(
    () => auth.assertAccessPrincipalBinding({ ...decoded, tenant_id: TENANT_B }, principal),
    { code: "AUTH_TENANT_CLAIM_MISMATCH" }
  );
  assert.throws(
    () => auth.assertAccessPrincipalBinding({ ...decoded, property_id: "999" }, principal),
    { code: "AUTH_TENANT_CLAIM_MISMATCH" }
  );

  const forgedRole = jwt.sign(
    { ...auth.buildAccessClaims(principal, principal.session_id), role: "owner" },
    process.env.ACCESS_TOKEN_SECRET,
    { algorithm: "HS256", expiresIn: 900, issuer: process.env.AUTH_TOKEN_ISSUER, audience: process.env.AUTH_TOKEN_AUDIENCE }
  );
  assert.throws(() => auth.verifyAccessToken(forgedRole), { code: "AUTH_ACCESS_TOKEN_FORBIDDEN_CLAIM" });
});

test("database hook source covers password, PIN, disable, role, tenant, and deletion invalidation", () => {
  const sql = fs.readFileSync(
    path.join(__dirname, "../scripts/task4-session-invalidation-hooks.sql"),
    "utf8"
  );
  for (const required of [
    "password_hash", "pin_hash", "is_active", "role", "kds_role",
    "tenant_id", "property_id", "hotel_slug", "account_deleted"
  ]) {
    assert.match(sql, new RegExp(required));
  }
});

test("staff middleware attaches current canonical context and rejects boundary or tenant substitution", async () => {
  const login = await loginStaff();
  const req = { headers: { authorization: `Bearer ${login.accessToken}` } };
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
  let continued = false;
  await requireStaffAuth(req, response, () => { continued = true; });
  assert.equal(continued, true);
  assert.equal(req.staffRole, "staff");
  assert.equal(req.tenant.id, TENANT_A);
  assert.equal(req.property.id, "7");
  assert.equal(req.property.slug, "hotel-a");

  const current = await auth.validateSession(auth.verifyAccessToken(login.accessToken));
  const forgedTenant = jwt.sign(
    { ...auth.buildAccessClaims(current, current.session_id), tenant_id: TENANT_B },
    process.env.ACCESS_TOKEN_SECRET,
    { algorithm: "HS256", expiresIn: 900, issuer: process.env.AUTH_TOKEN_ISSUER, audience: process.env.AUTH_TOKEN_AUDIENCE }
  );
  const forgedResponse = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
  await requireStaffAuth(
    { headers: { authorization: `Bearer ${forgedTenant}` } },
    forgedResponse,
    () => assert.fail("forged tenant must not continue")
  );
  assert.equal(forgedResponse.statusCode, 401);
  assert.equal(forgedResponse.payload.code, "AUTH_TENANT_CLAIM_MISMATCH");

  const adminResponse = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
  await requireAdminAuth(
    { headers: { authorization: `Bearer ${login.accessToken}` } },
    adminResponse,
    () => assert.fail("hotel token must not cross the platform boundary")
  );
  assert.equal(adminResponse.statusCode, 401);
});
