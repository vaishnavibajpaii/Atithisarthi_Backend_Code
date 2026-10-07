"use strict";

const express = require("express");
const multer = require("multer");
const path = require("path");
const { supabase } = require("../utils/supabase");
const { validateBody } = require("../validators/common");
const {
  foodOrderBillAuditSchema,
  foodOrderBillFormatSchema,
  foodOrderBillReprintSchema
} = require("../validators/food-order-bill");
const { getImageDimensions } = require("../utils/image-dimensions");
const { requireStaffAuth, requireStaffManagerAccess } = require("../middleware/require-staff-auth");
const { requireHotelFeature, resolveStaffHotelSlug } = require("../middleware/require-hotel-feature");
const {
  buildPropertyStoragePath,
  isPropertyStoragePath,
  resolvePropertyStorageScope
} = require("../utils/storage-object-scope");
const {
  getFoodBillFormat,
  getFoodOrderBill,
  getLatestFoodBillPreview,
  isMissingFoodBillSchemaError,
  reprintFoodOrderBill,
  resetFoodBillFormat,
  sanitizeText,
  saveFoodBillFormat,
  writeFoodBillAudit
} = require("../utils/food-order-bill");

const router = express.Router();
const requireFoodModule = requireHotelFeature("food", {
  resolveHotelSlug: resolveStaffHotelSlug
});
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

router.use(requireStaffAuth, requireFoodModule, requireStaffManagerAccess);

function actorFromRequest(req) {
  return {
    id: req.staffUser?.sub || req.staffUser?.id || null,
    role: req.staffRole || req.staffUser?.role || "owner",
    displayName: req.staffUser?.displayName || "Hotel staff"
  };
}

function hotelFromRequest(req) {
  return sanitizeText(req.staffHotelSlug || req.staffUser?.hotelSlug, 120);
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

function handleRouteError(res, error, label) {
  if (isMissingFoodBillSchemaError(error)) {
    return res.status(503).json({
      success: false,
      schemaReady: false,
      code: "food_bill_schema_unavailable",
      message: "Food Order Thermal Bill schema is not initialized yet"
    });
  }
  if (error?.code === "FOOD_BILL_TOTAL_UNAVAILABLE") {
    return res.status(409).json({
      success: false,
      code: "food_bill_total_unavailable",
      message: "The final food bill is not ready yet. Complete the required billing step first."
    });
  }
  console.error(`${label}:`, error);
  return res.status(500).json({
    success: false,
    message: "Food order bill request failed"
  });
}

router.get("/format", async (req, res) => {
  try {
    const hotelSlug = hotelFromRequest(req);
    if (!hotelSlug) {
      return res.status(403).json({ success: false, message: "Hotel scope is missing" });
    }
    const format = await getFoodBillFormat({ supabaseClient: supabase, hotelSlug });
    const preview = req.query.preview === "true"
      ? await getLatestFoodBillPreview({
          supabaseClient: supabase,
          hotelSlug,
          actor: actorFromRequest(req)
        })
      : null;
    return res.json({ success: true, hotelSlug, format, preview });
  } catch (error) {
    return handleRouteError(res, error, "Food bill format fetch error");
  }
});

router.put("/format", validateBody(foodOrderBillFormatSchema), async (req, res) => {
  try {
    const hotelSlug = hotelFromRequest(req);
    if (!hotelSlug) {
      return res.status(403).json({ success: false, message: "Hotel scope is missing" });
    }
    const actor = actorFromRequest(req);
    const format = await saveFoodBillFormat({
      supabaseClient: supabase,
      hotelSlug,
      input: req.validatedBody,
      actorId: actor.id,
      actorRole: actor.role
    });
    return res.json({
      success: true,
      message: "Food order bill format saved and active",
      format
    });
  } catch (error) {
    return handleRouteError(res, error, "Food bill format save error");
  }
});

router.post(
  "/format/preview",
  validateBody(foodOrderBillFormatSchema),
  async (req, res) => {
    try {
      const hotelSlug = hotelFromRequest(req);
      if (!hotelSlug) {
        return res.status(403).json({ success: false, message: "Hotel scope is missing" });
      }
      const bill = await getLatestFoodBillPreview({
        supabaseClient: supabase,
        hotelSlug,
        actor: actorFromRequest(req),
        formatOverride: req.validatedBody
      });
      if (!bill) {
        return res.status(404).json({
          success: false,
          message: "No hotel-scoped food order is available for live preview yet"
        });
      }
      return res.json({ success: true, bill });
    } catch (error) {
      return handleRouteError(res, error, "Food bill format preview error");
    }
  }
);

router.post("/format/reset", async (req, res) => {
  try {
    const hotelSlug = hotelFromRequest(req);
    if (!hotelSlug) {
      return res.status(403).json({ success: false, message: "Hotel scope is missing" });
    }
    const actor = actorFromRequest(req);
    const format = await resetFoodBillFormat({
      supabaseClient: supabase,
      hotelSlug,
      actorId: actor.id,
      actorRole: actor.role
    });
    return res.json({
      success: true,
      message: "Food order bill format reset to hotel defaults",
      format
    });
  } catch (error) {
    return handleRouteError(res, error, "Food bill format reset error");
  }
});

router.post("/format/test-print", async (req, res) => {
  try {
    const hotelSlug = hotelFromRequest(req);
    if (!hotelSlug) {
      return res.status(403).json({ success: false, message: "Hotel scope is missing" });
    }
    const actor = actorFromRequest(req);
    await writeFoodBillAudit({
      supabaseClient: supabase,
      hotelSlug,
      action: "food_bill_test_printed",
      actorId: actor.id,
      actorRole: actor.role
    });
    return res.json({ success: true });
  } catch (error) {
    return handleRouteError(res, error, "Food bill test print audit error");
  }
});

router.post("/format/logo", handleLogoUpload, async (req, res) => {
  try {
    const hotelSlug = hotelFromRequest(req);
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
        message: "Logo dimensions must be between 16x16 and 4096x4096 pixels"
      });
    }

    const extension = ALLOWED_LOGO_TYPES.get(req.file.mimetype);
    const propertyScope = await resolvePropertyStorageScope(supabase, hotelSlug);
    const storagePath = buildPropertyStoragePath(
      propertyScope,
      "food-order-bill",
      `${Date.now()}-${safeFileStem(req.file.originalname)}${extension}`
    );
    const { error: uploadError } = await supabase.storage
      .from("hotel-assets")
      .upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });
    if (uploadError) throw uploadError;

    const { data: publicData } = supabase.storage
      .from("hotel-assets")
      .getPublicUrl(storagePath);
    const actor = actorFromRequest(req);
    const format = await saveFoodBillFormat({
      supabaseClient: supabase,
      hotelSlug,
      input: {
        logoUrl: publicData.publicUrl,
        logoStoragePath: storagePath,
        logoAltText: sanitizeText(req.body?.altText || req.file.originalname, 240)
      },
      actorId: actor.id,
      actorRole: actor.role
    });
    await writeFoodBillAudit({
      supabaseClient: supabase,
      hotelSlug,
      action: "food_bill_logo_changed",
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
      message: "Food receipt logo uploaded",
      format
    });
  } catch (error) {
    return handleRouteError(res, error, "Food bill logo upload error");
  }
});

router.delete("/format/logo", async (req, res) => {
  try {
    const hotelSlug = hotelFromRequest(req);
    if (!hotelSlug) {
      return res.status(403).json({ success: false, message: "Hotel scope is missing" });
    }
    const current = await getFoodBillFormat({ supabaseClient: supabase, hotelSlug });
    const propertyScope = await resolvePropertyStorageScope(supabase, hotelSlug);
    if (current.logoStoragePath && isPropertyStoragePath(current.logoStoragePath, propertyScope, {
      resource: "food-order-bill",
      allowLegacy: true
    })) {
      const { error } = await supabase.storage
        .from("hotel-assets")
        .remove([current.logoStoragePath]);
      if (error) throw error;
    }
    const actor = actorFromRequest(req);
    const format = await saveFoodBillFormat({
      supabaseClient: supabase,
      hotelSlug,
      input: { logoUrl: "", logoStoragePath: "", logoAltText: "" },
      actorId: actor.id,
      actorRole: actor.role
    });
    await writeFoodBillAudit({
      supabaseClient: supabase,
      hotelSlug,
      action: "food_bill_logo_removed",
      actorId: actor.id,
      actorRole: actor.role,
      formatVersion: format.version
    });
    return res.json({ success: true, message: "Food receipt logo removed", format });
  } catch (error) {
    return handleRouteError(res, error, "Food bill logo remove error");
  }
});

router.get("/orders/:id", async (req, res) => {
  try {
    const hotelSlug = hotelFromRequest(req);
    const orderId = sanitizeText(req.params.id, 160);
    if (!hotelSlug || !orderId) {
      return res.status(404).json({
        success: false,
        message: "This order is unavailable or you do not have access to it."
      });
    }
    const result = await getFoodOrderBill({
      supabaseClient: supabase,
      hotelSlug,
      orderId,
      actor: actorFromRequest(req),
      issueFinal: true
    });
    if (!result) {
      return res.status(404).json({
        success: false,
        message: "This order is unavailable or you do not have access to it."
      });
    }
    return res.json({
      success: true,
      hotelSlug,
      bill: result.bill,
      snapshot: result.snapshot
    });
  } catch (error) {
    return handleRouteError(res, error, "Food bill fetch error");
  }
});

router.post(
  "/orders/:id/reprint",
  validateBody(foodOrderBillReprintSchema),
  async (req, res) => {
    try {
      const hotelSlug = hotelFromRequest(req);
      const orderId = sanitizeText(req.params.id, 160);
      if (!hotelSlug || !orderId) {
        return res.status(404).json({
          success: false,
          message: "This order is unavailable or you do not have access to it."
        });
      }
      const bill = await reprintFoodOrderBill({
        supabaseClient: supabase,
        hotelSlug,
        orderId,
        actor: actorFromRequest(req),
        reason: req.validatedBody.reason
      });
      if (!bill) {
        return res.status(409).json({
          success: false,
          message: "A final issued food bill is required before reprinting"
        });
      }
      return res.json({
        success: true,
        message: "Original food bill prepared for reprint",
        bill
      });
    } catch (error) {
      return handleRouteError(res, error, "Food bill reprint error");
    }
  }
);

router.post(
  "/orders/:id/audit",
  validateBody(foodOrderBillAuditSchema),
  async (req, res) => {
    try {
      const hotelSlug = hotelFromRequest(req);
      const orderId = sanitizeText(req.params.id, 160);
      if (!hotelSlug || !orderId) {
        return res.status(404).json({
          success: false,
          message: "This order is unavailable or you do not have access to it."
        });
      }
      const result = await getFoodOrderBill({
        supabaseClient: supabase,
        hotelSlug,
        orderId,
        actor: actorFromRequest(req),
        issueFinal: false
      });
      if (!result) {
        return res.status(404).json({
          success: false,
          message: "This order is unavailable or you do not have access to it."
        });
      }
      const actor = actorFromRequest(req);
      const actionMap = {
        bill_printed: "food_bill_printed",
        bill_downloaded: "food_bill_downloaded",
        bill_test_printed: "food_bill_test_printed"
      };
      await writeFoodBillAudit({
        supabaseClient: supabase,
        hotelSlug,
        action: actionMap[req.validatedBody.action],
        actorId: actor.id,
        actorRole: actor.role,
        orderId,
        invoiceNumber: result.bill.invoiceNumber,
        snapshotId: result.bill.snapshotId || null,
        formatVersion: result.bill.templateVersion
      });
      return res.json({ success: true });
    } catch (error) {
      return handleRouteError(res, error, "Food bill audit error");
    }
  }
);

module.exports = router;
