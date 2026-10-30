"use strict";

const express = require("express");
const { env } = require("../config/env");
const { requireAdminAuth } = require("../middleware/require-admin-auth");
const { hasPermission } = require("../utils/permissions");
const { metrics } = require("../utils/operational-metrics");
const { getDeploymentIdentity, droppedCount } = require("../utils/logger");

function createOperationsHandler({ enabled = () => env.task7OperationsEndpointEnabled, snapshot = () => metrics.snapshot(),
  poolDiagnostics = () => require("../utils/tenant-database").getTenantPoolDiagnostics() } = {}) {
  return function operations(req, res) {
    res.setHeader("cache-control", "no-store");
    if (!enabled()) return res.status(404).json({ success: false, code: "not_found" });
    // This new diagnostic endpoint never accepts legacy/hotel principals, even if general RBAC is dormant.
    if (req.authPrincipal?.principal_type !== "platform_admin" || !req.authSession ||
        !hasPermission(req.authPrincipal, "platform.settings.read")) {
      return res.status(403).json({ success: false, code: "permission_denied" });
    }
    return res.json({ success: true, ...getDeploymentIdentity(), loggingDropped: droppedCount(), metrics: snapshot(), databasePool: poolDiagnostics() });
  };
}

const router = express.Router();
router.get("/operations", requireAdminAuth, createOperationsHandler());
module.exports = { operationsRouter: router, createOperationsHandler };
