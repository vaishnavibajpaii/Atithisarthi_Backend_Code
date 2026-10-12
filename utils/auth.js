const jwt = require("jsonwebtoken");
const { env } = require("../config/env");

const ADMIN_TOKEN_SCOPE = "admin";
const STAFF_TOKEN_SCOPE = "hotel_staff";
const STAFF_OWNER_ROLE = "owner";
const STAFF_BASIC_ROLE = "staff";
const STAFF_KDS_ROLES = ["general", "kitchen", "expo", "manager"];

function normalizeStaffKdsRole(kdsRole = "", accountRole = "") {
  if (normalizeStaffRole(accountRole) === STAFF_OWNER_ROLE) return "manager";
  const normalizedRole = String(kdsRole || "").trim().toLowerCase();
  return STAFF_KDS_ROLES.includes(normalizedRole) ? normalizedRole : "general";
}

function isStaffKdsRoleAllowed(kdsRole = "", allowedRoles = []) {
  const normalizedRole = normalizeStaffKdsRole(kdsRole);
  return normalizedRole === "manager" || normalizedRole === "general" ||
    (Array.isArray(allowedRoles) && allowedRoles.includes(normalizedRole));
}

function normalizeStaffRole(role = "") {
  const normalizedRole = String(role || "")
    .trim()
    .toLowerCase();

  return normalizedRole === STAFF_OWNER_ROLE ? STAFF_OWNER_ROLE : STAFF_BASIC_ROLE;
}

function isStaffManagerRole(role = "") {
  return normalizeStaffRole(role) === STAFF_OWNER_ROLE;
}

function signAdminToken(adminUser) {
  return jwt.sign(
    {
      sub: adminUser.id,
      scope: ADMIN_TOKEN_SCOPE,
      email: adminUser.email,
      fullName: adminUser.full_name || ""
    },
    env.jwtSecret,
    {
      expiresIn: env.jwtExpiresIn
    }
  );
}

function verifyAdminToken(token) {
  const decoded = jwt.verify(token, env.jwtSecret);

  if (decoded.scope !== ADMIN_TOKEN_SCOPE) {
    throw new Error("Invalid admin token scope");
  }

  return decoded;
}

function signStaffToken(staffAccess) {
  const staffId = String(staffAccess?.id || "").trim();
  const hotelSlug = String(
    staffAccess?.hotel_slug || staffAccess?.hotelSlug || ""
  ).trim();
  const role = normalizeStaffRole(staffAccess?.role);

  if (!staffId || !hotelSlug) {
    throw new Error("Staff token requires staff id and hotel slug");
  }

  return jwt.sign(
    {
      sub: staffId,
      scope: STAFF_TOKEN_SCOPE,
      hotelSlug,
      displayName: staffAccess.display_name || staffAccess.displayName || "Staff",
      role,
      kdsRole: normalizeStaffKdsRole(staffAccess.kds_role || staffAccess.kdsRole, role)
    },
    env.jwtSecret,
    {
      expiresIn: env.jwtExpiresIn
    }
  );
}

function verifyStaffToken(token) {
  const decoded = jwt.verify(token, env.jwtSecret);

  if (decoded.scope !== STAFF_TOKEN_SCOPE || !decoded.hotelSlug) {
    throw new Error("Invalid staff token scope");
  }

  return {
    ...decoded,
    role: normalizeStaffRole(decoded.role),
    isManager: isStaffManagerRole(decoded.role),
    kdsRole: normalizeStaffKdsRole(decoded.kdsRole, decoded.role)
  };
}

module.exports = {
  signAdminToken,
  verifyAdminToken,
  signStaffToken,
  verifyStaffToken,
  ADMIN_TOKEN_SCOPE,
  STAFF_TOKEN_SCOPE,
  STAFF_OWNER_ROLE,
  STAFF_BASIC_ROLE,
  normalizeStaffRole,
  isStaffManagerRole,
  STAFF_KDS_ROLES,
  normalizeStaffKdsRole,
  isStaffKdsRoleAllowed
};
