"use strict";

const crypto = require("crypto");

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableJson(value[key]);
    return result;
  }, {});
}

function canonicalRoomBookingRequest({ booking = {}, payments = [] } = {}) {
  const {
    created_at,
    updated_at,
    idempotency_key,
    request_fingerprint,
    ...durableBookingRequest
  } = booking || {};

  return {
    booking: durableBookingRequest,
    payments: Array.isArray(payments) ? payments : []
  };
}

function buildRoomBookingRequestFingerprint(value = {}) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableJson(canonicalRoomBookingRequest(value))))
    .digest("hex");
}

function classifyRoomBookingReplay(existingBooking, requestFingerprint) {
  if (!existingBooking) return { replay: false, conflict: false };

  const storedFingerprint = String(existingBooking.request_fingerprint || "").trim().toLowerCase();
  const submittedFingerprint = String(requestFingerprint || "").trim().toLowerCase();
  const matches = /^[a-f0-9]{64}$/.test(storedFingerprint) &&
    storedFingerprint === submittedFingerprint;

  return {
    replay: matches,
    conflict: !matches,
    legacy: !storedFingerprint
  };
}

function getRoomIdempotencyKey(req = {}) {
  const raw = String(req.get?.("Idempotency-Key") || req.headers?.["idempotency-key"] || "").trim();
  if (!raw) return { key: null, error: null };
  if (raw.length < 8 || raw.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(raw)) {
    return { key: null, error: "Idempotency-Key must be 8 to 200 safe characters" };
  }
  return { key: raw, error: null };
}

async function findRoomBookingByIdempotency({ supabaseClient, hotelSlug, key }) {
  if (!key) return null;
  const { data, error } = await supabaseClient.from("room_bookings").select("*")
    .eq("hotel_slug", hotelSlug).eq("idempotency_key", key).maybeSingle();
  if (error) {
    const code = String(error.code || "").toUpperCase();
    const details = `${error.message || ""} ${error.details || ""}`.toLowerCase();
    if (["42703", "PGRST204"].includes(code) && details.includes("idempotency_key")) return null;
    throw error;
  }
  return data || null;
}

function isRoomIdempotencyConflict(error) {
  const code = String(error?.code || "").toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  return code === "23505" && (details.includes("room_bookings_scope_idempotency_unique") || details.includes("idempotency_key"));
}

function isMissingTask6BookingAtomicRpc(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toLowerCase();
  return ["42883", "PGRST202"].includes(code) ||
    details.includes("task6_create_room_booking_atomic");
}

function isTask6BookingIdempotencyConflict(error) {
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toUpperCase();
  return details.includes("TASK6_BOOKING_IDEMPOTENCY_CONFLICT");
}

function isTask6BookingMaintenanceConflict(error) {
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`
    .trim()
    .toUpperCase();
  return details.includes("TASK6_BOOKING_MAINTENANCE_CONFLICT");
}

function normalizeTask6BookingAtomicResult(value) {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") return null;
  const wrapped = row.task6_create_room_booking_atomic;
  return wrapped && typeof wrapped === "object" ? wrapped : row;
}

module.exports = {
  buildRoomBookingRequestFingerprint,
  canonicalRoomBookingRequest,
  classifyRoomBookingReplay,
  findRoomBookingByIdempotency,
  getRoomIdempotencyKey,
  isMissingTask6BookingAtomicRpc,
  isRoomIdempotencyConflict,
  isTask6BookingIdempotencyConflict,
  isTask6BookingMaintenanceConflict,
  normalizeTask6BookingAtomicResult,
  stableJson
};
