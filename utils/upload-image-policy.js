"use strict";

const { getImageDimensions } = require("./image-dimensions");
const IMAGE_UPLOAD_LIMITS = Object.freeze({ fileSize: 5 * 1024 * 1024, files: 1, fields: 8, parts: 10, fieldNameSize: 100, fieldSize: 4096 });

function isAvifHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16 || buffer.toString("ascii", 4, 8) !== "ftyp") return false;
  const size = buffer.readUInt32BE(0);
  if (size < 16 || size > buffer.length || size % 4 !== 0) return false;
  const brands = [buffer.toString("ascii", 8, 12)];
  for (let offset = 16; offset + 4 <= size; offset += 4) brands.push(buffer.toString("ascii", offset, offset + 4));
  return brands.some((brand) => brand === "avif" || brand === "avis");
}

function hasValidImageHeader(file) {
  if (!Buffer.isBuffer(file?.buffer)) return false;
  if (file.mimetype === "image/avif") return isAvifHeader(file.buffer);
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.mimetype)) return false;
  const dimensions = getImageDimensions(file.buffer, file.mimetype);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) return false;
  if (file.mimetype === "image/jpeg") return file.buffer.indexOf(Buffer.from([0xff, 0xda]), 2) >= 0;
  if (file.mimetype === "image/png") {
    let imageData = false;
    for (let offset = 8, chunks = 0; offset + 12 <= file.buffer.length && chunks < 4096; chunks += 1) {
      const size = file.buffer.readUInt32BE(offset);
      const type = file.buffer.toString("ascii", offset + 4, offset + 8);
      if (size > file.buffer.length - offset - 12) return false;
      if (type === "IDAT" && size > 0) imageData = true;
      const next = offset + 12 + size;
      if (type === "IEND") return size === 0 && imageData && next === file.buffer.length;
      offset = next;
    }
    return false;
  }
  if (file.mimetype === "image/webp") {
    if (file.buffer.readUInt32LE(4) + 8 !== file.buffer.length) return false;
    let imageData = false;
    for (let offset = 12, chunks = 0; offset + 8 <= file.buffer.length && chunks < 4096; chunks += 1) {
      const size = file.buffer.readUInt32LE(offset + 4);
      const type = file.buffer.toString("ascii", offset, offset + 4);
      const next = offset + 8 + size + (size % 2);
      if (next > file.buffer.length) return false;
      if (["VP8 ", "VP8L", "ANMF"].includes(type) && size >= 5) imageData = true;
      if (next === file.buffer.length) return imageData;
      offset = next;
    }
    return false;
  }
  return false;
}

function safeUploadError(error) {
  if (error?.code === "LIMIT_FILE_SIZE") return "Image file must be 5 MB or smaller";
  if (error?.code === "LIMIT_FIELD_VALUE") return "Upload form field is too large";
  if (["LIMIT_FILE_COUNT", "LIMIT_PART_COUNT", "LIMIT_FIELD_COUNT", "LIMIT_FIELD_KEY", "LIMIT_UNEXPECTED_FILE"].includes(error?.code)) return "Upload form exceeds the allowed field or file limits";
  return "Only JPG, PNG, WebP, or AVIF uploads are allowed";
}

module.exports = { IMAGE_UPLOAD_LIMITS, isAvifHeader, hasValidImageHeader, safeUploadError };
