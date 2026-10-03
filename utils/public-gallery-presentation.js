"use strict";

function buildPublicGalleryPayload(items = []) {
  return {
    success: true,
    gallery: (Array.isArray(items) ? items : []).map((item) => ({
      id: item.id,
      imageUrl: item.image_url || "",
      storagePath: item.storage_path || "",
      alt: item.alt || "",
      layoutVariant: item.layout_variant || "standard",
      sortOrder: Number(item.sort_order || 0)
    }))
  };
}

module.exports = {
  buildPublicGalleryPayload
};
