const { supabase } = require("./supabase");
const logger = require("./logger");
const { metrics } = require("./operational-metrics");
const { env } = require("../config/env");
const { QrDeliveryLeaseStore } = require("./qr-delivery-lease-store");
const { createQrOutboxProcessor } = require("./qr-outbox-processor");
const { publishNotificationEvent } = require("./notification-live");
const {
  createNotificationEvent,
  processNotificationEventDeliverySafely
} = require("./notifications");

const DEFAULT_INTERVAL_MS = 2000;
let timer = null;
const processor = createQrOutboxProcessor({ databaseClient: supabase, createEvent: createNotificationEvent,
  deliver: processNotificationEventDeliverySafely, publish: publishNotificationEvent, metrics, logger,
  leaseStore: env.task7QrLeasedWorkerEnabled ? new QrDeliveryLeaseStore(supabase) : null });
const { processQrOutboxBatch } = processor;

function startQrOutboxWorker({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  metrics.worker("qr_outbox", { enabled: true });
  if (timer) return timer;
  const safeInterval = Math.max(1000, Number(intervalMs || DEFAULT_INTERVAL_MS));
  timer = setInterval(() => {
    void processQrOutboxBatch().catch((error) => {
      logger.error("QR outbox batch failed", { errorCode: "QR_OUTBOX_BATCH_FAILED" });
    });
  }, safeInterval);
  timer.unref?.();
  void processQrOutboxBatch().catch((error) => {
    logger.error("Initial QR outbox batch failed", { errorCode: "QR_OUTBOX_BATCH_FAILED" });
  });
  return timer;
}

function stopQrOutboxWorker() {
  metrics.worker("qr_outbox", { enabled: false, running: processor.isProcessing() });
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

module.exports = {
  processQrOutboxBatch,
  startQrOutboxWorker,
  stopQrOutboxWorker
};
