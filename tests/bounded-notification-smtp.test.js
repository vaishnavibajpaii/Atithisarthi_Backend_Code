"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events");
const { createBoundedNotificationSmtpSender } = require("../utils/bounded-notification-smtp");

const options = () => ({ disableFileAccess: true, disableUrlAccess: true, host: "smtp.example.test", port: 587, secure: false, auth: { user: "synthetic@example.test", pass: "fixture" } });
const message = () => ({ disableFileAccess: true, disableUrlAccess: true, from: "from@example.test", to: "owner@example.test", subject: "Synthetic <subject>", text: "Synthetic text", html: "<p>Synthetic &lt;body&gt;</p>" });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness({ requestSocket = true, transportThrow, connectThrow, sendThrow } = {}) {
  const x = { transports: [], sockets: [], connections: [], timers: new Set(), sends: [], callbacks: [], closeCalls: 0 };
  x.send = createBoundedNotificationSmtpSender({
    setTimeout(callback, delay) { const timer = { callback, delay }; x.timers.add(timer); return timer; },
    clearTimeout(timer) { x.timers.delete(timer); },
    net: { createConnection(config) {
      if (connectThrow) throw connectThrow;
      x.connections.push(config);
      const socket = new EventEmitter(); socket.destroyed = false; socket.destroyCalls = 0;
      const aborted = () => socket.destroy(Object.assign(new Error("PRIVATE-ABORT-DIAGNOSTIC"), { code: "ABORT_ERR" }));
      socket.destroy = (error) => {
        if (socket.destroyed) return socket;
        socket.destroyed = true; socket.destroyCalls++; socket.destroyError = error;
        config.signal.removeEventListener("abort", aborted);
        queueMicrotask(() => { if (error) socket.emit("error", error); socket.emit("close"); });
        return socket;
      };
      config.signal.addEventListener("abort", aborted, { once: true });
      x.sockets.push(socket); return socket;
    } },
    nodemailer: { createTransport(config) {
      if (transportThrow) throw transportThrow;
      const transport = { config, close() { x.closeCalls++; }, sendMail(mail) {
        x.sends.push(mail); if (sendThrow) throw sendThrow;
        return new Promise((resolve, reject) => {
          transport.resolve = resolve; transport.reject = reject;
          transport.request = () => config.getSocket(config, (error, socketOptions) => {
            x.callbacks.push({ error, socketOptions });
            if (error) reject(error);
            else { transport.socketOptions = socketOptions; socketOptions.connection.once("error", reject); }
          });
          if (requestSocket) transport.request();
        });
      } };
      x.transports.push(transport); return transport;
    } }
  });
  x.expire = () => { const timer = [...x.timers][0]; assert.ok(timer); timer.callback(); };
  x.start = (input = {}) => x.send({ transportOptions: options(), mail: message(), ...input });
  return x;
}

test("bounded sender preserves exact message object and existing safe SMTP settings", async () => {
  const x = harness(), mail = Object.freeze(message()), input = options(), pending = x.start({ mail, transportOptions: input });
  const config = x.transports[0].config;
  assert.equal(x.sends[0], mail); assert.deepEqual(input, options());
  for (const key of ["host", "port", "secure", "auth"]) assert.deepEqual(config[key], input[key]);
  assert.equal(config.disableFileAccess, true); assert.equal(config.disableUrlAccess, true);
  for (const key of ["connectionTimeout", "greetingTimeout", "socketTimeout"]) assert.equal(config[key], 45000);
  assert.equal([...x.timers][0].delay, 45000);
  assert.deepEqual(Object.keys(x.connections[0]).sort(), ["host", "port", "signal"]);
  x.sockets[0].emit("connect"); const result = { accepted: [mail.to], response: "250 accepted" }; x.transports[0].resolve(result);
  assert.equal(await pending, result); assert.equal(x.sockets[0].destroyed, true); assert.equal(x.closeCalls, 1); assert.equal(x.timers.size, 0);
  await flush();
});

test("secure modes remain delegated to Nodemailer with raw socket explicitly unsecured", async () => {
  for (const secure of [false, true]) {
    const x = harness(), pending = x.start({ transportOptions: { ...options(), secure, port: secure ? 465 : 587 } });
    assert.equal(x.transports[0].config.secure, secure); assert.equal(x.transports[0].config.ignoreTLS, undefined);
    assert.equal(x.transports[0].config.tls, undefined); x.sockets[0].emit("connect");
    assert.equal(x.transports[0].socketOptions.connection, x.sockets[0]); assert.equal(x.transports[0].socketOptions.secured, false);
    x.transports[0].resolve({ accepted: ["owner@example.test"] }); await pending;
  }
});

test("caller transport/socket/proxy/TLS overrides cannot bypass owned connection policy", async () => {
  const x = harness(), input = { ...options(), pool: true, socket: {}, connection: {}, getSocket() { throw new Error("OVERRIDE-CALLED"); }, proxy: "http://other.example.test", tls: { rejectUnauthorized: false }, auth: { ...options().auth, accessUrl: "https://other.example.test" } };
  const pending = x.start({ transportOptions: input }), config = x.transports[0].config;
  for (const key of ["pool", "socket", "connection", "proxy", "tls"]) assert.equal(config[key], undefined);
  assert.deepEqual(config.auth, options().auth); assert.notEqual(config.getSocket, input.getSocket);
  x.sockets[0].emit("connect"); x.transports[0].resolve({}); await pending;
});

test("invalid timeout/config fails before creating transport, timer or connection", async () => {
  for (const change of [{ timeoutMs: 0 }, { timeoutMs: 45001 }, { timeoutMs: NaN }, { timeoutMs: "400" }, { timeoutMs: 1.5 }, { transportOptions: {} }, { transportOptions: { ...options(), port: 0 } }, { mail: null }, { signal: {} }]) {
    const x = harness(); await assert.rejects(x.start(change), { code: "NOTIFICATION_SMTP_CONFIG_INVALID", message: "NOTIFICATION_SMTP_CONFIG_INVALID" });
    assert.equal(x.transports.length, 0); assert.equal(x.timers.size, 0); assert.equal(x.sockets.length, 0);
  }
});

test("already aborted ownership signal cannot start a transport or SMTP connection", async () => {
  const x = harness(), controller = new AbortController(); controller.abort(new Error("PRIVATE-LEASE-REASON"));
  await assert.rejects(x.start({ signal: controller.signal }), { code: "NOTIFICATION_DELIVERY_LEASE_LOST", message: "NOTIFICATION_DELIVERY_LEASE_LOST" });
  assert.equal(x.transports.length, 0); assert.equal(x.timers.size, 0); assert.equal(x.sockets.length, 0);
});

test("deadline covers pending DNS/connect, destroys socket, and prevents late handoff", async () => {
  const x = harness(), pending = x.start({ timeoutMs: 100 });
  const rejection = assert.rejects(pending, { code: "NOTIFICATION_SMTP_DEADLINE_PRE_DATA" }); x.expire(); await rejection;
  assert.equal(x.sockets[0].destroyed, true); assert.equal(x.connections[0].signal.aborted, true); assert.equal(x.callbacks.length, 1);
  assert.equal(x.callbacks[0].socketOptions, undefined); x.sockets[0].emit("connect");
  assert.equal(x.callbacks.length, 1); assert.equal(x.timers.size, 0); await flush();
});

test("deadline before socket request refuses a late getSocket and creates no late connection", async () => {
  const x = harness({ requestSocket: false }), pending = x.start();
  const rejection = assert.rejects(pending, { code: "NOTIFICATION_SMTP_DEADLINE_PRE_DATA" }); x.expire(); await rejection;
  x.transports[0].request(); assert.equal(x.connections.length, 0); assert.equal(x.callbacks.length, 1);
  assert.equal(x.callbacks[0].error.code, "NOTIFICATION_SMTP_PRE_DATA_FAILED"); await flush();
});

test("post-handoff total deadline actively closes socket and reports unknown acceptance", async () => {
  const x = harness(), pending = x.start(); x.sockets[0].emit("connect");
  const rejection = assert.rejects(pending, { code: "NOTIFICATION_SMTP_OUTCOME_UNKNOWN", message: "NOTIFICATION_SMTP_OUTCOME_UNKNOWN" }); x.expire(); await rejection;
  assert.equal(x.sockets[0].destroyed, true); assert.equal(x.sockets[0].destroyCalls, 1); assert.equal(x.timers.size, 0);
  x.transports[0].resolve({ accepted: ["owner@example.test"] }); await flush(); assert.equal(x.closeCalls, 1);
});

test("Nodemailer mutation of teardown errors cannot change the caller's bounded error", async () => {
  for (const connected of [false, true]) {
    const x = harness(), pending = x.start();
    if (connected) x.sockets[0].emit("connect");
    x.sockets[0].on("error", (error) => {
      error.code = "ESOCKET";
      error.message = "PRIVATE-PROVIDER-DIAGNOSTIC";
      error.response = "PRIVATE-PROVIDER-RESPONSE";
    });
    const expected = connected ? "NOTIFICATION_SMTP_OUTCOME_UNKNOWN" : "NOTIFICATION_SMTP_DEADLINE_PRE_DATA";
    const rejected = assert.rejects(pending, { code: expected, message: expected });
    x.expire();
    const reason = x.connections[0].signal.reason;
    reason.code = "ABORT_ERR"; reason.message = "PRIVATE-ABORT-DIAGNOSTIC";
    if (!connected) {
      x.callbacks[0].error.code = "ECONNECTION";
      x.callbacks[0].error.message = "PRIVATE-CALLBACK-DIAGNOSTIC";
    }
    await rejected; await flush();
    assert.notEqual(x.sockets[0].destroyError, reason);
    if (!connected) assert.notEqual(x.sockets[0].destroyError, x.callbacks[0].error);
    assert.equal(x.timers.size, 0);
  }
});

test("ownership abort before/during connect and after handoff closes only that attempt", async () => {
  for (const connected of [false, true]) {
    const x = harness(), controller = new AbortController(), pending = x.start({ signal: controller.signal });
    if (connected) x.sockets[0].emit("connect");
    const rejection = assert.rejects(pending, { code: "NOTIFICATION_DELIVERY_LEASE_LOST", message: "NOTIFICATION_DELIVERY_LEASE_LOST" });
    controller.abort(new Error("PRIVATE-LEASE-REASON")); await rejection;
    assert.equal(x.sockets[0].destroyed, true); assert.equal(x.connections[0].signal.aborted, true); assert.equal(x.timers.size, 0);
    x.sockets[0].emit("connect"); assert.equal(x.callbacks.length, 1); await flush();
  }
});

test("concurrent attempts own independent sockets, deadlines and abort controllers", async () => {
  const x = harness(), controller = new AbortController(), first = x.start({ signal: controller.signal }), second = x.start();
  x.sockets.forEach((socket) => socket.emit("connect")); const rejected = assert.rejects(first, { code: "NOTIFICATION_DELIVERY_LEASE_LOST" });
  controller.abort(); await rejected; assert.equal(x.sockets[0].destroyed, true); assert.equal(x.sockets[1].destroyed, false); assert.equal(x.timers.size, 1);
  x.transports[1].resolve({ accepted: ["owner@example.test"] }); await second; assert.equal(x.timers.size, 0); await flush();
});

test("connect errors and synchronous dependency failures expose bounded categories only", async () => {
  for (const failure of ["transportThrow", "connectThrow", "sendThrow"]) {
    const x = harness({ [failure]: new Error("PRIVATE-PROVIDER-CREDENTIAL-DIAGNOSTIC") });
    await assert.rejects(x.start(), { code: "NOTIFICATION_SMTP_PRE_DATA_FAILED", message: "NOTIFICATION_SMTP_PRE_DATA_FAILED" });
    assert.equal(x.timers.size, 0); await flush();
  }
  const x = harness(), pending = x.start(), rejected = assert.rejects(pending, { code: "NOTIFICATION_SMTP_PRE_DATA_FAILED" });
  x.sockets[0].emit("error", new Error("PRIVATE-CONNECT-DIAGNOSTIC")); await rejected;
  assert.equal(x.callbacks.length, 1); assert.equal(x.sockets[0].destroyed, true); await flush();
});

test("explicit provider rejection, auth failure and ambiguous connection loss stay bounded", async () => {
  for (const [error, expected] of [
    [{ code: "EENVELOPE", responseCode: 554, command: "DATA" }, "NOTIFICATION_SMTP_PROVIDER_REJECTED"],
    [{ code: "EMESSAGE", responseCode: 451, command: "DATA" }, "NOTIFICATION_SMTP_PROVIDER_REJECTED"],
    [{ code: "EAUTH", responseCode: 535, command: "AUTH PLAIN" }, "NOTIFICATION_SMTP_PRE_DATA_FAILED"],
    [{ code: "ECONNECTION", command: "CONN" }, "NOTIFICATION_SMTP_OUTCOME_UNKNOWN"],
    [{ code: "ETIMEDOUT", command: "CONN" }, "NOTIFICATION_SMTP_OUTCOME_UNKNOWN"]
  ]) {
    const x = harness(), pending = x.start(); x.sockets[0].emit("connect");
    x.transports[0].reject(Object.assign(new Error("PRIVATE-PROVIDER-DIAGNOSTIC owner@example.test"), error));
    await assert.rejects(pending, { code: expected, message: expected }); assert.equal(x.sockets[0].destroyed, true); assert.equal(x.timers.size, 0); await flush();
  }
});

test("first observed terminal outcome wins a deadline/success race and cleanup is once-only", async () => {
  const x = harness(), pending = x.start(); x.sockets[0].emit("connect"); const staleTimer = [...x.timers][0];
  x.transports[0].resolve({ accepted: ["owner@example.test"] }); await pending; staleTimer.callback();
  assert.equal(x.closeCalls, 1); assert.equal(x.sockets[0].destroyCalls, 1); assert.equal(x.timers.size, 0); await flush();
});

test("a second socket request cannot create or share another socket", async () => {
  const x = harness(), pending = x.start(); const second = [];
  x.transports[0].config.getSocket({}, (...args) => second.push(args)); assert.equal(second.length, 1);
  assert.equal(second[0][0].code, "NOTIFICATION_SMTP_PRE_DATA_FAILED"); assert.equal(x.sockets.length, 1);
  x.sockets[0].emit("connect"); x.transports[0].resolve({}); await pending; await flush();
});
