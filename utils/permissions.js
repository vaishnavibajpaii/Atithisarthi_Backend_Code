"use strict";

const PERMISSIONS = Object.freeze({
  SESSION_READ: "session.read",
  MENU_READ: "menu.read",
  ORDERS_READ: "orders.read",
  ORDERS_MANAGE: "orders.manage",
  KDS_READ: "kds.read",
  KDS_PREPARE: "kds.prepare",
  KDS_SERVE: "kds.serve",
  KDS_OVERRIDE: "kds.override",
  TABLES_READ: "tables.read",
  TABLES_MANAGE: "tables.manage",
  QR_READ: "qr.read",
  QR_MANAGE: "qr.manage",
  BOOKINGS_READ: "bookings.read",
  BOOKINGS_CREATE: "bookings.create",
  BOOKINGS_MANAGE: "bookings.manage",
  ROOMS_READ: "rooms.read",
  ROOMS_MANAGE: "rooms.manage",
  BILLING_READ: "billing.read",
  BILLING_MANAGE: "billing.manage",
  PAYMENTS_READ: "payments.read",
  PAYMENTS_MANAGE: "payments.manage",
  PAYMENTS_REFUND: "payments.refund",
  REPORTS_READ: "reports.read",
  INQUIRIES_READ: "inquiries.read",
  INQUIRIES_MANAGE: "inquiries.manage",
  CONTENT_READ: "content.read",
  CONTENT_MANAGE: "content.manage",
  NOTIFICATIONS_READ: "notifications.read",
  NOTIFICATIONS_MANAGE: "notifications.manage",
  SETTINGS_READ: "settings.read",
  SETTINGS_MANAGE: "settings.manage"
});

const STAFF_BASE = Object.freeze([
  PERMISSIONS.SESSION_READ,
  PERMISSIONS.MENU_READ,
  PERMISSIONS.ORDERS_READ,
  PERMISSIONS.ORDERS_MANAGE,
  PERMISSIONS.KDS_READ,
  PERMISSIONS.TABLES_READ,
  PERMISSIONS.BOOKINGS_READ,
  PERMISSIONS.BOOKINGS_CREATE,
  PERMISSIONS.ROOMS_READ,
  PERMISSIONS.NOTIFICATIONS_READ,
  PERMISSIONS.NOTIFICATIONS_MANAGE,
  PERMISSIONS.SETTINGS_READ
]);

const OWNER_ONLY = Object.freeze([
  PERMISSIONS.KDS_OVERRIDE,
  PERMISSIONS.TABLES_MANAGE,
  PERMISSIONS.QR_READ,
  PERMISSIONS.QR_MANAGE,
  PERMISSIONS.BOOKINGS_MANAGE,
  PERMISSIONS.ROOMS_MANAGE,
  PERMISSIONS.BILLING_READ,
  PERMISSIONS.BILLING_MANAGE,
  PERMISSIONS.PAYMENTS_READ,
  PERMISSIONS.PAYMENTS_MANAGE,
  PERMISSIONS.PAYMENTS_REFUND,
  PERMISSIONS.REPORTS_READ,
  PERMISSIONS.INQUIRIES_READ,
  PERMISSIONS.INQUIRIES_MANAGE,
  PERMISSIONS.CONTENT_READ,
  PERMISSIONS.CONTENT_MANAGE,
  PERMISSIONS.SETTINGS_MANAGE
]);

const PLATFORM_PERMISSIONS = Object.freeze([
  "platform.session.read",
  "platform.hotels.read", "platform.hotels.manage",
  "platform.menu.read", "platform.menu.manage",
  "platform.orders.read", "platform.orders.manage",
  "platform.bookings.read", "platform.bookings.manage",
  "platform.inquiries.read", "platform.inquiries.manage",
  "platform.notifications.read", "platform.notifications.manage",
  "platform.settings.read", "platform.settings.manage",
  "platform.rooms.read", "platform.rooms.manage",
  "platform.billing.read", "platform.billing.manage",
  "platform.payments.read", "platform.payments.manage",
  "platform.content.read", "platform.content.manage",
  "platform.branding.read", "platform.branding.manage",
  "platform.qr.manage", "platform.assets.manage"
]);

function getEffectivePermissions(principal = {}) {
  if (!principal || typeof principal !== "object") return new Set();
  if (principal.principal_type === "platform_admin") {
    return new Set(PLATFORM_PERMISSIONS);
  }
  if (principal.principal_type !== "hotel_staff") return new Set();

  const role = String(principal.role || "").trim().toLowerCase();
  const kdsRole = String(principal.kds_role || "").trim().toLowerCase();
  if (!['owner', 'staff'].includes(role)) return new Set();

  const grants = new Set(STAFF_BASE);
  if (role === "owner") {
    OWNER_ONLY.forEach((permission) => grants.add(permission));
    grants.add(PERMISSIONS.KDS_PREPARE);
    grants.add(PERMISSIONS.KDS_SERVE);
    return grants;
  }
  if (["general", "kitchen", "manager"].includes(kdsRole)) {
    grants.add(PERMISSIONS.KDS_PREPARE);
  }
  if (["general", "expo", "manager"].includes(kdsRole)) {
    grants.add(PERMISSIONS.KDS_SERVE);
  }
  return grants;
}

function hasPermission(principal, permission) {
  return typeof permission === "string" && getEffectivePermissions(principal).has(permission);
}

module.exports = {
  OWNER_ONLY,
  PERMISSIONS,
  PLATFORM_PERMISSIONS,
  STAFF_BASE,
  getEffectivePermissions,
  hasPermission
};
