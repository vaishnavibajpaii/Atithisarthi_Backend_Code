"use strict";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(["sent", "skipped"]);
const fail = (code) => Object.assign(new Error(code), { code });
const id = (value) => typeof value === "number" && !Number.isSafeInteger(value) ? "" : String(value ?? "");
const same = (left, right) => id(left) === id(right);
const retryDelay = (attempt) => Math.min(300000, Math.max(5000, 5000 * (2 ** Math.min(6, attempt - 1))));

function createQrOutboxProcessor({ databaseClient: db, createEvent, deliver, publish, metrics, logger, now = Date.now, leaseStore = null }) {
  let processing = false;
  function validate(event) {
    if (!/^[1-9]\d*$/.test(id(event.id)) || !UUID.test(event.tenant_id || "") || !/^[1-9]\d*$/.test(id(event.property_id)) ||
      typeof event.hotel_slug !== "string" || !event.hotel_slug.trim() || event.hotel_slug !== event.hotel_slug.trim() ||
      event.aggregate_type !== "order" || !/^[1-9]\d*$/.test(id(event.aggregate_id)) ||
      typeof event.deduplication_key !== "string" || !event.deduplication_key ||
      !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload) ||
      typeof event.event_type !== "string" || !event.event_type.trim() ||
      !Number.isSafeInteger(Number(event.attempt_count)) || Number(event.attempt_count) < 0 || Number(event.attempt_count) >= 2147483647 ||
      !Number.isFinite(Date.parse(event.next_attempt_at))) throw fail("QR_OUTBOX_SCOPE_OR_PAYLOAD_INVALID");
  }
  const owned = (query, event) => query.eq("tenant_id", event.tenant_id).eq("property_id", event.property_id).eq("hotel_slug", event.hotel_slug);
  const fenced = (query, event) => owned(query.eq("id", event.id).eq("attempt_count", event.attempt_count)
    .eq("next_attempt_at", event.next_attempt_at).is("published_at", null), event);
  async function claimEvent(event) {
    const attempts = Number(event.attempt_count) + 1;
    const result = await owned(db.from("qr_event_outbox").update({ attempt_count: attempts,
      next_attempt_at: new Date(now() + retryDelay(attempts)).toISOString(), last_error: null })
      .eq("id", event.id).eq("attempt_count", event.attempt_count).is("published_at", null)
      .lte("next_attempt_at", new Date(now()).toISOString()), event).select("*").maybeSingle();
    if (result.error) throw result.error;
    return result.data;
  }
  async function validateCanonicalSource(event) {
    const hotel = await db.from("hotels").select("id,tenant_id,slug").eq("id", event.property_id)
      .eq("tenant_id", event.tenant_id).eq("slug", event.hotel_slug).maybeSingle();
    if (hotel.error) throw hotel.error;
    if (!hotel.data || !same(hotel.data.id, event.property_id) || hotel.data.tenant_id !== event.tenant_id || hotel.data.slug !== event.hotel_slug) {
      throw fail("QR_OUTBOX_PROPERTY_SCOPE_MISMATCH");
    }
    const order = await owned(db.from("orders").select("id,tenant_id,property_id,hotel_slug").eq("id", event.aggregate_id), event).maybeSingle();
    if (order.error) throw order.error;
    if (!order.data || !same(order.data.id, event.aggregate_id) || order.data.tenant_id !== event.tenant_id ||
      !same(order.data.property_id, event.property_id) || order.data.hotel_slug !== event.hotel_slug) throw fail("QR_OUTBOX_ORDER_SCOPE_MISMATCH");
  }
  function validateNotification(notification, event) {
    if (!notification || !/^[1-9]\d*$/.test(id(notification.id)) || notification.tenant_id !== event.tenant_id ||
      !same(notification.property_id, event.property_id) || notification.hotel_slug !== event.hotel_slug || notification.source_type !== "order" ||
      !same(notification.source_id, event.aggregate_id) || notification.payload?.qrOutboxDeduplicationKey !== event.deduplication_key) {
      throw fail("QR_OUTBOX_NOTIFICATION_SCOPE_MISMATCH");
    }
  }
  async function publishClaimed(event, assertOwned = async () => {}) {
    await assertOwned();
    await validateCanonicalSource(event);
    const existing = await owned(db.from("notification_events").select("*").eq("source_type", "order")
      .eq("source_id", String(event.aggregate_id)).contains("payload", { qrOutboxDeduplicationKey: event.deduplication_key }), event)
      .limit(1).maybeSingle();
    if (existing.error) throw existing.error;
    let notification = existing.data;
    await assertOwned();
    if (!notification) notification = await createEvent({ databaseClient: db, tenantId: event.tenant_id, propertyId: event.property_id,
      hotelSlug: event.hotel_slug, sourceType: "order", sourceId: event.aggregate_id,
      payload: { ...event.payload, eventType: event.event_type.toLowerCase(), eventVersion: event.deduplication_key,
        qrOutboxEventId: String(event.id), qrOutboxDeduplicationKey: event.deduplication_key } });
    validateNotification(notification, event);
    try { publish(notification); } catch { logger.warn("QR dashboard publication failed; polling can recover", { errorCode: "QR_OUTBOX_LOCAL_PUBLICATION_FAILED" }); }
    if (!TERMINAL.has(notification.status)) {
      if (!["pending", "failed"].includes(notification.status)) throw fail("QR_OUTBOX_NOTIFICATION_STATUS_INVALID");
      await assertOwned();
      const processed = await deliver(notification, { databaseClient: db });
      validateNotification(processed, event);
      if (!same(processed.id, notification.id) || !TERMINAL.has(processed.status)) throw fail("QR_OUTBOX_DELIVERY_RETRY_REQUIRED");
    }
    if (leaseStore) {
      await assertOwned();
      if (!(await leaseStore.complete(event, true))) throw fail("QR_OUTBOX_LEASE_LOST");
      return true;
    }
    const timestamp = new Date(now()).toISOString();
    const result = await fenced(db.from("qr_event_outbox").update({ published_at: timestamp, next_attempt_at: timestamp, last_error: null }), event)
      .select("id").maybeSingle();
    if (result.error) throw result.error;
    return !!result.data;
  }
  async function recordFailure(event, error) {
    const code = /^QR_OUTBOX_[A-Z_]{1,80}$/.test(error?.code || "") ? error.code : "QR_OUTBOX_RETRYABLE_ERROR";
    if (leaseStore) { await leaseStore.complete(event, false, code); return; }
    const result = await fenced(db.from("qr_event_outbox").update({ last_error: code }), event);
    if (result.error) logger.error("QR outbox failure state could not be saved", { errorCode: "QR_OUTBOX_FAILURE_WRITE_FAILED" });
  }
  async function processQrOutboxBatch({ limit = 25 } = {}) {
    if (processing) return { processed: 0, skipped: true };
    processing = true;
    let processed = 0, failed = false;
    metrics.worker("qr_outbox", { running: true, started: true });
    try {
      const count = Number.isFinite(Number(limit)) ? Math.min(25, Math.max(1, Math.trunc(Number(limit)))) : 25;
      const candidates = leaseStore ? { data: Array(count).fill(null) } : await db.from("qr_event_outbox").select("*").is("published_at", null)
        .lte("next_attempt_at", new Date(now()).toISOString()).order("id", { ascending: true }).limit(count);
      if (candidates.error) throw candidates.error;
      for (const candidate of candidates.data || []) {
        let claimed, heartbeat;
        try {
          if (!leaseStore) validate(candidate);
          claimed = leaseStore ? await leaseStore.claim() : await claimEvent(candidate);
          if (!claimed) { if (leaseStore) break; continue; }
          validate(claimed);
          if (leaseStore) heartbeat = leaseStore.watch(claimed);
          if (await publishClaimed(claimed, heartbeat?.assertOwned)) processed += 1;
        } catch (error) {
          failed = true;
          if (claimed) {
            try { await recordFailure(claimed, error); }
            catch { logger.error("QR outbox failure state could not be saved", { errorCode: "QR_OUTBOX_FAILURE_WRITE_FAILED" }); }
          }
          logger.warn("QR outbox event remains retryable", { errorCode: /^QR_OUTBOX_[A-Z_]{1,80}$/.test(error?.code || "") ? error.code : "QR_OUTBOX_RETRYABLE_ERROR" });
        } finally { heartbeat?.stop(); }
      }
      return { processed, skipped: false };
    } catch (error) { failed = true; throw error; }
    finally { processing = false; metrics.worker("qr_outbox", { running: false, completed: true, failed }); }
  }
  return { processQrOutboxBatch, isProcessing: () => processing };
}

module.exports = { createQrOutboxProcessor };
