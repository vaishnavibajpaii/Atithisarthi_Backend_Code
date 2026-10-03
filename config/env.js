function getEnv(name, fallback = "") {
  return process.env[name] || fallback;
}

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const env = {
nodeEnv: getEnv("NODE_ENV", "Production"),
port: Number(getEnv("PORT", "10000")),


  supabaseUrl: getRequiredEnv("SUPABASE_URL"),
  supabaseServiceRoleKey: getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"),

  tenantRuntimeEnabled:
    getEnv("TENANT_RUNTIME_ENABLED", "false") === "true",
  tenantRuntimePublicHotelEnabled:
    getEnv("TENANT_RUNTIME_PUBLIC_HOTEL_ENABLED", "false") === "true",
  tenantRuntimePublicMenuEnabled:
    getEnv("TENANT_RUNTIME_PUBLIC_MENU_ENABLED", "false") === "true",
  tenantRuntimePublicGalleryEnabled:
    getEnv("TENANT_RUNTIME_PUBLIC_GALLERY_ENABLED", "false") === "true",
  tenantRuntimePublicTestimonialsEnabled:
    getEnv("TENANT_RUNTIME_PUBLIC_TESTIMONIALS_ENABLED", "false") === "true",
  tenantDatabaseUrl: getEnv("TENANT_DATABASE_URL", ""),
  tenantDatabasePoolMax: Number(getEnv("TENANT_DATABASE_POOL_MAX", "10")),
  tenantDatabaseIdleTimeoutMs: Number(
    getEnv("TENANT_DATABASE_IDLE_TIMEOUT_MS", "30000")
  ),
  tenantDatabaseConnectionTimeoutMs: Number(
    getEnv("TENANT_DATABASE_CONNECTION_TIMEOUT_MS", "10000")
  ),
  tenantDatabaseStatementTimeoutMs: Number(
    getEnv("TENANT_DATABASE_STATEMENT_TIMEOUT_MS", "15000")
  ),

  jwtSecret: getRequiredEnv("JWT_SECRET"),
  jwtExpiresIn: getEnv("JWT_EXPIRES_IN", "7d"),
  qrContextSigningSecret: getEnv("QR_CONTEXT_SIGNING_SECRET", ""),
  qrContextStrictRequired:
    getEnv("QR_CONTEXT_STRICT_REQUIRED", "false") === "true",
  frontendUrl: getEnv("FRONTEND_URL", " "),
  frontendOrigins: getEnv("FRONTEND_ORIGINS", ""),
  publicTenantHostAliases: getEnv("PUBLIC_TENANT_HOST_ALIASES", ""),
  adminUrl: getEnv("ADMIN_URL", " "),
  notificationDeliveryEnabled:
    getEnv("NOTIFICATION_DELIVERY_ENABLED", "false") === "true",
  notificationDeliveryChannel: getEnv("NOTIFICATION_DELIVERY_CHANNEL", "email"),
  notificationEmailFrom: getEnv("NOTIFICATION_EMAIL_FROM", ""),
  notificationEmailTo: getEnv("NOTIFICATION_EMAIL_TO", ""),
  notificationSmtpHost: getEnv("NOTIFICATION_SMTP_HOST", ""),
  notificationSmtpPort: Number(getEnv("NOTIFICATION_SMTP_PORT", "587")),
  notificationSmtpSecure:
    getEnv("NOTIFICATION_SMTP_SECURE", "false") === "true",
  notificationSmtpUser: getEnv("NOTIFICATION_SMTP_USER", ""),
  notificationSmtpPass: getEnv("NOTIFICATION_SMTP_PASS", ""),

  paymentGatewayEnabled:
    getEnv("PAYMENT_GATEWAY_ENABLED", "false") === "true",
  roomCombinedCheckoutEnabled:
    getEnv("ROOM_COMBINED_CHECKOUT_ENABLED", "false") === "true",
  paymentGatewayProvider: getEnv("PAYMENT_GATEWAY_PROVIDER", "razorpay"),
  paymentGatewayCurrency: getEnv("PAYMENT_GATEWAY_CURRENCY", "INR"),
  paymentRouteTransfersEnabled:
    getEnv("PAYMENT_ROUTE_TRANSFERS_ENABLED", "false") === "true",
  razorpayKeyId: getEnv("RAZORPAY_KEY_ID", ""),
  razorpayKeySecret: getEnv("RAZORPAY_KEY_SECRET", ""),
  razorpayWebhookSecret: getEnv("RAZORPAY_WEBHOOK_SECRET", ""),
  razorpayApiBaseUrl: getEnv("RAZORPAY_API_BASE_URL", "https://api.razorpay.com/v1"),
  paymentGatewayTimeoutMs: Number(getEnv("PAYMENT_GATEWAY_TIMEOUT_MS", "10000")),
  paymentWebhookWorkerEnabled:
    getEnv("PAYMENT_WEBHOOK_WORKER_ENABLED", "false") === "true",
  paymentWebhookWorkerIntervalMs: Number(getEnv("PAYMENT_WEBHOOK_WORKER_INTERVAL_MS", "5000")),

  isProduction: getEnv("NODE_ENV", "development") === "production",
  isDevelopment: getEnv("NODE_ENV", "development") === "development"
};

module.exports = { env };
