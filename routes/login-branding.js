"use strict";

const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const { supabase } = require("../utils/supabase");
const { requireAdminAuth } = require("../middleware/require-admin-auth");
const { validateBody } = require("../validators/common");
const {
  loginBrandingImageDeleteSchema,
  loginBrandingSaveSchema,
  loginBrandingScopeSchema
} = require("../validators/login-branding");
const {
  BUILT_IN_LOGIN_BRANDING,
  buildPublicLoginBranding,
  isMissingLoginBrandingRelationError
} = require("../utils/login-branding");
const { getImageDimensions } = require("../utils/image-dimensions");
const {
  buildPlatformStoragePath,
  buildPropertyStoragePath,
  isPlatformStoragePath,
  isPropertyStoragePath,
  resolvePropertyStorageScope
} = require("../utils/storage-object-scope");

const publicRouter = express.Router();
const adminRouter = express.Router();
const PUBLIC_CACHE_TTL_MS = 60 * 1000;
const publicBrandingCache = new Map();
const ALLOWED_IMAGE_TYPES = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"]
]);

const IMAGE_CONFIG_KEYS = Object.freeze([
  "logoUrl",
  "footerLogoUrl",
  "heroImageUrl",
  "backgroundImageUrl"
]);

const publicBrandingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many branding requests. Please try again later." }
});

const brandingImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter(req, file, callback) {
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      return callback(new Error("Only JPG, PNG, or WebP images are allowed"));
    }
    callback(null, true);
  }
});

function normalizeScope(scope = {}) {
  return {
    scopeType: String(scope.scopeType || "").trim().toLowerCase(),
    hotelSlug: String(scope.hotelSlug || "").trim().toLowerCase()
  };
}

function getScopeStoragePrefix(scope) {
  return scope.scopeType === "platform"
    ? "platform/login-branding/"
    : `${scope.hotelSlug}/login-branding/`;
}

function requirePlatformBrandingAdmin(req, res, next) {
  if (req.adminUser?.scope !== "admin") {
    return res.status(403).json({
      success: false,
      message: "Platform Admin access is required"
    });
  }
  next();
}

function clearPublicBrandingCache() {
  publicBrandingCache.clear();
}

async function getBrandingRow(scope) {
  let query = supabase
    .from("login_page_branding")
    .select("id,scope_type,hotel_slug,draft_config,published_config,is_published,version,created_at,updated_at,published_at");

  query = scope.scopeType === "platform"
    ? query.eq("scope_type", "platform").is("hotel_slug", null)
    : query.eq("scope_type", "hotel").eq("hotel_slug", scope.hotelSlug);

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data || null;
}

async function assertHotelExists(scope) {
  if (scope.scopeType !== "hotel") return null;
  return resolvePropertyStorageScope(supabase, scope.hotelSlug);
}

async function writeAudit({ rowId = null, scope, action, actorId, metadata = {} }) {
  const { error } = await supabase.from("login_page_branding_audit").insert([{
    branding_id: rowId,
    scope_type: scope.scopeType,
    hotel_slug: scope.scopeType === "hotel" ? scope.hotelSlug : null,
    action,
    actor_id: actorId || null,
    metadata
  }]);

  if (error && !isMissingLoginBrandingRelationError(error)) {
    console.warn("Login branding audit write failed:", error.message || error);
  }
}

function handleUploadMiddleware(req, res, next) {
  brandingImageUpload.single("file")(req, res, (error) => {
    if (!error) return next();
    return res.status(400).json({
      success: false,
      message: error.code === "LIMIT_FILE_SIZE"
        ? "Branding image must be 4 MB or smaller"
        : error.message || "Invalid branding image"
    });
  });
}

publicRouter.use((req, res, next) => { res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300"); next(); });
publicRouter.get("/", publicBrandingLimiter, async (req, res) => {
  const hotelSlug = String(req.query.hotelSlug || "").trim().toLowerCase();
  if (hotelSlug && !/^[a-z0-9][a-z0-9-]{1,119}$/.test(hotelSlug)) {
    return res.status(400).json({ success: false, message: "Invalid hotel slug" });
  }

  const cacheKey = hotelSlug || "platform";
  const cached = publicBrandingCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json({ success: true, branding: cached.branding });
  }

  try {
    const platformRow = await getBrandingRow({ scopeType: "platform", hotelSlug: "" });
    const platformConfig = platformRow?.is_published && platformRow.published_config
      ? platformRow.published_config
      : {};
    let hotelConfig = {};
    if (hotelSlug) {
      const hotelRow = await getBrandingRow({ scopeType: "hotel", hotelSlug });
      hotelConfig = hotelRow?.is_published && hotelRow.published_config
        ? hotelRow.published_config
        : {};
    }

    const branding = buildPublicLoginBranding({
      ...BUILT_IN_LOGIN_BRANDING,
      ...platformConfig,
      ...hotelConfig
    });
    publicBrandingCache.set(cacheKey, { branding, expiresAt: Date.now() + PUBLIC_CACHE_TTL_MS });
    return res.json({ success: true, branding });
  } catch (error) {
    if (!isMissingLoginBrandingRelationError(error)) {
      console.warn("Public login branding lookup failed:", error.message || error);
    }
    return res.json({ success: true, branding: buildPublicLoginBranding(BUILT_IN_LOGIN_BRANDING) });
  }
});

adminRouter.use(requireAdminAuth, requirePlatformBrandingAdmin);

adminRouter.get("/", async (req, res) => {
  const parsedScope = loginBrandingScopeSchema.safeParse({
    scopeType: req.query.scopeType,
    hotelSlug: req.query.hotelSlug || undefined
  });
  if (!parsedScope.success) {
    return res.status(400).json({ success: false, message: parsedScope.error.issues[0]?.message || "Invalid branding scope" });
  }

  const scope = normalizeScope(parsedScope.data);
  try {
    await assertHotelExists(scope);
    const row = await getBrandingRow(scope);
    return res.json({
      success: true,
      branding: row ? {
        id: row.id,
        scopeType: row.scope_type,
        hotelSlug: row.hotel_slug || "",
        draftConfig: buildPublicLoginBranding(row.draft_config || BUILT_IN_LOGIN_BRANDING),
        publishedConfig: row.published_config ? buildPublicLoginBranding(row.published_config) : null,
        isPublished: !!row.is_published,
        version: Number(row.version || 0),
        updatedAt: row.updated_at,
        publishedAt: row.published_at
      } : {
        id: null,
        scopeType: scope.scopeType,
        hotelSlug: scope.hotelSlug,
        draftConfig: buildPublicLoginBranding(BUILT_IN_LOGIN_BRANDING),
        publishedConfig: null,
        isPublished: false,
        version: 0,
        updatedAt: null,
        publishedAt: null
      }
    });
  } catch (error) {
    if (isMissingLoginBrandingRelationError(error)) {
      return res.status(503).json({ success: false, message: "Login branding storage is not initialized yet" });
    }
    return res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : "Failed to load login branding" });
  }
});

adminRouter.put("/", validateBody(loginBrandingSaveSchema), async (req, res) => {
  const scope = normalizeScope(req.validatedBody);
  const actorId = String(req.adminUser?.sub || "").trim();
  try {
    await assertHotelExists(scope);
    const existing = await getBrandingRow(scope);
    const payload = {
      scope_type: scope.scopeType,
      hotel_slug: scope.scopeType === "hotel" ? scope.hotelSlug : null,
      draft_config: buildPublicLoginBranding(req.validatedBody.config),
      updated_by: actorId || null,
      updated_at: new Date().toISOString()
    };
    let result;
    if (existing) {
      result = await supabase.from("login_page_branding").update(payload).eq("id", existing.id).select("id").single();
    } else {
      result = await supabase.from("login_page_branding").insert([{ ...payload, created_by: actorId || null }]).select("id").single();
    }
    if (result.error) throw result.error;
    await writeAudit({ rowId: result.data.id, scope, action: "draft_saved", actorId });
    return res.json({ success: true, message: "Branding draft saved", brandingId: result.data.id });
  } catch (error) {
    if (isMissingLoginBrandingRelationError(error)) {
      return res.status(503).json({ success: false, message: "Login branding storage is not initialized yet" });
    }
    return res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : "Failed to save branding draft" });
  }
});

adminRouter.post("/publish", validateBody(loginBrandingScopeSchema), async (req, res) => {
  const scope = normalizeScope(req.validatedBody);
  const actorId = String(req.adminUser?.sub || "").trim();
  try {
    await assertHotelExists(scope);
    const existing = await getBrandingRow(scope);
    if (!existing) return res.status(400).json({ success: false, message: "Save a branding draft before publishing" });

    const nextVersion = Number(existing.version || 0) + 1;
    const { error } = await supabase.from("login_page_branding").update({
      published_config: existing.draft_config,
      is_published: true,
      version: nextVersion,
      published_by: actorId || null,
      published_at: new Date().toISOString(),
      updated_by: actorId || null,
      updated_at: new Date().toISOString()
    }).eq("id", existing.id);
    if (error) throw error;
    clearPublicBrandingCache();
    await writeAudit({ rowId: existing.id, scope, action: "published", actorId, metadata: { version: nextVersion } });
    return res.json({ success: true, message: "Login branding published", version: nextVersion });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : "Failed to publish login branding" });
  }
});

adminRouter.post("/reset", validateBody(loginBrandingScopeSchema), async (req, res) => {
  const scope = normalizeScope(req.validatedBody);
  const actorId = String(req.adminUser?.sub || "").trim();
  try {
    await assertHotelExists(scope);
    const existing = await getBrandingRow(scope);
    if (scope.scopeType === "hotel") {
      if (existing) {
        const { error } = await supabase.from("login_page_branding").delete().eq("id", existing.id);
        if (error) throw error;
      }
    } else if (existing) {
      const { error } = await supabase.from("login_page_branding").update({
        draft_config: BUILT_IN_LOGIN_BRANDING,
        published_config: BUILT_IN_LOGIN_BRANDING,
        is_published: true,
        version: Number(existing.version || 0) + 1,
        updated_by: actorId || null,
        published_by: actorId || null,
        updated_at: new Date().toISOString(),
        published_at: new Date().toISOString()
      }).eq("id", existing.id);
      if (error) throw error;
    }
    clearPublicBrandingCache();
    await writeAudit({ rowId: existing?.id || null, scope, action: "reset", actorId });
    return res.json({
      success: true,
      message: scope.scopeType === "hotel" ? "Hotel branding reset to platform fallback" : "Platform branding reset to built-in defaults"
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : "Failed to reset login branding" });
  }
});

adminRouter.post("/image", handleUploadMiddleware, async (req, res) => {
  const parsedScope = loginBrandingScopeSchema.safeParse({ scopeType: req.body.scopeType, hotelSlug: req.body.hotelSlug || undefined });
  if (!parsedScope.success) {
    return res.status(400).json({ success: false, message: parsedScope.error.issues[0]?.message || "Invalid branding scope" });
  }

  const scope = normalizeScope(parsedScope.data);
  const allowedImageTypes = ["logo", "footer-logo", "hero", "background"];
  const file = req.file;
  if (!file) return res.status(400).json({ success: false, message: "No image uploaded" });
  if (!allowedImageTypes.includes(req.body.imageType)) {
    return res.status(400).json({ success: false, message: "Invalid branding image type" });
  }
  const imageType = req.body.imageType;

  const dimensions = getImageDimensions(file.buffer, file.mimetype);
  if (!dimensions || dimensions.width < 32 || dimensions.height < 32 || dimensions.width > 6000 || dimensions.height > 6000) {
    return res.status(400).json({ success: false, message: "Image signature or dimensions are invalid (32–6000 px required)" });
  }

  try {
    const propertyScope = await assertHotelExists(scope);
    const extension = ALLOWED_IMAGE_TYPES.get(file.mimetype);
    const fileName = `${imageType}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}${extension}`;
    const storagePath = scope.scopeType === "platform"
      ? buildPlatformStoragePath("login-branding", fileName)
      : buildPropertyStoragePath(propertyScope, "login-branding", fileName);
    const { error } = await supabase.storage.from("hotel-assets").upload(storagePath, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
      cacheControl: "31536000"
    });
    if (error) throw error;
    const { data: publicData } = supabase.storage.from("hotel-assets").getPublicUrl(storagePath);
    await writeAudit({
      scope,
      action: "image_uploaded",
      actorId: String(req.adminUser?.sub || "").trim(),
      metadata: { imageType, storagePath, width: dimensions.width, height: dimensions.height, mimeType: file.mimetype }
    });
    return res.status(201).json({
      success: true,
      message: "Branding image uploaded",
      image: { publicUrl: publicData.publicUrl, storagePath, width: dimensions.width, height: dimensions.height }
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : "Failed to upload branding image" });
  }
});

adminRouter.delete("/image", validateBody(loginBrandingImageDeleteSchema), async (req, res) => {
  const scope = normalizeScope(req.validatedBody);
  const storagePath = req.validatedBody.storagePath;
  if (storagePath.includes("..")) {
    return res.status(403).json({ success: false, message: "Image path does not belong to this branding scope" });
  }

  try {
    const propertyScope = await assertHotelExists(scope);
    const belongsToScope = scope.scopeType === "platform"
      ? isPlatformStoragePath(storagePath, "login-branding")
      : isPropertyStoragePath(storagePath, propertyScope, { resource: "login-branding", allowLegacy: true });
    if (!belongsToScope) {
      return res.status(403).json({ success: false, message: "Image path does not belong to this branding scope" });
    }
    const { data: publicData } = supabase.storage.from("hotel-assets").getPublicUrl(storagePath);
    const publicUrl = String(publicData?.publicUrl || "").trim();
    const row = await getBrandingRow(scope);
    const referencesImage = (config = {}) => IMAGE_CONFIG_KEYS.some((key) => {
      const value = String(config?.[key] || "").trim();
      return value && (value === storagePath || value === publicUrl || value.endsWith(`/${storagePath}`));
    });

    if (row?.is_published && referencesImage(row.published_config)) {
      return res.status(409).json({
        success: false,
        message: "Publish a replacement or remove this image from published branding before deleting the file"
      });
    }

    const { error } = await supabase.storage.from("hotel-assets").remove([storagePath]);
    if (error) throw error;
    if (row?.draft_config && referencesImage(row.draft_config)) {
      const nextDraftConfig = { ...row.draft_config };
      for (const key of IMAGE_CONFIG_KEYS) {
        const value = String(nextDraftConfig[key] || "").trim();
        if (value === storagePath || value === publicUrl || value.endsWith(`/${storagePath}`)) {
          nextDraftConfig[key] = "";
        }
      }
      const { error: updateError } = await supabase.from("login_page_branding").update({
        draft_config: nextDraftConfig,
        updated_by: String(req.adminUser?.sub || "").trim() || null,
        updated_at: new Date().toISOString()
      }).eq("id", row.id);
      if (updateError) throw updateError;
    }
    await writeAudit({
      scope,
      action: "image_removed",
      actorId: String(req.adminUser?.sub || "").trim(),
      metadata: { storagePath }
    });
    return res.json({ success: true, message: "Branding image removed" });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : "Failed to remove branding image" });
  }
});

module.exports = { publicLoginBrandingRouter: publicRouter, adminLoginBrandingRouter: adminRouter };
