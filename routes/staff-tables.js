const express = require("express");
const { supabase } = require("../utils/supabase");
const { env } = require("../config/env");
const { getStaffTenantMutationClient } = require("../utils/tenant-route-database");
const { getTenantRequestScope } = require("../utils/tenant-request-context");
const { requireStaffAuth, requireStaffManagerAccess } = require("../middleware/require-staff-auth");
const {
  requireHotelFeature,
  resolveStaffHotelSlug
} = require("../middleware/require-hotel-feature");
const { buildQrContextToken } = require("../utils/qr-context");
const {
  OPERATIONAL_STATUSES,
  isMissingTableMasterSchema,
  normalizeTableCode,
  normalizeTableText,
  tableKey,
  tableResponse
} = require("../utils/restaurant-tables");

const router = express.Router();
const requireStaffFoodModule = requireHotelFeature("food", {
  resolveHotelSlug: resolveStaffHotelSlug
});
const ACTIVE_STATUSES = ["new", "confirmed", "preparing"];
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ /-]{0,39}$/;

function actorId(req) {
  const value = String(req.staffUser?.sub || req.staffUser?.id || "").trim();
  return /^\d+$/.test(value) ? Number(value) : null;
}

function blocksTable(order = {}) {
  const status = String(order.status || "new").toLowerCase();
  const kitchen = String(order.kitchen_status || "").toLowerCase();
  const payment = String(order.payment_status || "unpaid").toLowerCase();

  const billing = String(order.billing_status || "not_billed").toLowerCase();

  if (status === "cancelled" || kitchen === "cancelled") return false;
  if ((status === "completed" || kitchen === "served") &&
      payment === "paid" && billing === "billed") {
    return false;
  }
  return (
    ACTIVE_STATUSES.includes(status) ||
    ["new", "accepted", "preparing", "ready", "delayed"].includes(kitchen) ||
    (status === "completed" && payment !== "paid")
  );
}

function liveStatus(table, order) {
  if (!table.isActive) return "inactive";
  if (table.operationalStatus !== "active") return table.operationalStatus;
  if (!order) return "available";

  const status = String(order.status || "new").toLowerCase();
  const kitchen = String(order.kitchen_status || "").toLowerCase();
  const payment = String(order.payment_status || "unpaid").toLowerCase();
  const billing = String(order.billing_status || "not_billed").toLowerCase();

  if ((status === "completed" || billing === "billed") && payment !== "paid") return "billing_pending";
  if (kitchen === "ready") return "ready";
  if (["preparing", "delayed"].includes(kitchen) || status === "preparing") return "preparing";
  if (status === "new" || kitchen === "new") return "new";
  if (status === "confirmed" || kitchen === "accepted") return "confirmed";
  return status || "new";
}

function floorOrder(order) {
  return order
    ? {
        id: order.id,
        restaurantTableId: order.restaurant_table_id ? String(order.restaurant_table_id) : "",
        tableNumber: order.table_number || "",
        orderSource: order.order_source || "",
        status: order.status || "new",
        kitchenStatus: order.kitchen_status || "",
        effectiveKitchenStatus: order.kitchen_status || order.status || "new",
        paymentStatus: order.payment_status || "",
        billingStatus: order.billing_status || "",
        createdAt: order.created_at || ""
      }
    : null;
}

function parseTable(body = {}) {
  const tableCode = normalizeTableCode(body.tableCode);
  const displayOrder = Number.parseInt(String(body.displayOrder ?? 0), 10);
  const capacity = body.capacity === "" || body.capacity == null
    ? null
    : Number.parseInt(String(body.capacity), 10);
  const operationalStatus = String(body.operationalStatus || "active").toLowerCase();

  if (!CODE_PATTERN.test(tableCode)) return { error: "Use a safe table code up to 40 characters." };
  if (!Number.isInteger(displayOrder) || displayOrder < 0 || displayOrder > 1000000) {
    return { error: "Display order must be between 0 and 1000000." };
  }
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 100)) {
    return { error: "Capacity must be between 1 and 100." };
  }
  if (!OPERATIONAL_STATUSES.includes(operationalStatus)) return { error: "Invalid operational status." };

  return {
    value: {
      table_code: tableCode,
      table_name: normalizeTableText(body.tableName, 120) || `Table ${tableCode}`,
      display_order: displayOrder,
      capacity,
      area_name: normalizeTableText(body.areaName, 80),
      operational_status: operationalStatus,
      is_active: body.isActive !== false
    }
  };
}

async function orderMaps(hotelSlug) {
  const { data, error } = await supabase
    .from("orders")
    .select("id,restaurant_table_id,table_number,order_source,status,kitchen_status,payment_status,billing_status,created_at")
    .eq("hotel_slug", hotelSlug)
    .eq("order_type", "dine-in")
    .is("parent_order_id", null)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(500);

  if (error) throw error;

  const byId = new Map();
  const byCode = new Map();

  (data || []).filter(blocksTable).forEach((order) => {
    const id = String(order.restaurant_table_id || "");
    const code = tableKey(order.table_number);
    if (id && !byId.has(id)) byId.set(id, order);
    if (code && !byCode.has(code)) byCode.set(code, order);
  });

  return { byId, byCode };
}

router.get("/tables/floor", requireStaffAuth, requireStaffFoodModule, async (req, res) => {
  try {
    const hotelSlug = normalizeTableText(req.staffHotelSlug, 120);
    const { data, error } = await supabase
      .from("restaurant_tables")
      .select("*")
      .eq("hotel_slug", hotelSlug)
      .eq("is_active", true)
      .order("display_order", { ascending: true })
      .order("table_code", { ascending: true });

    if (error) throw error;

    const maps = await orderMaps(hotelSlug);
    const tables = (data || [])
      .map((row) => {
        const table = tableResponse(row);
        const order = maps.byId.get(table.id) || maps.byCode.get(tableKey(table.tableCode)) || null;
        return { ...table, liveStatus: liveStatus(table, order), activeOrder: floorOrder(order) };
      })
      .sort((first, second) => {
        const firstTime = new Date(first.activeOrder?.createdAt || 0).getTime() || 0;
        const secondTime = new Date(second.activeOrder?.createdAt || 0).getTime() || 0;
        if (!!first.activeOrder !== !!second.activeOrder) return first.activeOrder ? -1 : 1;
        if (first.activeOrder && second.activeOrder && firstTime !== secondTime) return secondTime - firstTime;
        return first.displayOrder - second.displayOrder ||
          first.tableCode.localeCompare(second.tableCode, undefined, { numeric: true, sensitivity: "base" });
      });

    const counts = tables.reduce((result, table) => {
      result.all += 1;
      result[table.liveStatus] = Number(result[table.liveStatus] || 0) + 1;
      return result;
    }, { all: 0, available: 0, new: 0, preparing: 0, ready: 0, billing_pending: 0 });

    res.json({ success: true, hotelSlug, count: tables.length, counts, tables });
  } catch (error) {
    if (isMissingTableMasterSchema(error)) {
      return res.status(503).json({ success: false, code: "TABLE_MASTER_NOT_INITIALIZED", message: "Restaurant table setup is not initialized yet." });
    }
    console.error("Staff table floor fetch error:", error);
    res.status(500).json({ success: false, message: "Failed to load the restaurant table floor." });
  }
});

router.get("/tables/:id/availability", requireStaffAuth, requireStaffFoodModule, async (req, res) => {
  try {
    const hotelSlug = normalizeTableText(req.staffHotelSlug, 120);
    const { data, error } = await supabase
      .from("restaurant_tables")
      .select("*")
      .eq("id", req.params.id)
      .eq("hotel_slug", hotelSlug)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, message: "Table not found for this hotel." });

    const table = tableResponse(data);
    const maps = await orderMaps(hotelSlug);
    const order = maps.byId.get(table.id) || maps.byCode.get(tableKey(table.tableCode)) || null;

    res.json({
      success: true,
      available: table.isActive && table.operationalStatus === "active" && !order,
      table,
      liveStatus: liveStatus(table, order),
      activeOrder: floorOrder(order)
    });
  } catch (error) {
    console.error("Staff table availability error:", error);
    res.status(500).json({ success: false, message: "Failed to check table availability." });
  }
});

router.get("/tables", requireStaffAuth, requireStaffManagerAccess, requireStaffFoodModule, async (req, res) => {
  try {
    const hotelSlug = normalizeTableText(req.staffHotelSlug, 120);
    const { data, error } = await supabase
      .from("restaurant_tables")
      .select("*")
      .eq("hotel_slug", hotelSlug)
      .order("display_order", { ascending: true })
      .order("table_code", { ascending: true });

    if (error) throw error;
    res.json({ success: true, hotelSlug, tables: (data || []).map(tableResponse) });
  } catch (error) {
    if (isMissingTableMasterSchema(error)) {
      return res.status(503).json({ success: false, code: "TABLE_MASTER_NOT_INITIALIZED", message: "Restaurant table setup is not initialized yet." });
    }
    res.status(500).json({ success: false, message: "Failed to load table management." });
  }
});

router.post("/tables", requireStaffAuth, requireStaffManagerAccess, requireStaffFoodModule, async (req, res) => {
  try {
    const parsed = parseTable(req.body);
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });

    const hotelSlug = normalizeTableText(req.staffHotelSlug, 120);
    const actor = actorId(req);
    const database = await getStaffTenantMutationClient(req, supabase);
    const scope = env.tenantRuntimeWritesEnabled ? getTenantRequestScope(req) : null;
    const { data, error } = await database
      .from("restaurant_tables")
      .insert([{
        ...(scope ? { tenant_id: scope.tenantId, property_id: scope.propertyId } : {}),
        hotel_slug: scope?.propertySlug || hotelSlug,
        ...parsed.value,
        created_by_staff_id: actor,
        updated_by_staff_id: actor
      }])
      .select("*")
      .single();

    if (error) {
      if (String(error.code) === "23505") {
        return res.status(409).json({ success: false, code: "TABLE_CODE_EXISTS", message: "That table code already exists for this hotel." });
      }
      throw error;
    }

    res.status(201).json({ success: true, message: "Table created.", table: tableResponse(data) });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to create table." });
  }
});

router.post("/tables/bulk", requireStaffAuth, requireStaffManagerAccess, requireStaffFoodModule, async (req, res) => {
  try {
    const hotelSlug = normalizeTableText(req.staffHotelSlug, 120);
    const prefix = normalizeTableText(req.body?.prefix, 20);
    const start = Number.parseInt(String(req.body?.start), 10);
    const end = Number.parseInt(String(req.body?.end), 10);

    if (!/^[A-Za-z0-9._-]{0,20}$/.test(prefix) || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end - start + 1 > 500) {
      return res.status(400).json({ success: false, message: "Use a safe prefix and a range of at most 500 tables." });
    }

    const capacity = req.body?.capacity === "" || req.body?.capacity == null ? null : Number(req.body.capacity);
    if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 100)) {
      return res.status(400).json({ success: false, message: "Capacity must be between 1 and 100." });
    }

    const candidates = Array.from({ length: end - start + 1 }, (_, index) => `${prefix}${start + index}`);
    const existingResult = await supabase.from("restaurant_tables").select("table_code").eq("hotel_slug", hotelSlug);
    if (existingResult.error) throw existingResult.error;

    const existing = new Set((existingResult.data || []).map((row) => tableKey(row.table_code)));
    const createCodes = candidates.filter((code) => !existing.has(tableKey(code)));
    const rows = createCodes.map((code, index) => ({
      hotel_slug: hotelSlug,
      table_code: code,
      table_name: `Table ${code}`,
      display_order: start + index,
      area_name: normalizeTableText(req.body?.areaName, 80),
      capacity,
      operational_status: "active",
      is_active: true,
      created_by_staff_id: actorId(req),
      updated_by_staff_id: actorId(req)
    }));
    const database = await getStaffTenantMutationClient(req, supabase);
    const scope = env.tenantRuntimeWritesEnabled ? getTenantRequestScope(req) : null;
    const ownedRows = rows.map((row) => ({
      ...(scope ? { tenant_id: scope.tenantId, property_id: scope.propertyId } : {}),
      ...row,
      hotel_slug: scope?.propertySlug || hotelSlug
    }));
    const result = rows.length
      ? await database.from("restaurant_tables").insert(ownedRows).select("*")
      : { data: [], error: null };

    if (result.error) throw result.error;
    res.status(201).json({
      success: true,
      message: `Created ${result.data.length} tables; skipped ${candidates.length - result.data.length} existing.`,
      requestedCount: candidates.length,
      createdCount: result.data.length,
      skippedCount: candidates.length - result.data.length,
      created: result.data.map(tableResponse)
    });
  } catch (error) {
    if (String(error.code) === "23505") {
      return res.status(409).json({ success: false, code: "BULK_TABLE_CONFLICT", message: "The range changed. Refresh and preview again." });
    }
    res.status(500).json({ success: false, message: "Failed to create the table range." });
  }
});

router.patch("/tables/:id", requireStaffAuth, requireStaffManagerAccess, requireStaffFoodModule, async (req, res) => {
  try {
    const hotelSlug = normalizeTableText(req.staffHotelSlug, 120);
    const parsed = parseTable(req.body);
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });

    const currentResult = await supabase
      .from("restaurant_tables")
      .select("*")
      .eq("id", req.params.id)
      .eq("hotel_slug", hotelSlug)
      .maybeSingle();

    if (currentResult.error) throw currentResult.error;
    if (!currentResult.data) return res.status(404).json({ success: false, message: "Table not found for this hotel." });

    if (!parsed.value.is_active || parsed.value.operational_status !== "active") {
      const maps = await orderMaps(hotelSlug);
      const order = maps.byId.get(String(currentResult.data.id)) || maps.byCode.get(tableKey(currentResult.data.table_code));
      if (order) {
        return res.status(409).json({ success: false, code: "TABLE_HAS_ACTIVE_ORDER", message: "This table has an active order and cannot be deactivated or blocked." });
      }
    }

    const database = await getStaffTenantMutationClient(req, supabase);
    let update = database
      .from("restaurant_tables")
      .update({
        ...parsed.value,
        updated_by_staff_id: actorId(req),
        updated_at: new Date().toISOString(),
        row_version: Number(currentResult.data.row_version || 1) + 1
      })
      .eq("id", req.params.id)
      .eq("hotel_slug", hotelSlug);

    if (req.body?.rowVersion != null) update = update.eq("row_version", Number(req.body.rowVersion));
    const result = await update.select("*").maybeSingle();

    if (result.error) {
      if (String(result.error.code) === "23505") {
        return res.status(409).json({ success: false, code: "TABLE_CODE_EXISTS", message: "That table code already exists for this hotel." });
      }
      throw result.error;
    }
    if (!result.data) return res.status(409).json({ success: false, code: "TABLE_CHANGED", message: "This table changed. Refresh and try again." });

    res.json({ success: true, message: "Table updated.", table: tableResponse(result.data) });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to update table." });
  }
});

router.patch("/table-master/settings", requireStaffAuth, requireStaffManagerAccess, requireStaffFoodModule, async (req, res) => {
  try {
    const hotelSlug = normalizeTableText(req.staffHotelSlug, 120);
    const enforce = req.body?.enforceTableMaster === true;

    if (enforce) {
      const result = await supabase
        .from("restaurant_tables")
        .select("id", { count: "exact", head: true })
        .eq("hotel_slug", hotelSlug)
        .eq("is_active", true);
      if (result.error) throw result.error;
      if (!result.count) {
        return res.status(409).json({ success: false, message: "Configure at least one active table before enabling enforcement." });
      }
    }

    const database = await getStaffTenantMutationClient(req, supabase);
    const scope = env.tenantRuntimeWritesEnabled ? getTenantRequestScope(req) : null;
    const { data, error } = await database
      .from("hotel_ordering_settings")
      .upsert({
        ...(scope ? { tenant_id: scope.tenantId, property_id: scope.propertyId } : {}),
        hotel_slug: scope?.propertySlug || hotelSlug,
        enforce_table_master: enforce,
        updated_at: new Date().toISOString()
      }, { onConflict: "hotel_slug" })
      .select("hotel_slug,enforce_table_master")
      .single();

    if (error) throw error;
    res.json({
      success: true,
      message: enforce ? "Table master enforcement enabled." : "Compatibility mode enabled.",
      enforceTableMaster: data.enforce_table_master === true
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to update table enforcement." });
  }
});

router.post("/tables/:id/qr", requireStaffAuth, requireStaffManagerAccess, requireStaffFoodModule, async (req, res) => {
  try {
    const hotelSlug = normalizeTableText(req.staffHotelSlug, 120);
    const result = await supabase
      .from("restaurant_tables")
      .select("*")
      .eq("id", req.params.id)
      .eq("hotel_slug", hotelSlug)
      .maybeSingle();

    if (result.error) throw result.error;
    if (!result.data) return res.status(404).json({ success: false, message: "Table not found for this hotel." });

    const table = tableResponse(result.data);
    if (!table.isActive || table.operationalStatus !== "active") {
      return res.status(409).json({ success: false, message: "Only active tables can receive a QR link." });
    }

    const token = buildQrContextToken({ hotelSlug, tableNumber: table.tableCode, orderSource: "qr", orderType: "dine-in" });
    const base = String(process.env.PUBLIC_FRONTEND_URL || "").trim().replace(/\/$/, "");
    const query = new URLSearchParams({ hotel: hotelSlug, table: table.tableCode, source: "qr", qctx: token }).toString();

    res.json({ success: true, table, qrContextToken: token, url: `${base}/menu.html?${query}` });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to generate the table QR link." });
  }
});

module.exports = router;
