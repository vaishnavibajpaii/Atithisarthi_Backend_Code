"use strict";

const { env } = require("../config/env");
const platformPolicies = require("../utils/platform-route-permissions");
const staffPolicies = require("../utils/staff-route-permissions");
const { requirePermission } = require("./require-permission");

function normalizePath(value) {
  const path = String(value || "").split("?")[0].replace(/\/+$/, "");
  return path || "/";
}

function compilePolicy(definition) {
  const [method, route, permission] = String(definition).trim().split(/\s+/);
  const expression = normalizePath(route)
    .split("/")
    .map((part) => part.startsWith(":") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("/");
  return Object.freeze({
    method,
    route: normalizePath(route),
    permission,
    pattern: new RegExp(`^${expression}/?$`)
  });
}

const ROUTE_POLICIES = Object.freeze(
  [...platformPolicies, ...staffPolicies].map(compilePolicy)
);

function resolveRoutePermission(method, path) {
  const normalizedMethod = String(method || "").toUpperCase();
  const normalizedPath = normalizePath(path);
  const policy = ROUTE_POLICIES.find((candidate) =>
    candidate.method === normalizedMethod && candidate.pattern.test(normalizedPath)
  );
  return policy?.permission || "";
}

function enforceRoutePermission(req, res, next) {
  if (!env.authRbacEnforcementEnabled) return next();
  const permission = resolveRoutePermission(req.method, req.originalUrl || req.url);
  if (!permission) {
    return res.status(403).json({
      success: false,
      code: "permission_policy_missing",
      message: "This protected route does not have an authorization policy"
    });
  }
  return requirePermission(permission)(req, res, next);
}

module.exports = {
  ROUTE_POLICIES,
  enforceRoutePermission,
  normalizePath,
  resolveRoutePermission
};
