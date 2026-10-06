const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { env } = require("../config/env");
const logger = require("../utils/logger");
const { timeDatabaseCall } = require("../utils/request-timing");
const { supabase } = require("../utils/supabase");
const { createNotificationEventSafely } = require("../utils/notifications");
const { invalidatePublicTestimonialsCache } = require("../utils/public-route-cache");
const {
  buildOrderTrackingReference,
  getOrderTrackingColumns,
  isMissingOrderTrackingColumnsError
} = require("../utils/order-tracking");
const {
  getOrderCreatedByStaffMap,
  getOrderCreatedByStaffResponse,
  isMissingOrderStaffAttributionColumnsError,
  normalizeOrderCreatedByStaffId
} = require("../utils/order-staff-attribution");
const {
  signStaffToken,
  normalizeStaffRole,
  isStaffManagerRole,
  normalizeStaffKdsRole,
  isStaffKdsRoleAllowed
} = require("../utils/auth");
const { requireStaffAuth, requireStaffManagerAccess } = require("../middleware/require-staff-auth");
const {
  requireHotelFeature,
  resolveStaffHotelSlug
} = require("../middleware/require-hotel-feature");
const {
  buildFeatureDisabledPayload,
  fetchHotelFeatureConfig,
  isHotelFeatureEnabled,
  normalizeHotelFeatureConfig
} = require("../utils/hotel-feature-settings");
const {
  calculateAdr,
  calculateCombinedRevenue,
  calculateOccupancyRate,
  calculateOverlappingRoomNights
} = require("../utils/hotel-report-accounting");const {
  getRoomBookingSourceGroup,
  getRoomBookingSourceLabel
} = require("../utils/room-booking-source");
const { validateBody } = require("../validators/common");
const staffTablesRouter = require("./staff-tables");
const staffQrManagementRouter = require("./staff-qr-management");
const staffQrCorrectionsRouter = require("./staff-qr-corrections");
const {
  staffLoginSchema,
  staffTableOrderSchema,
  staffRoomServiceOrderSchema,
  staffOrderItemAdditionSchema,
  staffKdsKitchenStatusSchema,
  staffPaymentMethodSettingsSchema
} = require("../validators/staff");
const {
  buildOrderItemSnapshots,
  buildComboSummaryLine
} = require("../utils/order-item-snapshots");
const {
  fetchMenuComboPresentationMap,
  isMissingMenuComboSchemaError,
  validateRequestedMenuCombos
} = require("../utils/menu-combos");
const {
  fetchHotelMenuCategories,
  filterEligibleMenuItems
} = require("../utils/menu-categories");
const {
  buildStaffMenuPayload
} = require("../utils/staff-menu-presentation");
const {
  attachCanonicalStaffTenantContext
} = require("../utils/tenant-staff-context");
const {
  getTenantRequestScope
} = require("../utils/tenant-request-context");
const {
  fetchTenantStaffMenuBundle
} = require("../utils/tenant-staff-menu");
const {
  buildStaffOrderingDisabledPayload,
  fetchHotelOrderingSettings,
  invalidateHotelOrderingSettings,
  isMissingHotelOrderingSettingsTableError
} = require("../utils/hotel-ordering-settings");
const { resolveTableForOrder } = require("../utils/restaurant-tables");
const { issueFoodBillSnapshotIfFinal } = require("../utils/food-order-bill");
const {
  DEFAULT_STAFF_REPORT_TIME_ZONE,
  addCalendarDays,
  buildStaffOrderTrend,
  getStaffTrendPeriod,
  getZonedDateKey,
  getZonedDayStart,
  normalizeStaffReportTimeZone
} = require("../utils/staff-order-trend");

const router = express.Router();
router.use(staffQrManagementRouter);
router.use(staffQrCorrectionsRouter);
router.use(staffTablesRouter);
const requireStaffFoodModule = requireHotelFeature("food", {
  resolveHotelSlug: resolveStaffHotelSlug
});
async function attachStaffMenuTenantContext(req, res, next) {
  if (!env.tenantRuntimeStaffMenuEnabled) return next();
  try {
    const hotel = await attachCanonicalStaffTenantContext(req);
    if (!hotel) {
      return res.status(403).json({
        success: false,
        code: "HOTEL_SCOPE_REQUIRED",
        message: "Staff hotel scope is not mapped to a tenant"
      });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}
function requireStaffMenuFoodModule(req, res, next) {
  if (env.tenantRuntimeStaffMenuEnabled) return next();
  return requireStaffFoodModule(req, res, next);
}
const requireStaffRoomService = requireHotelFeature("room_service", {
  resolveHotelSlug: resolveStaffHotelSlug
});
const requireStaffFoodReports = requireHotelFeature("food_reports", {
  resolveHotelSlug: resolveStaffHotelSlug
});
const STAFF_ORDER_RANGES = ["today", "week", "month", "recent", "all"];
const STAFF_ORDERS_DEFAULT_LIMIT = 50;
const STAFF_ORDERS_MAX_LIMIT = 200;
const STAFF_REPORT_BATCH_SIZE = 500;
const STAFF_BUSINESS_REPORT_MAX_ORDERS = 5000;
const STAFF_ITEM_REPORT_LIMIT = 5;
const STAFF_BUSINESS_REPORT_ITEM_LIMIT = 10;
const STAFF_BUSINESS_REPORT_CUSTOMER_LIMIT = 10;
const STAFF_BUSINESS_REPORT_STAFF_LIMIT = 10;
const STAFF_BUSINESS_REPORT_TABLE_LIMIT = 10;
const STAFF_BUSINESS_REPORT_MAX_ROOM_BOOKINGS = 5000;
const STAFF_ORDER_STATUSES = ["new", "confirmed", "preparing", "completed", "cancelled"];
const STAFF_ACTIVE_TABLE_ORDER_STATUSES = ["new", "confirmed", "preparing"];
const STAFF_KDS_STATUSES = [
  "new",
  "accepted",
  "preparing",
  "ready",
  "served",
  "delayed",
  "cancelled"
];
const STAFF_KDS_STATUS_TRANSITIONS = Object.freeze({
  new: Object.freeze(["accepted", "preparing"]),
  accepted: Object.freeze(["preparing", "delayed"]),
  preparing: Object.freeze(["ready", "delayed"]),
  delayed: Object.freeze(["preparing", "ready"]),
  ready: Object.freeze(["served"]),
  served: Object.freeze([]),
  cancelled: Object.freeze([])
});
const STAFF_KDS_KITCHEN_TARGETS = Object.freeze(["accepted", "preparing", "ready", "delayed"]);
const STAFF_KDS_EXPO_TARGETS = Object.freeze(["served"]);
const STAFF_KDS_REFRESH_AFTER_MS = 3000;
const STAFF_RESERVATION_STATUSES = ["new", "confirmed", "seated", "completed", "cancelled"];
const STAFF_INQUIRY_STATUSES = ["new", "contacted", "converted", "closed"];
const STAFF_CONTACT_SUBMISSION_STATUSES = ["new", "contacted", "resolved", "closed", "archived"];
const STAFF_SUPPORT_REQUEST_STATUSES = ["new", "acknowledged", "resolved", "closed"];
const STAFF_KDS_DEFAULT_LIMIT = 120;
const STAFF_KDS_MAX_LIMIT = 300;
const STAFF_MENU_FIELDS = [
  "item_id",
  "item_type",
  "name",
  "description",
  "price",
  "image",
  "alt",
  "badge",
  "tag",
  "category",
  "sort_order"
].join(",");
const STAFF_ORDER_LIST_FIELDS = [
  "id",
  "hotel_slug",
  "hotel_name",
  "order_type",
  "restaurant_table_id",
  "table_number",
  "order_source",
  "parent_order_id",
  "order_group_id",
  "order_entry_type",
  "order_sequence_label",
  "addon_sequence",
  "customer_name",
  "customer_phone",
  "customer_address",
  "payment_method",
  "payment_status",
  "billing_status",
  "bill_number",
  "billed_at",
  "paid_at",
  "room_id",
  "room_booking_id",
  "room_number",
  "room_service_guest_name",
  "room_service_charge_to_room",
  "status",
  "order_version",
  "kitchen_status",
  "note",
  "items",
  "totals",
  "payment_metadata",
  "gateway_transfer_id",
  "gateway_transfer_status",
  "gateway_settlement_status",
  "gateway_transfer_error",
  "created_at",
  "created_by_staff_id"
].join(",");
const STAFF_KDS_ORDER_FIELDS = [
  "id",
  "order_type",
  "restaurant_table_id",
  "table_number",
  "order_source",
  "order_entry_type",
  "order_sequence_label",
  "room_id",
  "room_booking_id",
  "room_number",
  "status",
  "order_version",
  "kitchen_status",
  "note",
  "items",
  "created_at",
  "created_by_staff_id"
].join(",");
const ORDER_BILLING_COLUMNS = [
  "payment_status",
  "billing_status",
  "bill_number",
  "billed_at",
  "paid_at"
];
const ORDER_TABLE_CONTEXT_COLUMNS = [
  "order_type",
  "table_number",
  "order_source"
];
const ORDER_ROOM_SERVICE_COLUMNS = [
  "room_id",
  "room_booking_id",
  "room_number",
  "room_service_guest_name",
  "room_service_charge_to_room"
];
const ORDER_ADDON_METADATA_COLUMNS = [
  "parent_order_id",
  "order_group_id",
  "order_entry_type",
  "order_sequence_label",
  "addon_sequence"
];
const ORDER_KITCHEN_COLUMNS = ["kitchen_status"];
const ORDER_ROUND_STATUSES = ["new", "accepted", "preparing", "ready", "served", "delayed", "cancelled"];

function isMissingOrderRoundsSchemaError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();

  return (
    code === "42P01" ||
    code === "42703" ||
    code === "PGRST202" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    details.includes("order_rounds") ||
    details.includes("add_staff_items_to_active_order") ||
    details.includes("order_version")
  );
}

function groupStaffActiveTableOrders(orders = []) {
  const tableGroups = new Map();

  (Array.isArray(orders) ? orders : []).forEach((order) => {
    const tableKey = String(order?.table_number || "").trim().toLowerCase();
    if (!tableKey) return;

    const existing = tableGroups.get(tableKey) || { order: null, activeRecordCount: 0 };
    const existingCreatedAtValue = new Date(existing.order?.created_at || 0).getTime();
    const nextCreatedAtValue = new Date(order?.created_at || 0).getTime();
    const existingCreatedAt = Number.isFinite(existingCreatedAtValue) ? existingCreatedAtValue : 0;
    const nextCreatedAt = Number.isFinite(nextCreatedAtValue) ? nextCreatedAtValue : 0;
    const existingId = String(existing.order?.id || "");
    const nextId = String(order?.id || "");
    const nextIsNewer =
      !existing.order ||
      nextCreatedAt > existingCreatedAt ||
      (nextCreatedAt === existingCreatedAt &&
        nextId.localeCompare(existingId, undefined, {
          numeric: true,
          sensitivity: "base"
        }) > 0);

    tableGroups.set(tableKey, {
      order: nextIsNewer ? order : existing.order,
      activeRecordCount: existing.activeRecordCount + 1
    });
  });

  return Array.from(tableGroups.values())
    .map(({ order, activeRecordCount }) => ({
      ...order,
      activeRecordCount
    }))
    .sort((firstOrder, secondOrder) => {
      const firstCreatedAtValue = new Date(firstOrder?.created_at || 0).getTime();
      const secondCreatedAtValue = new Date(secondOrder?.created_at || 0).getTime();
      const firstCreatedAt = Number.isFinite(firstCreatedAtValue) ? firstCreatedAtValue : 0;
      const secondCreatedAt = Number.isFinite(secondCreatedAtValue) ? secondCreatedAtValue : 0;

      if (firstCreatedAt !== secondCreatedAt) {
        return secondCreatedAt - firstCreatedAt;
      }

      return String(secondOrder?.id || "").localeCompare(
        String(firstOrder?.id || ""),
        undefined,
        { numeric: true, sensitivity: "base" }
      );
    });
}

function getStaffOrderCreatorColumns(staffUser = {}) {
  const createdByStaffId = normalizeOrderCreatedByStaffId(staffUser?.sub || staffUser?.id);
  return createdByStaffId ? { created_by_staff_id: createdByStaffId } : {};
}

function isMissingStaffAccessRelationError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();

  return (
    code === "42P01" ||
    code === "PGRST205" ||
    (details.includes("hotel_staff_access") &&
      (details.includes("relation") ||
        details.includes("schema cache") ||
        details.includes("could not find")))
  );
}

function isMissingContactSubmissionsRelationError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();

  return (
    code === "42P01" ||
    code === "PGRST205" ||
    (details.includes("contact_submissions") &&
      (details.includes("relation") ||
        details.includes("schema cache") ||
        details.includes("could not find")))
  );
}

function isMissingOrderSupportRequestsRelationError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();

  return (
    code === "42P01" ||
    code === "PGRST205" ||
    (details.includes("order_support_requests") &&
      (details.includes("relation") ||
        details.includes("schema cache") ||
        details.includes("could not find")))
  );
}

function isMissingTestimonialsRelationError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();

  return (
    code === "42P01" ||
    code === "PGRST205" ||
    (details.includes("testimonial") &&
      (details.includes("relation") ||
        details.includes("schema cache") ||
        details.includes("could not find")))
  );
}

function normalizeStatusValue(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeStaffText(value = "", maxLength = 120) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength)
    : "";
}

function getAllowedStaffStatus(value, allowedStatuses = []) {
  const normalizedStatus = normalizeStatusValue(value);
  return allowedStatuses.includes(normalizedStatus) ? normalizedStatus : "";
}

function normalizeBillNumberPart(value, fallback = "ORDER", maxLength = 18) {
  const normalizedValue = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return (normalizedValue || fallback).slice(0, maxLength);
}

function buildOrderBillNumber(order = {}, billedAt = new Date().toISOString()) {
  const hotelPart = normalizeBillNumberPart(
    order.hotel_slug || order.hotel_name,
    "HOTEL",
    18
  );
  const datePart = String(billedAt || new Date().toISOString())
    .slice(0, 10)
    .replace(/[^0-9]/g, "");
  const orderIdPart = String(order.id || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(-8);

  return [
    "BILL",
    hotelPart,
    datePart || "DATE",
    orderIdPart || "ORDER"
  ].join("-");
}

function isMissingOrderBillingColumnsError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();

  return (
    code === "PGRST204" ||
    (
      details.includes("could not find") &&
      ORDER_BILLING_COLUMNS.some((columnName) => details.includes(columnName))
    )
  );
}

function isMissingOrderTableContextColumnsError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();

  return (
    code === "PGRST204" ||
    (
      details.includes("could not find") &&
      ORDER_TABLE_CONTEXT_COLUMNS.some((columnName) => details.includes(columnName))
    )
  );
}

function isMissingOrderRoomServiceColumnsError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();

  return (
    code === "42703" ||
    code === "PGRST204" ||
    (
      details.includes("could not find") &&
      ORDER_ROOM_SERVICE_COLUMNS.some((columnName) => details.includes(columnName))
    ) ||
    ORDER_ROOM_SERVICE_COLUMNS.some((columnName) => details.includes(columnName))
  );
}

function isMissingRoomServiceSchemaError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();

  return (
    code === "42P01" ||
    code === "42703" ||
    code === "PGRST205" ||
    code === "PGRST204" ||
    details.includes("hotel_feature_settings") ||
    details.includes("enable_room_service") ||
    details.includes("room_bookings") ||
    details.includes("rooms")
  );
}

function isMissingOrderAddonMetadataColumnsError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();

  return (
    code === "PGRST204" ||
    (
      details.includes("could not find") &&
      ORDER_ADDON_METADATA_COLUMNS.some((columnName) => details.includes(columnName))
    )
  );
}

function isMissingOrderKitchenStatusColumnError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();

  return (
    code === "42703" ||
    code === "PGRST204" ||
    (
      details.includes("could not find") &&
      ORDER_KITCHEN_COLUMNS.some((columnName) => details.includes(columnName))
    ) ||
    details.includes("kitchen_status")
  );
}

async function fetchStaffOrderFamily({ hotelSlug, orderId }) {
  const { data: parentOrder, error: parentOrderError } = await supabase
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .eq("hotel_slug", hotelSlug)
    .maybeSingle();

  if (parentOrderError) throw parentOrderError;

  if (!parentOrder) {
    return {
      parentOrder: null,
      familyOrders: []
    };
  }

  if (parentOrder.parent_order_id) {
    return {
      parentOrder,
      familyOrders: []
    };
  }

  const { data: childOrders, error: childOrdersError } = await supabase
    .from("orders")
    .select("*")
    .eq("hotel_slug", hotelSlug)
    .eq("parent_order_id", String(orderId))
    .order("addon_sequence", { ascending: true })
    .order("created_at", { ascending: true });

  if (childOrdersError) throw childOrdersError;

  return {
    parentOrder,
    familyOrders: [parentOrder, ...(childOrders || [])]
  };
}

async function updateStaffOrderFamilyRecords({ familyOrders, buildUpdatePayload }) {
  const updatedOrders = [];

  for (const order of familyOrders) {
    const { data, error } = await supabase
      .from("orders")
      .update(buildUpdatePayload(order))
      .eq("id", order.id)
      .eq("hotel_slug", order.hotel_slug)
      .select()
      .single();

    if (error) throw error;
    updatedOrders.push(data);
  }

  return updatedOrders;
}

function getSafeJsonRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function buildStaffRouteTransferResponse(order = {}) {
  const paymentMetadata = getSafeJsonRecord(order.payment_metadata);
  const routeMetadata = getSafeJsonRecord(paymentMetadata.route);
  const transferStatus =
    order.gateway_transfer_status ||
    routeMetadata.transferStatus ||
    routeMetadata.transfer_status ||
    "";
  const settlementStatus =
    order.gateway_settlement_status ||
    routeMetadata.settlementStatus ||
    routeMetadata.settlement_status ||
    "";
  const transferId =
    order.gateway_transfer_id ||
    routeMetadata.transferId ||
    routeMetadata.transfer_id ||
    "";
  const transferError =
    order.gateway_transfer_error ||
    routeMetadata.transferError ||
    routeMetadata.transfer_error ||
    "";

  return {
    transferId,
    transferStatus,
    settlementStatus,
    transferError,
    transferRequested:
      !!routeMetadata.transferRequested ||
      !!routeMetadata.transferId ||
      !!transferId ||
      !!transferStatus,
    routeStatus: routeMetadata.routeStatus || "",
    routeReady: !!routeMetadata.routeReady
  };
}

function buildStaffUserResponse(staffAccess, features = null) {
  const role = normalizeStaffRole(staffAccess.role);
  const kdsRole = normalizeStaffKdsRole(staffAccess.kds_role, role);

  return {
    id: staffAccess.id,
    hotelSlug: staffAccess.hotel_slug,
    displayName: staffAccess.display_name || "Staff",
    role,
    isManager: isStaffManagerRole(role),
    kdsRole,
    features: normalizeHotelFeatureConfig(features || {}, staffAccess.hotel_slug)
  };
}

function buildStaffSessionResponse(staffUser = {}, features = null) {
  const role = normalizeStaffRole(staffUser.role);
  const kdsRole = normalizeStaffKdsRole(staffUser.kdsRole || staffUser.kds_role, role);

  return {
    id: staffUser.sub || staffUser.id || "",
    hotelSlug: staffUser.hotelSlug || staffUser.hotel_slug || "",
    displayName: staffUser.displayName || staffUser.display_name || "Staff",
    role,
    isManager: isStaffManagerRole(role),
    kdsRole,
    features: normalizeHotelFeatureConfig(
      features || staffUser.features || {},
      staffUser.hotelSlug || staffUser.hotel_slug
    )
  };
}

async function getStaffOrderHotelContext(hotelSlug) {
  const normalizedHotelSlug = normalizeStaffText(hotelSlug, 120);

  if (!normalizedHotelSlug) {
    return {
      error: "Staff hotel scope is missing"
    };
  }

  const { data, error } = await supabase
    .from("hotel_profiles")
    .select("hotel_slug,hotel_name,gst_percent")
    .eq("hotel_slug", normalizedHotelSlug)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    return {
      error: "Hotel profile not found"
    };
  }

  return { hotel: data };
}

async function getStaffAvailableMenuItemsById(hotelSlug, itemIds = []) {
  const { data, error } = await supabase
    .from("menu_items")
    .select("hotel_slug,item_id,name,price,item_type,category")
    .eq("hotel_slug", hotelSlug)
    .eq("is_available", true)
    .eq("is_archived", false)
    .in("item_id", itemIds);

  if (error) throw error;

  const eligibleItems = await filterEligibleMenuItems({ supabase, hotelSlug, consumer: "staff", menuItems: data || [] });
  return new Map(eligibleItems.map((item) => [String(item.item_id), item]));
}

async function fetchStaffRoomServiceFeatureSettings(hotelSlug = "") {
  const { data, error } = await supabase
    .from("hotel_feature_settings")
    .select("hotel_slug,enable_room_service")
    .eq("hotel_slug", hotelSlug)
    .maybeSingle();

  if (error) throw error;

  return {
    roomServiceEnabled: data?.enable_room_service === true
  };
}

async function fetchCheckedInRoomServiceBooking({ hotelSlug = "", roomBookingId }) {
  const { data: booking, error: bookingError } = await supabase
    .from("room_bookings")
    .select("*")
    .eq("id", roomBookingId)
    .eq("hotel_slug", hotelSlug)
    .maybeSingle();

  if (bookingError) throw bookingError;

  if (!booking) {
    return {
      error: "Room booking not found for this hotel",
      status: 404
    };
  }

  if (normalizeStatusValue(booking.booking_status) !== "checked_in") {
    return {
      error: "Room service orders can be linked only to a checked-in booking",
      status: 409
    };
  }

  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .select("id,hotel_slug,room_number,status,is_active")
    .eq("id", booking.room_id)
    .eq("hotel_slug", hotelSlug)
    .maybeSingle();

  if (roomError) throw roomError;

  if (!room) {
    return {
      error: "Room not found for this hotel",
      status: 404
    };
  }

  const roomStatus = normalizeStatusValue(room.status);
  if (room.is_active === false || roomStatus === "inactive" || roomStatus === "maintenance") {
    return {
      error: "This room cannot accept room service orders right now",
      status: 409
    };
  }

  return {
    booking,
    room
  };
}

async function calculateStaffTableOrderPricing({ hotelSlug, items }) {
  const hotelContext = await getStaffOrderHotelContext(hotelSlug);

  if (hotelContext.error) {
    return hotelContext;
  }

  const hotel = hotelContext.hotel;
  const uniqueItemIds = [...new Set((items || []).map((item) => String(item.id || "")))].filter(Boolean);
  const menuItemsById = await getStaffAvailableMenuItemsById(hotel.hotel_slug, uniqueItemIds);
  const missingItems = uniqueItemIds.filter((itemId) => !menuItemsById.has(itemId));

  if (missingItems.length) {
    return {
      error: `Some menu items are unavailable: ${missingItems.join(", ")}`
    };
  }

  const comboValidation = await validateRequestedMenuCombos({
    hotelSlug: hotel.hotel_slug,
    requestedItems: items || [],
    menuItemRows: Array.from(menuItemsById.values())
  });

  if (!comboValidation.ok) {
    return {
      error: comboValidation.error || "Some combo items are unavailable right now"
    };
  }

  const verifiedItems = await buildOrderItemSnapshots({
    hotelSlug: hotel.hotel_slug,
    requestedItems: items || [],
    menuItemRows: Array.from(menuItemsById.values())
  });
  const subtotal = verifiedItems.reduce((sum, item) => sum + item.lineTotal, 0);
  const gstPercent = Number(hotel.gst_percent || 5);
  const gst = Math.round((subtotal * gstPercent) / 100);
  const normalTotal = subtotal + gst;

  return {
    hotel,
    items: verifiedItems,
    totals: {
      subtotal,
      gst,
      deliveryCharge: 0,
      gstPercent,
      normalTotal,
      total: normalTotal
    }
  };
}

function getStaffMoneyValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function mergeStaffOrderAdditionTotals(existingTotals = {}, deltaTotals = {}) {
  const current = existingTotals && typeof existingTotals === "object" && !Array.isArray(existingTotals)
    ? existingTotals
    : {};
  const delta = deltaTotals && typeof deltaTotals === "object" && !Array.isArray(deltaTotals)
    ? deltaTotals
    : {};
  const merged = { ...current };
  const additiveKeys = ["subtotal", "gst", "normalTotal", "total"];
  const deltaGrandTotal = getStaffMoneyValue(delta.normalTotal ?? delta.total);

  additiveKeys.forEach((key) => {
    if (current[key] !== undefined || delta[key] !== undefined) {
      merged[key] = getStaffMoneyValue(current[key]) + getStaffMoneyValue(delta[key]);
    }
  });
  ["final", "gpayFinalTotal"].forEach((key) => {
    if (current[key] !== undefined) {
      merged[key] = getStaffMoneyValue(current[key]) + deltaGrandTotal;
    }
  });
  if (merged.normalTotal === undefined) {
    merged.normalTotal = getStaffMoneyValue(current.normalTotal) + getStaffMoneyValue(delta.normalTotal);
  }
  if (merged.total === undefined) merged.total = merged.normalTotal;
  merged.gstPercent = current.gstPercent ?? delta.gstPercent;
  merged.deliveryCharge = getStaffMoneyValue(current.deliveryCharge);
  merged.additionRounds = Math.max(1, Number(current.additionRounds || 1)) + 1;
  return merged;
}

function buildStaffOrderAdditionFingerprint({ orderId, tableNumber, items, note }) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ orderId: String(orderId), tableNumber, items, note: note || "" }))
    .digest("hex");
}

function normalizeStaffOrderRoundRpcResult(value = null) {
  if (Array.isArray(value)) return value[0] || null;
  return value && typeof value === "object" ? value : null;
}

function formatStaffOrderMoney(amount = 0) {
  return `Rs. ${Number(amount || 0).toFixed(2)}`;
}

function buildStaffTableOrderSummary({
  hotelName,
  tableNumber,
  staffUser,
  customerName,
  customerPhone,
  note,
  items,
  totals
}) {
  const lines = [
    `Staff Table Order - ${hotelName || "Hotel"}`,
    "----------------------",
    "Order Type: Dine-in",
    `Table: ${tableNumber}`,
    "Source: Staff",
    `Taken By: ${staffUser?.displayName || staffUser?.display_name || "Staff"}`
  ];

  if (customerName) {
    lines.push(`Guest: ${customerName}`);
  }

  if (customerPhone) {
    lines.push(`Phone: ${customerPhone}`);
  }

  lines.push("");
  (items || []).forEach((item) => {
    lines.push(`${item.name} x${item.qty} = ${formatStaffOrderMoney(item.price * item.qty)}`);
    const comboSummaryLine = buildComboSummaryLine(item);

    if (comboSummaryLine) {
      lines.push(comboSummaryLine);
    }
  });
  lines.push("");
  lines.push(`Subtotal = ${formatStaffOrderMoney(totals.subtotal)}`);
  lines.push(`GST = ${formatStaffOrderMoney(totals.gst)}`);
  lines.push(`Total = ${formatStaffOrderMoney(totals.normalTotal)}`);
  lines.push("Payment Status = Unpaid");
  lines.push("Billing Status = Not billed");

  if (note) {
    lines.push("");
    lines.push(`Note = ${note}`);
  }

  return lines.join("\n");
}

function buildStaffRoomServiceOrderSummary({
  hotelName,
  roomNumber,
  roomBookingId,
  staffUser,
  customerName,
  customerPhone,
  chargeToRoom,
  paymentMethod,
  note,
  items,
  totals
}) {
  const lines = [
    `Room Service Order - ${hotelName || "Hotel"}`,
    "----------------------",
    "Order Type: Room service",
    `Room: ${roomNumber || "Not provided"}`,
    `Room Booking: ${roomBookingId}`,
    `Taken By: ${staffUser?.displayName || staffUser?.display_name || "Staff"}`
  ];

  if (customerName) {
    lines.push(`Guest: ${customerName}`);
  }

  if (customerPhone) {
    lines.push(`Phone: ${customerPhone}`);
  }

  lines.push("");
  (items || []).forEach((item) => {
    lines.push(`${item.name} x${item.qty} = ${formatStaffOrderMoney(item.price * item.qty)}`);
    const comboSummaryLine = buildComboSummaryLine(item);

    if (comboSummaryLine) {
      lines.push(comboSummaryLine);
    }
  });
  lines.push("");
  lines.push(`Subtotal = ${formatStaffOrderMoney(totals.subtotal)}`);
  lines.push(`GST = ${formatStaffOrderMoney(totals.gst)}`);
  lines.push(`Total = ${formatStaffOrderMoney(totals.normalTotal)}`);
  lines.push(`Payment Method = ${paymentMethod}`);
  lines.push(`Charge To Room = ${chargeToRoom ? "Yes" : "No"}`);
  lines.push("Payment Status = Unpaid");
  lines.push("Billing Status = Not billed");

  if (note) {
    lines.push("");
    lines.push(`Note = ${note}`);
  }

  return lines.join("\n");
}

async function insertStaffTableOrderRow(baseOrderRow, optionalOrderColumns) {
  let currentOptionalOrderColumns = { ...optionalOrderColumns };
  let insertAttempt = await supabase
    .from("orders")
    .insert([{ ...baseOrderRow, ...currentOptionalOrderColumns }])
    .select()
    .single();

  if (insertAttempt.error && isMissingOrderTrackingColumnsError(insertAttempt.error)) {
    const { tracking_token, tracking_token_created_at, ...columnsWithoutTracking } =
      currentOptionalOrderColumns;
    currentOptionalOrderColumns = columnsWithoutTracking;
    insertAttempt = await supabase
      .from("orders")
      .insert([{ ...baseOrderRow, ...currentOptionalOrderColumns }])
      .select()
      .single();
  }

  if (
    insertAttempt.error &&
    isMissingOrderStaffAttributionColumnsError(insertAttempt.error)
  ) {
    const { created_by_staff_id, ...columnsWithoutStaffAttribution } =
      currentOptionalOrderColumns;
    currentOptionalOrderColumns = columnsWithoutStaffAttribution;
    insertAttempt = await supabase
      .from("orders")
      .insert([{ ...baseOrderRow, ...currentOptionalOrderColumns }])
      .select()
      .single();
  }

  return insertAttempt;
}

function isMissingStaffActiveTableOrderGuard(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();

  return (
    code === "42883" ||
    code === "PGRST202" ||
    details.includes("create_staff_table_order_if_available") ||
    details.includes("get_staff_active_table_order")
  );
}

function normalizeStaffActiveTableOrderResult(value = null) {
  if (Array.isArray(value)) {
    return value[0] || null;
  }

  return value && typeof value === "object" ? value : null;
}

async function fetchStaffActiveTableOrder({ hotelSlug, tableNumber }) {
  const { data, error } = await supabase.rpc("get_staff_active_table_order", {
    p_hotel_slug: hotelSlug,
    p_table_number: tableNumber
  });

  return {
    data: normalizeStaffActiveTableOrderResult(data),
    error
  };
}

async function insertStaffTableOrderWithActiveTableGuard(baseOrderRow, optionalOrderColumns) {
  const orderPayload = {
    ...baseOrderRow,
    ...optionalOrderColumns
  };
  const { data, error } = await supabase.rpc("create_staff_table_order_if_available", {
    p_order: orderPayload
  });

  if (error) {
    return { data: null, error, conflict: null };
  }

  const result = normalizeStaffActiveTableOrderResult(data);

  if (!result || result.created !== true || !result.order) {
    return {
      data: null,
      error: null,
      conflict: result?.activeOrder || null
    };
  }

  return {
    data: result.order,
    error: null,
    conflict: null
  };
}

function getStaffOrdersRange(value = "") {
  const normalizedRange = String(value || "").trim().toLowerCase();
  return STAFF_ORDER_RANGES.includes(normalizedRange) ? normalizedRange : "recent";
}

function getStaffOrdersLimit(value, range = "recent") {
  const parsedLimit = Number.parseInt(String(value || "").trim(), 10);
  const defaultLimit = range === "all" ? STAFF_ORDERS_MAX_LIMIT : STAFF_ORDERS_DEFAULT_LIMIT;

  if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
    return defaultLimit;
  }

  return Math.min(parsedLimit, STAFF_ORDERS_MAX_LIMIT);
}

function getStaffOrdersRangeStart(range) {
  const now = new Date();

  if (range === "today") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  if (range === "week") {
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - 7);
    return weekStart;
  }

  if (range === "month") {
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }

  return null;
}

function parseStaffReportDate(value = "") {
  const normalizedValue = String(value || "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedValue)) {
    return null;
  }

  const parsedDate = new Date(`${normalizedValue}T00:00:00.000Z`);
  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
}

function getStaffReportPeriod(query = {}) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(todayStart.getDate() + 1);
  const normalizedRange = String(query.range || "month").trim().toLowerCase();
  const month = Number.parseInt(String(query.month || "").trim(), 10);
  const year = Number.parseInt(String(query.year || "").trim(), 10);
  let fromDate = null;
  let toDate = null;
  let label = "Current month";
  let range = "month";

  if (normalizedRange === "today") {
    fromDate = todayStart;
    toDate = tomorrowStart;
    label = "Today";
    range = "today";
  } else if (normalizedRange === "yesterday") {
    toDate = todayStart;
    fromDate = new Date(todayStart);
    fromDate.setDate(todayStart.getDate() - 1);
    label = "Yesterday";
    range = "yesterday";
  } else if (normalizedRange === "week") {
    fromDate = new Date(todayStart);
    fromDate.setDate(todayStart.getDate() - 6);
    toDate = tomorrowStart;
    label = "Current week";
    range = "week";
  } else if (normalizedRange === "last_month") {
    fromDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    toDate = new Date(now.getFullYear(), now.getMonth(), 1);
    label = "Last month";
    range = "last_month";
  } else if (normalizedRange === "all") {
    label = "All time";
    range = "all";
  } else if (normalizedRange === "custom") {
    fromDate = parseStaffReportDate(query.fromDate || query.from_date);
    const parsedToDate = parseStaffReportDate(query.toDate || query.to_date);

    if (!fromDate || !parsedToDate || parsedToDate < fromDate) {
      return {
        ok: false,
        message: "Valid fromDate and toDate are required for custom reports"
      };
    }

    toDate = new Date(parsedToDate);
    toDate.setDate(toDate.getDate() + 1);
    label = "Custom range";
    range = "custom";
  } else if (
    Number.isInteger(month) &&
    month >= 1 &&
    month <= 12 &&
    Number.isInteger(year) &&
    year >= 2000 &&
    year <= 2100
  ) {
    fromDate = new Date(year, month - 1, 1);
    toDate = new Date(year, month, 1);
    label = `${year}-${String(month).padStart(2, "0")}`;
    range = "month";
  } else {
    fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
    toDate = tomorrowStart;
  }

  return {
    ok: true,
    range,
    label,
    fromDate,
    toDate,
    from: fromDate ? fromDate.toISOString() : "",
    to: toDate ? toDate.toISOString() : "",
    generatedAt: new Date().toISOString()
  };
}

function getStaffNumberValue(value) {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

function getStaffOrderItemsSubtotal(order = {}) {
  return Array.isArray(order.items)
    ? order.items.reduce((sum, item) => {
      const quantity = getStaffNumberValue(item?.qty) || 0;
      const price = getStaffNumberValue(item?.price) || 0;
      return sum + quantity * price;
    }, 0)
    : 0;
}

function getStaffOrderTotalAmount(order = {}) {
  const totals =
    order.totals && typeof order.totals === "object" && !Array.isArray(order.totals)
      ? order.totals
      : {};

  return (
    getStaffNumberValue(totals.gpayFinalTotal) ??
    getStaffNumberValue(totals.final) ??
    getStaffNumberValue(totals.total) ??
    getStaffNumberValue(totals.normalTotal) ??
    getStaffOrderItemsSubtotal(order)
  );
}

function getStaffOrderReportSourceKey(order = {}) {
  const source = normalizeStatusValue(order.order_source);
  const orderType = normalizeStatusValue(order.order_type);
  const tableNumber = String(order.table_number || "").trim();
  const isQrTableOrder =
    Boolean(tableNumber) ||
    orderType === "dine-in" ||
    source === "qr" ||
    source === "table" ||
    source === "dine-in";

  return isQrTableOrder ? "qr-table" : "website";
}

function createStaffOrdersSummary() {
  return {
    totalOrders: 0,
    totalEarnings: 0,
    paidOrders: 0,
    unpaidOrders: 0,
    paidEarnings: 0,
    unpaidEarnings: 0,
    billedOrders: 0,
    unbilledOrders: 0,
    qrOrders: 0,
    websiteOrders: 0,
    qrEarnings: 0,
    websiteEarnings: 0
  };
}

function addStaffOrderToSummary(summary, order = {}) {
  const total = getStaffOrderTotalAmount(order);
  const paymentStatus = normalizeStatusValue(order.payment_status);
  const billingStatus = normalizeStatusValue(order.billing_status);
  const sourceKey = getStaffOrderReportSourceKey(order);

  summary.totalOrders += 1;
  summary.totalEarnings += total;

  if (paymentStatus === "paid") {
    summary.paidOrders += 1;
    summary.paidEarnings += total;
  } else {
    summary.unpaidOrders += 1;
    summary.unpaidEarnings += total;
  }

  if (billingStatus === "billed") {
    summary.billedOrders += 1;
  } else {
    summary.unbilledOrders += 1;
  }

  if (sourceKey === "qr-table") {
    summary.qrOrders += 1;
    summary.qrEarnings += total;
  } else {
    summary.websiteOrders += 1;
    summary.websiteEarnings += total;
  }

  return summary;
}

function getStaffOperationalReportStarts(
  now = new Date(),
  timeZone = process.env.APP_TIMEZONE || DEFAULT_STAFF_REPORT_TIME_ZONE
) {
  const normalizedTimeZone = normalizeStaffReportTimeZone(timeZone);
  const todayKey = getZonedDateKey(now, normalizedTimeZone);
  const monthKey = `${todayKey.slice(0, 7)}-01`;
  const trendPeriod = getStaffTrendPeriod({ now, timeZone: normalizedTimeZone });
  const todayStart = getZonedDayStart(todayKey, normalizedTimeZone);
  const weekStart = getZonedDayStart(addCalendarDays(todayKey, -6), normalizedTimeZone);
  const monthStart = getZonedDayStart(monthKey, normalizedTimeZone);
  const trendStart = trendPeriod.queryStart;

  return {
    todayStart,
    weekStart,
    monthStart,
    trendPeriod,
    timeZone: normalizedTimeZone,
    earliestStart: [weekStart, monthStart, trendStart]
      .filter(Boolean)
      .sort((left, right) => left.getTime() - right.getTime())[0]
  };
}

async function fetchStaffOrdersForReports({ hotelSlug, startDate }) {
  const orders = [];
  let from = 0;

  while (true) {
    let query = supabase
      .from("orders")
      .select("id, status, order_type, table_number, order_source, payment_status, billing_status, items, totals, created_at")
      .eq("hotel_slug", hotelSlug)
      .order("created_at", { ascending: false })
      .range(from, from + STAFF_REPORT_BATCH_SIZE - 1);

    if (startDate) {
      query = query.gte("created_at", startDate.toISOString());
    }

    const { data, error } = await query;

    if (error) throw error;

    const batch = Array.isArray(data) ? data : [];
    orders.push(...batch);

    if (batch.length < STAFF_REPORT_BATCH_SIZE) {
      break;
    }

    from += STAFF_REPORT_BATCH_SIZE;
  }

  return orders;
}

async function fetchStaffOrdersForBusinessReport({ hotelSlug, period }) {
  const orders = [];
  let from = 0;

  while (orders.length < STAFF_BUSINESS_REPORT_MAX_ORDERS) {
    let query = supabase
      .from("orders")
      .select("id,hotel_slug,hotel_name,order_type,table_number,order_source,status,payment_method,payment_status,billing_status,items,totals,note,created_at,customer_name,customer_phone,created_by_staff_id")
      .eq("hotel_slug", hotelSlug)
      .order("created_at", { ascending: false })
      .range(from, from + STAFF_REPORT_BATCH_SIZE - 1);

    if (period?.fromDate) {
      query = query.gte("created_at", period.fromDate.toISOString());
    }

    if (period?.toDate) {
      query = query.lt("created_at", period.toDate.toISOString());
    }

    const { data, error } = await query;

    if (error) throw error;

    const batch = Array.isArray(data) ? data : [];
    orders.push(...batch);

    if (batch.length < STAFF_REPORT_BATCH_SIZE) {
      break;
    }

    from += STAFF_REPORT_BATCH_SIZE;
  }

  return {
    orders: orders.slice(0, STAFF_BUSINESS_REPORT_MAX_ORDERS),
    truncated: orders.length >= STAFF_BUSINESS_REPORT_MAX_ORDERS
  };
}

function buildStaffOperationalReports(orders = [], starts = getStaffOperationalReportStarts()) {
  const reports = {
    today: createStaffOrdersSummary(),
    week: createStaffOrdersSummary(),
    month: createStaffOrdersSummary()
  };

  orders.forEach((order) => {
    const createdAtValue = order?.created_at ? new Date(order.created_at) : null;
    if (!createdAtValue || Number.isNaN(createdAtValue.getTime())) return;

    if (createdAtValue >= starts.todayStart) {
      addStaffOrderToSummary(reports.today, order);
    }

    if (createdAtValue >= starts.weekStart) {
      addStaffOrderToSummary(reports.week, order);
    }

    if (createdAtValue >= starts.monthStart) {
      addStaffOrderToSummary(reports.month, order);
    }
  });

  return reports;
}

function normalizeStaffItemId(item = {}) {
  return String(item?.id || item?.itemId || item?.item_id || "")
    .trim()
    .slice(0, 120);
}

function normalizeStaffItemName(item = {}, fallback = "Unnamed item") {
  const name = String(item?.name || item?.itemName || item?.item_name || "")
    .trim()
    .slice(0, 160);

  return name || fallback;
}

function getStaffItemQuantity(item = {}) {
  const quantity =
    getStaffNumberValue(item?.qty) ??
    getStaffNumberValue(item?.quantity) ??
    0;

  return quantity > 0 ? quantity : 0;
}

function getStaffItemRevenue(item = {}) {
  const explicitLineTotal = getStaffNumberValue(item?.lineTotal);

  if (explicitLineTotal !== null && explicitLineTotal >= 0) {
    return explicitLineTotal;
  }

  const quantity = getStaffItemQuantity(item);
  const price = getStaffNumberValue(item?.price) || 0;
  return quantity * price;
}

function createStaffItemSalesSummary() {
  return {
    totalDistinctItems: 0,
    totalUnitsSold: 0,
    totalRevenue: 0,
    topItems: [],
    lowItems: []
  };
}

function addStaffOrderItemsToSalesMap(itemsMap, order = {}) {
  if (!(itemsMap instanceof Map) || !Array.isArray(order.items)) {
    return itemsMap;
  }

  const orderId = String(order.id || "").trim();
  const createdAt = String(order.created_at || "").trim();
  const sourceKey = getStaffOrderReportSourceKey(order);

  order.items.forEach((item) => {
    const itemId = normalizeStaffItemId(item);
    const itemName = normalizeStaffItemName(item, itemId || "Unnamed item");
    const quantity = getStaffItemQuantity(item);
    const revenue = getStaffItemRevenue(item);

    if (!itemId || !itemName || quantity <= 0) {
      return;
    }

    const existing = itemsMap.get(itemId) || {
      itemId,
      itemName,
      quantitySold: 0,
      revenue: 0,
      orderCount: 0,
      qrOrders: 0,
      websiteOrders: 0,
      qrRevenue: 0,
      websiteRevenue: 0,
      lastOrderedAt: "",
      orderIds: new Set()
    };

    existing.quantitySold += quantity;
    existing.revenue += revenue;

    if (sourceKey === "qr-table") {
      existing.qrOrders += 1;
      existing.qrRevenue += revenue;
    } else {
      existing.websiteOrders += 1;
      existing.websiteRevenue += revenue;
    }

    if (orderId && !existing.orderIds.has(orderId)) {
      existing.orderIds.add(orderId);
      existing.orderCount += 1;
    }

    if (createdAt && (!existing.lastOrderedAt || createdAt > existing.lastOrderedAt)) {
      existing.lastOrderedAt = createdAt;
    }

    itemsMap.set(itemId, existing);
  });

  return itemsMap;
}

function finalizeStaffItemSalesEntries(itemsMap) {
  if (!(itemsMap instanceof Map)) {
    return [];
  }

  return [...itemsMap.values()]
    .map((entry) => ({
      itemId: entry.itemId,
      itemName: entry.itemName,
      quantitySold: entry.quantitySold,
      revenue: entry.revenue,
      orderCount: entry.orderCount,
      qrOrders: entry.qrOrders,
      websiteOrders: entry.websiteOrders,
      qrRevenue: entry.qrRevenue,
      websiteRevenue: entry.websiteRevenue,
      lastOrderedAt: entry.lastOrderedAt || ""
    }))
    .filter((entry) => entry.itemId && entry.quantitySold > 0);
}

function sortStaffTopSellingItems(entries = []) {
  return [...entries].sort((left, right) => (
    right.quantitySold - left.quantitySold ||
    right.revenue - left.revenue ||
    right.orderCount - left.orderCount ||
    left.itemName.localeCompare(right.itemName)
  ));
}

function sortStaffLowSellingItems(entries = []) {
  return [...entries].sort((left, right) => (
    left.quantitySold - right.quantitySold ||
    left.revenue - right.revenue ||
    left.orderCount - right.orderCount ||
    left.itemName.localeCompare(right.itemName)
  ));
}

function buildStaffItemSalesSummary(orders = []) {
  const itemsMap = new Map();

  orders.forEach((order) => {
    addStaffOrderItemsToSalesMap(itemsMap, order);
  });

  const entries = finalizeStaffItemSalesEntries(itemsMap);
  const topItems = sortStaffTopSellingItems(entries).slice(0, STAFF_ITEM_REPORT_LIMIT);
  const lowItems = sortStaffLowSellingItems(entries).slice(0, STAFF_ITEM_REPORT_LIMIT);

  return {
    totalDistinctItems: entries.length,
    totalUnitsSold: entries.reduce((sum, entry) => sum + entry.quantitySold, 0),
    totalRevenue: entries.reduce((sum, entry) => sum + entry.revenue, 0),
    topItems,
    lowItems
  };
}

function buildStaffCategorySalesSummary(orders = []) {
  const categoryMap = new Map();
  (Array.isArray(orders) ? orders : []).forEach((order) => {
    const seenInOrder = new Set();
    (Array.isArray(order?.items) ? order.items : []).forEach((item) => {
      const categoryKey = String(item?.category || "uncategorized").trim() || "uncategorized";
      const categoryName = String(item?.categoryName || item?.category || "Uncategorized").trim();
      const entry = categoryMap.get(categoryKey) || {
        categoryKey,
        categoryName,
        quantitySold: 0,
        revenue: 0,
        orderCount: 0
      };
      entry.quantitySold += getStaffItemQuantity(item);
      entry.revenue += getStaffItemRevenue(item);
      if (!seenInOrder.has(categoryKey)) {
        entry.orderCount += 1;
        seenInOrder.add(categoryKey);
      }
      categoryMap.set(categoryKey, entry);
    });
  });
  return [...categoryMap.values()].sort((left, right) =>
    right.revenue - left.revenue ||
    right.quantitySold - left.quantitySold ||
    left.categoryName.localeCompare(right.categoryName)
  );
}

function buildStaffItemSalesReports(orders = [], starts = getStaffOperationalReportStarts()) {
  const periods = {
    today: [],
    week: [],
    month: []
  };

  orders.forEach((order) => {
    const createdAtValue = order?.created_at ? new Date(order.created_at) : null;
    if (!createdAtValue || Number.isNaN(createdAtValue.getTime())) return;

    if (createdAtValue >= starts.todayStart) {
      periods.today.push(order);
    }

    if (createdAtValue >= starts.weekStart) {
      periods.week.push(order);
    }

    if (createdAtValue >= starts.monthStart) {
      periods.month.push(order);
    }
  });

  return {
    today: buildStaffItemSalesSummary(periods.today),
    week: buildStaffItemSalesSummary(periods.week),
    month: buildStaffItemSalesSummary(periods.month),
    basis: {
      reportLimit: STAFF_ITEM_REPORT_LIMIT,
      lowItemsMeaning:
        "Low-selling items are ranked only among items that were sold in the selected report window."
    }
  };
}

function incrementStaffReportGroup(map, key, amount = 0) {
  const normalizedKey = String(key || "unknown").trim().toLowerCase() || "unknown";
  const existing = map.get(normalizedKey) || {
    key: normalizedKey,
    label: normalizedKey,
    orders: 0,
    revenue: 0,
    cancellations: 0
  };

  existing.orders += 1;
  existing.revenue += amount;
  map.set(normalizedKey, existing);
  return existing;
}

function finalizeStaffReportGroups(map, limit = 10) {
  return [...map.values()]
    .map((entry) => ({
      ...entry,
      averageValue: entry.orders ? entry.revenue / entry.orders : 0
    }))
    .sort((left, right) => (
      right.revenue - left.revenue ||
      right.orders - left.orders ||
      left.label.localeCompare(right.label)
    ))
    .slice(0, limit);
}

function maskStaffReportPhone(value = "") {
  const digits = String(value || "").replace(/\D/g, "");

  if (digits.length < 4) {
    return "";
  }

  return `${"*".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

function getStaffBusinessOrderSourceLabel(order = {}) {
  const source = normalizeStatusValue(order.order_source);

  if (source === "staff") return "Staff-assisted";
  if (source === "room_service" || source === "room-service") return "Room Service";
  if (source === "qr") return "QR";
  if (source === "whatsapp") return "WhatsApp";
  if (source === "online" || source === "website") return "Website";
  if (String(order.table_number || "").trim()) return "Table";

  return source || "Website";
}

function getStaffOrderTotalsValue(order = {}, keys = []) {
  const totals = order?.totals && typeof order.totals === "object" && !Array.isArray(order.totals)
    ? order.totals
    : {};

  for (const key of keys) {
    const value = getStaffNumberValue(totals[key]);
    if (value !== null) return Math.max(0, value);
  }

  return 0;
}

function buildStaffDailySalesBreakdown(orders = []) {
  const dailyMap = new Map();

  orders.forEach((order) => {
    const dateKey = String(order.created_at || "").slice(0, 10);
    if (!dateKey) return;

    const total = getStaffOrderTotalAmount(order);
    const existing = dailyMap.get(dateKey) || {
      date: dateKey,
      orders: 0,
      revenue: 0,
      paidRevenue: 0
    };

    existing.orders += 1;
    existing.revenue += total;

    if (normalizeStatusValue(order.payment_status) === "paid") {
      existing.paidRevenue += total;
    }

    dailyMap.set(dateKey, existing);
  });

  return [...dailyMap.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function buildStaffCustomerReport(orders = []) {
  const customerMap = new Map();

  orders.forEach((order) => {
    const name = normalizeStaffText(order.customer_name, 120);
    const phone = normalizeStaffText(order.customer_phone, 40);
    const key = phone || name;

    if (!key) return;

    const total = getStaffOrderTotalAmount(order);
    const existing = customerMap.get(key) || {
      customerName: name || "Guest",
      phoneMasked: maskStaffReportPhone(phone),
      totalOrders: 0,
      totalSpend: 0,
      lastOrderAt: ""
    };

    existing.totalOrders += 1;
    existing.totalSpend += total;

    if (order.created_at && (!existing.lastOrderAt || order.created_at > existing.lastOrderAt)) {
      existing.lastOrderAt = order.created_at;
    }

    customerMap.set(key, existing);
  });

  const customers = [...customerMap.values()].sort((left, right) => (
    right.totalSpend - left.totalSpend ||
    right.totalOrders - left.totalOrders ||
    left.customerName.localeCompare(right.customerName)
  ));

  return {
    totalKnownCustomers: customers.length,
    repeatCustomers: customers.filter((customer) => customer.totalOrders > 1).length,
    newCustomers: customers.filter((customer) => customer.totalOrders === 1).length,
    topCustomers: customers.slice(0, STAFF_BUSINESS_REPORT_CUSTOMER_LIMIT)
  };
}

function buildStaffPerformanceReport(orders = [], staffById = new Map()) {
  const staffMap = new Map();

  orders.forEach((order) => {
    const staff = getOrderCreatedByStaffResponse(order, staffById);
    const staffId = staff?.id || "unassigned";
    const total = getStaffOrderTotalAmount(order);
    const existing = staffMap.get(staffId) || {
      staffId,
      staffName: staff?.displayName || "Unassigned",
      role: staff?.role || "",
      ordersTaken: 0,
      totalSales: 0,
      cancelledOrders: 0,
      tableOrders: 0,
      averageOrderValue: 0
    };

    existing.ordersTaken += 1;
    existing.totalSales += total;

    if (normalizeStatusValue(order.status) === "cancelled") {
      existing.cancelledOrders += 1;
    }

    if (String(order.table_number || "").trim() || normalizeStatusValue(order.order_type) === "dine-in") {
      existing.tableOrders += 1;
    }

    existing.averageOrderValue = existing.ordersTaken
      ? existing.totalSales / existing.ordersTaken
      : 0;
    staffMap.set(staffId, existing);
  });

  return [...staffMap.values()]
    .sort((left, right) => (
      right.totalSales - left.totalSales ||
      right.ordersTaken - left.ordersTaken ||
      left.staffName.localeCompare(right.staffName)
    ))
    .slice(0, STAFF_BUSINESS_REPORT_STAFF_LIMIT);
}

function buildStaffBusinessReport({ hotelSlug, orders = [], staffById = new Map(), period, truncated = false }) {
  const summary = {
    totalOrders: 0,
    totalRevenue: 0,
    grossRevenue: 0,
    netRevenue: 0,
    paidRevenue: 0,
    unpaidAmount: 0,
    refunds: 0,
    discounts: 0,
    taxes: 0,
    roomServiceRevenue: 0,
    paidOrders: 0,
    unpaidOrders: 0,
    cancelledOrders: 0,
    averageOrderValue: 0,
    highestOrderValue: 0
  };
  const paymentStatusMap = new Map();
  const paymentMethodMap = new Map();
  const sourceMap = new Map();
  const tableMap = new Map();
  const orderStatusMap = new Map();
  const cancellationRows = [];
  let recognizedOrderCount = 0;

  orders.forEach((order) => {
    const total = getStaffOrderTotalAmount(order);
    const paymentStatus = normalizeStatusValue(order.payment_status) || "unpaid";
    const paymentMethod = normalizeStatusValue(order.payment_method) || "not_provided";
    const orderStatus = normalizeStatusValue(order.status) || "new";
    const sourceLabel = getStaffBusinessOrderSourceLabel(order);
    const tableNumber = normalizeStaffText(order.table_number, 80);
    const isCancelled = orderStatus === "cancelled";
    const isRefunded = paymentStatus === "refunded";
    const recognizedRevenue = isCancelled || isRefunded ? 0 : total;
    const discounts = getStaffOrderTotalsValue(order, ["gpayDiscount", "discount", "discountAmount"]);
    const taxes = getStaffOrderTotalsValue(order, ["gst", "tax", "taxAmount"]);

    summary.totalOrders += 1;
    if (!isCancelled && !isRefunded) recognizedOrderCount += 1;
    summary.grossRevenue += isCancelled ? 0 : total;
    summary.refunds += isRefunded ? total : 0;
    summary.discounts += isCancelled ? 0 : discounts;
    summary.taxes += isCancelled ? 0 : taxes;
    summary.totalRevenue += recognizedRevenue;
    summary.highestOrderValue = Math.max(summary.highestOrderValue, total);

    if (sourceLabel === "Room Service") {
      summary.roomServiceRevenue += recognizedRevenue;
    }

    if (paymentStatus === "paid" && !isCancelled) {
      summary.paidOrders += 1;
      summary.paidRevenue += recognizedRevenue;
    } else if (!isCancelled && !isRefunded) {
      summary.unpaidOrders += 1;
      summary.unpaidAmount += recognizedRevenue;
    }

    if (isCancelled) {
      summary.cancelledOrders += 1;
      cancellationRows.push({
        orderId: String(order.id || ""),
        source: sourceLabel,
        amount: total,
        createdAt: order.created_at || "",
        reason: normalizeStaffText(order.note, 240) || "Not recorded"
      });
    }

    incrementStaffReportGroup(paymentStatusMap, paymentStatus, recognizedRevenue).label = paymentStatus;
    incrementStaffReportGroup(paymentMethodMap, paymentMethod, recognizedRevenue).label = paymentMethod;
    const sourceGroup = incrementStaffReportGroup(sourceMap, sourceLabel, recognizedRevenue);
    sourceGroup.label = sourceLabel;
    if (isCancelled) sourceGroup.cancellations += 1;
    incrementStaffReportGroup(orderStatusMap, orderStatus, recognizedRevenue).label = orderStatus;

    if (tableNumber) {
      incrementStaffReportGroup(tableMap, tableNumber, recognizedRevenue).label = tableNumber;
    }
  });

  summary.netRevenue = Math.max(0, summary.grossRevenue - summary.refunds);
  summary.totalRevenue = summary.netRevenue;

  summary.averageOrderValue = recognizedOrderCount
    ? summary.totalRevenue / recognizedOrderCount
    : 0;

  const revenueOrders = orders.filter((order) => {
    const status = normalizeStatusValue(order.status);
    const paymentStatus = normalizeStatusValue(order.payment_status);
    return status !== "cancelled" && paymentStatus !== "refunded";
  });
  const itemSales = buildStaffItemSalesSummary(revenueOrders);
  const categorySales = buildStaffCategorySalesSummary(revenueOrders);
  const comboOrders = revenueOrders.filter((order) =>
    Array.isArray(order.items) &&
    order.items.some((item) => String(item?.itemType || "single").trim() === "combo")
  );
  const comboSales = buildStaffItemSalesSummary(comboOrders);
  const hotelName =
    orders.find((order) => normalizeStaffText(order.hotel_name, 160))?.hotel_name ||
    hotelSlug;

  return {
    hotelSlug,
    hotelName,
    period: {
      range: period.range,
      label: period.label,
      from: period.from,
      to: period.to,
      generatedAt: period.generatedAt
    },
    basis: {
      orderCount: orders.length,
      maxOrders: STAFF_BUSINESS_REPORT_MAX_ORDERS,
      truncated
    },
    summary,
    dailySales: buildStaffDailySalesBreakdown(revenueOrders),
    items: {
      totalDistinctItems: itemSales.totalDistinctItems,
      totalUnitsSold: itemSales.totalUnitsSold,
      totalRevenue: itemSales.totalRevenue,
      topItems: itemSales.topItems.slice(0, STAFF_BUSINESS_REPORT_ITEM_LIMIT),
      lowItems: itemSales.lowItems.slice(0, STAFF_BUSINESS_REPORT_ITEM_LIMIT)
    },
    categories: categorySales,
    customers: buildStaffCustomerReport(revenueOrders),
    staffPerformance: buildStaffPerformanceReport(orders, staffById),
    payments: {
      byStatus: finalizeStaffReportGroups(paymentStatusMap, 20),
      byMethod: finalizeStaffReportGroups(paymentMethodMap, 20)
    },
    orderSources: finalizeStaffReportGroups(sourceMap, 20),
    orderStatuses: finalizeStaffReportGroups(orderStatusMap, 20),
    cancellations: cancellationRows.slice(0, 100),
    tables: finalizeStaffReportGroups(tableMap, STAFF_BUSINESS_REPORT_TABLE_LIMIT),
    combos: {
      totalComboOrders: comboOrders.length,
      totalDistinctCombos: comboSales.totalDistinctItems,
      totalComboUnitsSold: comboSales.totalUnitsSold,
      totalComboRevenue: comboSales.totalRevenue,
      topCombos: comboSales.topItems.slice(0, STAFF_BUSINESS_REPORT_ITEM_LIMIT),
      lowCombos: comboSales.lowItems.slice(0, STAFF_BUSINESS_REPORT_ITEM_LIMIT)
    },
    recommendations: buildStaffBusinessReportRecommendations({ summary, itemSales, comboSales })
  };
}

function buildStaffBusinessReportRecommendations({ summary = {}, itemSales = {}, comboSales = {} } = {}) {
  const recommendations = [];
  const topItem = Array.isArray(itemSales.topItems) ? itemSales.topItems[0] : null;
  const lowItem = Array.isArray(itemSales.lowItems) ? itemSales.lowItems[0] : null;
  const topCombo = Array.isArray(comboSales.topItems) ? comboSales.topItems[0] : null;

  if (topItem?.itemName) {
    recommendations.push(`${topItem.itemName} is the strongest seller in this report window.`);
  }

  if (lowItem?.itemName && lowItem.itemId !== topItem?.itemId) {
    recommendations.push(`${lowItem.itemName} is a low-selling sold item. Consider promotion, combo placement, or temporary menu review.`);
  }

  if (Number(summary.unpaidAmount || 0) > 0) {
    recommendations.push(`Review pending collections worth ${summary.unpaidAmount.toFixed(2)}.`);
  }

  if (topCombo?.itemName) {
    recommendations.push(`${topCombo.itemName} is the leading combo offer in this report window.`);
  }

  if (!recommendations.length) {
    recommendations.push("Reports are ready, but this period needs more order activity before strong recommendations appear.");
  }

  return recommendations;
}

function getStaffReportDateKey(value = "") {
  const normalized = String(value || "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : "";
}

function getStaffReportDateMs(value = "") {
  const dateKey = getStaffReportDateKey(value);
  return dateKey ? Date.parse(`${dateKey}T00:00:00.000Z`) : Number.NaN;
}

function getStaffRoomOverlapNights(booking = {}, fromDate = "", toDate = "") {
  return calculateOverlappingRoomNights({
    checkInDate: booking.check_in_date,
    checkOutDate: booking.check_out_date,
    fromDate,
    toDate
  });
}

function getStaffRoomReportRange(period = {}, bookings = []) {
  let fromDate = getStaffReportDateKey(period.from);
  let toDate = getStaffReportDateKey(period.to);

  if (!fromDate) {
    fromDate = (bookings || [])
      .map((booking) => getStaffReportDateKey(booking.check_in_date))
      .filter(Boolean)
      .sort()[0] || getStaffReportDateKey(new Date().toISOString());
  }

  if (!toDate) {
    const latestCheckout = (bookings || [])
      .map((booking) => getStaffReportDateKey(booking.check_out_date))
      .filter(Boolean)
      .sort()
      .pop();
    toDate = latestCheckout || getStaffReportDateKey(new Date(Date.now() + 86400000).toISOString());
  }

  if (getStaffReportDateMs(toDate) <= getStaffReportDateMs(fromDate)) {
    toDate = getStaffReportDateKey(new Date(getStaffReportDateMs(fromDate) + 86400000).toISOString());
  }

  return {
    fromDate,
    toDate,
    totalDays: Math.max(1, Math.round((getStaffReportDateMs(toDate) - getStaffReportDateMs(fromDate)) / 86400000))
  };
}

async function fetchStaffRoomReportData({ hotelSlug, period }) {
  let bookingsQuery = supabase
    .from("room_bookings")
    .select("*")
    .eq("hotel_slug", hotelSlug)
    .order("check_in_date", { ascending: true })
    .limit(STAFF_BUSINESS_REPORT_MAX_ROOM_BOOKINGS);
  const fromDate = getStaffReportDateKey(period?.from);
  const toDate = getStaffReportDateKey(period?.to);

  if (fromDate) bookingsQuery = bookingsQuery.gt("check_out_date", fromDate);
  if (toDate) bookingsQuery = bookingsQuery.lt("check_in_date", toDate);

  const [bookingsResult, roomsResult, roomTypesResult] = await Promise.all([
    bookingsQuery,
    supabase.from("rooms").select("*").eq("hotel_slug", hotelSlug),
    supabase.from("room_types").select("*").eq("hotel_slug", hotelSlug)
  ]);

  if (bookingsResult.error) throw bookingsResult.error;
  if (roomsResult.error) throw roomsResult.error;
  if (roomTypesResult.error) throw roomTypesResult.error;

  const bookings = bookingsResult.data || [];
  const bookingIds = bookings.map((booking) => booking.id).filter(Boolean);
  const payments = [];

  for (let index = 0; index < bookingIds.length; index += 400) {
    const bookingIdBatch = bookingIds.slice(index, index + 400);
    const paymentResult = await supabase
      .from("room_booking_payments")
      .select("*")
      .eq("hotel_slug", hotelSlug)
      .in("booking_id", bookingIdBatch);

    if (paymentResult.error) throw paymentResult.error;
    payments.push(...(paymentResult.data || []));
  }

  return {
    bookings,
    rooms: roomsResult.data || [],
    roomTypes: roomTypesResult.data || [],
    payments,
    truncated: bookings.length >= STAFF_BUSINESS_REPORT_MAX_ROOM_BOOKINGS
  };
}

function buildStaffRoomBusinessReport({ hotelSlug, period, data = {} }) {
  const bookings = Array.isArray(data.bookings) ? data.bookings : [];
  const rooms = Array.isArray(data.rooms) ? data.rooms : [];
  const roomTypes = Array.isArray(data.roomTypes) ? data.roomTypes : [];
  const payments = Array.isArray(data.payments) ? data.payments : [];
  const range = getStaffRoomReportRange(period, bookings);
  const roomById = new Map(rooms.map((room) => [String(room.id), room]));
  const roomTypeById = new Map(roomTypes.map((roomType) => [String(roomType.id), roomType]));
  const activeRooms = rooms.filter((room) => room.is_active !== false);
  const sellableRooms = activeRooms.filter((room) => !["maintenance", "inactive"].includes(normalizeStatusValue(room.status)));
  const paymentsByBooking = new Map();

  payments.forEach((payment) => {
    const bookingId = String(payment.booking_id || "");
    const list = paymentsByBooking.get(bookingId) || [];
    list.push(payment);
    paymentsByBooking.set(bookingId, list);
  });

  const bookingStatusMap = new Map();
  const bookingSourceMap = new Map();
  const bookingSourceGroupMap = new Map();
  const paymentMethodMap = new Map();
  const roomPerformanceMap = new Map();
  const roomTypePerformanceMap = new Map();
  const guestStays = [];
  const arrivals = [];
  const departures = [];
  const summary = {
    grossRoomRevenue: 0,
    netRoomRevenue: 0,
    paidAmount: 0,
    unpaidAmount: 0,
    refunds: 0,
    discounts: 0,
    taxes: 0,
    advances: 0,
    averageBookingValue: 0,
    adr: 0,
    totalBookings: bookings.length,
    roomNightsSold: 0,
    availableRoomNights: sellableRooms.length * range.totalDays,
    occupancyRate: 0,
    totalRooms: activeRooms.length,
    availableRooms: sellableRooms.length,
    maintenanceRooms: activeRooms.length - sellableRooms.length
  };

  bookings.forEach((booking) => {
    const status = normalizeStatusValue(booking.booking_status) || "pending";
    const source = normalizeStatusValue(booking.booking_source) || "unknown";
    const sourceGroup = getRoomBookingSourceGroup(source);
    const room = roomById.get(String(booking.room_id)) || {};
    const roomType = roomTypeById.get(String(room.room_type_id)) || {};
    const overlapNights = getStaffRoomOverlapNights(booking, range.fromDate, range.toDate);
    const totalNights = Math.max(1, Number(booking.total_nights || 0) || overlapNights || 1);
    const isRevenueEligible = !["cancelled", "no_show"].includes(status);
    const recognitionRatio = isRevenueEligible ? Math.min(1, overlapNights / totalNights) : 0;
    const grossAmount = Number(booking.total_amount || 0) * recognitionRatio;
    const taxAmount = Number(booking.tax_amount || 0) * recognitionRatio;
    const discountAmount = Number(booking.discount_amount || 0) * recognitionRatio;
    const bookingPayments = paymentsByBooking.get(String(booking.id)) || [];
    const paidPayments = bookingPayments
      .filter((payment) => normalizeStatusValue(payment.payment_status) === "paid")
      .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
    const refundedPayments = bookingPayments
      .filter((payment) => normalizeStatusValue(payment.payment_status) === "refunded")
      .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
    const paidAmount = bookingPayments.length
      ? Math.max(0, paidPayments - refundedPayments)
      : Math.max(0, Number(booking.advance_paid || 0));
    const recognizedPaid = Math.min(grossAmount, paidAmount * recognitionRatio);

    incrementStaffReportGroup(bookingStatusMap, status, grossAmount).label = status;
    const bookingSourceEntry = incrementStaffReportGroup(bookingSourceMap, source, grossAmount);
    bookingSourceEntry.label = getRoomBookingSourceLabel(source);
    if (status === "cancelled") bookingSourceEntry.cancellations += 1;
    const channelEntry = incrementStaffReportGroup(bookingSourceGroupMap, sourceGroup, grossAmount);
    channelEntry.label = sourceGroup === "website" ? "Website" : sourceGroup === "manual" ? "Manual" : "Legacy / Other";
    if (status === "cancelled") channelEntry.cancellations += 1;
    bookingPayments.forEach((payment) => {
      const method = normalizeStatusValue(payment.payment_method) || "not_provided";
      const amount = normalizeStatusValue(payment.payment_status) === "refunded"
        ? -Number(payment.amount || 0)
        : Number(payment.amount || 0);
      incrementStaffReportGroup(paymentMethodMap, method, amount).label = method;
    });

    if (isRevenueEligible) {
      summary.grossRoomRevenue += grossAmount;
      summary.taxes += taxAmount;
      summary.discounts += discountAmount;
      summary.refunds += refundedPayments * recognitionRatio;
      summary.paidAmount += recognizedPaid;
      summary.unpaidAmount += Math.max(0, grossAmount - recognizedPaid);
      summary.advances += Math.min(grossAmount, Number(booking.advance_paid || 0) * recognitionRatio);
      summary.roomNightsSold += overlapNights;
    }

    const roomKey = String(room.id || booking.room_id || "unknown");
    const roomEntry = roomPerformanceMap.get(roomKey) || {
      roomId: roomKey,
      roomNumber: room.room_number || "Unknown",
      roomType: roomType.name || "Unassigned",
      nightsSold: 0,
      revenue: 0,
      cancellations: 0,
      bookings: 0
    };
    roomEntry.bookings += 1;
    roomEntry.nightsSold += isRevenueEligible ? overlapNights : 0;
    roomEntry.revenue += grossAmount;
    if (status === "cancelled") roomEntry.cancellations += 1;
    roomPerformanceMap.set(roomKey, roomEntry);

    const roomTypeKey = String(roomType.id || room.room_type_id || "unassigned");
    const typeEntry = roomTypePerformanceMap.get(roomTypeKey) || {
      roomTypeId: roomTypeKey,
      roomType: roomType.name || "Unassigned",
      totalRooms: activeRooms.filter((candidate) => String(candidate.room_type_id || "unassigned") === roomTypeKey).length,
      nightsSold: 0,
      revenue: 0,
      bookings: 0
    };
    typeEntry.bookings += 1;
    typeEntry.nightsSold += isRevenueEligible ? overlapNights : 0;
    typeEntry.revenue += grossAmount;
    roomTypePerformanceMap.set(roomTypeKey, typeEntry);

    guestStays.push({
      guestName: booking.guest_name || "Guest",
      phoneMasked: maskStaffReportPhone(booking.guest_phone),
      roomNumber: room.room_number || "",
      checkInDate: booking.check_in_date || "",
      checkOutDate: booking.check_out_date || "",
      nights: totalNights,
      status,
      paymentStatus: booking.payment_status || "unpaid"
    });

    if (booking.check_in_date >= range.fromDate && booking.check_in_date < range.toDate) {
      arrivals.push(guestStays[guestStays.length - 1]);
    }
    if (booking.check_out_date > range.fromDate && booking.check_out_date <= range.toDate) {
      departures.push(guestStays[guestStays.length - 1]);
    }
  });

  summary.netRoomRevenue = Math.max(0, summary.grossRoomRevenue - summary.refunds);
  const revenueBookingCount = bookings.filter((booking) => !["cancelled", "no_show"].includes(normalizeStatusValue(booking.booking_status))).length;
  summary.averageBookingValue = revenueBookingCount ? summary.netRoomRevenue / revenueBookingCount : 0;
  summary.adr = calculateAdr(summary.netRoomRevenue, summary.roomNightsSold);
  summary.occupancyRate = calculateOccupancyRate(
    summary.roomNightsSold,
    summary.availableRoomNights
  );

  const roomPerformance = [...roomPerformanceMap.values()].map((entry) => ({
    ...entry,
    occupancyRate: summary.availableRoomNights && range.totalDays
      ? (entry.nightsSold / range.totalDays) * 100
      : 0,
    averageRate: entry.nightsSold ? entry.revenue / entry.nightsSold : 0
  })).sort((left, right) => right.revenue - left.revenue);
  const roomTypePerformance = [...roomTypePerformanceMap.values()].map((entry) => {
    const nightsAvailable = entry.totalRooms * range.totalDays;
    return {
      ...entry,
      nightsAvailable,
      occupancyRate: nightsAvailable ? (entry.nightsSold / nightsAvailable) * 100 : 0,
      adr: entry.nightsSold ? entry.revenue / entry.nightsSold : 0
    };
  }).sort((left, right) => right.revenue - left.revenue);

  return {
    reportType: "rooms",
    hotelSlug,
    hotelName: hotelSlug,
    period: {
      range: period.range,
      label: period.label,
      from: `${range.fromDate}T00:00:00.000Z`,
      to: `${range.toDate}T00:00:00.000Z`,
      generatedAt: period.generatedAt
    },
    basis: {
      bookingCount: bookings.length,
      maxBookings: STAFF_BUSINESS_REPORT_MAX_ROOM_BOOKINGS,
      truncated: data.truncated === true,
      occupancyFormula: "Occupied room nights / available room nights x 100",
      revenueRecognition: "Booking values are prorated by stay nights overlapping the selected period.",
      maintenanceBasis: "Current room maintenance status; historical maintenance periods are not stored."
    },
    summary,
    bookingStatuses: finalizeStaffReportGroups(bookingStatusMap, 20),
    bookingSourceGroups: finalizeStaffReportGroups(bookingSourceGroupMap, 3),
    bookingSources: finalizeStaffReportGroups(bookingSourceMap, 20),
    payments: { byMethod: finalizeStaffReportGroups(paymentMethodMap, 20) },
    roomPerformance,
    roomTypePerformance,
    guestStays: guestStays.slice(0, 100),
    arrivals: arrivals.slice(0, 100),
    departures: departures.slice(0, 100),
    maintenance: activeRooms
      .filter((room) => normalizeStatusValue(room.status) === "maintenance")
      .map((room) => ({ roomNumber: room.room_number || "", status: room.status || "maintenance" }))
  };
}

function buildStaffCombinedBusinessReport({ hotelSlug, period, foodReport, roomReport }) {
  const foodRevenue = Number(foodReport?.summary?.netRevenue ?? foodReport?.summary?.totalRevenue ?? 0);
  const roomRevenue = Number(roomReport?.summary?.netRoomRevenue || 0);
  const roomServiceRevenue = Number(foodReport?.summary?.roomServiceRevenue || 0);

  return {
    reportType: "combined",
    hotelSlug,
    hotelName: foodReport?.hotelName || roomReport?.hotelName || hotelSlug,
    period: foodReport?.period || roomReport?.period || period,
    basis: {
      accountingRule: "Combined revenue = Food revenue (including Room Service once) + Room revenue.",
      roomServiceTreatment: "Room Service stays in Food revenue and is not added to Room revenue or counted again from checkout receipts.",
      paymentRule: "Food and Room payment summaries remain separate; checkout allocations are settlement evidence, not extra revenue."
    },
    summary: {
      combinedRevenue: calculateCombinedRevenue({
        foodNetRevenue: foodRevenue,
        roomNetRevenue: roomRevenue
      }),
      foodRevenue,
      roomRevenue,
      roomServiceRevenue,
      foodOrders: Number(foodReport?.summary?.totalOrders || 0),
      roomBookings: Number(roomReport?.summary?.totalBookings || 0),
      pendingFoodAmount: Number(foodReport?.summary?.unpaidAmount || 0),
      pendingRoomAmount: Number(roomReport?.summary?.unpaidAmount || 0)
    },
    food: foodReport,
    rooms: roomReport
  };
}

function canStaffViewOrderFinancials(req = {}) {
  return Boolean(req.staffCanViewManagerData || req.staffUser?.isManager);
}

function getStaffOrderAdditionPolicy(order = {}) {
  const orderStatus = normalizeStatusValue(order.status);
  const paymentStatus = normalizeStatusValue(order.payment_status || order.paymentStatus || "unpaid");
  const billingStatus = normalizeStatusValue(order.billing_status || order.billingStatus || "not_billed");

  if (normalizeStatusValue(order.order_type || order.orderType) !== "dine-in" || order.parent_order_id || order.parentOrderId) {
    return { allowed: false, code: "ORDER_NOT_DINE_IN_ROOT", reason: "Only the active root dine-in order can receive more items." };
  }
  if (!STAFF_ACTIVE_TABLE_ORDER_STATUSES.includes(orderStatus)) {
    return { allowed: false, code: "ORDER_CLOSED", reason: "This order is no longer open for additional items." };
  }
  if (paymentStatus && paymentStatus !== "unpaid") {
    return { allowed: false, code: "PAYMENT_LOCKED", reason: "Items cannot be added after payment processing has started." };
  }
  if ((billingStatus && billingStatus !== "not_billed") || order.bill_number || order.billNumber) {
    return { allowed: false, code: "BILLING_LOCKED", reason: "Items cannot be added after the final bill has been issued." };
  }
  if (!String(order.table_number || order.tableNumber || "").trim()) {
    return { allowed: false, code: "TABLE_MISSING", reason: "This order is not assigned to a restaurant table." };
  }

  return { allowed: true, code: "", reason: "" };
}

function mapStaffOrderRound(round = {}, { includeFinancials = true } = {}) {
  const items = Array.isArray(round.items) ? round.items : [];
  return {
    id: round.id,
    orderId: String(round.order_id || round.orderId || ""),
    sequence: Number(round.sequence_number || round.sequence || 0),
    kotReference: round.kot_reference || round.kotReference || "",
    source: round.source || "staff",
    status: round.status || "new",
    items: includeFinancials ? items : stripStaffOrderItemFinancials(items),
    totalsDelta: includeFinancials && round.totals_delta && typeof round.totals_delta === "object"
      ? round.totals_delta
      : {},
    note: round.note || "",
    createdByStaffId: round.created_by_staff_id ? String(round.created_by_staff_id) : "",
    createdByRole: round.created_by_role || "",
    createdAt: round.created_at || "",
    sentToKitchenAt: round.sent_to_kitchen_at || "",
    updatedAt: round.updated_at || "",
    version: Math.max(1, Number(round.row_version || 1))
  };
}

async function fetchStaffOrderRoundsByOrderIds({ hotelSlug, orderIds = [] }) {
  const normalizedOrderIds = [...new Set(orderIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (!normalizedOrderIds.length) return new Map();

  const { data, error } = await supabase
    .from("order_rounds")
    .select("*")
    .eq("hotel_slug", hotelSlug)
    .in("order_id", normalizedOrderIds)
    .order("sequence_number", { ascending: true });

  if (error) {
    if (isMissingOrderRoundsSchemaError(error)) return new Map();
    throw error;
  }

  return (data || []).reduce((roundsByOrderId, round) => {
    const orderId = String(round.order_id || "");
    const rounds = roundsByOrderId.get(orderId) || [];
    rounds.push(round);
    roundsByOrderId.set(orderId, rounds);
    return roundsByOrderId;
  }, new Map());
}

function attachStaffOrderRounds(orders = [], roundsByOrderId = new Map()) {
  return (Array.isArray(orders) ? orders : []).map((order) => ({
    ...order,
    _orderRounds: roundsByOrderId.get(String(order.id || "")) || []
  }));
}

function isStaffOrderFinancialItemKey(key = "") {
  const normalizedKey = String(key || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .trim()
    .toLowerCase();

  return /(^|_)(price|amount|total|subtotal|tax|gst|discount|savings|cost)(_|$)/.test(normalizedKey);
}

function stripStaffOrderItemFinancials(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => stripStaffOrderItemFinancials(entry));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.entries(value).reduce((sanitized, [key, entry]) => {
    if (!isStaffOrderFinancialItemKey(key)) {
      sanitized[key] = stripStaffOrderItemFinancials(entry);
    }
    return sanitized;
  }, {});
}

function buildStaffOrderResponse(
  order = {},
  staffById = new Map(),
  { includeFinancials = true } = {}
) {
  const createdByStaffId = normalizeOrderCreatedByStaffId(order.created_by_staff_id);
  const items = Array.isArray(order.items) ? order.items : [];
  const additionPolicy = getStaffOrderAdditionPolicy(order);
  const rounds = Array.isArray(order._orderRounds) ? order._orderRounds : [];

  return {
    id: order.id,
    hotelSlug: order.hotel_slug || "",
    hotelName: order.hotel_name || "",
    orderType: order.order_type || "",
    restaurantTableId: order.restaurant_table_id ? String(order.restaurant_table_id) : "",
    tableNumber: order.table_number || "",
    orderSource: order.order_source || "",
    parentOrderId: order.parent_order_id ? String(order.parent_order_id) : "",
    orderGroupId: order.order_group_id || "",
    orderEntryType: order.order_entry_type || "",
    orderSequenceLabel: order.order_sequence_label || "",
    addonSequence: order.addon_sequence || null,
    customerName: order.customer_name || "",
    customerPhone: order.customer_phone || "",
    customerAddress: order.customer_address || "",
    financialsVisible: !!includeFinancials,
    paymentMethod: includeFinancials ? order.payment_method || "" : "",
    paymentStatus: order.payment_status || "",
    billingStatus: order.billing_status || "",
    billNumber: includeFinancials ? order.bill_number || "" : "",
    billedAt: includeFinancials ? order.billed_at || "" : "",
    paidAt: includeFinancials ? order.paid_at || "" : "",
    roomService: {
      roomId: order.room_id ? String(order.room_id) : "",
      roomBookingId: order.room_booking_id ? String(order.room_booking_id) : "",
      roomNumber: order.room_number || "",
      guestName: order.room_service_guest_name || "",
      chargeToRoom: !!order.room_service_charge_to_room
    },
    status: order.status || "new",
    kitchenStatus: order.kitchen_status || "",
    effectiveKitchenStatus: getEffectiveKitchenStatus(order),
    version: Math.max(1, Number(order.order_version || order.version || 1)),
    canAddItems: additionPolicy.allowed,
    addItemsBlockedCode: additionPolicy.code,
    addItemsBlockedReason: additionPolicy.reason,
    note: order.note || "",
    items: includeFinancials ? items : stripStaffOrderItemFinancials(items),
    totals:
      includeFinancials && order.totals && typeof order.totals === "object" && !Array.isArray(order.totals)
        ? order.totals
        : {},
    rounds: rounds.map((round) => mapStaffOrderRound(round, { includeFinancials })),
    routeTransfer: includeFinancials ? buildStaffRouteTransferResponse(order) : {},
    createdAt: order.created_at || "",
    updatedAt: order.updated_at || order.created_at || "",
    createdByStaffId: createdByStaffId ? String(createdByStaffId) : "",
    createdByStaff: getOrderCreatedByStaffResponse(order, staffById)
  };
}

function getStaffKdsOrdersLimit(value) {
  const parsedLimit = Number.parseInt(String(value || "").trim(), 10);

  if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
    return STAFF_KDS_DEFAULT_LIMIT;
  }

  return Math.min(parsedLimit, STAFF_KDS_MAX_LIMIT);
}

function isTruthyStaffQueryFlag(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function getEffectiveKitchenStatus(order = {}) {
  const explicitKitchenStatus = normalizeStatusValue(order.kitchen_status);

  if (STAFF_KDS_STATUSES.includes(explicitKitchenStatus)) {
    return explicitKitchenStatus;
  }

  const orderStatus = normalizeStatusValue(order.status);

  if (orderStatus === "cancelled" || orderStatus === "payment_failed") {
    return "cancelled";
  }

  if (orderStatus === "completed") {
    return "served";
  }

  if (orderStatus === "preparing") {
    return "preparing";
  }

  if (orderStatus === "confirmed") {
    return "accepted";
  }

  if (orderStatus === "new") {
    return "new";
  }

  return "new";
}

function isValidStaffKdsTransition(currentStatus = "", nextStatus = "") {
  const current = normalizeStatusValue(currentStatus) || "new";
  const next = normalizeStatusValue(nextStatus);
  return (STAFF_KDS_STATUS_TRANSITIONS[current] || []).includes(next);
}

function isValidStaffKdsOrderId(orderId = "") {
  return /^[1-9]\d*$/.test(String(orderId || "").trim());
}

function canStaffPerformKdsTransition(req, nextStatus = "") {
  const target = normalizeStatusValue(nextStatus);
  if (STAFF_KDS_KITCHEN_TARGETS.includes(target)) {
    return isStaffKdsRoleAllowed(req.staffKdsRole, ["kitchen"]);
  }
  if (STAFF_KDS_EXPO_TARGETS.includes(target)) {
    return isStaffKdsRoleAllowed(req.staffKdsRole, ["expo"]);
  }
  return req.staffCanViewManagerData === true;
}

function buildStaffKdsOrderResponse(
  order = {},
  staffById = new Map(),
  options = {}
) {
  const baseOrder = buildStaffOrderResponse(order, staffById, { ...options, includeFinancials: false });
  const effectiveKitchenStatus = getEffectiveKitchenStatus(order);

  return {
    id: baseOrder.id,
    orderType: baseOrder.orderType,
    restaurantTableId: baseOrder.restaurantTableId,
    tableNumber: baseOrder.tableNumber,
    orderSource: baseOrder.orderSource,
    orderEntryType: baseOrder.orderEntryType,
    orderSequenceLabel: baseOrder.orderSequenceLabel,
    roomService: {
      roomId: baseOrder.roomService?.roomId || "",
      roomBookingId: baseOrder.roomService?.roomBookingId || "",
      roomNumber: baseOrder.roomService?.roomNumber || ""
    },
    status: baseOrder.status,
    version: baseOrder.version,
    note: baseOrder.note,
    items: baseOrder.items,
    createdAt: baseOrder.createdAt,
    updatedAt: order.updated_at || order.created_at || "",
    createdByStaff: baseOrder.createdByStaff,
    kitchenStatus: order.kitchen_status || "",
    effectiveKitchenStatus
  };
}

function buildStaffKdsRoundTickets(order = {}, staffById = new Map(), options = {}) {
  const baseOrder = buildStaffKdsOrderResponse(order, staffById, options);
  const rounds = Array.isArray(order._orderRounds) ? order._orderRounds : [];
  if (!rounds.length) return [baseOrder];

  const originalItems = (Array.isArray(baseOrder.items) ? baseOrder.items : []).filter(
    (item) => !Number(item?.orderRoundSequence || 0)
  );
  const originalTicket = {
    ...baseOrder,
    items: originalItems,
    roundSequence: 1,
    kotReference: `KOT-${order.id}-01`,
    kdsTicketId: `${order.id}:round:1`
  };
  const additionTickets = rounds.map((round) => {
    const mappedRound = mapStaffOrderRound(round, options);
    return {
      ...baseOrder,
      items: mappedRound.items,
      note: mappedRound.note,
      roundSequence: mappedRound.sequence,
      kotReference: mappedRound.kotReference,
      kdsTicketId: `${order.id}:round:${mappedRound.sequence}`,
      kitchenStatus: mappedRound.status,
      effectiveKitchenStatus: mappedRound.status,
      createdAt: mappedRound.createdAt,
      roundVersion: mappedRound.version,
      isAdditionRound: true
    };
  });

  return [originalTicket, ...additionTickets];
}

function getStaffKdsStatusCounts(orders = []) {
  return (Array.isArray(orders) ? orders : []).reduce((counts, order) => {
    const status = String(order?.effectiveKitchenStatus || "").trim() || "new";
    counts[status] = Number(counts[status] || 0) + 1;
    return counts;
  }, {});
}

function buildStaffReservationResponse(reservation = {}) {
  return {
    id: reservation.id,
    hotelSlug: reservation.hotel_slug || "",
    hotelName: reservation.hotel_name || "",
    name: reservation.name || "",
    phone: reservation.phone || "",
    date: reservation.date || "",
    time: reservation.time || "",
    guests: reservation.guests || "",
    note: reservation.note || "",
    status: reservation.status || "new",
    createdAt: reservation.created_at || ""
  };
}

function buildStaffInquiryResponse(inquiry = {}) {
  return {
    id: inquiry.id,
    hotelSlug: inquiry.hotel_slug || "",
    hotelName: inquiry.hotel_name || "",
    name: inquiry.name || "",
    phone: inquiry.phone || "",
    eventType: inquiry.event_type || "",
    date: inquiry.date || "",
    guests: inquiry.guests || "",
    specialRequirements: inquiry.special_requirements || "",
    status: inquiry.status || "new",
    createdAt: inquiry.created_at || ""
  };
}

function buildStaffContactSubmissionResponse(contactSubmission = {}) {
  return {
    id: contactSubmission.id,
    hotelSlug: contactSubmission.hotel_slug || "",
    hotelName: contactSubmission.hotel_name || "",
    name: contactSubmission.name || "",
    email: contactSubmission.email || "",
    subject: contactSubmission.subject || "",
    message: contactSubmission.message || "",
    status: contactSubmission.status || "new",
    source: contactSubmission.source || "",
    googleSheetStatus: contactSubmission.google_sheet_status || "",
    createdAt: contactSubmission.created_at || ""
  };
}

function buildStaffSupportRequestResponse(supportRequest = {}) {
  return {
    id: supportRequest.id,
    hotelSlug: supportRequest.hotel_slug || "",
    hotelName: supportRequest.hotel_name || "",
    orderId: String(supportRequest.order_id || ""),
    tableNumber: supportRequest.table_number || "",
    requestType: supportRequest.request_type || "",
    status: supportRequest.status || "new",
    orderStatus: supportRequest.order_status || "",
    message: supportRequest.message || "",
    source: supportRequest.source || "",
    createdAt: supportRequest.created_at || "",
    updatedAt: supportRequest.updated_at || ""
  };
}

function buildStaffTestimonialResponse(testimonial = {}) {
  return {
    id: testimonial.id,
    hotelSlug: testimonial.hotel_slug || "",
    name: testimonial.guest_name || "",
    role: testimonial.guest_role || "",
    text: testimonial.review_text || "",
    stars: Number(testimonial.star_rating || 5),
    avatar: testimonial.avatar_url || "",
    sortOrder: Number(testimonial.sort_order || 0),
    isActive: testimonial.is_active !== false,
    isApproved: testimonial.is_approved === true,
    moderationStatus: testimonial.is_approved === true
      ? "approved"
      : testimonial.is_archived === true || testimonial.is_active === false
        ? "rejected"
        : "pending",
    isArchived: testimonial.is_archived === true,
    createdAt: testimonial.created_at || "",
    updatedAt: testimonial.updated_at || ""
  };
}

async function updateStaffScopedRecordStatus(req, res, config = {}) {
  try {
    const hotelSlug = String(req.staffHotelSlug || "").trim();
    const recordId = String(req.params.id || "").trim();
    const status = getAllowedStaffStatus(req.body?.status, config.allowedStatuses);

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    if (!recordId) {
      return res.status(400).json({
        success: false,
        message: `${config.label} id is required`
      });
    }

    if (!status) {
      return res.status(400).json({
        success: false,
        message: `Status must be one of: ${config.allowedStatuses.join(", ")}`
      });
    }

    const { data, error } = await supabase
      .from(config.table)
      .update({ status })
      .eq("id", recordId)
      .eq("hotel_slug", hotelSlug)
      .select()
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        success: false,
        message: `${config.label} not found for this hotel`
      });
    }

    res.json({
      success: true,
      message: `${config.label} status updated`,
      [config.responseKey]: config.buildResponse(data)
    });
  } catch (error) {
    if (
      typeof config.isMissingRelationError === "function" &&
      config.isMissingRelationError(error)
    ) {
      return res.status(400).json({
        success: false,
        message: config.missingRelationMessage || `${config.label} table is not initialized yet`
      });
    }

    console.error(`Staff ${config.responseKey} status update error:`, error);
    res.status(500).json({
      success: false,
      message: `Failed to update ${config.label.toLowerCase()} status`
    });
  }
}

router.post("/login", validateBody(staffLoginSchema), async (req, res) => {
  try {
    const { hotelSlug, pin } = req.validatedBody;
    const normalizedHotelSlug = String(hotelSlug || "").trim();

    const { data: staffAccessRows, error } = await supabase
      .from("hotel_staff_access")
      .select("*")
      .eq("hotel_slug", normalizedHotelSlug)
      .eq("is_active", true);

    if (error) {
      if (isMissingStaffAccessRelationError(error)) {
        return res.status(503).json({
          success: false,
          message: "Staff access is not initialized yet"
        });
      }

      throw error;
    }

    const activeAccessRows = Array.isArray(staffAccessRows) ? staffAccessRows : [];
    let matchedStaffAccess = null;

    for (const staffAccess of activeAccessRows) {
      const isMatch = await bcrypt.compare(pin, staffAccess.pin_hash || "");

      if (isMatch) {
        matchedStaffAccess = staffAccess;
        break;
      }
    }

    if (!matchedStaffAccess) {
      return res.status(401).json({
        success: false,
        message: "Invalid hotel slug or PIN"
      });
    }

    await supabase
      .from("hotel_staff_access")
      .update({ last_login_at: new Date().toISOString() })
      .eq("id", matchedStaffAccess.id);

    const token = signStaffToken(matchedStaffAccess);
    const featureConfig = await fetchHotelFeatureConfig(
      supabase,
      matchedStaffAccess.hotel_slug
    );

    res.json({
      success: true,
      message: "Staff login successful",
      token,
      staffUser: buildStaffUserResponse(matchedStaffAccess, featureConfig)
    });
  } catch (error) {
    console.error("Staff login error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to login staff user"
    });
  }
});

router.get(
  "/menu",
  requireStaffAuth,
  attachStaffMenuTenantContext,
  requireStaffMenuFoodModule,
  async (req, res) => {
  try {
    const hotelSlug = String(req.staffHotelSlug || "").trim();

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    let menuItems;
    let categoryResult;
    let comboPresentationMap = new Map();
    if (env.tenantRuntimeStaffMenuEnabled) {
      const tenantResult = await fetchTenantStaffMenuBundle(
        getTenantRequestScope(req),
        hotelSlug
      );
      if (!isHotelFeatureEnabled(tenantResult.featureConfig, "food")) {
        return res
          .status(403)
          .json(buildFeatureDisabledPayload("food"));
      }
      menuItems = tenantResult.menuItems;
      categoryResult = tenantResult.categoryResult;
      comboPresentationMap = tenantResult.comboPresentationMap;
    } else {
      const { data, error } = await supabase
        .from("menu_items")
        .select(STAFF_MENU_FIELDS)
        .eq("hotel_slug", hotelSlug)
        .eq("is_available", true)
        .eq("is_archived", false)
        .order("category", { ascending: true })
        .order("sort_order", { ascending: true });
      if (error) throw error;
      menuItems = data || [];
      categoryResult = await fetchHotelMenuCategories({
        supabase,
        hotelSlug,
        consumer: "staff",
        menuItems
      });
      try {
        comboPresentationMap = await fetchMenuComboPresentationMap({
          hotelSlug,
          menuItems
        });
      } catch (comboError) {
        if (!isMissingMenuComboSchemaError(comboError)) {
          throw comboError;
        }
      }
    }
    const payload = buildStaffMenuPayload({
      hotelSlug,
      menuItems,
      categoryResult,
      comboPresentationMap
    });
    res.set("Cache-Control", "private, no-cache");
    res.json(payload);
  } catch (error) {
    console.error("Staff menu fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch staff menu"
    });
  }
});

router.get("/ordering-settings", requireStaffAuth, requireStaffFoodModule, async (req, res) => {
  try {
    const hotelSlug = String(req.staffHotelSlug || "").trim();

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    const settings = await fetchHotelOrderingSettings(hotelSlug);

    res.json({
      success: true,
      hotelSlug,
      ordering: {
        staffOrderingEnabled: settings.staffOrderingEnabled !== false,
        enforceTableMaster: settings.enforceTableMaster === true,
        secureOnlinePaymentEnabled: settings.secureOnlinePaymentEnabled !== false,
        cashOnDeliveryEnabled: settings.cashOnDeliveryEnabled !== false,
        manualUpiPaymentEnabled: settings.manualUpiPaymentEnabled !== false,
        title: settings.disabledTitle || "",
        message: settings.disabledMessage || "",
        icon: settings.disabledIcon || ""
      }
    });
  } catch (error) {
    console.error("Staff ordering settings fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch staff ordering settings"
    });
  }
});

router.patch(
  "/ordering-settings/payment-methods",
  requireStaffAuth,
  requireStaffManagerAccess,
  requireStaffFoodModule,
  validateBody(staffPaymentMethodSettingsSchema),
  async (req, res) => {
    try {
      const hotelSlug = String(req.staffHotelSlug || "").trim();
      if (!hotelSlug) {
        return res.status(403).json({
          success: false,
          message: "Staff hotel scope is missing"
        });
      }

      const {
        secureOnlinePaymentEnabled,
        cashOnDeliveryEnabled,
        manualUpiPaymentEnabled
      } = req.validatedBody;
      const { data, error } = await supabase
        .from("hotel_ordering_settings")
        .upsert(
          [{
            hotel_slug: hotelSlug,
            secure_online_payment_enabled: secureOnlinePaymentEnabled,
            cash_on_delivery_enabled: cashOnDeliveryEnabled,
            manual_upi_payment_enabled: manualUpiPaymentEnabled,
            updated_at: new Date().toISOString()
          }],
          { onConflict: "hotel_slug" }
        )
        .select([
          "hotel_slug",
          "secure_online_payment_enabled",
          "cash_on_delivery_enabled",
          "manual_upi_payment_enabled",
          "updated_at"
        ].join(","))
        .single();

      if (error) {
        if (isMissingHotelOrderingSettingsTableError(error)) {
          return res.status(400).json({
            success: false,
            code: "PAYMENT_SETTINGS_NOT_INITIALIZED",
            message: "Hotel payment-method settings are not initialized yet"
          });
        }
        throw error;
      }

      invalidateHotelOrderingSettings(hotelSlug);
      logger.info("Hotel payment methods updated", {
        requestId: req.requestId || "",
        hotelSlug,
        staffUserId: String(req.staffUser?.sub || req.staffUser?.id || ""),
        staffRole: String(req.staffRole || req.staffUser?.role || ""),
        secureOnlinePaymentEnabled: data.secure_online_payment_enabled !== false,
        cashOnDeliveryEnabled: data.cash_on_delivery_enabled !== false,
        manualUpiPaymentEnabled: data.manual_upi_payment_enabled !== false
      });

      return res.json({
        success: true,
        message: "Customer payment methods saved for this hotel",
        hotelSlug,
        ordering: {
          secureOnlinePaymentEnabled: data.secure_online_payment_enabled !== false,
          cashOnDeliveryEnabled: data.cash_on_delivery_enabled !== false,
          manualUpiPaymentEnabled: data.manual_upi_payment_enabled !== false
        }
      });
    } catch (error) {
      console.error("Staff payment-method settings save error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to save hotel payment methods"
      });
    }
  }
);

router.get("/kds/orders", requireStaffAuth, requireStaffFoodModule, async (req, res) => {
  try {
    const hotelSlug = String(req.staffHotelSlug || "").trim();

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    const limit = getStaffKdsOrdersLimit(req.query.limit);
    const includeCancelled = isTruthyStaffQueryFlag(req.query.includeCancelled);
    const includeServed = req.query.includeServed === undefined
      ? true
      : isTruthyStaffQueryFlag(req.query.includeServed);

    const { data, error } = await supabase
      .from("orders")
      .select(STAFF_KDS_ORDER_FIELDS)
      .eq("hotel_slug", hotelSlug)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    const rawOrders = Array.isArray(data) ? data : [];
    const roundsByOrderId = await fetchStaffOrderRoundsByOrderIds({
      hotelSlug,
      orderIds: rawOrders.map((order) => order.id)
    });
    const orders = attachStaffOrderRounds(rawOrders, roundsByOrderId);
    const includeFinancials = canStaffViewOrderFinancials(req);
    const createdByStaffMap = await getOrderCreatedByStaffMap(supabase, orders);
    const kdsOrders = orders
      .flatMap((order) => buildStaffKdsRoundTickets(order, createdByStaffMap, { includeFinancials }))
      .filter((order) => {
        if (!includeCancelled && order.effectiveKitchenStatus === "cancelled") {
          return false;
        }

        if (!includeServed && order.effectiveKitchenStatus === "served") {
          return false;
        }

        return true;
      });

    res.json({
      success: true,
      hotelSlug,
      serverTime: new Date().toISOString(),
      refreshAfterMs: STAFF_KDS_REFRESH_AFTER_MS,
      capabilities: {
        role: req.staffKdsRole || "general",
        canPrepare: isStaffKdsRoleAllowed(req.staffKdsRole, ["kitchen"]),
        canServe: isStaffKdsRoleAllowed(req.staffKdsRole, ["expo"]),
        canManage: req.staffCanViewManagerData === true
      },
      count: kdsOrders.length,
      countsByKitchenStatus: getStaffKdsStatusCounts(kdsOrders),
      orders: kdsOrders
    });
  } catch (error) {
    console.error("Staff KDS orders fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch kitchen display orders"
    });
  }
});

router.patch(
  "/kds/orders/:id/kitchen-status",
  requireStaffAuth,
  requireStaffFoodModule,
  validateBody(staffKdsKitchenStatusSchema),
  async (req, res) => {
    try {
      const hotelSlug = String(req.staffHotelSlug || "").trim();
      const orderId = String(req.params.id || "").trim();
      const kitchenStatus = String(req.validatedBody.kitchenStatus || "").trim();
      const expectedVersion = Number(req.validatedBody.expectedVersion);

      if (!hotelSlug) {
        return res.status(403).json({
          success: false,
          message: "Staff hotel scope is missing"
        });
      }

      if (!isValidStaffKdsOrderId(orderId)) {
        return res.status(400).json({
          success: false,
          code: "INVALID_ORDER_ID",
          message: "A valid order id is required"
        });
      }

      const currentResult = await supabase
        .from("orders")
        .select("id,kitchen_status,status,order_version")
        .eq("id", orderId)
        .eq("hotel_slug", hotelSlug)
        .maybeSingle();
      if (currentResult.error) throw currentResult.error;
      if (!currentResult.data) {
        return res.status(404).json({ success: false, message: "Order not found for this hotel" });
      }
      const currentVersion = Math.max(1, Number(currentResult.data.order_version || 1));
      const currentStatus = getEffectiveKitchenStatus(currentResult.data);
      if (currentVersion !== expectedVersion) {
        return res.status(409).json({ success: false, code: "KDS_TICKET_CHANGED", message: "This kitchen ticket changed. The latest queue has been loaded." });
      }
      if (!isValidStaffKdsTransition(currentStatus, kitchenStatus)) {
        return res.status(409).json({ success: false, code: "KDS_INVALID_TRANSITION", message: `Kitchen stage cannot move from ${currentStatus} to ${kitchenStatus}.` });
      }
      if (!canStaffPerformKdsTransition(req, kitchenStatus)) {
        return res.status(403).json({ success: false, code: "KDS_ROLE_REQUIRED", message: kitchenStatus === "served" ? "Waiter or expo access is required." : "Kitchen access is required." });
      }

      const { data, error } = await supabase
        .from("orders")
        .update({
          kitchen_status: kitchenStatus,
          order_version: currentVersion + 1
        })
        .eq("id", orderId)
        .eq("hotel_slug", hotelSlug)
        .eq("order_version", currentVersion)
        .select("*")
        .maybeSingle();

      if (error) {
        if (isMissingOrderKitchenStatusColumnError(error)) {
          return res.status(400).json({
            success: false,
            message: "Order kitchen status field is not initialized yet"
          });
        }

        throw error;
      }

      if (!data) {
        return res.status(409).json({
          success: false,
          code: "KDS_TICKET_CHANGED",
          message: "This kitchen ticket changed. The latest queue has been loaded."
        });
      }

      const createdByStaffMap = await getOrderCreatedByStaffMap(supabase, [data]);
      const includeFinancials = canStaffViewOrderFinancials(req);

      res.json({
        success: true,
        message: "Kitchen status updated",
        order: buildStaffKdsOrderResponse(data, createdByStaffMap, { includeFinancials })
      });
    } catch (error) {
      console.error("Staff KDS kitchen status update error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to update kitchen status"
      });
    }
  }
);

router.patch(
  "/kds/orders/:id/rounds/:sequence/kitchen-status",
  requireStaffAuth,
  requireStaffFoodModule,
  validateBody(staffKdsKitchenStatusSchema),
  async (req, res) => {
    try {
      const hotelSlug = String(req.staffHotelSlug || "").trim();
      const orderId = String(req.params.id || "").trim();
      const sequence = Number(req.params.sequence);
      const kitchenStatus = String(req.validatedBody.kitchenStatus || "").trim();

      if (!hotelSlug || !Number.isInteger(sequence) || sequence < 2) {
        return res.status(400).json({ success: false, message: "A valid hotel, order, and round are required." });
      }
      if (!isValidStaffKdsOrderId(orderId)) {
        return res.status(400).json({
          success: false,
          code: "INVALID_ORDER_ID",
          message: "A valid order id is required"
        });
      }

      const expectedVersion = Number(req.validatedBody.expectedVersion);
      const { data: currentRound, error: currentRoundError } = await supabase
        .from("order_rounds")
        .select("*")
        .eq("hotel_slug", hotelSlug)
        .eq("order_id", orderId)
        .eq("sequence_number", sequence)
        .maybeSingle();

      if (currentRoundError) {
        if (isMissingOrderRoundsSchemaError(currentRoundError)) {
          return res.status(503).json({ success: false, code: "ORDER_ROUNDS_NOT_INITIALIZED", message: "Order rounds are not initialized yet." });
        }
        throw currentRoundError;
      }
      if (!currentRound) {
        return res.status(404).json({ success: false, code: "ROUND_NOT_FOUND", message: "Kitchen round not found for this hotel and order." });
      }
      if (Number(currentRound.row_version || 1) !== expectedVersion) {
        return res.status(409).json({ success: false, code: "ROUND_CHANGED", message: "This kitchen round changed. Refresh the board and try again." });
      }
      if (!isValidStaffKdsTransition(currentRound.status, kitchenStatus)) {
        return res.status(409).json({ success: false, code: "KDS_INVALID_TRANSITION", message: `Kitchen stage cannot move from ${currentRound.status} to ${kitchenStatus}.` });
      }
      if (!canStaffPerformKdsTransition(req, kitchenStatus)) {
        return res.status(403).json({ success: false, code: "KDS_ROLE_REQUIRED", message: kitchenStatus === "served" ? "Waiter or expo access is required." : "Kitchen access is required." });
      }

      const updatedItems = (Array.isArray(currentRound.items) ? currentRound.items : []).map((item) => ({
        ...item,
        kitchenStatus
      }));
      const { data, error } = await supabase
        .from("order_rounds")
        .update({
          status: kitchenStatus,
          items: updatedItems,
          updated_at: new Date().toISOString(),
          row_version: expectedVersion + 1,
          ...(kitchenStatus === "cancelled" ? { cancelled_at: new Date().toISOString() } : {})
        })
        .eq("hotel_slug", hotelSlug)
        .eq("order_id", orderId)
        .eq("sequence_number", sequence)
        .eq("row_version", expectedVersion)
        .select("*")
        .maybeSingle();

      if (error) {
        if (isMissingOrderRoundsSchemaError(error)) {
          return res.status(503).json({ success: false, code: "ORDER_ROUNDS_NOT_INITIALIZED", message: "Order rounds are not initialized yet." });
        }
        throw error;
      }
      if (!data) {
        return res.status(409).json({ success: false, code: "ROUND_CHANGED", message: "This kitchen round changed. Refresh the board and try again." });
      }

      return res.json({
        success: true,
        message: "Kitchen round status updated",
        round: mapStaffOrderRound(data, { includeFinancials: canStaffViewOrderFinancials(req) })
      });
    } catch (error) {
      console.error("Staff KDS round status update error:", error);
      return res.status(500).json({ success: false, message: "Failed to update kitchen round status" });
    }
  }
);

router.get("/orders/table-activity", requireStaffAuth, requireStaffFoodModule, async (req, res) => {
  try {
    const hotelSlug = String(req.staffHotelSlug || "").trim();

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    const { data, error } = await supabase
      .from("orders")
      .select(STAFF_KDS_ORDER_FIELDS)
      .eq("hotel_slug", hotelSlug)
      .eq("order_type", "dine-in")
      .is("parent_order_id", null)
      .in("status", STAFF_ACTIVE_TABLE_ORDER_STATUSES)
      .not("table_number", "is", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(300);

    if (error) throw error;

    const safeOrders = groupStaffActiveTableOrders(data);
    const includeFinancials = canStaffViewOrderFinancials(req);
    const staffById = await getOrderCreatedByStaffMap(supabase, safeOrders);
    const orders = safeOrders.map((order) => ({
      ...buildStaffKdsOrderResponse(order, staffById, { includeFinancials }),
      activeRecordCount: Number(order.activeRecordCount || 1)
    }));
    const countsByStatus = STAFF_ACTIVE_TABLE_ORDER_STATUSES.reduce(
      (counts, status) => ({
        ...counts,
        [status]: orders.filter((order) => normalizeStatusValue(order.status) === status).length
      }),
      {}
    );

    return res.json({
      success: true,
      hotelSlug,
      activeStatuses: STAFF_ACTIVE_TABLE_ORDER_STATUSES,
      count: orders.length,
      legacyDuplicateScopes: orders.filter((order) => order.activeRecordCount > 1).length,
      countsByStatus,
      orders
    });
  } catch (error) {
    console.error("Staff table activity fetch error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch active table orders"
    });
  }
});

router.get("/orders/table-activity/:id", requireStaffAuth, requireStaffFoodModule, async (req, res) => {
  try {
    const hotelSlug = String(req.staffHotelSlug || "").trim();
    const orderId = String(req.params.id || "").trim();
    const tableNumber = normalizeStaffText(req.query.tableNumber, 80);

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Order id is required"
      });
    }

    let query = supabase
      .from("orders")
      .select(STAFF_ORDER_LIST_FIELDS)
      .eq("id", orderId)
      .eq("hotel_slug", hotelSlug)
      .eq("order_type", "dine-in")
      .is("parent_order_id", null);

    if (tableNumber) {
      query = query.eq("table_number", tableNumber);
    }

    const { data, error } = await query.maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        success: false,
        message: "This order is no longer available or you do not have access to it."
      });
    }

    const includeFinancials = canStaffViewOrderFinancials(req);
    const staffById = await getOrderCreatedByStaffMap(supabase, [data]);
    const roundsByOrderId = await fetchStaffOrderRoundsByOrderIds({ hotelSlug, orderIds: [data.id] });
    const orderWithRounds = attachStaffOrderRounds([data], roundsByOrderId)[0];

    return res.json({
      success: true,
      hotelSlug,
      order: buildStaffOrderResponse(orderWithRounds, staffById, { includeFinancials })
    });
  } catch (error) {
    console.error("Staff selected table order fetch error:", error);
    return res.status(500).json({
      success: false,
      message: "The selected order could not be loaded."
    });
  }
});
router.get("/orders/active-table", requireStaffAuth, requireStaffFoodModule, async (req, res) => {
  try {
    const hotelSlug = String(req.staffHotelSlug || "").trim();
    const tableNumber = normalizeStaffText(req.query.tableNumber, 80);

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    if (!tableNumber) {
      return res.status(400).json({
        success: false,
        message: "Table number is required"
      });
    }

    const { data: activeOrder, error } = await fetchStaffActiveTableOrder({
      hotelSlug,
      tableNumber
    });

    if (error) {
      if (isMissingStaffActiveTableOrderGuard(error)) {
        return res.status(503).json({
          success: false,
          code: "ACTIVE_TABLE_GUARD_NOT_INITIALIZED",
          message: "Active table order protection is not initialized yet"
        });
      }

      throw error;
    }

    return res.json({
      success: true,
      hotelSlug,
      tableNumber,
      activeStatuses: STAFF_ACTIVE_TABLE_ORDER_STATUSES,
      hasActiveOrder: !!activeOrder,
      activeOrder
    });
  } catch (error) {
    console.error("Staff active table order lookup error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to check active table order"
    });
  }
});

router.get("/orders", requireStaffAuth, requireStaffFoodModule, async (req, res) => {
  try {
    const hotelSlug = String(req.staffHotelSlug || "").trim();

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    const range = getStaffOrdersRange(req.query.range);
    const limit = getStaffOrdersLimit(req.query.limit, range);
    const rangeStart = getStaffOrdersRangeStart(range);
    let query = supabase
      .from("orders")
      .select(STAFF_ORDER_LIST_FIELDS)
      .eq("hotel_slug", hotelSlug)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (rangeStart) {
      query = query.gte("created_at", rangeStart.toISOString());
    }

    const { data, error } = await timeDatabaseCall(res, query);

    if (error) throw error;

    const safeOrders = data || [];
    const includeFinancials = canStaffViewOrderFinancials(req);
    const staffById = await timeDatabaseCall(
      res,
      () => getOrderCreatedByStaffMap(supabase, safeOrders)
    );
    const orders = safeOrders.map((order) =>
      buildStaffOrderResponse(order, staffById, { includeFinancials })
    );

    res.json({
      success: true,
      hotelSlug,
      range,
      count: orders.length,
      orders
    });
  } catch (error) {
    console.error("Staff orders fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch staff orders"
    });
  }
});

router.post("/orders", requireStaffAuth, requireStaffFoodModule, validateBody(staffTableOrderSchema), async (req, res) => {
  try {
    const hotelSlug = String(req.staffHotelSlug || "").trim();

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    const orderingSettings = await fetchHotelOrderingSettings(hotelSlug);

    if (orderingSettings.staffOrderingEnabled === false) {
      return res.status(403).json(buildStaffOrderingDisabledPayload(orderingSettings));
    }

    const tableResolution = await resolveTableForOrder({
      hotelSlug,
      restaurantTableId: req.validatedBody.restaurantTableId,
      tableNumber: normalizeStaffText(req.validatedBody.tableNumber, 80),
      enforceTableMaster: orderingSettings.enforceTableMaster
    });

    if (!tableResolution.ok) {
      return res.status(tableResolution.status || 400).json({
        success: false,
        code: tableResolution.code,
        message: tableResolution.message
      });
    }

    const tableNumber = tableResolution.tableNumber;
    const customerName = normalizeStaffText(req.validatedBody.customerName, 100) || "Table Guest";
    const customerPhone = normalizeStaffText(req.validatedBody.customerPhone, 20);
    const note = normalizeStaffText(req.validatedBody.note, 1000);
    const items = req.validatedBody.items || [];
    const pricing = await calculateStaffTableOrderPricing({ hotelSlug, items });

    if (pricing.error) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        details: [
          {
            path: ["items"],
            message: pricing.error
          }
        ]
      });
    }

    const hotelName = pricing.hotel.hotel_name || "Unknown Hotel";
    const orderSummary = buildStaffTableOrderSummary({
      hotelName,
      tableNumber,
      staffUser: req.staffUser,
      customerName,
      customerPhone,
      note,
      items: pricing.items,
      totals: pricing.totals
    });
    const baseOrderRow = {
      hotel_name: hotelName,
      hotel_slug: pricing.hotel.hotel_slug || hotelSlug,
      customer_name: customerName,
      customer_phone: customerPhone,
      customer_address: `Dine-in table ${tableNumber}`,
      payment_method: "COD",
      note,
      items: pricing.items,
      totals: pricing.totals,
      whatsapp_message: orderSummary,
      status: "new"
    };
    const optionalOrderColumns = {
      order_type: "dine-in",
      table_number: tableNumber,
      order_source: "staff",
      payment_status: "unpaid",
      billing_status: "not_billed",
      ...(tableResolution.restaurantTableId
        ? { restaurant_table_id: tableResolution.restaurantTableId }
        : {}),
      ...getStaffOrderCreatorColumns(req.staffUser),
      ...getOrderTrackingColumns()
    };
    const { data, error, conflict } = await insertStaffTableOrderWithActiveTableGuard(
      baseOrderRow,
      optionalOrderColumns
    );

    if (conflict) {
      return res.status(409).json({
        success: false,
        code: "TABLE_HAS_ACTIVE_ORDER",
        message: `Table ${tableNumber} already has an active order. Open the existing order instead.`,
        activeOrder: {
          id: conflict.id || "",
          orderReference: conflict.id ? String(conflict.id) : "",
          status: conflict.status || "",
          tableNumber: conflict.tableNumber || tableNumber
        }
      });
    }

    if (error) {
      if (isMissingStaffActiveTableOrderGuard(error)) {
        return res.status(503).json({
          success: false,
          code: "ACTIVE_TABLE_GUARD_NOT_INITIALIZED",
          message: "Active table order protection is not initialized yet"
        });
      }

      if (isMissingOrderTableContextColumnsError(error)) {
        return res.status(400).json({
          success: false,
          message: "Order table context fields are not initialized yet"
        });
      }

      if (isMissingOrderBillingColumnsError(error)) {
        return res.status(400).json({
          success: false,
          message: "Order billing fields are not initialized yet"
        });
      }

      throw error;
    }

    void createNotificationEventSafely({
      hotelSlug: data.hotel_slug || hotelSlug,
      sourceType: "order",
      sourceId: data.id,
      payload: {
        orderId: data.id,
        hotelName: data.hotel_name || hotelName,
        customerName: data.customer_name || customerName,
        customerPhone: data.customer_phone || customerPhone,
        customerAddress: data.customer_address || `Dine-in table ${tableNumber}`,
        paymentMethod: data.payment_method || "COD",
        paymentStatus: data.payment_status || "unpaid",
        billingStatus: data.billing_status || "not_billed",
        note: data.note || note,
        items: Array.isArray(data.items) ? data.items : pricing.items,
        totals:
          data.totals && typeof data.totals === "object" && !Array.isArray(data.totals)
            ? data.totals
            : pricing.totals,
        whatsappMessage: data.whatsapp_message || orderSummary,
        orderContext: {
          orderType: data.order_type || "dine-in",
          tableNumber: data.table_number || tableNumber,
          orderSource: data.order_source || "staff"
        },
        status: data.status || "new",
        createdByStaff: {
          id: req.staffUser?.sub || req.staffUser?.id || "",
          displayName: req.staffUser?.displayName || "Staff",
          role: req.staffUser?.role || "staff"
        }
      }
    });

    const tracking = buildOrderTrackingReference(data);
    const createdByStaffMap = await getOrderCreatedByStaffMap(supabase, [data]);

    res.status(201).json({
      success: true,
      message: "Staff table order saved",
      order: buildStaffOrderResponse(
        data,
        createdByStaffMap,
        { includeFinancials: canStaffViewOrderFinancials(req) }
      ),
      tracking,
      trackingReady: !!tracking
    });
  } catch (error) {
    console.error("Staff table order create error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create staff table order"
    });
  }
});

router.post(
  "/orders/:id/items",
  requireStaffAuth,
  requireStaffFoodModule,
  validateBody(staffOrderItemAdditionSchema),
  async (req, res) => {
    try {
      const hotelSlug = String(req.staffHotelSlug || "").trim();
      const orderId = String(req.params.id || "").trim();
      const idempotencyKey = String(
        req.get("Idempotency-Key") || req.validatedBody.idempotencyKey || ""
      ).trim();

      if (!hotelSlug) {
        return res.status(403).json({ success: false, message: "Staff hotel scope is missing" });
      }
      if (!orderId) {
        return res.status(400).json({ success: false, message: "Order id is required" });
      }
      if (idempotencyKey.length < 12 || idempotencyKey.length > 160) {
        return res.status(400).json({
          success: false,
          code: "INVALID_IDEMPOTENCY_KEY",
          message: "A valid Idempotency-Key header is required."
        });
      }

      const orderingSettings = await fetchHotelOrderingSettings(hotelSlug);
      if (orderingSettings.staffOrderingEnabled === false) {
        return res.status(403).json(buildStaffOrderingDisabledPayload(orderingSettings));
      }

      const { data: currentOrder, error: currentOrderError } = await supabase
        .from("orders")
        .select("*")
        .eq("id", orderId)
        .eq("hotel_slug", hotelSlug)
        .maybeSingle();

      if (currentOrderError) throw currentOrderError;
      if (!currentOrder) {
        return res.status(404).json({ success: false, code: "ORDER_NOT_FOUND", message: "Order not found for this hotel." });
      }

      const additionPolicy = getStaffOrderAdditionPolicy(currentOrder);
      if (!additionPolicy.allowed) {
        return res.status(409).json({
          success: false,
          code: additionPolicy.code,
          message: additionPolicy.reason
        });
      }

      const tableNumber = normalizeStaffText(req.validatedBody.tableNumber, 80);
      if (normalizeStatusValue(tableNumber) !== normalizeStatusValue(currentOrder.table_number)) {
        return res.status(409).json({
          success: false,
          code: "TABLE_CHANGED",
          message: `This order is no longer assigned to Table ${tableNumber}.`
        });
      }

      const requestedItems = req.validatedBody.items || [];
      const pricing = await calculateStaffTableOrderPricing({ hotelSlug, items: requestedItems });
      if (pricing.error) {
        return res.status(400).json({
          success: false,
          message: "Validation failed",
          details: [{ path: ["items"], message: pricing.error }]
        });
      }

      const note = normalizeStaffText(req.validatedBody.note, 1000);
      const nextTotals = mergeStaffOrderAdditionTotals(currentOrder.totals, pricing.totals);
      const requestFingerprint = buildStaffOrderAdditionFingerprint({
        orderId,
        tableNumber,
        items: requestedItems,
        note
      });
      const createdByStaffId = normalizeOrderCreatedByStaffId(req.staffUser?.sub || req.staffUser?.id);
      const { data: rpcData, error: rpcError } = await supabase.rpc(
        "add_staff_items_to_active_order",
        {
          p_hotel_slug: hotelSlug,
          p_order_id: orderId,
          p_table_number: tableNumber,
          p_expected_version: req.validatedBody.expectedVersion,
          p_idempotency_key: idempotencyKey,
          p_request_fingerprint: requestFingerprint,
          p_items: pricing.items,
          p_totals: nextTotals,
          p_totals_delta: pricing.totals,
          p_note: note,
          p_created_by_staff_id: createdByStaffId || null,
          p_created_by_role: req.staffRole || req.staffUser?.role || "staff"
        }
      );

      if (rpcError) {
        if (isMissingOrderRoundsSchemaError(rpcError)) {
          return res.status(503).json({
            success: false,
            code: "ORDER_ROUNDS_NOT_INITIALIZED",
            message: "Order-round protection is not initialized yet."
          });
        }
        throw rpcError;
      }

      const result = normalizeStaffOrderRoundRpcResult(rpcData);
      if (!result?.ok) {
        const conflictCodes = new Set([
          "ORDER_CLOSED", "PAYMENT_LOCKED", "BILLING_LOCKED", "TABLE_CHANGED",
          "ORDER_VERSION_CONFLICT", "IDEMPOTENCY_KEY_REUSED", "ORDER_NOT_DINE_IN_ROOT"
        ]);
        const status = result?.code === "ORDER_NOT_FOUND" ? 404 : conflictCodes.has(result?.code) ? 409 : 400;
        return res.status(status).json({
          success: false,
          code: result?.code || "ORDER_ADDITION_REJECTED",
          message: result?.message || "The new items could not be added.",
          currentVersion: result?.currentVersion
        });
      }

      const updatedOrder = result.order || null;
      const roundsByOrderId = await fetchStaffOrderRoundsByOrderIds({ hotelSlug, orderIds: [orderId] });
      const orderWithRounds = attachStaffOrderRounds([updatedOrder], roundsByOrderId)[0];
      const createdByStaffMap = await getOrderCreatedByStaffMap(supabase, [updatedOrder]);
      const round = mapStaffOrderRound(result.round || {}, {
        includeFinancials: canStaffViewOrderFinancials(req)
      });

      if (!result.duplicate) {
        void createNotificationEventSafely({
          hotelSlug,
          sourceType: "order",
          sourceId: orderId,
          payload: {
            eventType: "order_items_added",
            orderId,
            tableNumber,
            roundSequence: round.sequence,
            kotReference: round.kotReference,
            items: round.items,
            note: round.note,
            createdByStaff: {
              id: req.staffUser?.sub || req.staffUser?.id || "",
              displayName: req.staffUser?.displayName || "Staff",
              role: req.staffRole || req.staffUser?.role || "staff"
            }
          }
        });
      }

      return res.status(result.duplicate ? 200 : 201).json({
        success: true,
        duplicate: result.duplicate === true,
        message: result.duplicate
          ? "This item-addition request was already completed."
          : `Round ${round.sequence} added and sent to kitchen.`,
        order: buildStaffKdsOrderResponse(orderWithRounds, createdByStaffMap, {
          includeFinancials: canStaffViewOrderFinancials(req)
        }),
        round
      });
    } catch (error) {
      console.error("Staff active order item addition error:", error);
      return res.status(500).json({ success: false, message: "Failed to add items to the active order" });
    }
  }
);

router.post("/room-service-orders", requireStaffAuth, requireStaffRoomService, validateBody(staffRoomServiceOrderSchema), async (req, res) => {
  try {
    const hotelSlug = String(req.staffHotelSlug || "").trim();

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    const orderingSettings = await fetchHotelOrderingSettings(hotelSlug);

    if (orderingSettings.staffOrderingEnabled === false) {
      return res.status(403).json(buildStaffOrderingDisabledPayload(orderingSettings));
    }

    const roomServiceSettings = await fetchStaffRoomServiceFeatureSettings(hotelSlug);

    if (!roomServiceSettings.roomServiceEnabled) {
      return res.status(403).json({
        success: false,
        code: "ROOM_SERVICE_DISABLED",
        message: "Room service ordering is not enabled for this hotel"
      });
    }

    const roomBookingId = req.validatedBody.roomBookingId;
    const roomContext = await fetchCheckedInRoomServiceBooking({ hotelSlug, roomBookingId });

    if (roomContext.error) {
      return res.status(roomContext.status || 400).json({
        success: false,
        message: roomContext.error
      });
    }

    const booking = roomContext.booking;
    const room = roomContext.room;
    const roomNumber = normalizeStaffText(room.room_number, 80);
    const customerName =
      normalizeStaffText(req.validatedBody.customerName, 100) ||
      normalizeStaffText(booking.guest_name, 100) ||
      "Room Guest";
    const customerPhone =
      normalizeStaffText(req.validatedBody.customerPhone, 20) ||
      normalizeStaffText(booking.guest_phone, 20);
    const chargeToRoom = req.validatedBody.chargeToRoom === true;
    const paymentMethod = chargeToRoom
      ? "Room Bill"
      : normalizeStaffText(req.validatedBody.paymentMethod, 40) || "COD";
    const note = normalizeStaffText(req.validatedBody.note, 1000);
    const items = req.validatedBody.items || [];
    const pricing = await calculateStaffTableOrderPricing({ hotelSlug, items });

    if (pricing.error) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        details: [
          {
            path: ["items"],
            message: pricing.error
          }
        ]
      });
    }

    const hotelName = pricing.hotel.hotel_name || "Unknown Hotel";
    const orderSummary = buildStaffRoomServiceOrderSummary({
      hotelName,
      roomNumber,
      roomBookingId: booking.id,
      staffUser: req.staffUser,
      customerName,
      customerPhone,
      chargeToRoom,
      paymentMethod,
      note,
      items: pricing.items,
      totals: pricing.totals
    });
    const baseOrderRow = {
      hotel_name: hotelName,
      hotel_slug: pricing.hotel.hotel_slug || hotelSlug,
      customer_name: customerName,
      customer_phone: customerPhone,
      customer_address: roomNumber ? `Room service - Room ${roomNumber}` : "Room service",
      payment_method: paymentMethod,
      note,
      items: pricing.items,
      totals: pricing.totals,
      whatsapp_message: orderSummary,
      status: "new"
    };
    const optionalOrderColumns = {
      order_type: "room_service",
      table_number: "",
      order_source: "room_service",
      payment_status: "unpaid",
      billing_status: "not_billed",
      room_id: room.id,
      room_booking_id: booking.id,
      room_number: roomNumber,
      room_service_guest_name: customerName,
      room_service_charge_to_room: chargeToRoom,
      ...getStaffOrderCreatorColumns(req.staffUser),
      ...getOrderTrackingColumns()
    };
    const { data, error } = await insertStaffTableOrderRow(baseOrderRow, optionalOrderColumns);

    if (error) {
      if (isMissingOrderRoomServiceColumnsError(error)) {
        return res.status(400).json({
          success: false,
          schemaReady: false,
          message: "Order room service fields are not initialized yet"
        });
      }

      if (isMissingOrderTableContextColumnsError(error)) {
        return res.status(400).json({
          success: false,
          message: "Order table context fields are not initialized yet"
        });
      }

      if (isMissingOrderBillingColumnsError(error)) {
        return res.status(400).json({
          success: false,
          message: "Order billing fields are not initialized yet"
        });
      }

      throw error;
    }

    void createNotificationEventSafely({
      hotelSlug: data.hotel_slug || hotelSlug,
      sourceType: "order",
      sourceId: data.id,
      payload: {
        orderId: data.id,
        hotelName: data.hotel_name || hotelName,
        customerName: data.customer_name || customerName,
        customerPhone: data.customer_phone || customerPhone,
        customerAddress: data.customer_address || baseOrderRow.customer_address,
        paymentMethod: data.payment_method || paymentMethod,
        paymentStatus: data.payment_status || "unpaid",
        billingStatus: data.billing_status || "not_billed",
        note: data.note || note,
        items: Array.isArray(data.items) ? data.items : pricing.items,
        totals:
          data.totals && typeof data.totals === "object" && !Array.isArray(data.totals)
            ? data.totals
            : pricing.totals,
        whatsappMessage: data.whatsapp_message || orderSummary,
        orderContext: {
          orderType: data.order_type || "room_service",
          tableNumber: data.table_number || "",
          orderSource: data.order_source || "room_service"
        },
        roomService: {
          roomId: data.room_id ? String(data.room_id) : String(room.id || ""),
          roomBookingId: data.room_booking_id ? String(data.room_booking_id) : String(booking.id || ""),
          roomNumber: data.room_number || roomNumber,
          guestName: data.room_service_guest_name || customerName,
          chargeToRoom: data.room_service_charge_to_room === true || chargeToRoom
        },
        status: data.status || "new",
        createdByStaff: {
          id: req.staffUser?.sub || req.staffUser?.id || "",
          displayName: req.staffUser?.displayName || "Staff",
          role: req.staffUser?.role || "staff"
        }
      }
    });

    const tracking = buildOrderTrackingReference(data);
    const createdByStaffMap = await getOrderCreatedByStaffMap(supabase, [data]);

    res.status(201).json({
      success: true,
      message: "Room service order saved",
      order: buildStaffOrderResponse(data, createdByStaffMap, {
        includeFinancials: canStaffViewOrderFinancials(req)
      }),
      tracking,
      trackingReady: !!tracking
    });
  } catch (error) {
    if (isMissingRoomServiceSchemaError(error)) {
      return res.status(400).json({
        success: false,
        schemaReady: false,
        message: "Room service schema is not initialized yet"
      });
    }

    console.error("Staff room service order create error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create room service order"
    });
  }
});

router.get("/orders-reports", requireStaffAuth, requireStaffManagerAccess, requireStaffFoodReports, async (req, res) => {
  try {
    const hotelSlug = String(req.staffHotelSlug || "").trim();

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    const reportStarts = getStaffOperationalReportStarts();
    const orders = await fetchStaffOrdersForReports({
      hotelSlug,
      startDate: reportStarts.earliestStart
    });

    res.json({
      success: true,
      hotelSlug,
      reports: buildStaffOperationalReports(orders, reportStarts),
      trend: {
        financialsVisible: true,
        ...buildStaffOrderTrend({
          orders,
          period: reportStarts.trendPeriod,
          getOrderTotal: getStaffOrderTotalAmount
        })
      }
    });
  } catch (error) {
    console.error("Staff order reports fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch staff order reports"
    });
  }
});

router.get("/orders-item-sales-reports", requireStaffAuth, requireStaffManagerAccess, requireStaffFoodReports, async (req, res) => {
  try {
    const hotelSlug = String(req.staffHotelSlug || "").trim();

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    const reportStarts = getStaffOperationalReportStarts();
    const orders = await fetchStaffOrdersForReports({
      hotelSlug,
      startDate: reportStarts.earliestStart
    });

    res.json({
      success: true,
      hotelSlug,
      itemSalesReports: buildStaffItemSalesReports(orders, reportStarts)
    });
  } catch (error) {
    console.error("Staff item sales reports fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch staff item sales reports"
    });
  }
});

router.get("/reports/business", requireStaffAuth, requireStaffManagerAccess, async (req, res) => {
  try {
    const hotelSlug = String(req.staffHotelSlug || "").trim();

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    const period = getStaffReportPeriod(req.query);

    if (!period.ok) {
      return res.status(400).json({
        success: false,
        message: period.message
      });
    }

    const featureConfig = await fetchHotelFeatureConfig(supabase, hotelSlug);
    const requestedType = String(req.query.type || "").trim().toLowerCase();
    const defaultType = featureConfig.canUseFoodReports
      ? "food"
      : featureConfig.canUseRoomReports
        ? "rooms"
        : "";
    const reportType = ["food", "rooms", "combined"].includes(requestedType)
      ? requestedType
      : defaultType;
    const requiredFeature = {
      food: "food_reports",
      rooms: "room_reports",
      combined: "combined_reports"
    }[reportType];

    if (!requiredFeature || !isHotelFeatureEnabled(featureConfig, requiredFeature)) {
      return res.status(403).json(buildFeatureDisabledPayload(requiredFeature || "reports"));
    }

    let report = null;

    if (reportType === "food") {
      const { orders, truncated } = await fetchStaffOrdersForBusinessReport({ hotelSlug, period });
      const staffById = await getOrderCreatedByStaffMap(supabase, orders);
      report = {
        reportType: "food",
        ...buildStaffBusinessReport({ hotelSlug, orders, staffById, period, truncated })
      };
    } else if (reportType === "rooms") {
      const roomData = await fetchStaffRoomReportData({ hotelSlug, period });
      report = buildStaffRoomBusinessReport({ hotelSlug, period, data: roomData });
    } else {
      const [foodResult, roomData] = await Promise.all([
        fetchStaffOrdersForBusinessReport({ hotelSlug, period }),
        fetchStaffRoomReportData({ hotelSlug, period })
      ]);
      const staffById = await getOrderCreatedByStaffMap(supabase, foodResult.orders);
      const foodReport = {
        reportType: "food",
        ...buildStaffBusinessReport({
          hotelSlug,
          orders: foodResult.orders,
          staffById,
          period,
          truncated: foodResult.truncated
        })
      };
      const roomReport = buildStaffRoomBusinessReport({ hotelSlug, period, data: roomData });
      report = buildStaffCombinedBusinessReport({
        hotelSlug,
        period,
        foodReport,
        roomReport
      });
    }

    res.json({
      success: true,
      reportType,
      features: featureConfig,
      report
    });
  } catch (error) {
    console.error("Staff business report fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch staff business report"
    });
  }
});

router.get("/reservations", requireStaffAuth, requireStaffManagerAccess, requireStaffFoodModule, async (req, res) => {
  try {
    const hotelSlug = String(req.staffHotelSlug || "").trim();

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    const range = getStaffOrdersRange(req.query.range);
    const limit = getStaffOrdersLimit(req.query.limit, range);
    const rangeStart = getStaffOrdersRangeStart(range);
    let query = supabase
      .from("reservations")
      .select("*")
      .eq("hotel_slug", hotelSlug)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (rangeStart) {
      query = query.gte("created_at", rangeStart.toISOString());
    }

    const { data, error } = await query;

    if (error) throw error;

    const reservations = (data || []).map(buildStaffReservationResponse);

    res.json({
      success: true,
      hotelSlug,
      range,
      count: reservations.length,
      reservations
    });
  } catch (error) {
    console.error("Staff reservations fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch staff reservations"
    });
  }
});

router.get("/inquiries", requireStaffAuth, requireStaffManagerAccess, async (req, res) => {
  try {
    const hotelSlug = String(req.staffHotelSlug || "").trim();

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    const range = getStaffOrdersRange(req.query.range);
    const limit = getStaffOrdersLimit(req.query.limit, range);
    const rangeStart = getStaffOrdersRangeStart(range);
    let query = supabase
      .from("inquiries")
      .select("*")
      .eq("hotel_slug", hotelSlug)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (rangeStart) {
      query = query.gte("created_at", rangeStart.toISOString());
    }

    const { data, error } = await query;

    if (error) throw error;

    const inquiries = (data || []).map(buildStaffInquiryResponse);

    res.json({
      success: true,
      hotelSlug,
      range,
      count: inquiries.length,
      inquiries
    });
  } catch (error) {
    console.error("Staff inquiries fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch staff inquiries"
    });
  }
});

router.get("/contact-submissions", requireStaffAuth, requireStaffManagerAccess, async (req, res) => {
  try {
    const hotelSlug = String(req.staffHotelSlug || "").trim();

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    const range = getStaffOrdersRange(req.query.range);
    const limit = getStaffOrdersLimit(req.query.limit, range);
    const rangeStart = getStaffOrdersRangeStart(range);
    let query = supabase
      .from("contact_submissions")
      .select("*")
      .eq("hotel_slug", hotelSlug)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (rangeStart) {
      query = query.gte("created_at", rangeStart.toISOString());
    }

    const { data, error } = await query;

    if (error) {
      if (isMissingContactSubmissionsRelationError(error)) {
        return res.json({
          success: true,
          hotelSlug,
          range,
          count: 0,
          contactSubmissions: []
        });
      }

      throw error;
    }

    const contactSubmissions = (data || []).map(buildStaffContactSubmissionResponse);

    res.json({
      success: true,
      hotelSlug,
      range,
      count: contactSubmissions.length,
      contactSubmissions
    });
  } catch (error) {
    console.error("Staff contact submissions fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch staff contact submissions"
    });
  }
});

router.get("/support-requests", requireStaffAuth, requireStaffFoodModule, async (req, res) => {
  try {
    const hotelSlug = String(req.staffHotelSlug || "").trim();

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    const range = getStaffOrdersRange(req.query.range);
    const limit = getStaffOrdersLimit(req.query.limit, range);
    const rangeStart = getStaffOrdersRangeStart(range);
    let query = supabase
      .from("order_support_requests")
      .select("*")
      .eq("hotel_slug", hotelSlug)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (rangeStart) {
      query = query.gte("created_at", rangeStart.toISOString());
    }

    const { data, error } = await query;

    if (error) {
      if (isMissingOrderSupportRequestsRelationError(error)) {
        return res.json({
          success: true,
          hotelSlug,
          range,
          count: 0,
          supportRequests: []
        });
      }

      throw error;
    }

    const supportRequests = (data || []).map(buildStaffSupportRequestResponse);

    res.json({
      success: true,
      hotelSlug,
      range,
      count: supportRequests.length,
      supportRequests
    });
  } catch (error) {
    console.error("Staff support requests fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch staff support requests"
    });
  }
});

router.get("/testimonials", requireStaffAuth, requireStaffManagerAccess, async (req, res) => {
  try {
    const hotelSlug = String(req.staffHotelSlug || "").trim();

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    const range = getStaffOrdersRange(req.query.range);
    const limit = getStaffOrdersLimit(req.query.limit, range);
    const rangeStart = getStaffOrdersRangeStart(range);
    let query = supabase
      .from("testimonials")
      .select("*")
      .eq("hotel_slug", hotelSlug)
      .order("is_approved", { ascending: true })
      .order("created_at", { ascending: false })
      .limit(limit);

    if (rangeStart) {
      query = query.gte("created_at", rangeStart.toISOString());
    }

    const { data, error } = await query;

    if (error) {
      if (isMissingTestimonialsRelationError(error)) {
        return res.json({
          success: true,
          hotelSlug,
          range,
          count: 0,
          testimonials: []
        });
      }

      throw error;
    }

    const testimonials = (data || []).map(buildStaffTestimonialResponse);

    res.json({
      success: true,
      hotelSlug,
      range,
      count: testimonials.length,
      testimonials
    });
  } catch (error) {
    console.error("Staff testimonials fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch staff testimonials"
    });
  }
});

router.patch("/reservations/:id/status", requireStaffAuth, requireStaffManagerAccess, requireStaffFoodModule, async (req, res) => {
  await updateStaffScopedRecordStatus(req, res, {
    table: "reservations",
    label: "Reservation",
    responseKey: "reservation",
    allowedStatuses: STAFF_RESERVATION_STATUSES,
    buildResponse: buildStaffReservationResponse
  });
});

router.patch("/inquiries/:id/status", requireStaffAuth, requireStaffManagerAccess, async (req, res) => {
  await updateStaffScopedRecordStatus(req, res, {
    table: "inquiries",
    label: "Inquiry",
    responseKey: "inquiry",
    allowedStatuses: STAFF_INQUIRY_STATUSES,
    buildResponse: buildStaffInquiryResponse
  });
});

router.patch("/contact-submissions/:id/status", requireStaffAuth, requireStaffManagerAccess, async (req, res) => {
  await updateStaffScopedRecordStatus(req, res, {
    table: "contact_submissions",
    label: "Contact message",
    responseKey: "contactSubmission",
    allowedStatuses: STAFF_CONTACT_SUBMISSION_STATUSES,
    buildResponse: buildStaffContactSubmissionResponse,
    isMissingRelationError: isMissingContactSubmissionsRelationError,
    missingRelationMessage: "Contact submissions table is not initialized yet"
  });
});

router.patch("/support-requests/:id/status", requireStaffAuth, requireStaffFoodModule, async (req, res) => {
  await updateStaffScopedRecordStatus(req, res, {
    table: "order_support_requests",
    label: "Support request",
    responseKey: "supportRequest",
    allowedStatuses: STAFF_SUPPORT_REQUEST_STATUSES,
    buildResponse: buildStaffSupportRequestResponse,
    isMissingRelationError: isMissingOrderSupportRequestsRelationError,
    missingRelationMessage: "Support requests table is not initialized yet"
  });
});

router.patch("/testimonials/:id/approval", requireStaffAuth, requireStaffManagerAccess, async (req, res) => {
  try {
    const hotelSlug = String(req.staffHotelSlug || "").trim();
    const testimonialId = String(req.params.id || "").trim();
    const { isApproved, expectedUpdatedAt = "", moderationAction = "" } = req.body || {};

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    if (!testimonialId) {
      return res.status(400).json({
        success: false,
        message: "Testimonial id is required"
      });
    }

    if (typeof isApproved !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "isApproved must be true or false"
      });
    }
    const normalizedModerationAction = String(moderationAction || "").trim().toLowerCase();
    if (normalizedModerationAction && !["approve", "reject", "unapprove"].includes(normalizedModerationAction)) {
      return res.status(400).json({
        success: false,
        message: "Unsupported testimonial moderation action"
      });
    }
    const requestedAction = normalizedModerationAction || (isApproved ? "approve" : "unapprove");

    const currentResult = await supabase
      .from("testimonials")
      .select("*")
      .eq("id", testimonialId)
      .eq("hotel_slug", hotelSlug)
      .maybeSingle();

    if (currentResult.error) {
      if (isMissingTestimonialsRelationError(currentResult.error)) {
        return res.status(400).json({
          success: false,
          message: "Testimonials table is not initialized yet"
        });
      }
      throw currentResult.error;
    }

    if (!currentResult.data) {
      return res.status(404).json({
        success: false,
        message: "Testimonial not found for this hotel"
      });
    }

    const currentUpdatedAt = String(currentResult.data.updated_at || "");
    if (expectedUpdatedAt && String(expectedUpdatedAt) !== currentUpdatedAt) {
      return res.status(409).json({
        success: false,
        code: "testimonial_changed",
        message: "This review changed after it was loaded. Refresh and retry."
      });
    }

    const nextUpdatedAt = new Date().toISOString();
    const moderationUpdate = {
      is_approved: requestedAction === "approve",
      is_active: requestedAction === "reject" ? false : requestedAction === "approve" ? true : currentResult.data.is_active,
      is_archived: requestedAction === "reject" ? true : requestedAction === "approve" ? false : currentResult.data.is_archived,
      updated_at: nextUpdatedAt
    };
    const { data, error } = await supabase
      .from("testimonials")
      .update(moderationUpdate)
      .eq("id", testimonialId)
      .eq("hotel_slug", hotelSlug)
      .eq("updated_at", currentUpdatedAt)
      .select()
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      return res.status(409).json({
        success: false,
        code: "testimonial_changed",
        message: "This review changed while it was being moderated. Refresh and retry."
      });
    }

    invalidatePublicTestimonialsCache(hotelSlug);
    logger.info("Hotel testimonial approval updated", {
      requestId: req.requestId || "",
      hotelSlug,
      testimonialId,
      staffUserId: String(req.staffUser?.sub || req.staffUser?.id || ""),
      staffRole: String(req.staffRole || req.staffUser?.role || ""),
      previousApproved: currentResult.data.is_approved === true,
      nextApproved: moderationUpdate.is_approved,
      moderationAction: requestedAction
    });

    return res.json({
      success: true,
      message: requestedAction === "reject" ? "Testimonial rejected" : "Testimonial approval updated",
      testimonial: buildStaffTestimonialResponse(data)
    });
  } catch (error) {
    console.error("Staff testimonial approval update error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update testimonial approval"
    });
  }
});

router.patch("/orders/:id/status", requireStaffAuth, requireStaffFoodModule, async (req, res) => {
  try {
    const hotelSlug = String(req.staffHotelSlug || "").trim();
    const orderId = String(req.params.id || "").trim();
    const status = getAllowedStaffStatus(req.body?.status, STAFF_ORDER_STATUSES);

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Order id is required"
      });
    }

    if (!status) {
      return res.status(400).json({
        success: false,
        message: `Status must be one of: ${STAFF_ORDER_STATUSES.join(", ")}`
      });
    }
    const lifecycleUpdate = {
      status,
      kitchen_status: {
        new: "new",
        confirmed: "accepted",
        preparing: "preparing",
        completed: "served",
        cancelled: "cancelled"
      }[status]
    };

    const { data, error } = await supabase
      .from("orders")
      .update(lifecycleUpdate)
      .eq("id", orderId)
      .eq("hotel_slug", hotelSlug)
      .select()
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        success: false,
        message: "Order not found for this hotel"
      });
    }

    const createdByStaffMap = await getOrderCreatedByStaffMap(supabase, [data]);

    res.json({
      success: true,
      message: "Order status updated",
      order: buildStaffOrderResponse(
        data,
        createdByStaffMap,
        { includeFinancials: canStaffViewOrderFinancials(req) }
      )
    });
  } catch (error) {
    console.error("Staff order status update error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update order status"
    });
  }
});

router.patch("/orders/:id/mark-billed", requireStaffAuth, requireStaffManagerAccess, requireStaffFoodModule, async (req, res) => {
  try {
    const hotelSlug = String(req.staffHotelSlug || "").trim();
    const orderId = String(req.params.id || "").trim();

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Order id is required"
      });
    }

    const { data: currentOrder, error: currentOrderError } = await supabase
      .from("orders")
      .select(STAFF_ORDER_LIST_FIELDS)
      .eq("id", orderId)
      .eq("hotel_slug", hotelSlug)
      .maybeSingle();

    if (currentOrderError) {
      if (isMissingOrderBillingColumnsError(currentOrderError)) {
        return res.status(400).json({
          success: false,
          message: "Order billing fields are not initialized yet"
        });
      }

      throw currentOrderError;
    }

    if (!currentOrder) {
      return res.status(404).json({
        success: false,
        message: "Order not found for this hotel"
      });
    }

    if (
      normalizeStatusValue(currentOrder.billing_status) === "billed" &&
      currentOrder.bill_number
    ) {
      const createdByStaffMap = await getOrderCreatedByStaffMap(supabase, [currentOrder]);
      return res.json({
        success: true,
        idempotentReplay: true,
        message: "Order already billed",
        order: buildStaffOrderResponse(currentOrder, createdByStaffMap)
      });
    }

    const isAlreadyBilled = normalizeStatusValue(currentOrder.billing_status) === "billed";
    const billedAt = isAlreadyBilled && currentOrder.billed_at
      ? currentOrder.billed_at
      : new Date().toISOString();
    const currentVersion = Math.max(1, Number(currentOrder.order_version || 1));
    const updatePayload = {
      billing_status: "billed",
      billed_at: billedAt,
      order_version: currentVersion + 1
    };

    if (!currentOrder.bill_number) {
      updatePayload.bill_number = buildOrderBillNumber(currentOrder, billedAt);
    }

    const { data, error } = await supabase
      .from("orders")
      .update(updatePayload)
      .eq("id", orderId)
      .eq("hotel_slug", hotelSlug)
      .select(STAFF_ORDER_LIST_FIELDS)
      .eq("order_version", currentVersion)
      .maybeSingle();

    if (error) {
      if (isMissingOrderBillingColumnsError(error)) {
        return res.status(400).json({
          success: false,
          message: "Order billing fields are not initialized yet"
        });
      }

      throw error;
    }

    if (!data) {
      const { data: latestOrder, error: latestOrderError } = await supabase
        .from("orders")
        .select(STAFF_ORDER_LIST_FIELDS)
        .eq("id", orderId)
        .eq("hotel_slug", hotelSlug)
        .maybeSingle();

      if (latestOrderError) throw latestOrderError;
      if (!latestOrder) {
        return res.status(404).json({
          success: false,
          message: "Order not found for this hotel"
        });
      }

      const latestStaffMap = await getOrderCreatedByStaffMap(supabase, [latestOrder]);
      const latestResponse = buildStaffOrderResponse(latestOrder, latestStaffMap);
      if (
        normalizeStatusValue(latestOrder.billing_status) === "billed" &&
        latestOrder.bill_number
      ) {
        return res.json({
          success: true,
          idempotentReplay: true,
          message: "Order already billed",
          order: latestResponse
        });
      }

      return res.status(409).json({
        success: false,
        code: "ORDER_VERSION_CONFLICT",
        message: "The order changed before billing. The latest status has been restored.",
        order: latestResponse
      });
    }

    const createdByStaffMap = await getOrderCreatedByStaffMap(supabase, [data]);
    let foodBillSnapshotReady = false;
    try {
      foodBillSnapshotReady = await issueFoodBillSnapshotIfFinal({
        supabaseClient: supabase,
        hotelSlug,
        orderId: data.id,
        actor: {
          id: req.staffUser?.sub || req.staffUser?.id || null,
          role: req.staffRole || req.staffUser?.role || "owner",
          displayName: req.staffUser?.displayName || "Hotel staff"
        }
      });
    } catch (snapshotError) {
      console.error("Food bill snapshot issue after billing failed:", snapshotError);
    }

    res.json({
      success: true,
      message: "Order marked billed",
      foodBillSnapshotReady,
      order: buildStaffOrderResponse(
        data,
        createdByStaffMap
      )
    });
  } catch (error) {
    console.error("Staff mark billed error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to mark order billed"
    });
  }
});

router.patch("/orders/:id/mark-paid", requireStaffAuth, requireStaffManagerAccess, requireStaffFoodModule, async (req, res) => {
  try {
    const hotelSlug = String(req.staffHotelSlug || "").trim();
    const orderId = String(req.params.id || "").trim();

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Order id is required"
      });
    }

    const { data: currentOrder, error: currentOrderError } = await supabase
      .from("orders")
      .select(STAFF_ORDER_LIST_FIELDS)
      .eq("id", orderId)
      .eq("hotel_slug", hotelSlug)
      .maybeSingle();

    if (currentOrderError) {
      if (isMissingOrderBillingColumnsError(currentOrderError)) {
        return res.status(400).json({
          success: false,
          message: "Order billing fields are not initialized yet"
        });
      }

      throw currentOrderError;
    }

    if (!currentOrder) {
      return res.status(404).json({
        success: false,
        message: "Order not found for this hotel"
      });
    }

    if (normalizeStatusValue(currentOrder.payment_status) === "paid") {
      const createdByStaffMap = await getOrderCreatedByStaffMap(supabase, [currentOrder]);
      return res.json({
        success: true,
        idempotentReplay: true,
        message: "Order already paid",
        order: buildStaffOrderResponse(currentOrder, createdByStaffMap)
      });
    }

    const isAlreadyPaid = normalizeStatusValue(currentOrder.payment_status) === "paid";
    const paidAt = isAlreadyPaid && currentOrder.paid_at
      ? currentOrder.paid_at
      : new Date().toISOString();
    const currentVersion = Math.max(1, Number(currentOrder.order_version || 1));

    const { data, error } = await supabase
      .from("orders")
      .update({
        payment_status: "paid",
        paid_at: paidAt,
        order_version: currentVersion + 1
      })
      .eq("id", orderId)
      .eq("hotel_slug", hotelSlug)
      .select(STAFF_ORDER_LIST_FIELDS)
      .eq("order_version", currentVersion)
      .maybeSingle();

    if (error) {
      if (isMissingOrderBillingColumnsError(error)) {
        return res.status(400).json({
          success: false,
          message: "Order billing fields are not initialized yet"
        });
      }

      throw error;
    }

    if (!data) {
      const { data: latestOrder, error: latestOrderError } = await supabase
        .from("orders")
        .select(STAFF_ORDER_LIST_FIELDS)
        .eq("id", orderId)
        .eq("hotel_slug", hotelSlug)
        .maybeSingle();

      if (latestOrderError) throw latestOrderError;
      if (!latestOrder) {
        return res.status(404).json({
          success: false,
          message: "Order not found for this hotel"
        });
      }

      const latestStaffMap = await getOrderCreatedByStaffMap(supabase, [latestOrder]);
      const latestResponse = buildStaffOrderResponse(latestOrder, latestStaffMap);
      if (normalizeStatusValue(latestOrder.payment_status) === "paid") {
        return res.json({
          success: true,
          idempotentReplay: true,
          message: "Order already paid",
          order: latestResponse
        });
      }

      return res.status(409).json({
        success: false,
        code: "ORDER_VERSION_CONFLICT",
        message: "The order changed before payment. The latest status has been restored.",
        order: latestResponse
      });
    }

    const createdByStaffMap = await getOrderCreatedByStaffMap(supabase, [data]);

    res.json({
      success: true,
      message: "Order marked paid",
      order: buildStaffOrderResponse(
        data,
        createdByStaffMap
      )
    });
  } catch (error) {
    console.error("Staff mark paid error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to mark order paid"
    });
  }
});

router.patch("/orders/:id/mark-family-billed", requireStaffAuth, requireStaffManagerAccess, requireStaffFoodModule, async (req, res) => {
  try {
    const hotelSlug = String(req.staffHotelSlug || "").trim();
    const orderId = String(req.params.id || "").trim();

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Order id is required"
      });
    }

    const { parentOrder, familyOrders } = await fetchStaffOrderFamily({ hotelSlug, orderId });

    if (!parentOrder) {
      return res.status(404).json({
        success: false,
        message: "Order not found for this hotel"
      });
    }

    if (parentOrder.parent_order_id) {
      return res.status(409).json({
        success: false,
        message: "Open the parent order to mark the full table family billed"
      });
    }

    const updatedOrders = await updateStaffOrderFamilyRecords({
      familyOrders,
      buildUpdatePayload(order) {
        const isAlreadyBilled = normalizeStatusValue(order.billing_status) === "billed";
        const billedAt = isAlreadyBilled && order.billed_at
          ? order.billed_at
          : new Date().toISOString();
        const updatePayload = {
          billing_status: "billed",
          billed_at: billedAt
        };

        if (!order.bill_number) {
          updatePayload.bill_number = buildOrderBillNumber(order, billedAt);
        }

        return updatePayload;
      }
    });

    const createdByStaffMap = await getOrderCreatedByStaffMap(supabase, updatedOrders);
    const foodBillSnapshotResults = await Promise.all(updatedOrders.map(async (order) => {
      try {
        return await issueFoodBillSnapshotIfFinal({
          supabaseClient: supabase,
          hotelSlug,
          orderId: order.id,
          actor: {
            id: req.staffUser?.sub || req.staffUser?.id || null,
            role: req.staffRole || req.staffUser?.role || "owner",
            displayName: req.staffUser?.displayName || "Hotel staff"
          }
        });
      } catch (snapshotError) {
        console.error("Food family bill snapshot issue failed:", snapshotError);
        return false;
      }
    }));

    res.json({
      success: true,
      message: `Marked ${updatedOrders.length} linked order${updatedOrders.length === 1 ? "" : "s"} billed`,
      foodBillSnapshotsReady: foodBillSnapshotResults.filter(Boolean).length,
      orders: updatedOrders.map((order) => buildStaffOrderResponse(order, createdByStaffMap))
    });
  } catch (error) {
    if (isMissingOrderBillingColumnsError(error)) {
      return res.status(400).json({
        success: false,
        message: "Order billing fields are not initialized yet"
      });
    }

    if (isMissingOrderAddonMetadataColumnsError(error)) {
      return res.status(400).json({
        success: false,
        message: "Order add-on metadata fields are not initialized yet"
      });
    }

    console.error("Staff mark family billed error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to mark table family billed"
    });
  }
});

router.patch("/orders/:id/mark-family-paid", requireStaffAuth, requireStaffManagerAccess, requireStaffFoodModule, async (req, res) => {
  try {
    const hotelSlug = String(req.staffHotelSlug || "").trim();
    const orderId = String(req.params.id || "").trim();

    if (!hotelSlug) {
      return res.status(403).json({
        success: false,
        message: "Staff hotel scope is missing"
      });
    }

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Order id is required"
      });
    }

    const { parentOrder, familyOrders } = await fetchStaffOrderFamily({ hotelSlug, orderId });

    if (!parentOrder) {
      return res.status(404).json({
        success: false,
        message: "Order not found for this hotel"
      });
    }

    if (parentOrder.parent_order_id) {
      return res.status(409).json({
        success: false,
        message: "Open the parent order to mark the full table family paid"
      });
    }

    const updatedOrders = await updateStaffOrderFamilyRecords({
      familyOrders,
      buildUpdatePayload(order) {
        const isAlreadyPaid = normalizeStatusValue(order.payment_status) === "paid";
        const paidAt = isAlreadyPaid && order.paid_at
          ? order.paid_at
          : new Date().toISOString();

        return {
          payment_status: "paid",
          paid_at: paidAt
        };
      }
    });

    const createdByStaffMap = await getOrderCreatedByStaffMap(supabase, updatedOrders);

    res.json({
      success: true,
      message: `Marked ${updatedOrders.length} linked order${updatedOrders.length === 1 ? "" : "s"} paid`,
      orders: updatedOrders.map((order) => buildStaffOrderResponse(order, createdByStaffMap))
    });
  } catch (error) {
    if (isMissingOrderBillingColumnsError(error)) {
      return res.status(400).json({
        success: false,
        message: "Order billing fields are not initialized yet"
      });
    }

    if (isMissingOrderAddonMetadataColumnsError(error)) {
      return res.status(400).json({
        success: false,
        message: "Order add-on metadata fields are not initialized yet"
      });
    }

    console.error("Staff mark family paid error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to mark table family paid"
    });
  }
});

router.get("/me", requireStaffAuth, async (req, res) => {
  try {
    const featureConfig = await fetchHotelFeatureConfig(supabase, req.staffHotelSlug);

    res.json({
      success: true,
      staffUser: buildStaffSessionResponse(req.staffUser, featureConfig),
      features: featureConfig
    });
  } catch (error) {
    console.error("Staff session feature resolution error:", error);
    res.status(503).json({
      success: false,
      code: "FEATURE_CONFIGURATION_UNAVAILABLE",
      message: "Hotel feature configuration could not be loaded"
    });
  }
});

module.exports = router;


