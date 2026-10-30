"use strict";
const { randomUUID } = require("node:crypto");
const lost = () => Object.assign(new Error("QR_OUTBOX_LEASE_LOST"), { code: "QR_OUTBOX_LEASE_LOST" });

class QrDeliveryLeaseStore {
  constructor(databaseClient, { leaseSeconds = 60, heartbeatMs = 10000 } = {}) {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 300 ||
      !Number.isInteger(heartbeatMs) || heartbeatMs < 1000 || heartbeatMs >= leaseSeconds * 500) throw new Error("QR_LEASE_CONFIG_INVALID");
    this.db = databaseClient; this.leaseSeconds = leaseSeconds; this.heartbeatMs = heartbeatMs;
  }
  async rpc(name, args = {}) {
    const { data, error } = await this.db.rpc(name, args);
    if (error) throw error;
    return data;
  }
  async readiness() { return this.rpc("task7d_qr_delivery_readiness"); }
  async claim() {
    const owner = randomUUID();
    const result = await this.rpc("task7d_claim_qr_delivery", { p_lease_owner: owner, p_lease_seconds: this.leaseSeconds });
    if (!result) return null;
    if (!result.event || result.lease?.owner !== owner || typeof result.lease.version !== "string" || !/^[1-9]\d*$/.test(result.lease.version)) throw lost();
    return { ...result.event, _task7Lease: result.lease };
  }
  args(event) {
    if (!event?._task7Lease) throw lost();
    return { p_event_id: String(event.id), p_lease_owner: event._task7Lease.owner, p_claim_version: String(event._task7Lease.version) };
  }
  async renew(event) {
    return (await this.rpc("task7d_renew_qr_delivery", { ...this.args(event), p_lease_seconds: this.leaseSeconds })) === true;
  }
  async complete(event, success, code = null) {
    return (await this.rpc("task7d_complete_qr_delivery", { ...this.args(event), p_success: success === true, p_error_code: code })) === true;
  }
  watch(event) {
    let stopped = false, leaseLost = false, inFlight = false;
    const renew = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try { if (!(await this.renew(event))) leaseLost = true; }
      catch { leaseLost = true; }
      finally { inFlight = false; }
    };
    const timer = setInterval(() => { void renew(); }, this.heartbeatMs); timer.unref?.();
    return { stop() { stopped = true; clearInterval(timer); },
      assertOwned: async () => {
        let owned = false;
        try { owned = !stopped && !leaseLost && await this.renew(event); } catch { /* Fail closed until a new claim. */ }
        if (!owned) { leaseLost = true; throw lost(); }
        if (leaseLost) throw lost();
      } };
  }
}
module.exports = { QrDeliveryLeaseStore };
