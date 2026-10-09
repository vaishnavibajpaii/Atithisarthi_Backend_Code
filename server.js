require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const { env } = require("./config/env");
const logger = require("./utils/logger");
const { startQrOutboxWorker, stopQrOutboxWorker } = require("./utils/qr-outbox");
const {
  startPaymentWebhookWorker,
  stopPaymentWebhookWorker
} = require("./workers/payment-webhook-worker");
const {
  attachRequestContext,
  logRequestLifecycle
} = require("./middleware/request-observability");
const ordersRoute = require("./routes/orders");
const orderTrackingRoute = require("./routes/order-tracking");
const inquiriesRoute = require("./routes/inquiries");
const contactSubmissionsRoute = require("./routes/contact-submissions");
const reservationsRoute = require("./routes/reservations");
const testimonialsRoute = require("./routes/testimonials");
const adminRoute = require("./routes/admin");
const adminRoomBookingRoute = require("./routes/admin-room-booking");
const tenantRoute = require("./routes/tenant");
const publicRoute = require("./routes/public");
const publicQrRoute = require("./routes/public-qr");
const publicRoomBookingRoute = require("./routes/public-room-booking");
const publicAssistantRoute = require("./routes/public-assistant");
const authRoute = require("./routes/auth");
const staffRoute = require("./routes/staff");
const staffNotificationsRoute = require("./routes/staff-notifications");
const staffRoomBookingRoute = require("./routes/staff-room-booking");
const staffRoomManagementRoute = require("./routes/staff-room-management");
const staffRoomCheckoutBillRoute = require("./routes/staff-room-checkout-bill");
const staffFoodOrderBillRoute = require("./routes/staff-food-order-bill");
const adminRoomCheckoutBillRoute = require("./routes/admin-room-checkout-bill");
const uploadRoute = require("./routes/upload");
const paymentsRoute = require("./routes/payments");
const paymentWebhooksRoute = require("./routes/payment-webhooks");
const {
  publicLoginBrandingRouter,
  adminLoginBrandingRouter
} = require("./routes/login-branding");
const {
  getConfiguredTenantAliasOrigins
} = require("./utils/public-hotel-access");

const app = express();
//const PORT = 5000;
const PORT = env.port;
app.set("trust proxy", 1);

app.use(attachRequestContext);
app.use(logRequestLifecycle);

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isHttpsUrl(value = "") {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isLocalUrl(value = "") {
  try {
    const url = new URL(value);
    return ["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname);
  } catch {
    return false;
  }
}

function buildReadinessCheck(name, ready, issue = "", enabled) {
  const check = {
    name,
    ready: !!ready,
    issue: ready ? "" : issue
  };
  if (typeof enabled === "boolean") {
    check.enabled = enabled;
  }
  return check;
}

function getReadinessChecks() {
  const paymentEnabled = !!env.paymentGatewayEnabled;
  const paymentProvider = String(env.paymentGatewayProvider || "").trim().toLowerCase();
  const paymentProviderSupported = !paymentEnabled || paymentProvider === "razorpay";
  const paymentCredentialsReady = !paymentEnabled || (
    hasText(env.razorpayKeyId) &&
    hasText(env.razorpayKeySecret)
  );
  const paymentWebhookReady = !env.isProduction || !paymentEnabled || hasText(env.razorpayWebhookSecret);
  const paymentLiveKeyReady =
    !env.isProduction ||
    !paymentEnabled ||
    !String(env.razorpayKeyId || "").startsWith("rzp_test_");
  const emailNotificationReady =
    !env.notificationDeliveryEnabled ||
    String(env.notificationDeliveryChannel || "").trim().toLowerCase() !== "email" ||
    (
      hasText(env.notificationEmailFrom) &&
      hasText(env.notificationEmailTo) &&
      hasText(env.notificationSmtpHost) &&
      hasText(env.notificationSmtpUser) &&
      hasText(env.notificationSmtpPass)
    );
  const tenantRuntimeReady =
    !env.tenantRuntimeEnabled || hasText(env.tenantDatabaseUrl);
  const tenantPublicHotelReady =
    !env.tenantRuntimePublicHotelEnabled ||
    (env.tenantRuntimeEnabled && hasText(env.tenantDatabaseUrl));
  const tenantPublicMenuReady =
    !env.tenantRuntimePublicMenuEnabled ||
    (env.tenantRuntimeEnabled && hasText(env.tenantDatabaseUrl));
  const tenantPublicGalleryReady =
    !env.tenantRuntimePublicGalleryEnabled ||
    (env.tenantRuntimeEnabled && hasText(env.tenantDatabaseUrl));
  const tenantPublicTestimonialsReady =
    !env.tenantRuntimePublicTestimonialsEnabled ||
    (env.tenantRuntimeEnabled && hasText(env.tenantDatabaseUrl));
  const tenantPublicPopupReady =
    !env.tenantRuntimePublicPopupEnabled ||
    (env.tenantRuntimeEnabled && hasText(env.tenantDatabaseUrl));
  const tenantPublicRoomsReady =
    !env.tenantRuntimePublicRoomsEnabled ||
    (env.tenantRuntimeEnabled && hasText(env.tenantDatabaseUrl));
  const tenantPublicOrderTrackingReady =
    !env.tenantRuntimePublicOrderTrackingEnabled ||
    (env.tenantRuntimeEnabled && hasText(env.tenantDatabaseUrl));
  const tenantStaffMenuReady =
    !env.tenantRuntimeStaffMenuEnabled ||
    (env.tenantRuntimeEnabled && hasText(env.tenantDatabaseUrl));
  const tenantStaffOrderingSettingsReady =
    !env.tenantRuntimeStaffOrderingSettingsEnabled ||
    (env.tenantRuntimeEnabled && hasText(env.tenantDatabaseUrl));
  const tenantStaffSessionReady =
    !env.tenantRuntimeStaffSessionEnabled ||
    (env.tenantRuntimeEnabled && hasText(env.tenantDatabaseUrl));
  const tenantRuntimeWritesReady =
    !env.tenantRuntimeWritesEnabled ||
    (env.tenantRuntimeEnabled && hasText(env.tenantDatabaseUrl));

  return [
    buildReadinessCheck(
      "supabase_config",
      hasText(env.supabaseUrl) && hasText(env.supabaseServiceRoleKey),
      "missing_supabase_config"
    ),
    buildReadinessCheck(
      "jwt_secret",
      hasText(env.jwtSecret) && (!env.isProduction || env.jwtSecret.length >= 32),
      "weak_or_missing_jwt_secret"
    ),
    buildReadinessCheck(
      "frontend_origin",
      !env.isProduction || (isHttpsUrl(env.frontendUrl) && !isLocalUrl(env.frontendUrl)),
      "frontend_url_must_be_https_non_local"
    ),
    buildReadinessCheck(
      "admin_origin",
      !env.isProduction || (isHttpsUrl(env.adminUrl) && !isLocalUrl(env.adminUrl)),
      "admin_url_must_be_https_non_local"
    ),
    buildReadinessCheck(
      "payment_provider",
      paymentProviderSupported,
      "unsupported_payment_provider"
    ),
    buildReadinessCheck(
      "payment_credentials",
      paymentCredentialsReady,
      "missing_payment_credentials"
    ),
    buildReadinessCheck(
      "payment_webhook",
      paymentWebhookReady,
      "missing_payment_webhook_secret"
    ),
    buildReadinessCheck(
      "payment_live_key",
      paymentLiveKeyReady,
      "test_payment_key_in_production"
    ),
    buildReadinessCheck(
      "email_notifications",
      emailNotificationReady,
      "missing_email_notification_config"
    ),
    buildReadinessCheck(
      "tenant_runtime_database",
      tenantRuntimeReady,
      "missing_tenant_database_url",
      env.tenantRuntimeEnabled
    ),
    buildReadinessCheck(
      "tenant_runtime_public_hotel",
      tenantPublicHotelReady,
      "tenant_public_hotel_requires_tenant_runtime",
      env.tenantRuntimePublicHotelEnabled
    ),
    buildReadinessCheck(
      "tenant_runtime_public_menu",
      tenantPublicMenuReady,
      "tenant_public_menu_requires_tenant_runtime",
      env.tenantRuntimePublicMenuEnabled
    ),
    buildReadinessCheck(
      "tenant_runtime_public_gallery",
      tenantPublicGalleryReady,
      "tenant_public_gallery_requires_tenant_runtime",
      env.tenantRuntimePublicGalleryEnabled
    ),
    buildReadinessCheck(
      "tenant_runtime_public_testimonials",
      tenantPublicTestimonialsReady,
      "tenant_public_testimonials_requires_tenant_runtime",
      env.tenantRuntimePublicTestimonialsEnabled
    ),
    buildReadinessCheck(
      "tenant_runtime_public_popup",
      tenantPublicPopupReady,
      "tenant_public_popup_requires_tenant_runtime",
      env.tenantRuntimePublicPopupEnabled
    ),
    buildReadinessCheck(
      "tenant_runtime_public_rooms",
      tenantPublicRoomsReady,
      "tenant_public_rooms_requires_tenant_runtime",
      env.tenantRuntimePublicRoomsEnabled
    ),
    buildReadinessCheck(
      "tenant_runtime_public_order_tracking",
      tenantPublicOrderTrackingReady,
      "tenant_public_order_tracking_requires_tenant_runtime",
      env.tenantRuntimePublicOrderTrackingEnabled
    ),
    buildReadinessCheck(
      "tenant_runtime_staff_menu",
      tenantStaffMenuReady,
      "tenant_staff_menu_requires_tenant_runtime",
      env.tenantRuntimeStaffMenuEnabled
    ),
    buildReadinessCheck(
      "tenant_runtime_staff_ordering_settings",
      tenantStaffOrderingSettingsReady,
      "tenant_staff_ordering_settings_requires_tenant_runtime",
      env.tenantRuntimeStaffOrderingSettingsEnabled
    ),
    buildReadinessCheck(
      "tenant_runtime_staff_session",
      tenantStaffSessionReady,
      "tenant_staff_session_requires_tenant_runtime",
      env.tenantRuntimeStaffSessionEnabled
    ),
    buildReadinessCheck(
      "tenant_runtime_writes",
      tenantRuntimeWritesReady,
      "tenant_writes_require_tenant_runtime",
      env.tenantRuntimeWritesEnabled
    )
  ];
}

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => String(req.originalUrl || req.url || "").startsWith("/api/staff")
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many login attempts. Please try again later."
  }
});

function getStaffRateLimitKey(req) {
  const authHeader = String(req.headers.authorization || "").trim();

  if (authHeader.startsWith("Bearer ")) {
    return `staff:${crypto.createHash("sha256").update(authHeader).digest("hex").slice(0, 32)}`;
  }

  return `staff-ip:${rateLimit.ipKeyGenerator(req.ip)}`;
}

function isStaffLoginRequest(req) {
  return String(req.originalUrl || req.url || "").split("?")[0] === "/api/staff/login";
}

const staffReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getStaffRateLimitKey,
  skip: (req) => isStaffLoginRequest(req) || !["GET", "HEAD", "OPTIONS"].includes(req.method),
  message: {
    success: false,
    code: "STAFF_READ_RATE_LIMITED",
    message: "Staff live updates are temporarily limited. Please wait and retry."
  }
});

const staffMutationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 180,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getStaffRateLimitKey,
  skip: (req) => isStaffLoginRequest(req) || ["GET", "HEAD", "OPTIONS"].includes(req.method),
  message: {
    success: false,
    code: "STAFF_MUTATION_RATE_LIMITED",
    message: "Too many staff updates were submitted. Please wait and retry."
  }
});

// Security & parsing middleware (added here)
app.disable("x-powered-by");
app.use(helmet());
app.use(
  "/api/payments/webhook",
  express.raw({ type: "application/json", limit: "1mb" }),
  paymentWebhooksRoute
);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

const normalizeOrigin = (value = "") => String(value || "").trim().replace(/\/$/, "");
const parseOriginList = (value = "") =>
  String(value || "")
    .split(",")
    .map((entry) => normalizeOrigin(entry))
    .filter(Boolean);

const allowedOrigins = [
  env.frontendUrl,
  env.adminUrl,
  ...parseOriginList(env.frontendOrigins),
  ...getConfiguredTenantAliasOrigins()
]
  .map(normalizeOrigin)
  .filter(Boolean)
  .filter((origin, index, list) => list.indexOf(origin) === index);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);

      const normalizedOrigin = normalizeOrigin(origin);

      if (allowedOrigins.includes(normalizedOrigin)) {
        return callback(null, true);
      }

      logger.warn("Blocked by CORS", {
        origin: normalizedOrigin,
        allowedOrigins
      });

      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true
  })
);

app.use(globalLimiter);



// app.get("/api/health", (req, res) => {
//   res.json({
//     success: true,
//     message: "Backend is running"
//   });
// });

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "Backend is running",
    env: env.nodeEnv,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get("/api/readiness", (req, res) => {
  const checks = getReadinessChecks();
  const ready = checks.every((check) => check.ready);

  res.status(ready ? 200 : 503).json({
    success: ready,
    ready,
    env: env.nodeEnv,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    checks
  });
});

app.use("/api/orders", ordersRoute);
app.use("/api/order-tracking", orderTrackingRoute);
app.use("/api/inquiries", inquiriesRoute);
app.use("/api/contact-submissions", contactSubmissionsRoute);
app.use("/api/reservations", reservationsRoute);
app.use("/api/testimonials", testimonialsRoute);
app.use("/api/admin/room-booking", adminRoomBookingRoute);
app.use("/api/admin/room-checkout-bill", adminRoomCheckoutBillRoute);
app.use("/api/admin/login-branding", adminLoginBrandingRouter);
app.use("/api/admin", adminRoute);
app.use("/api/tenant", tenantRoute);
app.use("/api/public/rooms", publicRoomBookingRoute);
app.use("/api/public/login-branding", publicLoginBrandingRouter);
app.use("/api/public", publicRoute);
app.use("/api/public/qr", publicQrRoute);
app.use("/api/public/assistant", publicAssistantRoute);
app.use("/api/auth", authRoute);
app.use("/api/staff/login", authLimiter);
app.use("/api/staff", staffReadLimiter, staffMutationLimiter);
app.use("/api/staff/notifications", staffNotificationsRoute);
app.use("/api/staff/room-booking", staffRoomBookingRoute);
app.use("/api/staff/room-management", staffRoomManagementRoute);
app.use("/api/staff/room-checkout-bill", staffRoomCheckoutBillRoute);
app.use("/api/staff/food-order-bill", staffFoodOrderBillRoute);
app.use("/api/staff", staffRoute);
app.use("/api/payments", paymentsRoute);
app.use("/api/admin/upload", uploadRoute);

app.use((err, req, res, next) => {
  // console.error("Unhandled server error:", err);
logger.error("Unhandled server error", {
  message: err.message,
  stack: env.isDevelopment ? err.stack : undefined
});

  if (err.message === "Not allowed by CORS") {
    return res.status(403).json({
      success: false,
      message: "Origin not allowed"
    });
  }

  return res.status(500).json({
    success: false,
    message: "Internal server error"
  });
});

// app.listen(PORT, () => {
//   // console.log(`Server running on http://localhost:${PORT}`);
//   logger.info("Server started", {
//   port: PORT,
//   nodeEnv: env.nodeEnv
// });

// });

try {
  const server = app.listen(PORT, () => {
    logger.info("Server started", {
      port: PORT,
      nodeEnv: env.nodeEnv
    });
    startQrOutboxWorker();
    startPaymentWebhookWorker();
  });
  const shutdown = () => {
    stopQrOutboxWorker();
    stopPaymentWebhookWorker();
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
} catch (error) {
  logger.error("Server failed to start", {
    message: error.message,
    stack: error.stack
  });
  process.exit(1);
}
