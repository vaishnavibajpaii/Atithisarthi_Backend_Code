const express = require("express");
const { supabase } = require("../utils/supabase");
const { env } = require("../config/env");
const { getStaffTenantMutationClient } = require("../utils/tenant-route-database");
const { getTenantRequestScope } = require("../utils/tenant-request-context");
const logger = require("../utils/logger");
const { requireStaffAuth, requireStaffManagerAccess } = require("../middleware/require-staff-auth");
const { requireHotelFeature, resolveStaffHotelSlug } = require("../middleware/require-hotel-feature");
const { tableResponse } = require("../utils/restaurant-tables");
const { fetchPublicHotelAccess } = require("../utils/public-hotel-access");
const {
  decryptQrToken,
  encryptQrToken,
  generateOpaqueQrToken,
  getCanonicalQrUrl,
  hashSecret,
  safeSecretPrefix
} = require("../utils/secure-qr");

const router = express.Router();
const requireStaffFoodModule = requireHotelFeature("food", { resolveHotelSlug: resolveStaffHotelSlug });

function actorId(req) {
  const value = String(req.staffUser?.sub || req.staffUser?.id || "").trim();
  return /^\d+$/.test(value) ? Number(value) : null;
}

function isMissingSecureQrSchema(error) {
  const code = String(error?.code || "").toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`.toLowerCase();
  return ["42P01", "42703", "PGRST204", "PGRST205"].includes(code) || details.includes("restaurant_table_qr_tokens");
}

async function fetchScopedTable(req, res) {
  const hotelSlug = String(req.staffHotelSlug || "").trim();
  const result = await supabase.from("restaurant_tables").select("*")
    .eq("id", req.params.id).eq("hotel_slug", hotelSlug).maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) {
    res.status(404).json({ success: false, message: "Table not found for this hotel." });
    return null;
  }
  return { hotelSlug, row: result.data, table: tableResponse(result.data) };
}

async function fetchActiveToken(hotelSlug, tableId) {
  return supabase.from("restaurant_table_qr_tokens")
    .select("id,hotel_slug,restaurant_table_id,token_prefix,token_ciphertext,token_version,is_active,created_at,rotated_at,revoked_at,last_used_at")
    .eq("hotel_slug", hotelSlug).eq("restaurant_table_id", tableId)
    .eq("is_active", true).is("revoked_at", null).maybeSingle();
}

async function recordQrManagementAudit({ hotelSlug, tableId, tokenId, eventType, req }) {
  const database = await getStaffTenantMutationClient(req, supabase);
  const scope = env.tenantRuntimeWritesEnabled ? getTenantRequestScope(req) : null;
  const { error } = await database.from("qr_security_events").insert([{
    ...(scope ? { tenant_id: scope.tenantId, property_id: scope.propertyId } : {}),
    hotel_slug: scope?.propertySlug || hotelSlug,
    restaurant_table_id: tableId,
    actor_type: "staff",
    actor_reference: String(req.staffUser?.sub || req.staffUser?.id || ""),
    event_type: eventType,
    request_id: req.requestId || null,
    safe_context: { tokenId: tokenId ? String(tokenId) : null, role: req.staffRole || req.staffUser?.role || "manager" }
  }]);
  if (error && !isMissingSecureQrSchema(error)) throw error;
}

async function createToken({ hotelSlug, tableId, req }) {
  const latest = await supabase.from("restaurant_table_qr_tokens")
    .select("token_version").eq("hotel_slug", hotelSlug).eq("restaurant_table_id", tableId)
    .order("token_version", { ascending: false }).limit(1);
  if (latest.error && !isMissingSecureQrSchema(latest.error)) throw latest.error;
  const nextVersion = Number(latest.data?.[0]?.token_version || 0) + 1;
  const rawToken = generateOpaqueQrToken();
  const database = await getStaffTenantMutationClient(req, supabase);
  const scope = env.tenantRuntimeWritesEnabled ? getTenantRequestScope(req) : null;
  const inserted = await database.from("restaurant_table_qr_tokens").insert([{
    ...(scope ? { tenant_id: scope.tenantId, property_id: scope.propertyId } : {}),
    hotel_slug: scope?.propertySlug || hotelSlug,
    restaurant_table_id: tableId,
    token_hash: hashSecret(rawToken),
    token_prefix: safeSecretPrefix(rawToken),
    token_ciphertext: encryptQrToken(rawToken),
    token_version: nextVersion,
    created_by_staff_id: actorId(req)
  }]).select("id,token_prefix,token_version,is_active,created_at,last_used_at").single();
  if (inserted.error) throw inserted.error;
  return { record: inserted.data, rawToken };
}

function tokenStatusResponse(record = {}) {
  return {
    id: record.id ? String(record.id) : "",
    prefix: record.token_prefix || "",
    version: Number(record.token_version || 1),
    isActive: record.is_active === true && !record.revoked_at,
    createdAt: record.created_at || "",
    rotatedAt: record.rotated_at || "",
    revokedAt: record.revoked_at || "",
    lastUsedAt: record.last_used_at || ""
  };
}

async function returnPrintableToken(req, res, { rotate = false } = {}) {
  const context = await fetchScopedTable(req, res);
  if (!context) return;
  if (!context.table.isActive || context.table.operationalStatus !== "active") {
    return res.status(409).json({ success: false, message: "Only active tables can receive a QR link." });
  }
  let active = await fetchActiveToken(context.hotelSlug, context.row.id);
  if (active.error && isMissingSecureQrSchema(active.error)) {
    return res.status(503).json({ success: false, code: "SECURE_QR_NOT_INITIALIZED", message: "Apply the secure QR database migration first." });
  }
  if (active.error) throw active.error;
  if (rotate && active.data) {
    const now = new Date().toISOString();
    const database = await getStaffTenantMutationClient(req, supabase);
    const revoked = await database.from("restaurant_table_qr_tokens")
      .update({ is_active: false, revoked_at: now, rotated_at: now })
      .eq("id", active.data.id).eq("hotel_slug", context.hotelSlug).eq("restaurant_table_id", context.row.id);
    if (revoked.error) throw revoked.error;
    await recordQrManagementAudit({ hotelSlug: context.hotelSlug, tableId: context.row.id, tokenId: active.data.id, eventType: "QR_TOKEN_ROTATED", req });
    active = { data: null, error: null };
  }
  let record = active.data;
  let rawToken = record ? decryptQrToken(record.token_ciphertext) : "";
  if (record && !rawToken) {
    const recoveryError = new Error("The active QR link cannot be recovered with the current server key.");
    recoveryError.code = "QR_TOKEN_ROTATION_REQUIRED";
    throw recoveryError;
  }
  if (!record) {
    const created = await createToken({ hotelSlug: context.hotelSlug, tableId: context.row.id, req });
    record = created.record;
    rawToken = created.rawToken;
    await recordQrManagementAudit({ hotelSlug: context.hotelSlug, tableId: context.row.id, tokenId: record.id, eventType: rotate ? "QR_TOKEN_REGENERATED" : "QR_TOKEN_CREATED", req });
  }
  const hotelAccess = await fetchPublicHotelAccess(context.hotelSlug);
  return res.json({
    success: true,
    table: context.table,
    token: tokenStatusResponse(record),
    url: getCanonicalQrUrl(rawToken, hotelAccess?.primary_domain),
    requiresReprint: rotate
  });
}

router.get("/tables/:id/qr", requireStaffAuth, requireStaffManagerAccess, requireStaffFoodModule, async (req, res) => {
  try {
    const context = await fetchScopedTable(req, res);
    if (!context) return;
    const active = await fetchActiveToken(context.hotelSlug, context.row.id);
    if (active.error && isMissingSecureQrSchema(active.error)) return res.status(503).json({ success: false, code: "SECURE_QR_NOT_INITIALIZED", message: "Apply the secure QR database migration first." });
    if (active.error) throw active.error;
    return res.json({ success: true, table: context.table, token: active.data ? tokenStatusResponse(active.data) : null });
  } catch (error) {
    return res.status(500).json({ success: false, message: "QR token status could not be loaded." });
  }
});

router.post("/tables/:id/qr", requireStaffAuth, requireStaffManagerAccess, requireStaffFoodModule, async (req, res) => {
  try {
    return await returnPrintableToken(req, res);
  } catch (error) {
    logger.error("Staff table QR generation failed", {
      requestId: req.requestId,
      hotelSlug: req.staffHotelSlug,
      tableId: req.params.id,
      code: error.code || "",
      message: error.message
    });
    if (error.code === "QR_TOKEN_ROTATION_REQUIRED") {
      return res.status(409).json({
        success: false,
        code: "QR_TOKEN_ROTATION_REQUIRED",
        message: "This saved QR link was protected with an earlier server key. Rotate QR once to create and copy a new secure link."
      });
    }
    return res.status(isMissingSecureQrSchema(error) ? 503 : 500).json({
      success: false,
      message: isMissingSecureQrSchema(error)
        ? "Apply the secure QR database migration first."
        : "Failed to generate the secure table QR link."
    });
  }
});

router.post("/tables/:id/qr/rotate", requireStaffAuth, requireStaffManagerAccess, requireStaffFoodModule, async (req, res) => {
  try {
    return await returnPrintableToken(req, res, { rotate: true });
  } catch (error) {
    logger.error("Staff table QR rotation failed", {
      requestId: req.requestId,
      hotelSlug: req.staffHotelSlug,
      tableId: req.params.id,
      code: error.code || "",
      message: error.message
    });
    return res.status(isMissingSecureQrSchema(error) ? 503 : 500).json({
      success: false,
      message: isMissingSecureQrSchema(error)
        ? "Apply the secure QR database migration first."
        : "Failed to rotate the secure table QR link."
    });
  }
});

router.post("/tables/:id/qr/revoke", requireStaffAuth, requireStaffManagerAccess, requireStaffFoodModule, async (req, res) => {
  try {
    const context = await fetchScopedTable(req, res);
    if (!context) return;
    const active = await fetchActiveToken(context.hotelSlug, context.row.id);
    if (active.error) throw active.error;
    if (!active.data) return res.json({ success: true, message: "This table has no active QR token." });
    const database = await getStaffTenantMutationClient(req, supabase);
    const revoked = await database.from("restaurant_table_qr_tokens")
      .update({ is_active: false, revoked_at: new Date().toISOString() })
      .eq("id", active.data.id).eq("hotel_slug", context.hotelSlug).eq("restaurant_table_id", context.row.id);
    if (revoked.error) throw revoked.error;
    await recordQrManagementAudit({ hotelSlug: context.hotelSlug, tableId: context.row.id, tokenId: active.data.id, eventType: "QR_TOKEN_REVOKED", req });
    return res.json({ success: true, message: `QR ordering revoked for Table ${context.table.tableCode}.`, token: { ...tokenStatusResponse(active.data), isActive: false } });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to revoke the table QR link." });
  }
});

router.get("/tables/:id/qr/print", requireStaffAuth, requireStaffManagerAccess, requireStaffFoodModule, async (req, res) => {
  try { return await returnPrintableToken(req, res); }
  catch (error) { return res.status(500).json({ success: false, message: "Printable QR link could not be loaded." }); }
});

module.exports = router;
