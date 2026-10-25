const crypto = require("crypto");
const { env } = require("../config/env");

const QR_TOKEN_PREFIX = "q1_";
const QR_SESSION_COOKIE = "qr_order_session";
const QR_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

function normalizeSecureQrText(value = "", maxLength = 160) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLength);
}

function toBase64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function generateOpaqueQrToken() {
  return `${QR_TOKEN_PREFIX}${toBase64Url(crypto.randomBytes(32))}`;
}

function generateCustomerSessionToken() {
  return toBase64Url(crypto.randomBytes(32));
}

function generateCsrfToken() {
  return toBase64Url(crypto.randomBytes(24));
}

function hashSecret(value = "") {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function getEncryptionKey() {
  const secret = String(env.qrContextSigningSecret || env.jwtSecret || "").trim();
  return crypto.createHash("sha256").update(`restaurant-table-qr:${secret}`, "utf8").digest();
}

function encryptQrToken(rawToken = "") {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(rawToken), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", toBase64Url(iv), toBase64Url(tag), toBase64Url(ciphertext)].join(".");
}

function decryptQrToken(encryptedToken = "") {
  const [version, encodedIv, encodedTag, encodedCiphertext] = String(encryptedToken || "").split(".");
  if (version !== "v1" || !encodedIv || !encodedTag || !encodedCiphertext) return "";
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      getEncryptionKey(),
      Buffer.from(encodedIv, "base64url")
    );
    decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, "base64url")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    return "";
  }
}

function getCookie(req, name) {
  const cookieHeader = String(req?.headers?.cookie || "");
  for (const entry of cookieHeader.split(";")) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex < 0) continue;
    const key = entry.slice(0, separatorIndex).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(entry.slice(separatorIndex + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function getQrSessionToken(req) {
  return getCookie(req, QR_SESSION_COOKIE);
}

function getQrSessionCookieOptions() {
  // The TEST browser acceptance environment is intentionally Node
  // "development" so the Razorpay LIVE guard remains closed, but it is still
  // a cross-site HTTPS frontend-to-API deployment. Reuse the reviewed Task 4
  // cookie policy rather than deriving QR-session behaviour from NODE_ENV.
  // A `SameSite=None` cookie must be Secure; fall back safely for a local
  // development configuration that has not enabled secure cookies.
  const secure = env.authRefreshCookieSecure === true;
  const configuredSameSite = String(env.authRefreshCookieSameSite || "lax").toLowerCase();
  const sameSite = configuredSameSite === "none" && !secure
    ? "lax"
    : configuredSameSite;

  return {
    httpOnly: true,
    secure,
    sameSite,
    maxAge: QR_SESSION_TTL_MS,
    path: "/api/public/qr"
  };
}

function normalizeQrFrontendBase(value = "") {
  const candidate = String(value || "").split(",")[0].trim();
  if (!candidate) return "";

  try {
    const parsed = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)
        ? candidate
        : "https://" + candidate
    );
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
      return "";
    }
    return parsed.origin.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function getCanonicalQrUrl(rawToken = "", frontendBaseOverride = "") {
  const frontendBase =
    normalizeQrFrontendBase(frontendBaseOverride) ||
    normalizeQrFrontendBase(env.frontendUrl || process.env.PUBLIC_FRONTEND_URL || "");
  return frontendBase + "/menu?q=" + encodeURIComponent(rawToken);
}
function buildRequestFingerprint(value) {
  return hashSecret(JSON.stringify(value));
}

function safeSecretPrefix(value = "") {
  return normalizeSecureQrText(value, 2000).slice(0, 12);
}

module.exports = {
  QR_SESSION_COOKIE,
  QR_SESSION_TTL_MS,
  buildRequestFingerprint,
  decryptQrToken,
  encryptQrToken,
  generateCsrfToken,
  generateCustomerSessionToken,
  generateOpaqueQrToken,
  getCanonicalQrUrl,
  getQrSessionCookieOptions,
  getQrSessionToken,
  hashSecret,
  normalizeSecureQrText,
  safeSecretPrefix
};
