"use strict";

const { getRoomDefaultNightlyPrice } = require("./room-pricing");

function normalizeText(value = "", maxLength = 120) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength)
    : "";
}

function getSafeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safePublicImageUrl(value = "") {
  const url = normalizeText(value, 2048);
  if (!url) return "";
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
  } catch (_error) {
    return "";
  }
}

function mapManagedPublicImage(row = {}, source = "room") {
  const originalUrl = safePublicImageUrl(row.original_url);
  const optimizedUrl = safePublicImageUrl(row.optimized_url) || originalUrl;
  const cardUrl = safePublicImageUrl(row.card_url) || optimizedUrl;
  const thumbnailUrl = safePublicImageUrl(row.thumbnail_url) || cardUrl;
  if (!originalUrl) return null;
  return {
    id: Number(row.id), source, originalUrl, optimizedUrl, cardUrl, thumbnailUrl,
    altText: normalizeText(row.alt_text, 240),
    caption: normalizeText(row.caption, 500),
    isPrimary: row.is_primary === true,
    width: Number(row.width || 0), height: Number(row.height || 0)
  };
}

function mapLegacyPublicImage(value, index, fallbackAlt) {
  const objectValue = value && typeof value === "object" ? value : {};
  const originalUrl = safePublicImageUrl(typeof value === "string"
    ? value
    : objectValue.originalUrl || objectValue.url || objectValue.src || objectValue.image_url);
  if (!originalUrl) return null;
  return {
    id: `legacy-${index + 1}`, source: "legacy", originalUrl,
    optimizedUrl: safePublicImageUrl(objectValue.optimizedUrl) || originalUrl,
    cardUrl: safePublicImageUrl(objectValue.cardUrl) || originalUrl,
    thumbnailUrl: safePublicImageUrl(objectValue.thumbnailUrl) || originalUrl,
    altText: normalizeText(objectValue.altText || objectValue.alt || fallbackAlt, 240),
    caption: normalizeText(objectValue.caption, 500),
    isPrimary: index === 0,
    width: Number(objectValue.width || 0), height: Number(objectValue.height || 0)
  };
}

function combinePublicRoomImages(room, roomType, roomImages = [], roomTypeImages = []) {
  const managed = [...roomImages, ...roomTypeImages].filter(Boolean);
  if (managed.length) {
    const primary = roomImages.find((image) => image.isPrimary) || roomImages[0] ||
      roomTypeImages.find((image) => image.isPrimary) || roomTypeImages[0];
    const seen = new Set();
    return [primary, ...managed]
      .filter((image) => image && !seen.has(image.originalUrl) && seen.add(image.originalUrl))
      .map((image, index) => ({ ...image, isPrimary: index === 0 }));
  }
  const legacyValues = getSafeArray(room.images_json).length
    ? getSafeArray(room.images_json)
    : getSafeArray(roomType?.images_json);
  return legacyValues
    .map((value, index) => mapLegacyPublicImage(
      value,
      index,
      room.title || roomType?.name || `Room ${room.room_number || ""}`
    ))
    .filter(Boolean);
}

function mapPublicRoom(room = {}, roomType = null, galleryImages = []) {
  const effectivePrice = getRoomDefaultNightlyPrice({ room, roomType }).amount;
  return {
    id: room.id,
    hotelSlug: normalizeText(room.hotel_slug, 120),
    roomTypeId: room.room_type_id || null,
    roomType: roomType
      ? {
          id: roomType.id,
          name: roomType.name || "",
          description: roomType.description || "",
          basePrice: Number(roomType.base_price || 0),
          maxAdults: Number(roomType.max_adults || 0),
          maxChildren: Number(roomType.max_children || 0),
          amenities: getSafeArray(roomType.amenities_json),
          images: getSafeArray(roomType.images_json),
          cancellationPolicy: roomType.cancellation_policy || ""
        }
      : null,
    roomNumber: room.room_number || "",
    title: room.title || room.room_number || "",
    floor: room.floor || "",
    capacity: Number(room.capacity || 0),
    maxAdults: Number(room.max_adults || 0),
    maxChildren: Number(room.max_children || 0),
    bedType: room.bed_type || "",
    pricePerNight: Math.max(0, effectivePrice),
    basePrice: Number(room.base_price || 0),
    discountPrice: room.discount_price === null || room.discount_price === undefined
      ? null
      : Number(room.discount_price || 0),
    taxPercent: Number(room.tax_percent || 0),
    amenities: getSafeArray(room.amenities_json),
    images: getSafeArray(room.images_json),
    galleryImages,
    primaryImage: galleryImages[0] || null,
    description: room.description || ""
  };
}

function buildPagination(page, pageSize, totalItems) {
  const total = Math.max(0, Number(totalItems || 0));
  return {
    page,
    pageSize,
    totalItems: total,
    totalPages: total ? Math.ceil(total / pageSize) : 0,
    hasMore: page * pageSize < total
  };
}

function mapSummaryImage(image, fallbackAlt = "Room") {
  if (!image) return null;
  return {
    cardUrl: image.cardUrl || image.optimizedUrl || image.originalUrl || "",
    thumbnailUrl: image.thumbnailUrl || image.cardUrl || image.optimizedUrl || image.originalUrl || "",
    alt: image.altText || fallbackAlt,
    width: Number(image.width || 0) || 960,
    height: Number(image.height || 0) || 640
  };
}

function firstLegacyImage(values, fallbackAlt) {
  return mapLegacyPublicImage(getSafeArray(values)[0], 0, fallbackAlt);
}

function applyRoomDiscoverySort(items, sort) {
  const sorted = [...items];
  if (sort === "price_asc") {
    sorted.sort((a, b) => a.startingPrice - b.startingPrice || String(a.name).localeCompare(String(b.name)));
  } else if (sort === "price_desc") {
    sorted.sort((a, b) => b.startingPrice - a.startingPrice || String(a.name).localeCompare(String(b.name)));
  } else if (sort === "capacity") {
    sorted.sort((a, b) => b.capacity.adults - a.capacity.adults || String(a.name).localeCompare(String(b.name)));
  }
  return sorted;
}

module.exports = {
  applyRoomDiscoverySort,
  buildPagination,
  combinePublicRoomImages,
  firstLegacyImage,
  getSafeArray,
  mapManagedPublicImage,
  mapPublicRoom,
  mapSummaryImage,
  normalizeText,
  safePublicImageUrl
};
