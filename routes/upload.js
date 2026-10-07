const express = require("express");
const multer = require("multer");
const path = require("path");
const { supabase } = require("../utils/supabase");
const { requireAdminAuth } = require("../middleware/require-admin-auth");
const { getImageDimensions } = require("../utils/image-dimensions");
const {
  authorizePlatformAdminStoragePath,
  buildPlatformStoragePath,
  buildPropertyStoragePath,
  resolvePropertyStorageScope
} = require("../utils/storage-object-scope");

const router = express.Router();

const ALLOWED_IMAGE_TYPES = new Map([
  [
    "image/jpeg",
    {
      defaultExt: ".jpg",
      extensions: [".jpg", ".jpeg"],
      isValidBuffer: (buffer) =>
        buffer.length >= 3 &&
        buffer[0] === 0xff &&
        buffer[1] === 0xd8 &&
        buffer[2] === 0xff
    }
  ],
  [
    "image/png",
    {
      defaultExt: ".png",
      extensions: [".png"],
      isValidBuffer: (buffer) =>
        buffer.length >= 8 &&
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0d &&
        buffer[5] === 0x0a &&
        buffer[6] === 0x1a &&
        buffer[7] === 0x0a
    }
  ],
  [
    "image/webp",
    {
      defaultExt: ".webp",
      extensions: [".webp"],
      isValidBuffer: (buffer) =>
        buffer.length >= 12 &&
        buffer.toString("ascii", 0, 4) === "RIFF" &&
        buffer.toString("ascii", 8, 12) === "WEBP"
    }
  ],
  [
    "image/avif",
    {
      defaultExt: ".avif",
      extensions: [".avif"],
      isValidBuffer: (buffer) =>
        buffer.length >= 16 &&
        buffer.toString("ascii", 4, 8) === "ftyp" &&
        ["avif", "avis"].some((brand) => buffer.toString("ascii", 8, 16).includes(brand))
    }
  ]
]);
const ALLOWED_IMAGE_TYPE_LABEL = "JPG, PNG, WebP, or AVIF";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter(req, file, cb) {
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      return cb(new Error(`Only ${ALLOWED_IMAGE_TYPE_LABEL} uploads are allowed`));
    }

    cb(null, true);
  }
});

function handleImageUpload(req, res, next) {
  upload.single("file")(req, res, (error) => {
    if (!error) {
      return next();
    }

    const message = error.code === "LIMIT_FILE_SIZE"
      ? "Image file must be 5 MB or smaller"
      : error.message || `Only ${ALLOWED_IMAGE_TYPE_LABEL} uploads are allowed`;

    return res.status(400).json({
      success: false,
      message
    });
  });
}

function sanitizeStorageSegment(value = "", fallback = "misc") {
  const sanitized = String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return sanitized || fallback;
}

function sanitizeFileName(name = "") {
  const sanitized = String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9.\-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return sanitized || "image";
}

function getSafeImageExtension(file) {
  const imageConfig = ALLOWED_IMAGE_TYPES.get(file.mimetype);
  const originalExt = path.extname(file.originalname || "").toLowerCase();

  if (imageConfig?.extensions.includes(originalExt)) {
    return originalExt;
  }

  return imageConfig?.defaultExt || ".img";
}

function isValidImageUpload(file) {
  const imageConfig = ALLOWED_IMAGE_TYPES.get(file?.mimetype || "");

  if (!imageConfig || !Buffer.isBuffer(file?.buffer)) {
    return false;
  }

  return imageConfig.isValidBuffer(file.buffer);
}

router.post(
  "/",
  requireAdminAuth,
  handleImageUpload,
  async (req, res) => {
    try {
      const file = req.file;
      const hotelSlug = String(req.body.hotelSlug || "shared").trim();
      const folder = String(req.body.folder || "misc").trim();

      if (!file) {
        return res.status(400).json({
          success: false,
          message: "No file uploaded"
        });
      }

      if (!isValidImageUpload(file)) {
        return res.status(400).json({
          success: false,
          message: `Invalid image file. Please upload a valid ${ALLOWED_IMAGE_TYPE_LABEL} file.`
        });
      }
      const dimensions = getImageDimensions(file.buffer, file.mimetype);
      if (dimensions) {
        const pixels = Number(dimensions.width) * Number(dimensions.height);
        if (dimensions.width > 8000 || dimensions.height > 8000 || pixels > 40_000_000) {
          return res.status(400).json({
            success: false,
            message: "Image dimensions are too large. Use an image up to 8000 x 8000 and 40 megapixels."
          });
        }
        const isMenuImage = /^(menu-items|menu-categories)(\/|$)/i.test(folder);
        if (isMenuImage && (dimensions.width < 160 || dimensions.height < 160)) {
          return res.status(400).json({
            success: false,
            message: "Menu images must be at least 160 x 160 pixels."
          });
        }
      }

      const safeFolder = sanitizeStorageSegment(folder, "misc");
      const ext = getSafeImageExtension(file);
      const baseName = path.basename(file.originalname || "file", ext);
      const safeName = sanitizeFileName(baseName);
      const uniqueName = `${Date.now()}-${safeName}${ext}`;
      let storagePath;
      let storageScope;
      if (["shared", "platform"].includes(hotelSlug.toLowerCase())) {
        storagePath = buildPlatformStoragePath(safeFolder, uniqueName);
        storageScope = { kind: "platform" };
      } else {
        const propertyScope = await resolvePropertyStorageScope(supabase, hotelSlug);
        storagePath = buildPropertyStoragePath(propertyScope, safeFolder, uniqueName);
        storageScope = {
          kind: "property",
          propertyId: propertyScope.propertyId,
          propertySlug: propertyScope.propertySlug
        };
      }

      const { error: uploadError } = await supabase.storage
        .from("hotel-assets")
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype,
          upsert: false
        });

      if (uploadError) {
        throw uploadError;
      }

      const { data: publicData } = supabase.storage
        .from("hotel-assets")
        .getPublicUrl(storagePath);

      res.status(201).json({
        success: true,
        message: "File uploaded successfully",
        file: {
          originalName: file.originalname,
          path: storagePath,
          publicUrl: publicData.publicUrl,
          storageScope
        }
      });
    } catch (error) {
      console.error("Upload error:", error);
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.statusCode ? error.message : "Failed to upload file"
      });
    }
  }
);

router.delete("/", requireAdminAuth, async (req, res) => {
  try {
    const storagePath = String(req.body.storagePath || "").trim();

    if (!storagePath) {
      return res.status(400).json({
        success: false,
        message: "storagePath is required"
      });
    }

    const authorization = await authorizePlatformAdminStoragePath(supabase, storagePath);
    if (!authorization) {
      return res.status(403).json({
        success: false,
        message: "Storage path is not a recognized platform or current hotel scope"
      });
    }

    const { error } = await supabase.storage
      .from("hotel-assets")
      .remove([storagePath]);

    if (error) throw error;

    res.json({
      success: true,
      message: "File deleted successfully",
      storageScope: authorization.kind
    });
  } catch (error) {
    console.error("File delete error:", error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : "Failed to delete file"
    });
  }
});

module.exports = router;
