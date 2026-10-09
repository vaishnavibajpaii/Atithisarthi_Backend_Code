"use strict";

const { settleRoomCombinedCheckout } = require("./room-combined-checkout");
const { getCheckoutBill, isMissingBillSchemaError } = require("./room-checkout-bill");

const ADMIN_SCOPE_SCHEMA_ERROR_CODES = new Set([
  "42P01",
  "42703",
  "PGRST204",
  "PGRST205"
]);

function buildCheckoutErrorPayload(result = {}) {
  return {
    success: false,
    schemaReady: result.schemaReady !== false,
    retryable: result.retryable === true,
    code: result.code || "checkout_failed",
    message: result.message || "Combined checkout failed"
  };
}

function resolveStaffCombinedCheckoutContext(req = {}) {
  const isManager = !!(
    req.staffCanViewManagerData ||
    req.staffUser?.isManager
  );

  if (!isManager) {
    return {
      ok: false,
      status: 403,
      code: "manager_access_required",
      message: "Manager access is required for combined checkout"
    };
  }

  const hotelSlug = String(req.staffHotelSlug || "").trim();

  if (!hotelSlug) {
    return {
      ok: false,
      status: 403,
      code: "hotel_scope_missing",
      message: "Staff hotel scope is missing"
    };
  }

  return {
    ok: true,
    hotelSlug,
    actorUserId: req.staffUser?.sub || req.staffUser?.id || null,
    actorRole: req.staffRole || req.staffUser?.role || "staff"
  };
}

function createRoomCombinedCheckoutFeatureGate({ isEnabled } = {}) {
  if (typeof isEnabled !== "function") {
    throw new TypeError("Combined checkout feature resolver is required");
  }

  return function requireRoomCombinedCheckoutEnabled(req, res, next) {
    if (!isEnabled()) {
      return res.status(503).json({
        success: false,
        code: "combined_checkout_disabled",
        message: "Combined checkout is not enabled"
      });
    }

    next();
  };
}

function createAdminCombinedCheckoutContextResolver({ supabaseClient } = {}) {
  if (!supabaseClient || typeof supabaseClient.from !== "function") {
    throw new TypeError("Supabase client with from() is required");
  }

  return async function resolveAdminCombinedCheckoutContext(req = {}) {
    const bookingId = String(req.params?.id || "").trim();

    if (!/^\d+$/.test(bookingId) || BigInt(bookingId) <= 0n) {
      return {
        ok: false,
        status: 400,
        code: "checkout_request_invalid",
        message: "Booking id must be a positive integer"
      };
    }

    const { data, error } = await supabaseClient
      .from("room_bookings")
      .select("id,hotel_slug")
      .eq("id", bookingId)
      .maybeSingle();

    if (error) {
      const code = String(error.code || "").trim().toUpperCase();

      if (ADMIN_SCOPE_SCHEMA_ERROR_CODES.has(code)) {
        return {
          ok: false,
          status: 503,
          code: "checkout_schema_unavailable",
          message: "Room booking schema is not initialized yet"
        };
      }

      throw error;
    }

    if (!data) {
      return {
        ok: false,
        status: 404,
        code: "booking_not_found",
        message: "Room booking was not found"
      };
    }

    const hotelSlug = String(data.hotel_slug || "").trim();

    if (!hotelSlug) {
      return {
        ok: false,
        status: 500,
        code: "checkout_data_invalid",
        message: "Room booking hotel scope is invalid"
      };
    }

    return {
      ok: true,
      hotelSlug,
      actorUserId: req.adminUser?.sub || req.adminUser?.id || null,
      actorRole: "admin"
    };
  };
}

function createRoomCombinedCheckoutHandler({
  supabaseClient,
  resolveDatabaseClient = null,
  resolveRequestContext,
  settleCheckout = settleRoomCombinedCheckout
} = {}) {
  if (
    typeof resolveDatabaseClient !== "function" &&
    (!supabaseClient || typeof supabaseClient.rpc !== "function")
  ) {
    throw new TypeError("Supabase client with rpc() is required");
  }

  if (typeof resolveRequestContext !== "function") {
    throw new TypeError("Combined checkout context resolver is required");
  }

  if (typeof settleCheckout !== "function") {
    throw new TypeError("Combined checkout settlement function is required");
  }

  return async function roomCombinedCheckoutHandler(req, res) {
    try {
      const context = await resolveRequestContext(req);

      if (!context || context.ok === false) {
        const status = Number(context?.status || 403);
        return res.status(status).json({
          success: false,
          code: context?.code || "checkout_context_unavailable",
          message: context?.message || "Combined checkout context is unavailable"
        });
      }

      if (!String(context.hotelSlug || "").trim()) {
        return res.status(403).json({
          success: false,
          code: "hotel_scope_missing",
          message: "Combined checkout hotel scope is missing"
        });
      }

      const databaseClient = typeof resolveDatabaseClient === "function"
        ? await resolveDatabaseClient(req, context)
        : supabaseClient;
      if (!databaseClient || typeof databaseClient.rpc !== "function") {
        throw new TypeError("Tenant database client with rpc() is required");
      }

      const body = req.validatedBody || {};
      const result = await settleCheckout({
        supabaseClient: databaseClient,
        hotelSlug: context.hotelSlug,
        bookingId: req.params?.id,
        amount: body.amount,
        paymentMethod: body.paymentMethod,
        transactionId: body.transactionId,
        notes: body.notes,
        idempotencyKey: body.idempotencyKey,
        currency: body.currency || "INR",
        actorUserId: context.actorUserId,
        actorRole: context.actorRole
      });

      if (!result.ok) {
        return res
          .status(result.status || 500)
          .json(buildCheckoutErrorPayload(result));
      }

      let checkoutBill = null;
      if (typeof databaseClient.from === "function") {
        try {
          const billResult = await getCheckoutBill({
            supabaseClient: databaseClient,
            hotelSlug: context.hotelSlug,
            bookingId: req.params?.id,
            actor: {
              id: context.actorUserId,
              role: context.actorRole,
              displayName:
                req.staffUser?.displayName ||
                req.adminUser?.fullName ||
                context.actorRole
            },
            issueFinal: true
          });
          checkoutBill = billResult?.bill || null;
        } catch (billError) {
          if (!isMissingBillSchemaError(billError)) {
            console.error("Checkout bill snapshot issue error:", billError);
          }
        }
      }

      return res.status(result.idempotentReplay ? 200 : 201).json({
        success: true,
        message: result.idempotentReplay
          ? "Combined checkout was already completed"
          : "Combined checkout completed",
        idempotentReplay: result.idempotentReplay,
        checkoutBill,
        receipt: result.receipt,
        booking: result.booking,
        settledOrderCount: result.settledOrderCount
      });
    } catch (error) {
      if (error instanceof TypeError) {
        return res.status(400).json({
          success: false,
          code: "checkout_request_invalid",
          message: error.message || "Combined checkout request is invalid"
        });
      }

      console.error("Combined checkout handler error:", error);
      return res.status(500).json({
        success: false,
        code: "checkout_failed",
        message: "Combined checkout failed"
      });
    }
  };
}

module.exports = {
  buildCheckoutErrorPayload,
  createAdminCombinedCheckoutContextResolver,
  createRoomCombinedCheckoutFeatureGate,
  createRoomCombinedCheckoutHandler,
  resolveStaffCombinedCheckoutContext
};
