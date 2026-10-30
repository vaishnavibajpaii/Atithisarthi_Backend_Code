"use strict";

function parseTrustProxyHops(value = "1") {
  const text = String(value).trim();
  if (!/^[0-5]$/.test(text)) throw Object.assign(new Error("TRUST_PROXY_HOPS must be an integer from 0 to 5"), { code: "TRUST_PROXY_CONFIG_INVALID" });
  return Number(text);
}

function safeParserError(error) {
  if (error?.type === "entity.too.large") return { status: 413, code: "REQUEST_BODY_TOO_LARGE", message: "Request body is too large" };
  if (error?.type === "entity.parse.failed") return { status: 400, code: "INVALID_REQUEST_BODY", message: "Request body is invalid" };
  if (["charset.unsupported", "encoding.unsupported"].includes(error?.type)) return { status: 415, code: "UNSUPPORTED_BODY_ENCODING", message: "Request body encoding is unsupported" };
  return null;
}

module.exports = { parseTrustProxyHops, safeParserError };
