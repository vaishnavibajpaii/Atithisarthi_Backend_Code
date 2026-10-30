"use strict";

const MAX_TIMEOUT_MS = 45000;
const noop = () => {};
const boundedError = (code) => Object.assign(new Error(code), { code });

function failureCode(error, handedOff) {
  if (!handedOff) return "NOTIFICATION_SMTP_PRE_DATA_FAILED";
  const response = error?.responseCode;
  if (Number.isInteger(response) && response >= 400 && response <= 599 &&
      ["EENVELOPE", "EMESSAGE"].includes(error?.code)) {
    return "NOTIFICATION_SMTP_PROVIDER_REJECTED";
  }
  if (error?.code === "EAUTH") return "NOTIFICATION_SMTP_PRE_DATA_FAILED";
  // CONN and socket errors can occur after the server accepted the DATA body.
  return "NOTIFICATION_SMTP_OUTCOME_UNKNOWN";
}

function createBoundedNotificationSmtpSender({
  nodemailer = require("nodemailer"),
  net = require("node:net"),
  setTimeout: setTimer = global.setTimeout,
  clearTimeout: clearTimer = global.clearTimeout
} = {}) {
  return async function send({ transportOptions, mail, signal, timeoutMs = MAX_TIMEOUT_MS } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS ||
        !transportOptions || typeof transportOptions.host !== "string" || !transportOptions.host ||
        !Number.isSafeInteger(transportOptions.port) || transportOptions.port < 1 || transportOptions.port > 65535 ||
        typeof transportOptions.secure !== "boolean" ||
        typeof transportOptions.auth?.user !== "string" || typeof transportOptions.auth?.pass !== "string" ||
        !mail || typeof mail !== "object" || Array.isArray(mail) ||
        (signal != null && (typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function"))) {
      throw boundedError("NOTIFICATION_SMTP_CONFIG_INVALID");
    }
    if (signal?.aborted) throw boundedError("NOTIFICATION_DELIVERY_LEASE_LOST");

    return new Promise((resolve, reject) => {
      const connectionAbort = new AbortController();
      let settled = false, handedOff = false, socketRequested = false;
      let socket, transporter, deadline, socketCallback;

      const deliverSocket = (error, value) => {
        const callback = socketCallback;
        socketCallback = null;
        if (callback) callback(error, value);
      };
      const onConnect = () => {
        if (settled || signal?.aborted || connectionAbort.signal.aborted) {
          socket?.destroy();
          return;
        }
        handedOff = true;
        deliverSocket(null, { connection: socket, secured: false });
      };
      const onSocketError = () => {
        if (!handedOff) finish("NOTIFICATION_SMTP_PRE_DATA_FAILED");
      };
      const onAbort = () => finish("NOTIFICATION_DELIVERY_LEASE_LOST");

      function finish(errorCode, result) {
        if (settled) return;
        settled = true;
        if (deadline !== undefined) clearTimer(deadline);
        signal?.removeEventListener("abort", onAbort);
        // Nodemailer mutates errors received from sockets/callbacks (e.g. to
        // ESOCKET). The caller's error must never be shared with that teardown.
        const error = errorCode ? boundedError(errorCode) : null;
        if (socket) {
          socket.removeListener("connect", onConnect);
          socket.removeListener("error", onSocketError);
          // TLS can release its parent listeners during teardown. Absorb late
          // local socket errors without retaining the attempt's closure.
          socket.on("error", noop);
          if (!socket.destroyed) socket.destroy(errorCode ? boundedError(errorCode) : undefined);
        }
        // The AbortSignal also prevents a pending DNS/connect operation from
        // becoming a live connection after our attempt has already settled.
        connectionAbort.abort(errorCode ? boundedError(errorCode) : undefined);
        deliverSocket(boundedError(errorCode || "NOTIFICATION_SMTP_PRE_DATA_FAILED"));
        try { transporter?.close?.(); } catch { /* Per-attempt resource cleanup. */ }
        if (error) reject(error); else resolve(result);
      }

      signal?.addEventListener("abort", onAbort, { once: true });
      // Cover an abort observed while the listener was being installed.
      if (signal?.aborted) return onAbort();
      deadline = setTimer(() => finish(handedOff ? "NOTIFICATION_SMTP_OUTCOME_UNKNOWN" : "NOTIFICATION_SMTP_DEADLINE_PRE_DATA"), timeoutMs);

      try {
        // Only the existing application's connection settings are admitted.
        // Callers cannot replace getSocket, disable verification, add a proxy,
        // share a socket/pool, or redirect transport-level auth endpoints.
        transporter = nodemailer.createTransport({
          disableFileAccess: true,
          disableUrlAccess: true,
          host: transportOptions.host,
          port: transportOptions.port,
          secure: transportOptions.secure,
          auth: { user: transportOptions.auth.user, pass: transportOptions.auth.pass },
          connectionTimeout: timeoutMs,
          greetingTimeout: timeoutMs,
          socketTimeout: timeoutMs,
          getSocket(_options, callback) {
            if (settled || signal?.aborted || socketRequested) {
              callback(boundedError(signal?.aborted ? "NOTIFICATION_DELIVERY_LEASE_LOST" : "NOTIFICATION_SMTP_PRE_DATA_FAILED"));
              return;
            }
            socketRequested = true;
            socketCallback = callback;
            try {
              socket = net.createConnection({
                host: transportOptions.host,
                port: transportOptions.port,
                signal: connectionAbort.signal
              });
              socket.on("error", onSocketError);
              socket.once("connect", onConnect);
              if (settled || connectionAbort.signal.aborted) socket.destroy();
            } catch {
              finish("NOTIFICATION_SMTP_PRE_DATA_FAILED");
            }
          }
        });
        // Preserve the original message object. Attach both handlers even if
        // abort/deadline wins, consuming late Nodemailer results safely.
        Promise.resolve(transporter.sendMail(mail)).then(
          (result) => finish(null, result),
          (error) => finish(failureCode(error, handedOff))
        );
      } catch (error) {
        finish(failureCode(error, handedOff));
      }
    });
  };
}

const sendBoundedNotificationSmtp = createBoundedNotificationSmtpSender();
module.exports = { createBoundedNotificationSmtpSender, sendBoundedNotificationSmtp };
