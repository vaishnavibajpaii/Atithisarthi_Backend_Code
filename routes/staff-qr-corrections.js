const crypto = require("crypto");
const express = require("express");
const { supabase } = require("../utils/supabase");
const { getStaffTenantMutationClient } = require("../utils/tenant-route-database");
const { requireStaffAuth } = require("../middleware/require-staff-auth");
const { requireHotelFeature, resolveStaffHotelSlug } = require("../middleware/require-hotel-feature");
const { validateBody } = require("../validators/common");
const { staffQrCorrectionSchema } = require("../validators/staff-qr");
const { hashSecret } = require("../utils/secure-qr");
const ordersRoute = require("./orders");

const router = express.Router();
const requireStaffFoodModule = requireHotelFeature("food", { resolveHotelSlug: resolveStaffHotelSlug });
const calculateVerifiedOrderPricing = ordersRoute.calculateVerifiedOrderPricing;

function isMissingStaffQrCorrectionSchema(error) {
  const code = String(error?.code || "").toUpperCase();
  const details = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`.toLowerCase();
  return ["42P01", "42703", "PGRST202", "PGRST204", "PGRST205"].includes(code) ||
    details.includes("qr_staff_idempotency_records") ||
    details.includes("correct_secure_qr_submission_staff");
}

router.get("/qr-orders", requireStaffAuth, requireStaffFoodModule, async (req, res) => {
  try {
    const hotelSlug = String(req.staffHotelSlug || "").trim();
    const requestedStatus = String(req.query.status || "open").trim().toLowerCase();
    let query = supabase.from("qr_order_submissions")
      .select("public_reference,order_id,round_sequence,status,items,totals_delta,note,row_version,edit_expires_at,created_at,updated_at")
      .eq("hotel_slug", hotelSlug)
      .order("created_at", { ascending: false })
      .limit(120);
    if (requestedStatus === "open") query = query.in("status", ["pending", "new", "accepted", "preparing"]);
    else if (requestedStatus && requestedStatus !== "all") query = query.eq("status", requestedStatus);
    const submissionsResult = await query;
    if (submissionsResult.error) {
      if (isMissingStaffQrCorrectionSchema(submissionsResult.error)) {
        return res.status(503).json({ success: false, code: "SECURE_QR_NOT_INITIALIZED", message: "Secure QR ordering is not initialized." });
      }
      throw submissionsResult.error;
    }
    const submissions = submissionsResult.data || [];
    const orderIds = [...new Set(submissions.map((entry) => String(entry.order_id || "")).filter(Boolean))];
    let orderById = new Map();
    if (orderIds.length) {
      const ordersResult = await supabase.from("orders")
        .select("id,table_number,status,kitchen_status,payment_status,billing_status,order_version")
        .eq("hotel_slug", hotelSlug)
        .in("id", orderIds);
      if (ordersResult.error) throw ordersResult.error;
      orderById = new Map((ordersResult.data || []).map((order) => [String(order.id), order]));
    }
    return res.json({
      success: true,
      submissions: submissions.map((submission) => {
        const order = orderById.get(String(submission.order_id)) || {};
        return {
          publicReference: submission.public_reference,
          orderId: String(submission.order_id || ""),
          tableNumber: order.table_number || "",
          roundSequence: Number(submission.round_sequence || 1),
          status: submission.status || "new",
          kitchenStatus: Number(submission.round_sequence || 1) === 1
            ? order.kitchen_status || order.status || submission.status
            : submission.status,
          items: submission.items || [],
          totals: submission.totals_delta || {},
          note: submission.note || "",
          version: Number(submission.row_version || 1),
          editExpiresAt: submission.edit_expires_at || "",
          createdAt: submission.created_at || "",
          updatedAt: submission.updated_at || "",
          paymentStatus: order.payment_status || "",
          billingStatus: order.billing_status || ""
        };
      })
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "QR order submissions could not be loaded." });
  }
});

router.patch(
  "/qr-orders/:publicReference",
  requireStaffAuth,
  requireStaffFoodModule,
  validateBody(staffQrCorrectionSchema),
  async (req, res) => {
    try {
      const hotelSlug = String(req.staffHotelSlug || "").trim();
      const publicReference = String(req.params.publicReference || "").trim();
      const role = String(req.staffRole || req.staffUser?.role || "staff").trim().toLowerCase();
      const actorReference = String(req.staffUser?.sub || req.staffUser?.id || "").trim();
      const action = req.validatedBody.action;
      if (action === "cancel" && role !== "manager") {
        return res.status(403).json({ success: false, code: "MANAGER_REQUIRED", message: "Manager access is required for preparation-stage cancellation." });
      }
      const submissionResult = await supabase.from("qr_order_submissions")
        .select("public_reference,order_id,round_sequence,status,items,totals_delta,note,row_version")
        .eq("hotel_slug", hotelSlug)
        .eq("public_reference", publicReference)
        .maybeSingle();
      if (submissionResult.error) throw submissionResult.error;
      if (!submissionResult.data) {
        return res.status(404).json({ success: false, code: "QR_SUBMISSION_NOT_FOUND", message: "QR submission not found for this hotel." });
      }
      const submission = submissionResult.data;
      const orderResult = await supabase.from("orders")
        .select("id,table_number,payment_method")
        .eq("hotel_slug", hotelSlug)
        .eq("id", submission.order_id)
        .maybeSingle();
      if (orderResult.error) throw orderResult.error;
      if (!orderResult.data) return res.status(404).json({ success: false, message: "The active table order is no longer available." });

      let trustedItems = submission.items || [];
      let trustedTotals = submission.totals_delta || {};
      if (action === "edit") {
        const existingReferences = new Set((submission.items || [])
          .map((item) => String(item.publicItemReference || ""))
          .filter(Boolean));
        const invalidReference = (req.validatedBody.items || []).find((item) =>
          item.publicItemReference && !existingReferences.has(item.publicItemReference));
        if (invalidReference) {
          return res.status(409).json({ success: false, code: "QR_ITEM_SCOPE_MISMATCH", message: "One edited item does not belong to this QR submission." });
        }
        const pricing = await calculateVerifiedOrderPricing({
          hotelSlug,
          items: req.validatedBody.items.map((item) => ({ id: item.menuItemId, qty: item.quantity, note: item.note || "" })),
          paymentMethod: orderResult.data.payment_method || "COD",
          orderContext: { orderType: "dine-in", tableNumber: orderResult.data.table_number, orderSource: "qr" }
        });
        if (pricing.error) return res.status(400).json({ success: false, message: pricing.error });
        trustedItems = pricing.items.map((item, index) => {
          const requested = req.validatedBody.items[index];
          const previous = (submission.items || []).find((entry) => entry.publicItemReference === requested.publicItemReference) || {};
          return {
            ...item,
            publicItemReference: requested.publicItemReference || crypto.randomUUID(),
            qrSessionReference: previous.qrSessionReference || "",
            qrSubmissionReference: publicReference,
            kitchenStatus: "new"
          };
        });
        trustedTotals = pricing.totals;
      }
      const fingerprint = hashSecret(JSON.stringify({
        publicReference,
        action,
        expectedVersion: req.validatedBody.expectedVersion,
        items: req.validatedBody.items || [],
        note: req.validatedBody.note || "",
        reason: req.validatedBody.reason || ""
      }));
      const database = await getStaffTenantMutationClient(req, supabase);
      const { data: rpcData, error: rpcError } = await database.rpc("correct_secure_qr_submission_staff", {
        p_hotel_slug: hotelSlug,
        p_submission_reference: publicReference,
        p_expected_version: req.validatedBody.expectedVersion,
        p_action: action,
        p_idempotency_key_hash: hashSecret(req.validatedBody.clientRequestId),
        p_request_fingerprint: fingerprint,
        p_items: trustedItems,
        p_totals: trustedTotals,
        p_note: req.validatedBody.note || submission.note || "",
        p_reason: req.validatedBody.reason || "",
        p_actor_reference: actorReference,
        p_actor_role: role,
        p_request_id: req.requestId || ""
      });
      if (rpcError) {
        if (isMissingStaffQrCorrectionSchema(rpcError)) {
          return res.status(503).json({ success: false, code: "STAFF_QR_CORRECTION_NOT_INITIALIZED", message: "Apply the Staff QR correction migration first." });
        }
        throw rpcError;
      }
      const result = Array.isArray(rpcData) ? rpcData[0] : rpcData;
      if (!result?.ok) {
        const code = result?.code || "QR_CORRECTION_REJECTED";
        const status = code === "QR_SUBMISSION_NOT_FOUND" ? 404
          : code === "MANAGER_REQUIRED" ? 403
            : ["QR_SUBMISSION_CHANGED", "QR_EDIT_LOCKED", "QR_CANCELLATION_LOCKED", "BILLING_LOCKED", "IDEMPOTENCY_KEY_REUSED"].includes(code) ? 409 : 400;
        return res.status(status).json({
          success: false,
          code,
          message: code === "QR_SUBMISSION_CHANGED"
            ? "This QR order was updated by another user. Reload the latest version."
            : code === "QR_EDIT_LOCKED"
              ? "The kitchen has already accepted this QR order. Use controlled cancellation instead."
              : result?.message || "The QR correction could not be completed.",
          currentVersion: result?.currentVersion,
          kitchenStatus: result?.kitchenStatus
        });
      }
      return res.json({
        success: true,
        duplicate: result.duplicate === true,
        action,
        message: result.duplicate ? "This correction was already completed." : `QR round ${action} completed.`,
        submission: result.submission,
        round: result.round,
        order: result.order
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: "The QR correction could not be completed." });
    }
  }
);

module.exports = router;
