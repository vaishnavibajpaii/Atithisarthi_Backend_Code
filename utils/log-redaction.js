"use strict";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /password|passwd|secret|token|cookie|authorization|api.?key|key.?id|key.?secret|pin$|email|phone|mobile|address|guest|customer|document|id.?proof|payload|body|headers|stack|error.?message|^message$|^details?$|^ip$|^origin$|hotel.?hint|hotel.?slug|tenant.?id|property.?id/i;
const ALLOWED_META = new Set(["requestId", "traceId", "method", "operation", "statusCode", "durationMs", "dbDurationMs",
  "responseBytes", "code", "errorCode", "errorCategory", "result", "reasonCode", "worker", "jobId", "attemptNumber",
  "eventId", "webhookEventId", "provider", "merchantRef", "paymentStage", "port", "nodeEnv", "enabled", "processed",
  "completed", "claimed", "failed", "deadLetter", "skipped", "retryAttempt", "tenantCorrelation"]);

function environmentSecrets() {
  return Object.entries(process.env).filter(([key, value]) =>
    /SECRET|TOKEN|PASSWORD|PASS$|SERVICE_ROLE|API_KEY|KEY_ID|DATABASE_URL/i.test(key) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value).sort((a, b) => b.length - a.length);
}

function redactText(value, secrets = environmentSecrets()) {
  let text = typeof value === "string" ? value.slice(0, 4096) : "";
  for (const secret of secrets) if (secret.length >= 8) text = text.split(secret).join(REDACTED);
  return text
    .replace(/\b(?:postgres(?:ql)?|https?):\/\/[^\s]+/gi, "[URL_REDACTED]")
    .replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\b(?:rzp_(?:test|live)_|q1_)[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, REDACTED)
    .replace(/(?:\+\d[\d ()-]{8,}\d|\b\d{10,16}\b)/g, REDACTED)
    .replace(/[\r\n\u0000-\u001f\u007f]/g, " ").slice(0, 512);
}

function redact(value, secrets = environmentSecrets(), seen = new WeakSet(), depth = 0) {
  if (typeof value === "string") return redactText(value, secrets);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value !== "object") return undefined;
  if (depth >= 6) return "[TRUNCATED]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  const output = Array.isArray(value) ? [] : Object.create(null);
  // Do not invoke getters, toJSON or custom object inspectors while logging.
  const entries = Object.entries(Object.getOwnPropertyDescriptors(value)).slice(0, 40);
  for (const [key, descriptor] of entries) {
    if (Array.isArray(value) && key === "length") continue;
    output[key] = SENSITIVE_KEY.test(key) ? REDACTED :
      "value" in descriptor ? redact(descriptor.value, secrets, seen, depth + 1) : "[ACCESSOR_OMITTED]";
  }
  return output;
}

function safeMetadata(meta = {}, secrets = environmentSecrets()) {
  if (!meta || typeof meta !== "object") return {};
  const output = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(meta))) {
    if (!ALLOWED_META.has(key) || !("value" in descriptor)) continue;
    const value = descriptor.value;
    // The application log schema accepts only bounded scalars, never arbitrary objects.
    if (typeof value === "string") output[key] = redactText(value, secrets).slice(0, 128);
    else if (typeof value === "boolean") output[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) output[key] = value;
  }
  return output;
}

module.exports = { REDACTED, redact, redactText, safeMetadata, environmentSecrets };
