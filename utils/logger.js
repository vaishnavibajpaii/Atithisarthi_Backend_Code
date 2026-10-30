"use strict";

const { redactText, safeMetadata, environmentSecrets } = require("./log-redaction");
const context = require("./operational-context");
const originalConsole = Object.fromEntries(["log", "info", "warn", "error", "debug", "trace"].map((method) =>
  [method, console[method].bind(console)]));
let consoleInstalled = false;

function getDeploymentIdentity() {
  const candidate = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.SOURCE_VERSION || "";
  return { service: "atithisarthi-api", version: /^[a-f0-9]{7,64}$/i.test(candidate) ? candidate.toLowerCase() : "unversioned" };
}

function createLogger({ write = (level, line) => originalConsole[level === "ERROR" ? "error" : level === "WARN" ? "warn" : "log"](line),
  now = () => new Date().toISOString() } = {}) {
  let dropped = 0;
  // Environment credentials/version are loaded before logger startup. Rotation
  // uses the existing process restart; avoid scanning the entire environment per log.
  const secrets = environmentSecrets();
  const nodeEnv = String(process.env.NODE_ENV || "development").toLowerCase();
  const environment = ["development", "test", "staging", "production"].includes(nodeEnv) ? nodeEnv : "unknown";
  const identity = getDeploymentIdentity();
  function emit(level, message, meta) {
    try {
      const record = { timestamp: now(), level, environment, ...identity,
        message: redactText(typeof message === "string" ? message : "event", secrets),
        ...safeMetadata(context.get(), secrets), ...safeMetadata(meta, secrets) };
      write(level, JSON.stringify(record));
    } catch {
      // Logging must never reverse a committed payment/order or break a response.
      dropped += 1;
    }
  }
  return { info: (message, meta) => emit("INFO", message, meta), warn: (message, meta) => emit("WARN", message, meta),
    error: (message, meta) => emit("ERROR", message, meta), droppedCount: () => dropped };
}

const logger = createLogger();
function installSafeConsole() {
  if (consoleInstalled) return;
  consoleInstalled = true;
  for (const method of Object.keys(originalConsole)) {
    console[method] = (...args) => {
      try {
        // Legacy console sites frequently pass full DB errors/payloads. Do not serialize them.
        const error = args.find((value) => value instanceof Error);
        const code = error && Object.getOwnPropertyDescriptor(error, "code")?.value;
        logger[method === "error" || method === "trace" ? "error" : method === "warn" ? "warn" : "info"]("legacy_console", {
          errorCode: typeof code === "string" && /^[a-z0-9_]{1,64}$/i.test(code) ? code : undefined
        });
      } catch { logger.warn("legacy_console_arguments_omitted"); }
    };
  }
}

module.exports = { ...logger, createLogger, getDeploymentIdentity, installSafeConsole };
