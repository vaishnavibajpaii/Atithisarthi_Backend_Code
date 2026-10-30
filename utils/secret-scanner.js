"use strict";

const crypto = require("node:crypto");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const SECRET_NAME = "(?:SUPABASE_SERVICE_ROLE_KEY|JWT_SECRET|ACCESS_TOKEN_SECRET|REFRESH_TOKEN_HMAC_SECRET|QR_CONTEXT_SIGNING_SECRET|RAZORPAY_KEY_SECRET|RAZORPAY_WEBHOOK_SECRET|SMTP_PASS|NOTIFICATION_SMTP_PASS|CLOUDFLARE_API_TOKEN|RAILWAY_TOKEN)";

function scanText(source, file, allowlist = []) {
  const findings = [];
  const seen = new Set();
  const add = (detector, value, offset) => {
    const valueSha256 = hash(value);
    const key = `${detector}:${offset}:${valueSha256}`;
    if (seen.has(key)) return;
    seen.add(key);
    const fixture = allowlist.find((entry) => entry.file === file && entry.detector === detector && entry.valueSha256 === valueSha256);
    const exampleFile = /(?:^|\/)\.env[^/]*\.example$|(?:^|\/)\.env\.example$/.test(file);
    const placeholder = exampleFile && /^(?:replace[-_]|your[-_]|changeme$|<[^>]+>$|rzp_(?:test|live)_(?:replace|your)[-_])/i.test(value);
    findings.push({ detector, file, line: source.slice(0, offset).split("\n").length, valueSha256,
      status: fixture ? "fixture-approved" : placeholder ? "placeholder-example" : "manual-review" });
  };
  const detectors = [
    ["postgres-connection-url", /postgres(?:ql)?:\/\/[^\s"'`<>]+/gi],
    ["razorpay-key-id", /\brzp_(?:test|live)_[A-Za-z0-9_-]{6,}\b/g],
    ["jwt-like-token", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g]
  ];
  for (const [detector, pattern] of detectors) for (const match of source.matchAll(pattern)) add(detector, match[0], match.index);
  const assignment = new RegExp(`\\b${SECRET_NAME}["']?\\s*(?:\\|\\|=|\\?\\?=|=|:)\\s*(?:"([^"\\r\\n]*)"|'([^'\\r\\n]*)')`, "g");
  for (const match of source.matchAll(assignment)) {
    const value = match[1] ?? match[2];
    if (value) add("assigned-secret", value, match.index);
  }
  if (/(?:^|\/)\.env(?:\.|$)/.test(file)) {
    const envAssignment = new RegExp(`^[ \\t]*${SECRET_NAME}[ \\t]*=[ \\t]*([^\\r\\n#]+)`, "gm");
    for (const match of source.matchAll(envAssignment)) {
      const value = match[1].trim().replace(/^(["'])(.*)\1$/, "$2");
      if (value) add("assigned-secret", value, match.index);
    }
  }
  const keyHeader = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g;
  for (const match of source.matchAll(keyHeader)) {
    const tail = source.slice(match.index, match.index + 20000);
    const end = /-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.exec(tail);
    add("private-key-material", end ? tail.slice(0, end.index + end[0].length) : tail, match.index);
  }
  return findings;
}

function validateAllowlist(entries) {
  if (!Array.isArray(entries)) throw new Error("Secret fixture allowlist must be an array");
  const seen = new Set();
  for (const entry of entries) {
    const key = `${entry.file}:${entry.detector}:${entry.valueSha256}`;
    const eligibleFile = /^(?:backend\/tests\/|backend\/scripts\/verify-|backend\/scripts\/task5-(?:gateway-runtime-permission|rotation-rollback)-probe\.sql$|scripts\/operations\/task7a-local-baseline\.cjs$|(?:backend\/)?\.env[^/]*\.example$)/;
    if (!eligibleFile.test(entry.file || "") || entry.file.includes("..") ||
      !/^[a-f0-9]{64}$/.test(entry.valueSha256 || "") || !entry.reason || seen.has(key)) throw new Error("Secret fixture allowlist entry is invalid");
    seen.add(key);
  }
  return entries;
}

function decodeSource(bytes, file) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const data = Buffer.from(bytes.subarray(2));
    if (data.length % 2) return data.toString("utf8");
    return data.swap16().toString("utf16le");
  }
  const sourceFile = /\.(?:js|cjs|mjs|json|html|css|md|sql|ya?ml|toml|ini|env|example|txt)$|(?:^|\/)\.(?:env|gitignore|gitmodules)(?:\.|$)/i.test(file);
  if (!sourceFile && bytes.subarray(0, 8192).includes(0)) return null;
  return bytes.toString("utf8");
}

module.exports = { scanText, validateAllowlist, decodeSource };
