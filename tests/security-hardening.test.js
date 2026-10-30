"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
process.env.SUPABASE_URL ||= "https://task7-security.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "synthetic-security-service-key";
process.env.JWT_SECRET ||= "synthetic-security-jwt-at-least-thirty-two-characters";
process.env.NOTIFICATION_EMAIL_FROM = "notifier@example.test";
const { parseTrustProxyHops, safeParserError } = require("../utils/http-security");
const { IMAGE_UPLOAD_LIMITS, hasValidImageHeader, isAvifHeader, safeUploadError } = require("../utils/upload-image-policy");
const { scanText, validateAllowlist, decodeSource } = require("../utils/secret-scanner");
const multer = require("multer");
const express = require("express");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR9sAAAAASUVORK5CYII=", "base64");

function request(body, contentType) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const req = Readable.from([bytes]);
  req.headers = { "content-type": contentType, "content-length": String(bytes.length) };
  req.method = "POST";
  return req;
}

function multipart(parts) {
  const boundary = "task7-synthetic-boundary";
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.file ? '; filename="fixture.png"' : ""}\r\n${part.file ? "Content-Type: image/png\r\n" : ""}\r\n`));
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return request(Buffer.concat(chunks), `multipart/form-data; boundary=${boundary}`);
}

async function parseUpload(parts) {
  const req = multipart(parts);
  const middleware = multer({ storage: multer.memoryStorage(), limits: IMAGE_UPLOAD_LIMITS }).single("file");
  const error = await new Promise((resolve) => middleware(req, {}, resolve));
  return { req, error };
}

test("proxy defaults remain one hop; trust-all, subnets, negatives and malformed values fail closed", () => {
  assert.equal(parseTrustProxyHops(), 1);
  for (const value of ["0", "1", "2", "5"]) assert.equal(parseTrustProxyHops(value), Number(value));
  for (const value of ["true", "false", "-1", "1.5", "6", "loopback", "10.0.0.0/8", "", "1\n2"]) assert.throws(() => parseTrustProxyHops(value), { code: "TRUST_PROXY_CONFIG_INVALID" });
});

test("parser errors expose only bounded categories and preserve unknown error handling", () => {
  for (const [type, status] of [["entity.too.large", 413], ["entity.parse.failed", 400], ["charset.unsupported", 415]]) {
    const result = safeParserError({ type, message: "private request body" });
    assert.equal(result.status, status); assert.ok(!JSON.stringify(result).includes("private"));
  }
  assert.equal(safeParserError({ message: "unknown" }), null);
});

test("malformed and oversized JSON are rejected by the real parser without prototype pollution", async () => {
  const parse = (body) => {
    const req = request(body, "application/json");
    return new Promise((resolve) => express.json({ limit: "1kb" })(req, {}, (error) => resolve({ req, error })));
  };
  const malformed = await parse('{"broken":'); assert.equal(safeParserError(malformed.error).status, 400);
  const oversized = await parse(JSON.stringify({ value: "x".repeat(2048) })); assert.equal(safeParserError(oversized.error).status, 413);
  const valid = await parse('{"__proto__":{"task7polluted":true},"value":1}');
  assert.ifError(valid.error); assert.equal(valid.req.body.value, 1); assert.equal({}.task7polluted, undefined);
});

test("a normal existing file/hotel/folder upload still parses with the same form names", async () => {
  const { req, error } = await parseUpload([{ name: "hotelSlug", value: "hotel-fixture" }, { name: "folder", value: "menu-items" }, { name: "file", value: PNG, file: true }]);
  assert.ifError(error); assert.equal(req.body.hotelSlug, "hotel-fixture"); assert.equal(req.body.folder, "menu-items");
  assert.deepEqual(req.file.buffer, PNG); assert.equal(req.file.mimetype, "image/png");
});

test("multipart field-count, field-size and unexpected-file attacks are bounded", async () => {
  const tooMany = await parseUpload(Array.from({ length: 9 }, (_, i) => ({ name: `field${i}`, value: "x" })));
  assert.equal(tooMany.error.code, "LIMIT_FIELD_COUNT");
  const oversized = await parseUpload([{ name: "folder", value: "x".repeat(4097) }]);
  assert.equal(oversized.error.code, "LIMIT_FIELD_VALUE");
  const wrong = await parseUpload([{ name: "untrusted", value: PNG, file: true }]);
  assert.equal(wrong.error.code, "LIMIT_UNEXPECTED_FILE");
  assert.ok(!safeUploadError(wrong.error).includes("untrusted"));
});

test("multipart file-size limit remains 5 MB and rejects larger input", async () => {
  const { error } = await parseUpload([{ name: "file", file: true, value: Buffer.alloc(IMAGE_UPLOAD_LIMITS.fileSize + 1) }]);
  assert.equal(error.code, "LIMIT_FILE_SIZE"); assert.match(safeUploadError(error), /5 MB/);
});

test("valid PNG header/container is accepted while truncated or mismatched content is denied", () => {
  assert.equal(hasValidImageHeader({ mimetype: "image/png", buffer: PNG }), true);
  for (const buffer of [PNG.subarray(0, 8), PNG.subarray(0, 33), PNG.subarray(0, PNG.length - 1), Buffer.from("<script>fixture</script>")]) {
    assert.equal(hasValidImageHeader({ mimetype: "image/png", buffer }), false);
  }
  assert.equal(hasValidImageHeader({ mimetype: "image/jpeg", buffer: PNG }), false);
  assert.equal(hasValidImageHeader({ mimetype: "image/svg+xml", buffer: Buffer.from("<svg/>") }), false);
});

test("JPEG/WebP signature-only payloads cannot bypass dimension/content-header checks", () => {
  assert.equal(hasValidImageHeader({ mimetype: "image/jpeg", buffer: Buffer.from([255, 216, 255]) }), false);
  const webp = Buffer.alloc(30); webp.write("RIFF", 0); webp.writeUInt32LE(22, 4); webp.write("WEBPVP8X", 8);
  assert.equal(hasValidImageHeader({ mimetype: "image/webp", buffer: webp }), false);
});

test("small valid lossless WebP headers keep their existing format support", () => {
  const webp = Buffer.alloc(26); webp.write("RIFF", 0); webp.writeUInt32LE(18, 4); webp.write("WEBPVP8L", 8);
  webp.writeUInt32LE(5, 16); webp[20] = 0x2f;
  assert.equal(hasValidImageHeader({ mimetype: "image/webp", buffer: webp }), true);
});

test("AVIF brand checks use exact bounded ftyp brands, never substring matches", () => {
  const valid = Buffer.alloc(24); valid.writeUInt32BE(24, 0); valid.write("ftyp", 4); valid.write("mif1", 8); valid.write("avif", 16);
  assert.equal(isAvifHeader(valid), true);
  const wrong = Buffer.from(valid); wrong.write("xavi", 16); assert.equal(isAvifHeader(wrong), false);
  const oversized = Buffer.from(valid); oversized.writeUInt32BE(1000, 0); assert.equal(isAvifHeader(oversized), false);
  assert.equal(isAvifHeader(valid.subarray(0, 12)), false);
});

test("static headers start CSP in report-only mode with no new HSTS/framing enforcement", () => {
  const headers = fs.readFileSync(path.resolve(__dirname, "../../frontend/_headers"), "utf8");
  assert.match(headers, /^\/\*\r?\n/);
  assert.match(headers, /Content-Security-Policy-Report-Only:/);
  assert.doesNotMatch(headers, /^\s*Content-Security-Policy:|Strict-Transport-Security:|X-Frame-Options:/m);
  for (const value of ["checkout.razorpay.com", "cdn.jsdelivr.net", "fonts.googleapis.com", "wss://*.supabase.co"]) assert.ok(headers.includes(value));
  assert.match(headers, /Referrer-Policy: no-referrer/); assert.match(headers, /X-Content-Type-Options: nosniff/);
  assert.match(headers, /Cache-Control: public, max-age=31536000, immutable/);
});

test("frontend packaging retains private source/dependency exclusions and excludes local tool state", () => {
  const rules = fs.readFileSync(path.resolve(__dirname, "../../frontend/.assetsignore"), "utf8").split(/\r?\n/);
  for (const pattern of ["node_modules/", ".git/", ".env", ".env.*", "package.json", "package-lock.json", ".wrangler/", ".cache/"]) assert.ok(rules.includes(pattern), pattern);
  assert.ok(!rules.includes("vendor/") && !rules.includes("js/") && !rules.includes("img/"));
});

const assignment = (value) => ["JWT", "_SECRET=", JSON.stringify(value)].join("");

test("an example comment never hides a literal secret in application source", () => {
  const results = scanText(assignment("synthetic-sensitive-value") + " // example", "backend/routes/fixture.js");
  assert.equal(results.length, 1); assert.equal(results[0].status, "manual-review");
  assert.ok(!JSON.stringify(results).includes("synthetic-sensitive-value"));
});

test("approved fixtures bind exact file, detector and complete value fingerprint", () => {
  const file = "backend/tests/fixture.test.js";
  const finding = scanText(assignment("fixture-value-a"), file)[0];
  const allowlist = validateAllowlist([{ file, detector: finding.detector, valueSha256: finding.valueSha256, reason: "Synthetic unit fixture" }]);
  assert.equal(scanText(assignment("fixture-value-a"), file, allowlist)[0].status, "fixture-approved");
  assert.equal(scanText(assignment("fixture-value-b"), file, allowlist)[0].status, "manual-review");
  assert.equal(scanText(assignment("fixture-value-a"), "backend/tests/other.test.js", allowlist)[0].status, "manual-review");
});

test("empty env values do not consume the next setting and invalid allowlists fail", () => {
  assert.equal(scanText(["JWT", "_SECRET=\nNEXT_SETTING=false"].join(""), ".env.example").length, 0);
  assert.throws(() => validateAllowlist([{ file: "backend/routes/live.js", detector: "assigned-secret", valueSha256: "0".repeat(64), reason: "no" }]));
  assert.throws(() => validateAllowlist([{ file: "backend/tests/x.js", detector: "assigned-secret", valueSha256: "invalid", reason: "no" }]));
});

test("private-key fingerprints include the complete material and change with content", () => {
  const key = (value) => ["-----BEGIN ", "PRIVATE KEY-----\n", value, "\n-----END ", "PRIVATE KEY-----"].join("");
  const first = scanText(key("synthetic-a"), "backend/tests/fixture.test.js")[0];
  const second = scanText(key("synthetic-b"), "backend/tests/fixture.test.js")[0];
  assert.equal(first.detector, "private-key-material"); assert.notEqual(first.valueSha256, second.valueSha256);
});

test("UTF-16 and embedded NUL source do not bypass secret detection", () => {
  const source = assignment("fixture-encoding-secret");
  const utf16 = Buffer.concat([Buffer.from([255, 254]), Buffer.from(source, "utf16le")]);
  assert.equal(scanText(decodeSource(utf16, "backend/tests/fixture.test.js"), "backend/tests/fixture.test.js").length, 1);
  const nul = Buffer.from("\0" + source);
  assert.equal(scanText(decodeSource(nul, "frontend/fixture.html"), "frontend/fixture.html").length, 1);
});

test("security storage inventory is read-only and excludes object/secret content", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../scripts/task7c-storage-security-inventory.sql"), "utf8");
  const sql = source.replace(/--[^\n]*/g, "").replace(/'(?:''|[^'])*'/g, "''");
  assert.match(sql, /begin transaction isolation level repeatable read read only;/i);
  assert.doesNotMatch(sql, /\b(insert|update|delete|truncate|alter|drop|create|grant|revoke|call|copy)\b/i);
  assert.doesNotMatch(sql, /\b(from|join)\s+(?:vault\.(?:secrets|decrypted_secrets)|storage\.objects|public\.)/i);
});

test("scanner includes nonignored new source but excludes runtime secrets and dependency trees", () => {
  const files = require("../scripts/scan-secrets").repositoryFiles();
  assert.ok(files.some((file) => file.endsWith(path.normalize("backend/utils/http-security.js"))));
  assert.ok(!files.some((file) => /[\\/]node_modules[\\/]|[\\/]\.cache[\\/]|[\\/]\.env$/.test(file)));
});

test("notification options preserve six existing recipient/subject/text/html fixtures", async () => {
  const nodemailer = require("nodemailer");
  const original = nodemailer.createTransport;
  const options = [], transports = [];
  nodemailer.createTransport = (config) => { transports.push(config); return { sendMail: async (mail) => { options.push(mail); return { accepted: ["owner@example.test"] }; } }; };
  try {
    const notifications = require("../utils/notifications");
    for (const type of ["order", "reservation", "inquiry", "contact_submission", "testimonial", "support_request"]) {
      await notifications.sendNotificationEventEmail({ id: "synthetic", hotel_slug: "hotel-fixture", source_type: type, source_id: "100",
        event_type: type + "_created", created_at: "2026-10-28T00:00:00Z", payload: { customerName: "Synthetic Guest", guestName: "Synthetic Guest",
          message: "Synthetic <message>", items: [{ name: "Fixture meal", qty: 1, price: 100 }], totalAmount: 100 } }, { ownerEmail: "owner@example.test" });
    }
    const before = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../docs/security/evidence/task7c-local/notification-render-before.json"), "utf8").replace(/^\uFEFF/, ""));
    assert.deepEqual(options.map(({ disableFileAccess, disableUrlAccess, ...mail }) => mail), before);
    assert.equal(transports[0].disableFileAccess, true); assert.equal(transports[0].disableUrlAccess, true);
    assert.ok(options.every((mail) => mail.disableFileAccess === true && mail.disableUrlAccess === true));
  } finally { nodemailer.createTransport = original; }
});

test("patched mailer rejects raw-file and remote-content access with the configured guards", async () => {
  const transport = require("nodemailer").createTransport({ streamTransport: true, buffer: true, disableFileAccess: true, disableUrlAccess: true });
  await assert.rejects(transport.sendMail({ from: "notifier@example.test", to: "owner@example.test", raw: { path: __filename } }), /access|disabled/i);
  await assert.rejects(transport.sendMail({ from: "notifier@example.test", to: "owner@example.test", html: { path: "https://remote.example.test/content" } }), /access|disabled/i);
});
