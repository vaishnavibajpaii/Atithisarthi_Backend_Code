"use strict";

const { normalizePublicText } = require("./public-hotel-access");

function isPopupNotificationWithinActiveWindow(notification = {}, now = new Date()) {
  const startAt = notification?.start_at ? Date.parse(notification.start_at) : null;
  const endAt = notification?.end_at ? Date.parse(notification.end_at) : null;
  const nowMs = now.getTime();
  if (Number.isFinite(startAt) && startAt > nowMs) return false;
  if (Number.isFinite(endAt) && endAt < nowMs) return false;
  return true;
}

function normalizePopupNotificationLink(value = "") {
  const candidate = normalizePublicText(value, 2000);
  if (!candidate) return "";
  if (candidate.startsWith("/")) return candidate;
  try {
    const parsedUrl = new URL(candidate);
    return ["http:", "https:"].includes(parsedUrl.protocol) ? parsedUrl.toString() : "";
  } catch {
    return "";
  }
}

function mapPublicPopupNotification(notification = {}) {
  return {
    id: notification.id,
    hotelSlug: normalizePublicText(notification.hotel_slug, 120),
    title: normalizePublicText(notification.title, 160),
    description: normalizePublicText(notification.description, 4000),
    imageUrl: normalizePublicText(notification.image_url, 2000),
    storagePath: normalizePublicText(notification.storage_path, 500),
    ctaText: normalizePublicText(notification.cta_text, 120),
    ctaLink: normalizePopupNotificationLink(notification.cta_link),
    displayMode: normalizePublicText(notification.display_mode, 40).toLowerCase(),
    startAt: normalizePublicText(notification.start_at, 80),
    endAt: normalizePublicText(notification.end_at, 80),
    priority: Number.isFinite(Number(notification.priority)) ? Number(notification.priority) : 0
  };
}

function buildPublicPopupNotificationPayload(items = [], now = new Date()) {
  const notifications = (Array.isArray(items) ? items : [])
    .filter((item) => isPopupNotificationWithinActiveWindow(item, now))
    .map((item) => mapPublicPopupNotification(item));
  return {
    success: true,
    notifications,
    notification: notifications[0] || null
  };
}

module.exports = {
  buildPublicPopupNotificationPayload,
  isPopupNotificationWithinActiveWindow,
  mapPublicPopupNotification,
  normalizePopupNotificationLink
};
