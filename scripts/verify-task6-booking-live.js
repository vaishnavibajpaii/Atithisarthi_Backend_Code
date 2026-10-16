"use strict";

require("dotenv").config({ quiet: true });

const crypto = require("node:crypto");
const {
  normalizeBaseUrl,
  normalizeSlug
} = require("./verify-tenant-public-hotel-live");

const EXPECTED_CONFIRMATION = "TASK6_BOOKING_TEST_WRITES_CONFIRMED";
const cleanupBookingIds = new Set();

function fail(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function dateOnly(value, name) {
  const normalized = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    fail("TASK6_BOOKING_DATE_INVALID", `${name} must use YYYY-MM-DD`);
  }
  const timestamp = Date.parse(`${normalized}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) {
    fail("TASK6_BOOKING_DATE_INVALID", `${name} is not a valid date`);
  }
  return { value: normalized, timestamp };
}

function addDays(value, days) {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return new Date(timestamp + days * 86400000).toISOString().slice(0, 10);
}

function readInputs() {
  if (process.env.TASK6_BOOKING_LIVE_CONFIRM !== EXPECTED_CONFIRMATION) {
    fail(
      "TASK6_BOOKING_LIVE_CONFIRMATION_MISSING",
      `Set TASK6_BOOKING_LIVE_CONFIRM=${EXPECTED_CONFIRMATION}; this probe creates two synthetic TEST bookings`
    );
  }
  if (String(process.env.TASK6_BOOKING_LIVE_ENV || "").trim().toUpperCase() !== "TEST") {
    fail("TASK6_BOOKING_LIVE_ENV_INVALID", "TASK6_BOOKING_LIVE_ENV must be TEST");
  }

  const checkIn = dateOnly(process.env.TASK6_BOOKING_CHECK_IN, "TASK6_BOOKING_CHECK_IN");
  const checkOut = dateOnly(process.env.TASK6_BOOKING_CHECK_OUT, "TASK6_BOOKING_CHECK_OUT");
  if (checkOut.timestamp <= checkIn.timestamp) {
    fail("TASK6_BOOKING_DATE_RANGE_INVALID", "Check-out must be after check-in");
  }
  const minimum = Date.now() + 30 * 86400000;
  if (checkIn.timestamp < minimum) {
    fail("TASK6_BOOKING_DATE_TOO_SOON", "Use synthetic dates at least 30 days in the future");
  }
  if ((checkOut.timestamp - checkIn.timestamp) / 86400000 > 14) {
    fail("TASK6_BOOKING_DATE_RANGE_TOO_LARGE", "The synthetic stay must be 14 nights or fewer");
  }

  const requestedRoomId = String(process.env.TASK6_BOOKING_ROOM_ID || "").trim();
  if (requestedRoomId && !/^\d+$/.test(requestedRoomId)) {
    fail("TASK6_BOOKING_ROOM_ID_INVALID", "TASK6_BOOKING_ROOM_ID must be a positive integer");
  }

  return {
    baseUrl: normalizeBaseUrl(
      process.env.TASK6_BOOKING_LIVE_BASE_URL ||
      process.env.TASK3_PUBLIC_HOTEL_LIVE_BASE_URL ||
      process.env.APP_BACKEND_BASE_URL
    ),
    slug: normalizeSlug(
      process.env.TASK6_TEST_PROPERTY_SLUG || process.env.TASK3_TEST_PROPERTY_A_SLUG
    ),
    checkIn: checkIn.value,
    checkOut: checkOut.value,
    requestedRoomId: requestedRoomId ? Number(requestedRoomId) : null
  };
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      ...options,
      redirect: "error",
      signal: controller.signal
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      fail("TASK6_BOOKING_RESPONSE_NOT_JSON", "The TEST backend did not return JSON");
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function requireHealthy(baseUrl) {
  for (const endpoint of ["health", "readiness"]) {
    const response = await requestJson(`${baseUrl}/api/${endpoint}`);
    if (response.status !== 200 || response.body?.success !== true) {
      fail("TASK6_BOOKING_BACKEND_NOT_READY", `${endpoint} endpoint is not ready`, response);
    }
  }
}

async function selectRoom(inputs) {
  const query = new URLSearchParams({
    checkInDate: inputs.checkIn,
    checkOutDate: inputs.checkOut,
    adults: "1",
    children: "0"
  });
  const response = await requestJson(
    `${inputs.baseUrl}/api/public/rooms/${encodeURIComponent(inputs.slug)}/availability?${query}`
  );
  if (response.status !== 200 || response.body?.success !== true) {
    fail("TASK6_BOOKING_AVAILABILITY_FAILED", "Could not read TEST room availability", response);
  }
  const rooms = Array.isArray(response.body.rooms) ? response.body.rooms : [];
  const room = inputs.requestedRoomId
    ? rooms.find((candidate) => Number(candidate?.id) === inputs.requestedRoomId)
    : rooms[0];
  if (!room?.id) {
    fail(
      "TASK6_BOOKING_NO_AVAILABLE_ROOM",
      "No eligible TEST room is available for the supplied dates"
    );
  }
  return room;
}

async function createBooking(inputs, payload, key) {
  return requestJson(
    `${inputs.baseUrl}/api/public/rooms/${encodeURIComponent(inputs.slug)}/bookings`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key
      },
      body: JSON.stringify(payload)
    }
  );
}

function bookingId(response) {
  return response?.body?.booking?.id || null;
}

function isCreated(response) {
  return [200, 201].includes(response?.status) && response?.body?.success === true;
}

function isOverlap(response) {
  return response?.status === 409 && response?.body?.code === "ROOM_ALREADY_BOOKED";
}

function isDigestConflict(response) {
  return response?.status === 409 &&
    response?.body?.code === "ROOM_BOOKING_IDEMPOTENCY_CONFLICT";
}

function safeResponse(response) {
  return {
    status: response?.status || 0,
    success: response?.body?.success === true,
    code: response?.body?.code || null,
    idempotent: response?.body?.idempotent === true,
    bookingId: bookingId(response)
  };
}

async function main() {
  const inputs = readInputs();
  await requireHealthy(inputs.baseUrl);
  const room = await selectRoom(inputs);
  const runId = crypto.randomUUID();
  const payload = {
    roomId: Number(room.id),
    guestName: "Task Six Synthetic Guest",
    guestPhone: "+910000000000",
    guestEmail: "",
    guestCompanyName: "",
    guestGstin: "",
    guestPlaceOfSupply: "",
    checkInDate: inputs.checkIn,
    checkOutDate: inputs.checkOut,
    adults: 1,
    children: 0,
    notes: `TASK6 synthetic concurrency ${runId}`
  };
  const keyA = `task6-booking-${runId}-a`;
  const keyB = `task6-booking-${runId}-b`;

  const concurrent = await Promise.all([
    createBooking(inputs, payload, keyA),
    createBooking(inputs, payload, keyB)
  ]);
  concurrent.map(bookingId).filter(Boolean).forEach((id) => cleanupBookingIds.add(id));
  const winners = concurrent.filter(isCreated);
  const overlaps = concurrent.filter(isOverlap);
  if (winners.length !== 1 || overlaps.length !== 1) {
    fail(
      "TASK6_BOOKING_CONCURRENT_OVERLAP_FAILED",
      "Expected one concurrent booking success and one overlap rejection",
      concurrent.map(safeResponse)
    );
  }

  const winner = winners[0];
  const winnerKey = concurrent[0] === winner ? keyA : keyB;
  const replay = await createBooking(inputs, payload, winnerKey);
  if (!isCreated(replay) || replay.body?.idempotent !== true || bookingId(replay) !== bookingId(winner)) {
    fail(
      "TASK6_BOOKING_REPLAY_FAILED",
      "Same-key/same-request retry did not return the original booking",
      { winner: safeResponse(winner), replay: safeResponse(replay) }
    );
  }

  const changedDigest = await createBooking(
    inputs,
    { ...payload, notes: `${payload.notes} changed` },
    winnerKey
  );
  if (!isDigestConflict(changedDigest)) {
    fail(
      "TASK6_BOOKING_DIGEST_CONFLICT_FAILED",
      "Same-key/changed-request retry was not rejected",
      safeResponse(changedDigest)
    );
  }

  const adjacentPayload = {
    ...payload,
    checkInDate: inputs.checkOut,
    checkOutDate: addDays(inputs.checkOut, 1),
    notes: `TASK6 synthetic adjacent ${runId}`
  };
  const adjacent = await createBooking(
    inputs,
    adjacentPayload,
    `task6-booking-${runId}-adjacent`
  );
  if (bookingId(adjacent)) cleanupBookingIds.add(bookingId(adjacent));
  if (!isCreated(adjacent) || !bookingId(adjacent)) {
    fail(
      "TASK6_BOOKING_ADJACENT_FAILED",
      "Adjacent half-open booking was not accepted",
      safeResponse(adjacent)
    );
  }

  process.stdout.write(`${JSON.stringify({
    success: true,
    result: "PASS",
    propertySlug: inputs.slug,
    roomId: Number(room.id),
    overlapDates: [inputs.checkIn, inputs.checkOut],
    adjacentDates: [adjacentPayload.checkInDate, adjacentPayload.checkOutDate],
    concurrent: concurrent.map(safeResponse),
    replay: safeResponse(replay),
    changedDigest: safeResponse(changedDigest),
    cleanup: {
      action: "Cancel both synthetic bookings in the TEST staff/admin booking workflow",
      bookingIds: [...cleanupBookingIds]
    }
  }, null, 2)}\n`);
}

function safeFailure(error) {
  return {
    success: false,
    result: "FAIL",
    code: String(error?.code || "TASK6_BOOKING_LIVE_FAILED"),
    message: String(error?.message || "Task 6 live booking verification failed"),
    details: error?.details,
    cleanup: cleanupBookingIds.size
      ? {
          action: "Cancel these synthetic bookings in the TEST staff/admin booking workflow",
          bookingIds: [...cleanupBookingIds]
        }
      : null
  };
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(safeFailure(error), null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  addDays,
  isCreated,
  isDigestConflict,
  isOverlap,
  safeResponse
};
