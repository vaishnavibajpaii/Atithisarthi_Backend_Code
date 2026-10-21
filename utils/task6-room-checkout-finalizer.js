"use strict";

const crypto = require("crypto");
const {
  buildFinalCheckoutSnapshotCandidate,
  mapSnapshotBill
} = require("./room-checkout-bill");

const TASK6_CHECKOUT_RPC_NAME = "task6_finalize_room_checkout";
const SCHEMA_ERROR_CODES = new Set([
  "42P01",
  "42703",
  "42883",
  "PGRST202",
  "PGRST204",
  "PGRST205"
]);

function normalizeRequiredText(value, label, maxLength) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  if (normalized.length > maxLength) throw new TypeError(`${label} is too long`);
  return normalized;
}

function normalizeOptionalText(value, maxLength) {
  const normalized = String(value || "").trim();
  if (normalized.length > maxLength) throw new TypeError("Optional checkout value is too long");
  return normalized || null;
}

function normalizeBookingId(value) {
  const normalized = String(value || "").trim();
  if (!/^\d+$/.test(normalized)) throw new TypeError("Booking id must be a positive integer");

  let parsed;
  try {
    parsed = BigInt(normalized);
  } catch (_error) {
    throw new TypeError("Booking id must be a positive integer");
  }
  if (parsed <= 0n || parsed > 9223372036854775807n) {
    throw new TypeError("Booking id must be a positive integer");
  }
  return parsed.toString();
}

function normalizeAmountCents(value) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 99999999.99
  ) {
    throw new TypeError("Checkout amount is invalid");
  }
  return Math.round(value * 100);
}

function normalizeIdempotencyKey(value) {
  const normalized = normalizeRequiredText(value, "Idempotency key", 200);
  if (normalized.length < 8 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)) {
    throw new TypeError("Idempotency key is invalid");
  }
  return normalized;
}

function normalizeCurrency(value = "INR") {
  const normalized = normalizeRequiredText(value, "Currency", 8).toUpperCase();
  if (!/^[A-Z]{3,8}$/.test(normalized)) throw new TypeError("Currency is invalid");
  return normalized;
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableJson(value[key]);
    return result;
  }, {});
}

function buildTask6CheckoutRequestFingerprint({
  hotelSlug,
  bookingId,
  amountCents,
  paymentMethod,
  transactionId,
  notes,
  currency
} = {}) {
  const canonicalRequest = {
    operation: TASK6_CHECKOUT_RPC_NAME,
    hotelSlug: normalizeRequiredText(hotelSlug, "Hotel scope", 120),
    bookingId: normalizeBookingId(bookingId),
    amountCents,
    paymentMethod: normalizeRequiredText(paymentMethod, "Payment method", 80).toLowerCase(),
    transactionId: normalizeOptionalText(transactionId, 200),
    notes: normalizeOptionalText(notes, 2000) || "",
    currency: normalizeCurrency(currency)
  };
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
    throw new TypeError("Checkout amount is invalid");
  }
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableJson(canonicalRequest)))
    .digest("hex");
}

function buildTask6RoomCheckoutRpcParams({
  hotelSlug,
  bookingId,
  amount,
  paymentMethod,
  transactionId = null,
  notes = "",
  idempotencyKey,
  currency = "INR",
  actorUserId = null,
  actorRole = null,
  snapshotJson,
  payloadHash,
  requestFingerprint
} = {}) {
  const amountCents = normalizeAmountCents(amount);
  const normalizedSnapshot = snapshotJson && typeof snapshotJson === "object" && !Array.isArray(snapshotJson)
    ? snapshotJson
    : null;
  const normalizedFingerprint = String(requestFingerprint || "").trim().toLowerCase();
  const normalizedPayloadHash = String(payloadHash || "").trim().toLowerCase();
  if (!normalizedSnapshot) throw new TypeError("Final checkout snapshot is required");
  if (!/^[a-f0-9]{64}$/.test(normalizedFingerprint)) {
    throw new TypeError("Checkout request fingerprint is invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(normalizedPayloadHash)) {
    throw new TypeError("Checkout snapshot hash is invalid");
  }

  return {
    p_hotel_slug: normalizeRequiredText(hotelSlug, "Hotel scope", 120),
    p_booking_id: normalizeBookingId(bookingId),
    p_amount: amountCents / 100,
    p_payment_method: normalizeRequiredText(paymentMethod, "Payment method", 80),
    p_transaction_id: normalizeOptionalText(transactionId, 200),
    p_notes: normalizeOptionalText(notes, 2000) || "",
    p_created_by_user_id: normalizeOptionalText(actorUserId, 200),
    p_created_by_role: normalizeOptionalText(actorRole, 80),
    p_idempotency_key: normalizeIdempotencyKey(idempotencyKey),
    p_request_fingerprint: normalizedFingerprint,
    p_currency: normalizeCurrency(currency),
    p_snapshot_json: normalizedSnapshot,
    p_payload_hash: normalizedPayloadHash
  };
}

function mapTask6CheckoutFinalizerError(error = {}) {
  const code = String(error.code || "").trim().toUpperCase();
  const message = String(error.message || "").trim();
  const marker = message.toUpperCase();

  if (SCHEMA_ERROR_CODES.has(code)) {
    return {
      ok: false,
      status: 503,
      schemaReady: false,
      code: "checkout_schema_unavailable",
      message: "Atomic checkout is not available yet"
    };
  }
  if (code === "P0002") {
    return {
      ok: false,
      status: 404,
      schemaReady: true,
      code: "booking_not_found",
      message: "Room booking was not found for this hotel"
    };
  }
  if (marker.includes("TASK6_CHECKOUT_IDEMPOTENCY_CONFLICT")) {
    return {
      ok: false,
      status: 409,
      schemaReady: true,
      code: "checkout_idempotency_conflict",
      message: "This checkout request key was already used for different details"
    };
  }
  if (marker.includes("TASK6_CHECKOUT_AMOUNT_MISMATCH") || marker.includes("TASK6_CHECKOUT_SNAPSHOT_TOTAL_MISMATCH")) {
    return {
      ok: false,
      status: 409,
      schemaReady: true,
      code: "checkout_total_changed",
      message: "Checkout total or bill snapshot changed. Reload and try again."
    };
  }
  if (code === "40001" || marker.includes("TASK6_CHECKOUT_ORDER_SET_CHANGED")) {
    return {
      ok: false,
      status: 409,
      schemaReady: true,
      retryable: true,
      code: "checkout_conflict",
      message: "Room service orders changed during checkout. Reload and try again."
    };
  }
  if (marker.includes("TASK6_CHECKOUT_ALREADY_FINALIZED")) {
    return {
      ok: false,
      status: 409,
      schemaReady: true,
      code: "checkout_already_finalized",
      message: "This stay has already been checked out"
    };
  }
  if (code === "23505" || code === "23514") {
    return {
      ok: false,
      status: 409,
      schemaReady: true,
      code: "checkout_state_conflict",
      message: "Booking state does not allow combined checkout"
    };
  }
  if (code === "22023") {
    return {
      ok: false,
      status: marker.includes("PAYMENT_METADATA") ? 400 : 409,
      schemaReady: true,
      code: marker.includes("PAYMENT_METADATA")
        ? "checkout_payment_method_unsupported"
        : "checkout_request_invalid",
      message: marker.includes("PAYMENT_METADATA")
        ? "External provider payments must use the payment flow, not offline checkout"
        : "Checkout request or persisted financial snapshot is invalid"
    };
  }
  if (code === "42501") {
    return {
      ok: false,
      status: 403,
      schemaReady: true,
      code: "checkout_scope_denied",
      message: "Checkout is not available for this hotel or booking"
    };
  }

  return {
    ok: false,
    status: 500,
    schemaReady: true,
    code: "checkout_failed",
    message: "Combined checkout failed"
  };
}

async function settleTask6RoomCheckout({ supabaseClient, ...checkoutContext } = {}) {
  if (!supabaseClient || typeof supabaseClient.rpc !== "function") {
    throw new TypeError("Supabase client with rpc() is required");
  }

  const hotelSlug = normalizeRequiredText(checkoutContext.hotelSlug, "Hotel scope", 120);
  const bookingId = normalizeBookingId(checkoutContext.bookingId);
  const amountCents = normalizeAmountCents(checkoutContext.amount);
  const paymentMethod = normalizeRequiredText(checkoutContext.paymentMethod, "Payment method", 80);
  const transactionId = normalizeOptionalText(checkoutContext.transactionId, 200);
  const notes = normalizeOptionalText(checkoutContext.notes, 2000) || "";
  const currency = normalizeCurrency(checkoutContext.currency || "INR");
  const idempotencyKey = normalizeIdempotencyKey(checkoutContext.idempotencyKey);
  const actorUserId = normalizeOptionalText(checkoutContext.actorUserId, 200);
  const actorRole = normalizeOptionalText(checkoutContext.actorRole, 80);
  const actorDisplayName = normalizeOptionalText(checkoutContext.actorDisplayName, 160);
  const requestFingerprint = buildTask6CheckoutRequestFingerprint({
    hotelSlug,
    bookingId,
    amountCents,
    paymentMethod,
    transactionId,
    notes,
    currency
  });
  const issuedAt = new Date().toISOString();

  const candidate = await buildFinalCheckoutSnapshotCandidate({
    supabaseClient,
    hotelSlug,
    bookingId,
    actor: { id: actorUserId, role: actorRole, displayName: actorDisplayName },
    paymentMethod,
    transactionId,
    currency,
    issuedAt
  });
  if (!candidate) {
    return {
      ok: false,
      status: 404,
      schemaReady: true,
      code: "booking_not_found",
      message: "Room booking was not found for this hotel"
    };
  }

  const params = buildTask6RoomCheckoutRpcParams({
    hotelSlug,
    bookingId,
    amount: amountCents / 100,
    paymentMethod,
    transactionId,
    notes,
    idempotencyKey,
    currency,
    actorUserId,
    actorRole,
    snapshotJson: candidate.bill,
    payloadHash: candidate.payloadHash,
    requestFingerprint
  });
  const { data, error } = await supabaseClient.rpc(TASK6_CHECKOUT_RPC_NAME, params);
  if (error) return mapTask6CheckoutFinalizerError(error);

  if (
    !data || typeof data !== "object" ||
    !data.receipt || typeof data.receipt !== "object" ||
    !data.booking || typeof data.booking !== "object" ||
    !data.snapshot || typeof data.snapshot !== "object" ||
    !data.snapshot.snapshot_json || typeof data.snapshot.snapshot_json !== "object"
  ) {
    return {
      ok: false,
      status: 502,
      schemaReady: true,
      code: "checkout_response_invalid",
      message: "Atomic checkout returned an invalid response"
    };
  }

  return {
    ok: true,
    status: 200,
    schemaReady: true,
    atomicFinalizer: true,
    idempotentReplay: data.idempotentReplay === true,
    receipt: data.receipt,
    booking: data.booking,
    settledOrderCount: Number.isFinite(Number(data.settledOrderCount))
      ? Math.max(0, Math.trunc(Number(data.settledOrderCount)))
      : 0,
    checkoutBill: mapSnapshotBill(data.snapshot, data.booking)
  };
}

module.exports = {
  TASK6_CHECKOUT_RPC_NAME,
  buildTask6CheckoutRequestFingerprint,
  buildTask6RoomCheckoutRpcParams,
  mapTask6CheckoutFinalizerError,
  settleTask6RoomCheckout
};
