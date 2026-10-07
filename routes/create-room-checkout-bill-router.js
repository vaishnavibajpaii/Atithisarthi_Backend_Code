"use strict";

const express = require("express");
const multer = require("multer");
const path = require("path");
const { validateBody } = require("../validators/common");
const {
  roomCheckoutBillFormatSchema,
  roomCheckoutBillReprintSchema
} = require("../validators/room-checkout-bill");
const { getImageDimensions } = require("../utils/image-dimensions");
const {
  buildPropertyStoragePath,
  isPropertyStoragePath,
  resolvePropertyStorageScope
} = require("../utils/storage-object-scope");
const {
  getBillFormat,
  getCheckoutBill,
  isMissingBillSchemaError,
  reprintCheckoutBill,
  resetBillFormat,
  saveBillFormat,
  sanitizeText,
  writeAuditEvent
} = require("../utils/room-checkout-bill");

const ALLOWED_LOGO_TYPES = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"]
]);

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter(req, file, callback) {
    const allowed = ALLOWED_LOGO_TYPES.has(file.mimetype);
    callback(allowed ? null : new Error("Logo must be a PNG, JPG, or WebP image"), allowed);
  }
});

function handleLogoUpload(req, res, next) {
  logoUpload.single("file")(req, res, (error) => {
    if (!error) return next();
    return res.status(400).json({
      success: false,
      message:
        error.code === "LIMIT_FILE_SIZE"
          ? "Logo must be 2 MB or smaller"
          : error.message || "Invalid logo upload"
    });
  });
}

function safeStorageSegment(value = "", fallback = "hotel") {
  return sanitizeText(value, 180)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-|-$/g, "") || fallback;
}

function safeFileStem(value = "") {
  return path
    .basename(String(value || "logo"), path.extname(String(value || "")))
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "logo";
}

function createRoomCheckoutBillRouter({
  supabaseClient,
  authMiddleware,
  configureMiddleware = null,
  resolveHotelSlug,
  resolveBookingHotelSlug,
  resolveActor
}) {
  const router = express.Router();
  const allow = configureMiddleware || ((req, res, next) => next());
  router.use(authMiddleware);

  async function getRequestHotelSlug(req, bookingScoped = false) {
    const value = bookingScoped
      ? await resolveBookingHotelSlug(req)
      : await resolveHotelSlug(req);
    return sanitizeText(value, 120);
  }

  function handleRouteError(res, error, label) {
    if (isMissingBillSchemaError(error)) {
      return res.status(503).json({
        success: false,
        schemaReady: false,
        code: "checkout_bill_schema_unavailable",
        message: "Room checkout bill schema is not initialized yet"
      });
    }

    console.error(`${label}:`, error);
    return res.status(500).json({
      success: false,
      message: "Room checkout bill request failed"
    });
  }

  router.get("/format", allow, async (req, res) => {
    try {
      const hotelSlug = await getRequestHotelSlug(req);
      if (!hotelSlug) {
        return res.status(403).json({ success: false, message: "Hotel scope is missing" });
      }
      const format = await getBillFormat({ supabaseClient, hotelSlug });
      return res.json({ success: true, hotelSlug, format });
    } catch (error) {
      return handleRouteError(res, error, "Checkout bill format fetch error");
    }
  });

  router.put(
    "/format",
    allow,
    validateBody(roomCheckoutBillFormatSchema),
    async (req, res) => {
      try {
        const hotelSlug = await getRequestHotelSlug(req);
        if (!hotelSlug) {
          return res.status(403).json({ success: false, message: "Hotel scope is missing" });
        }
        const actor = resolveActor(req);
        const format = await saveBillFormat({
          supabaseClient,
          hotelSlug,
          input: req.validatedBody,
          actorId: actor.id,
          actorRole: actor.role
        });
        return res.json({
          success: true,
          message: "Room checkout bill format saved",
          format
        });
      } catch (error) {
        return handleRouteError(res, error, "Checkout bill format save error");
      }
    }
  );

  router.post("/format/reset", allow, async (req, res) => {
    try {
      const hotelSlug = await getRequestHotelSlug(req);
      if (!hotelSlug) {
        return res.status(403).json({ success: false, message: "Hotel scope is missing" });
      }
      const actor = resolveActor(req);
      const format = await resetBillFormat({
        supabaseClient,
        hotelSlug,
        actorId: actor.id,
        actorRole: actor.role
      });
      return res.json({
        success: true,
        message: "Room checkout bill format reset to hotel defaults",
        format
      });
    } catch (error) {
      return handleRouteError(res, error, "Checkout bill format reset error");
    }
  });

  router.post("/format/logo", allow, handleLogoUpload, async (req, res) => {
    try {
      const hotelSlug = await getRequestHotelSlug(req);
      if (!hotelSlug) {
        return res.status(403).json({ success: false, message: "Hotel scope is missing" });
      }
      if (!req.file?.buffer) {
        return res.status(400).json({ success: false, message: "Logo file is required" });
      }

      const dimensions = getImageDimensions(req.file.buffer, req.file.mimetype);
      if (
        !dimensions ||
        dimensions.width < 16 ||
        dimensions.height < 16 ||
        dimensions.width > 4096 ||
        dimensions.height > 4096
      ) {
        return res.status(400).json({
          success: false,
          message: "Logo dimensions must be between 16×16 and 4096×4096 pixels"
        });
      }

      const extension = ALLOWED_LOGO_TYPES.get(req.file.mimetype);
      const propertyScope = await resolvePropertyStorageScope(supabaseClient, hotelSlug);
      const storagePath = buildPropertyStoragePath(
        propertyScope,
        "room-checkout-bill",
        `${Date.now()}-${safeFileStem(req.file.originalname)}${extension}`
      );
      const { error: uploadError } = await supabaseClient.storage
        .from("hotel-assets")
        .upload(storagePath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false
        });
      if (uploadError) throw uploadError;

      const { data: publicData } = supabaseClient.storage
        .from("hotel-assets")
        .getPublicUrl(storagePath);
      const actor = resolveActor(req);
      const format = await saveBillFormat({
        supabaseClient,
        hotelSlug,
        input: {
          logoUrl: publicData.publicUrl,
          logoStoragePath: storagePath,
          logoAltText: sanitizeText(req.body?.altText || req.file.originalname, 240)
        },
        actorId: actor.id,
        actorRole: actor.role
      });

      await writeAuditEvent({
        supabaseClient,
        hotelSlug,
        action: "bill_logo_changed",
        actorId: actor.id,
        actorRole: actor.role,
        formatVersion: format.version,
        details: {
          storagePath,
          width: dimensions.width,
          height: dimensions.height,
          mimeType: req.file.mimetype
        }
      });
      return res.status(201).json({
        success: true,
        message: "Receipt logo uploaded",
        format
      });
    } catch (error) {
      return handleRouteError(res, error, "Checkout bill logo upload error");
    }
  });

  router.delete("/format/logo", allow, async (req, res) => {
    try {
      const hotelSlug = await getRequestHotelSlug(req);
      if (!hotelSlug) {
        return res.status(403).json({ success: false, message: "Hotel scope is missing" });
      }
      const current = await getBillFormat({ supabaseClient, hotelSlug });
      const propertyScope = await resolvePropertyStorageScope(supabaseClient, hotelSlug);
      if (current.logoStoragePath && isPropertyStoragePath(current.logoStoragePath, propertyScope, {
        resource: "room-checkout-bill",
        allowLegacy: true
      })) {
        const { error } = await supabaseClient.storage
          .from("hotel-assets")
          .remove([current.logoStoragePath]);
        if (error) throw error;
      }

      const actor = resolveActor(req);
      const format = await saveBillFormat({
        supabaseClient,
        hotelSlug,
        input: { logoUrl: "", logoStoragePath: "", logoAltText: "" },
        actorId: actor.id,
        actorRole: actor.role
      });
      await writeAuditEvent({
        supabaseClient,
        hotelSlug,
        action: "bill_logo_removed",
        actorId: actor.id,
        actorRole: actor.role,
        formatVersion: format.version
      });
      return res.json({ success: true, message: "Receipt logo removed", format });
    } catch (error) {
      return handleRouteError(res, error, "Checkout bill logo remove error");
    }
  });

  router.get("/bookings/:id", allow, async (req, res) => {
    try {
      const hotelSlug = await getRequestHotelSlug(req, true);
      if (!hotelSlug) {
        return res.status(404).json({
          success: false,
          message: "Room booking was not found in this hotel"
        });
      }
      const actor = resolveActor(req);
      const result = await getCheckoutBill({
        supabaseClient,
        hotelSlug,
        bookingId: sanitizeText(req.params.id, 80),
        actor,
        issueFinal: true
      });
      if (!result) {
        return res.status(404).json({
          success: false,
          message: "Room booking was not found in this hotel"
        });
      }
      return res.json({
        success: true,
        hotelSlug,
        bill: result.bill,
        summary: result.summary,
        snapshot: result.snapshot
      });
    } catch (error) {
      return handleRouteError(res, error, "Checkout bill fetch error");
    }
  });

  router.post(
    "/bookings/:id/reprint",
    allow,
    validateBody(roomCheckoutBillReprintSchema),
    async (req, res) => {
      try {
        const hotelSlug = await getRequestHotelSlug(req, true);
        if (!hotelSlug) {
          return res.status(404).json({
            success: false,
            message: "Room booking was not found in this hotel"
          });
        }
        const actor = resolveActor(req);
        const bill = await reprintCheckoutBill({
          supabaseClient,
          hotelSlug,
          bookingId: sanitizeText(req.params.id, 80),
          actor,
          reason: req.validatedBody.reason
        });
        if (!bill) {
          return res.status(409).json({
            success: false,
            message: "A final issued bill is required before reprinting"
          });
        }
        return res.json({
          success: true,
          message: "Original checkout bill prepared for reprint",
          bill
        });
      } catch (error) {
        return handleRouteError(res, error, "Checkout bill reprint error");
      }
    }
  );

  router.post("/bookings/:id/audit", allow, async (req, res) => {
    try {
      const hotelSlug = await getRequestHotelSlug(req, true);
      if (!hotelSlug) {
        return res.status(404).json({ success: false, message: "Room booking was not found" });
      }
      const action = sanitizeText(req.body?.action, 40);
      if (!["bill_printed", "bill_downloaded", "bill_test_printed"].includes(action)) {
        return res.status(400).json({ success: false, message: "Unsupported bill audit action" });
      }
      const actor = resolveActor(req);
      await writeAuditEvent({
        supabaseClient,
        hotelSlug,
        action,
        actorId: actor.id,
        actorRole: actor.role,
        bookingId: sanitizeText(req.params.id, 80)
      });
      return res.json({ success: true });
    } catch (error) {
      return handleRouteError(res, error, "Checkout bill audit error");
    }
  });

  return router;
}

module.exports = { createRoomCheckoutBillRouter };
