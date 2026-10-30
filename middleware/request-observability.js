const crypto = require("crypto");
const logger = require("../utils/logger");
const context = require("../utils/operational-context");
const { metrics, operationForPath } = require("../utils/operational-metrics");
const correlationKey = crypto.randomBytes(32);

function createRequestId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function getRequestId(req) {
  const headerValue = req.headers["x-request-id"];
  // Do not reflect arbitrary caller text, tokens or line breaks into headers/logs.
  if (typeof headerValue === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(headerValue)) return headerValue;
  return createRequestId();
}

function traceId(req) {
  const value = req.headers.traceparent;
  const match = typeof value === "string" && /^00-([a-f0-9]{32})-([a-f0-9]{16})-[a-f0-9]{2}$/.exec(value);
  return match && !/^0+$/.test(match[1]) && !/^0+$/.test(match[2]) ? match[1] : undefined;
}

function getRequestLogLevel(statusCode) {
  if (statusCode >= 500) return "error";
  if (statusCode >= 400) return "warn";
  return "info";
}

function shouldSkipRequestLog(req = {}) {
  return operationForPath(req.originalUrl || req.url || req.path) === "health";
}

function attachRequestContext(req, res, next) {
  const requestId = getRequestId(req);

  req.requestId = requestId;
  res.locals.requestId = requestId;
  res.setHeader("x-request-id", requestId);

  context.run({ requestId, traceId: traceId(req), operation: operationForPath(req.originalUrl || req.url) }, next);
}

function logRequestLifecycle(req, res, next) {
  const startedAt = process.hrtime.bigint();
  const originalWriteHead = res.writeHead;

  res.writeHead = function writeHeadWithServerTiming(...args) {
    if (!res.headersSent) {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const timingEntries = [`app;dur=${durationMs.toFixed(2)}`];
      const dbDurationMs = Number(res.locals?.dbDurationMs);
      if (Number.isFinite(dbDurationMs) && dbDurationMs >= 0) {
        timingEntries.push(`db;dur=${dbDurationMs.toFixed(2)}`);
      }
      res.setHeader("server-timing", timingEntries.join(", "));
    }

    return originalWriteHead.apply(this, args);
  };

  let recorded = false;
  function complete(aborted) {
    if (recorded) return;
    recorded = true;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const operation = operationForPath(req.originalUrl || req.url);
    metrics.request({ operation, statusCode: res.statusCode, durationMs, aborted });
    if (shouldSkipRequestLog(req)) return;
    const logLevel = getRequestLogLevel(res.statusCode);
    const logMessage =
      res.statusCode >= 500
        ? "Request failed"
        : res.statusCode >= 400
          ? "Request completed with client error"
          : "Request completed";

    logger[logLevel](logMessage, {
      requestId: req.requestId || "",
      method: ["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"].includes(req.method) ? req.method : "OTHER",
      operation,
      result: aborted ? "aborted" : res.statusCode === 409 ? "conflict" : res.statusCode >= 500 ? "server_error" : "completed",
      statusCode: res.statusCode || 0,
      durationMs: Number(durationMs.toFixed(2)),
      dbDurationMs: Number.isFinite(Number(res.locals?.dbDurationMs))
        ? Number(Number(res.locals.dbDurationMs).toFixed(2))
        : undefined,
      responseBytes: Number(res.getHeader("content-length") || 0) || undefined,
      tenantCorrelation: req.tenant?.id && req.property?.id ? crypto.createHmac("sha256", correlationKey)
        .update(`${req.tenant.id}:${req.property.id}`).digest("hex").slice(0, 16) : undefined
    });
  }
  res.on("finish", () => complete(false));
  res.on("close", () => complete(!res.writableFinished));

  next();
}

module.exports = {
  attachRequestContext,
  logRequestLifecycle,
  getRequestId,
  traceId
};
