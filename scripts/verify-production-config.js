require("dotenv").config({ path: ".env" });

const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const FRONTEND_CONFIG_PATH = path.join(PROJECT_ROOT, "frontend/js/app-config.js");
const FRONTEND_ROOT = path.join(PROJECT_ROOT, "frontend");
const SERVER_PATH = path.join(PROJECT_ROOT, "backend/server.js");
const PAYMENT_WEBHOOKS_ROUTE_PATH = path.join(PROJECT_ROOT, "backend/routes/payment-webhooks.js");
const LEGACY_PRODUCTION_BACKEND_URL =
  "https://my-projectbackendpaymentgateway-production.up.railway.app";
const FRONTEND_RUNTIME_PAGES = [
  {
    pageName: "index.html",
    requireContactSheetTag: true
  },
  {
    pageName: "menu.html",
    requireContactSheetTag: false
  },
  {
    pageName: "admin.html",
    requireContactSheetTag: false
  },
  {
    pageName: "staff-orders.html",
    requireContactSheetTag: false
  },
  {
    pageName: "order-tracking.html",
    requireContactSheetTag: false
  }
];

function getEnv(name, fallback = "") {
  return process.env[name] || fallback;
}

function getBooleanEnv(name) {
  return String(getEnv(name, "false")).trim().toLowerCase() === "true";
}

function isExplicitBooleanText(value = "") {
  const normalizedValue = String(value || "").trim().toLowerCase();
  return normalizedValue === "true" || normalizedValue === "false";
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

function isPlaceholder(value = "") {
  const text = String(value || "").trim().toLowerCase();
  return (
    !text ||
    text.includes("replace") ||
    text.includes("change-me") ||
    text.includes("your_") ||
    text.includes("example")
  );
}

function maskValue(value = "") {
  const text = String(value || "").trim();
  if (!text) return "missing";
  if (text.length <= 8) return "present";
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function addIssue(list, message) {
  list.push(message);
}

function addWarning(list, message) {
  list.push(message);
}

function cleanText(value, fallback = "") {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : fallback;
}

function normalizeUrl(value, fallback = "") {
  const normalizedValue = cleanText(value, fallback);
  return normalizedValue ? normalizedValue.replace(/\/+$/, "") : "";
}

function deriveApiBaseUrl(backendBaseUrl = "") {
  return backendBaseUrl ? `${backendBaseUrl}/api` : "";
}

function isLegacyBackendUrl(value = "") {
  return (
    value === LEGACY_PRODUCTION_BACKEND_URL ||
    value.startsWith(`${LEGACY_PRODUCTION_BACKEND_URL}/`)
  );
}

function extractMetaContent(source, name) {
  const match = source.match(
    new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"\\s*\\/?>`, "i")
  );

  return match ? match[1].trim() : null;
}

function parseOriginList(value = "") {
  return String(value || "")
    .split(",")
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function getIndexOrInfinity(source, marker) {
  const index = source.indexOf(marker);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

function checkRequiredProductionEnv(issues) {
  const required = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "JWT_SECRET",
    "FRONTEND_URL",
    "ADMIN_URL",
    "APP_BACKEND_BASE_URL"
  ];

  required.forEach((name) => {
    if (isPlaceholder(getEnv(name))) {
      addIssue(issues, `${name} is missing or still looks like a placeholder.`);
    }
  });

  if (!isHttpsUrl(getEnv("SUPABASE_URL"))) {
    addIssue(issues, "SUPABASE_URL must be a valid HTTPS URL.");
  }

  ["FRONTEND_URL", "ADMIN_URL"].forEach((name) => {
    const value = getEnv(name);

    if (!isHttpsUrl(value)) {
      addIssue(issues, `${name} must be HTTPS in production.`);
    }

    if (isLocalUrl(value)) {
      addIssue(issues, `${name} must not point to localhost in production.`);
    }
  });

  if (String(getEnv("JWT_SECRET")).trim().length < 32) {
    addIssue(issues, "JWT_SECRET should be at least 32 characters for production.");
  }

  parseOriginList(getEnv("FRONTEND_ORIGINS")).forEach((origin, index) => {
    if (!isHttpsUrl(origin)) {
      addIssue(
        issues,
        `FRONTEND_ORIGINS entry ${index + 1} must be HTTPS in production.`
      );
    }

    if (isLocalUrl(origin)) {
      addIssue(
        issues,
        `FRONTEND_ORIGINS entry ${index + 1} must not point to localhost in production.`
      );
    }
  });
}

function checkFrontendRuntimeEnv(issues) {
  const appBackendBaseUrl = normalizeUrl(getEnv("APP_BACKEND_BASE_URL"));
  const appApiBaseUrl = normalizeUrl(
    getEnv("APP_API_BASE_URL"),
    deriveApiBaseUrl(appBackendBaseUrl)
  );
  const contactSheetUrl = cleanText(getEnv("APP_CONTACT_SHEET_URL"));
  const allowOrderWhatsAppFallbackOnSaveFailure = getEnv(
    "APP_ALLOW_ORDER_WHATSAPP_FALLBACK_ON_SAVE_FAILURE"
  );
  const openWhatsAppAfterVerifiedOnlinePayment = getEnv(
    "APP_OPEN_WHATSAPP_AFTER_VERIFIED_ONLINE_PAYMENT"
  );

  if (!appBackendBaseUrl) {
    addIssue(issues, "APP_BACKEND_BASE_URL is required for frontend runtime config.");
  } else {
    if (!isHttpsUrl(appBackendBaseUrl)) {
      addIssue(issues, "APP_BACKEND_BASE_URL must be HTTPS in production.");
    }

    if (isLocalUrl(appBackendBaseUrl)) {
      addIssue(issues, "APP_BACKEND_BASE_URL must not point to localhost in production.");
    }
  }

  if (!appApiBaseUrl) {
    addIssue(
      issues,
      "APP_API_BASE_URL is required, or APP_BACKEND_BASE_URL must be set so it can be derived."
    );
  } else {
    if (!isHttpsUrl(appApiBaseUrl)) {
      addIssue(issues, "APP_API_BASE_URL must be HTTPS in production.");
    }

    if (isLocalUrl(appApiBaseUrl)) {
      addIssue(issues, "APP_API_BASE_URL must not point to localhost in production.");
    }
  }

  if (contactSheetUrl && !isHttpsUrl(contactSheetUrl)) {
    addIssue(issues, "APP_CONTACT_SHEET_URL must be HTTPS when it is set for production.");
  }

  if (!isExplicitBooleanText(allowOrderWhatsAppFallbackOnSaveFailure)) {
    addIssue(
      issues,
      "APP_ALLOW_ORDER_WHATSAPP_FALLBACK_ON_SAVE_FAILURE must be explicitly set to true or false for production."
    );
  }

  if (!isExplicitBooleanText(openWhatsAppAfterVerifiedOnlinePayment)) {
    addIssue(
      issues,
      "APP_OPEN_WHATSAPP_AFTER_VERIFIED_ONLINE_PAYMENT must be explicitly set to true or false for production."
    );
  }
}

function checkPaymentEnv(issues, warnings) {
  if (!getBooleanEnv("PAYMENT_GATEWAY_ENABLED")) {
    if (getBooleanEnv("PAYMENT_ROUTE_TRANSFERS_ENABLED")) {
      addIssue(
        issues,
        "PAYMENT_ROUTE_TRANSFERS_ENABLED is true while PAYMENT_GATEWAY_ENABLED is false."
      );
    }

    addWarning(warnings, "PAYMENT_GATEWAY_ENABLED is false. Online checkout will stay disabled.");
    return;
  }

  const provider = String(getEnv("PAYMENT_GATEWAY_PROVIDER", "razorpay")).trim().toLowerCase();
  const keyId = getEnv("RAZORPAY_KEY_ID");
  const currency = String(getEnv("PAYMENT_GATEWAY_CURRENCY", "INR")).trim().toUpperCase();
  const routeTransfersEnabled = getBooleanEnv("PAYMENT_ROUTE_TRANSFERS_ENABLED");
  const routeTestHotelSlug = getEnv("PAYMENT_ROUTE_TEST_HOTEL_SLUG");

  if (provider !== "razorpay") {
    addIssue(issues, "PAYMENT_GATEWAY_PROVIDER must be razorpay for the current integration.");
  }

  if (currency !== "INR") {
    addIssue(issues, "PAYMENT_GATEWAY_CURRENCY must be INR for the current Razorpay integration.");
  }

  ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"].forEach((name) => {
    if (isPlaceholder(getEnv(name))) {
      addIssue(issues, `${name} is required when payment gateway is enabled.`);
    }
  });

  if (keyId.startsWith("rzp_test_")) {
    addIssue(issues, "RAZORPAY_KEY_ID is a test key. Use live keys before real production launch.");
  }

  if (!isHttpsUrl(getEnv("RAZORPAY_API_BASE_URL", "https://api.razorpay.com/v1"))) {
    addIssue(issues, "RAZORPAY_API_BASE_URL must be HTTPS.");
  }

  if (routeTransfersEnabled && isPlaceholder(routeTestHotelSlug)) {
    addWarning(
      warnings,
      "PAYMENT_ROUTE_TEST_HOTEL_SLUG is missing. You will not be able to run the hotel Route readiness check quickly before launch."
    );
  }
}

function checkRoomCombinedCheckoutEnv(issues, warnings) {
  const rawBackendValue = String(
    getEnv("ROOM_COMBINED_CHECKOUT_ENABLED", "")
  ).trim().toLowerCase();
  const rawFrontendValue = String(
    getEnv("APP_ROOM_COMBINED_CHECKOUT_FRONTEND_ENABLED", "false")
  ).trim().toLowerCase();
  const rawTask6FinalizerValue = String(
    getEnv("TASK6_ROOM_CHECKOUT_FINALIZER_ENABLED", "false")
  ).trim().toLowerCase();

  if (rawBackendValue && !isExplicitBooleanText(rawBackendValue)) {
    addIssue(
      issues,
      "ROOM_COMBINED_CHECKOUT_ENABLED must be true or false when provided."
    );
  }

  if (!isExplicitBooleanText(rawFrontendValue)) {
    addIssue(
      issues,
      "APP_ROOM_COMBINED_CHECKOUT_FRONTEND_ENABLED must be true or false for production."
    );
  }

  if (!isExplicitBooleanText(rawTask6FinalizerValue)) {
    addIssue(
      issues,
      "TASK6_ROOM_CHECKOUT_FINALIZER_ENABLED must be true or false for production."
    );
  }

  if (rawFrontendValue === "true" && rawBackendValue !== "true") {
    addIssue(
      issues,
      "APP_ROOM_COMBINED_CHECKOUT_FRONTEND_ENABLED cannot be true unless ROOM_COMBINED_CHECKOUT_ENABLED is also true."
    );
  }

  if (rawTask6FinalizerValue === "true" && rawBackendValue !== "true") {
    addIssue(
      issues,
      "TASK6_ROOM_CHECKOUT_FINALIZER_ENABLED cannot be true unless ROOM_COMBINED_CHECKOUT_ENABLED is also true."
    );
  }

  if (rawFrontendValue === "true" && rawTask6FinalizerValue !== "true") {
    addIssue(
      issues,
      "APP_ROOM_COMBINED_CHECKOUT_FRONTEND_ENABLED cannot be true until TASK6_ROOM_CHECKOUT_FINALIZER_ENABLED is true."
    );
  }

  if (rawBackendValue !== "true") {
    addWarning(
      warnings,
      "ROOM_COMBINED_CHECKOUT_ENABLED is false or missing. Atomic combined checkout will stay disabled."
    );
    return;
  }

  if (rawTask6FinalizerValue !== "true") {
    addWarning(
      warnings,
      "TASK6_ROOM_CHECKOUT_FINALIZER_ENABLED is false or missing. Legacy combined checkout settlement remains selected."
    );
  } else {
    addWarning(
      warnings,
      "TASK6_ROOM_CHECKOUT_FINALIZER_ENABLED is true. Confirm the D-B migration, checkout concurrency probe, and TEST business-flow acceptance passed before production use."
    );
  }

  addWarning(
    warnings,
    "ROOM_COMBINED_CHECKOUT_ENABLED is true. Confirm the atomic checkout migration and staging verifier passed before mounting checkout routes."
  );

  if (rawFrontendValue !== "true") {
    addWarning(
      warnings,
      "APP_ROOM_COMBINED_CHECKOUT_FRONTEND_ENABLED is false. Admin/staff combined checkout buttons will remain disabled."
    );
    return;
  }

  if (rawTask6FinalizerValue !== "true") {
    return;
  }

  addWarning(
    warnings,
    "APP_ROOM_COMBINED_CHECKOUT_FRONTEND_ENABLED is true. Confirm production enablement was separately approved after staging checkout verification."
  );
}

function checkNotificationEnv(issues, warnings) {
  if (!getBooleanEnv("NOTIFICATION_DELIVERY_ENABLED")) {
    addWarning(warnings, "NOTIFICATION_DELIVERY_ENABLED is false. Email notifications will be skipped.");
    return;
  }

  const channel = String(getEnv("NOTIFICATION_DELIVERY_CHANNEL", "internal")).trim().toLowerCase();

  if (channel !== "email") {
    addWarning(warnings, `Notification channel is '${channel}'. Email delivery will not run unless channel is email.`);
    return;
  }

  [
    "NOTIFICATION_EMAIL_FROM",
    "NOTIFICATION_EMAIL_TO",
    "NOTIFICATION_SMTP_HOST",
    "NOTIFICATION_SMTP_USER",
    "NOTIFICATION_SMTP_PASS"
  ].forEach((name) => {
    if (isPlaceholder(getEnv(name))) {
      addIssue(issues, `${name} is required when email notifications are enabled.`);
    }
  });
}

function checkFrontendConfig(issues, warnings) {
  if (!fs.existsSync(FRONTEND_CONFIG_PATH)) {
    addWarning(warnings, "frontend/js/app-config.js was not found.");
    return;
  }

  const source = fs.readFileSync(FRONTEND_CONFIG_PATH, "utf8");

  if (source.includes(LEGACY_PRODUCTION_BACKEND_URL)) {
    addIssue(
      issues,
      "frontend/js/app-config.js still contains the legacy Railway backend fallback URL."
    );
  }

  if (source.includes('"legacy-production-fallback"')) {
    addIssue(
      issues,
      "frontend/js/app-config.js still advertises the legacy-production-fallback runtime mode."
    );
  }

  if (source.includes('API_BASE_URL: "http://localhost:5000/api"')) {
    addWarning(
      warnings,
      "frontend/js/app-config.js still contains an explicit localhost API_BASE_URL assignment."
    );
  }

  if (source.includes('BACKEND_BASE_URL: "http://localhost:5000"')) {
    addWarning(
      warnings,
      "frontend/js/app-config.js still contains an explicit localhost BACKEND_BASE_URL assignment."
    );
  }
}

function checkStampedFrontendRuntimePages(issues, warnings) {
  const expectedBackendBaseUrl = normalizeUrl(getEnv("APP_BACKEND_BASE_URL"));
  const expectedApiBaseUrl = normalizeUrl(
    getEnv("APP_API_BASE_URL"),
    deriveApiBaseUrl(expectedBackendBaseUrl)
  );
  const expectedContactSheetUrl = cleanText(getEnv("APP_CONTACT_SHEET_URL"));
  const expectedAllowOrderWhatsAppFallbackOnSaveFailure = String(
    getEnv("APP_ALLOW_ORDER_WHATSAPP_FALLBACK_ON_SAVE_FAILURE")
  ).trim().toLowerCase();
  const expectedOpenWhatsAppAfterVerifiedOnlinePayment = String(
    getEnv("APP_OPEN_WHATSAPP_AFTER_VERIFIED_ONLINE_PAYMENT")
  ).trim().toLowerCase();
  const allowedLegacyRuntimeValues = new Set(
    [expectedBackendBaseUrl, expectedApiBaseUrl].filter(Boolean)
  );

  FRONTEND_RUNTIME_PAGES.forEach(({ pageName, requireContactSheetTag }) => {
    const filePath = path.join(FRONTEND_ROOT, pageName);

    if (!fs.existsSync(filePath)) {
      addIssue(issues, `Required frontend page was not found: ${pageName}`);
      return;
    }

    const source = fs.readFileSync(filePath, "utf8");
    const backendMetaValue = extractMetaContent(source, "app-backend-base-url");
    const apiMetaValue = extractMetaContent(source, "app-api-base-url");
    const contactSheetMetaValue = extractMetaContent(
      source,
      "app-contact-sheet-url"
    );
    const orderFallbackMetaValue = extractMetaContent(
      source,
      "app-allow-order-whatsapp-fallback-on-save-failure"
    );
    const verifiedPaymentWhatsAppMetaValue = extractMetaContent(
      source,
      "app-open-whatsapp-after-verified-online-payment"
    );

    if (backendMetaValue === null) {
      addIssue(
        issues,
        `${pageName} is missing <meta name="app-backend-base-url">.`
      );
    } else if (backendMetaValue !== expectedBackendBaseUrl) {
      addIssue(
        issues,
        `${pageName} app-backend-base-url does not match APP_BACKEND_BASE_URL.`
      );
    }

    if (apiMetaValue === null) {
      addIssue(
        issues,
        `${pageName} is missing <meta name="app-api-base-url">.`
      );
    } else if (apiMetaValue !== expectedApiBaseUrl) {
      addIssue(
        issues,
        `${pageName} app-api-base-url does not match APP_API_BASE_URL.`
      );
    }

    if (requireContactSheetTag) {
      if (contactSheetMetaValue === null) {
        addIssue(
          issues,
          `${pageName} is missing <meta name="app-contact-sheet-url">.`
        );
      } else if (contactSheetMetaValue !== expectedContactSheetUrl) {
        addIssue(
          issues,
          `${pageName} app-contact-sheet-url does not match APP_CONTACT_SHEET_URL.`
        );
      }
    }

    if (orderFallbackMetaValue === null) {
      addIssue(
        issues,
        `${pageName} is missing <meta name="app-allow-order-whatsapp-fallback-on-save-failure">.`
      );
    } else if (
      orderFallbackMetaValue !== expectedAllowOrderWhatsAppFallbackOnSaveFailure
    ) {
      addIssue(
        issues,
        `${pageName} app-allow-order-whatsapp-fallback-on-save-failure does not match APP_ALLOW_ORDER_WHATSAPP_FALLBACK_ON_SAVE_FAILURE.`
      );
    }

    if (verifiedPaymentWhatsAppMetaValue === null) {
      addIssue(
        issues,
        `${pageName} is missing <meta name="app-open-whatsapp-after-verified-online-payment">.`
      );
    } else if (
      verifiedPaymentWhatsAppMetaValue !== expectedOpenWhatsAppAfterVerifiedOnlinePayment
    ) {
      addIssue(
        issues,
        `${pageName} app-open-whatsapp-after-verified-online-payment does not match APP_OPEN_WHATSAPP_AFTER_VERIFIED_ONLINE_PAYMENT.`
      );
    }

    [backendMetaValue, apiMetaValue].forEach((value) => {
      if (!value) return;

      if (isLegacyBackendUrl(value) && !allowedLegacyRuntimeValues.has(value)) {
        addIssue(
          issues,
          `${pageName} still points to the legacy Railway backend fallback.`
        );
      }

      if (isLocalUrl(value)) {
        addIssue(
          issues,
          `${pageName} points to localhost in stamped frontend runtime config.`
        );
      }
    });

    if (
      backendMetaValue &&
      apiMetaValue &&
      apiMetaValue !== deriveApiBaseUrl(backendMetaValue)
    ) {
      addWarning(
        warnings,
        `${pageName} app-api-base-url does not follow the usual backend + /api pattern. Confirm this split is intentional.`
      );
    }
  });
}

function checkServerDeploymentHints(warnings) {
  if (!fs.existsSync(SERVER_PATH)) return;

  const source = fs.readFileSync(SERVER_PATH, "utf8");

  if (!source.includes('app.set("trust proxy", 1)')) {
    addWarning(
      warnings,
      "If deployed behind a trusted proxy/load balancer, enable app.set(\"trust proxy\", 1) after confirming host requirements."
    );
  }
}

function checkWebhookMountSafety(issues, warnings) {
  if (!fs.existsSync(SERVER_PATH)) return;

  const source = fs.readFileSync(SERVER_PATH, "utf8");
  const webhookMountMarker = '"/api/payments/webhook"';
  const rawParserMarker = 'express.raw({ type: "application/json", limit: "1mb" })';
  const jsonParserMarker = 'app.use(express.json({ limit: "1mb" }));';
  const webhookRouteMarker = "paymentWebhooksRoute";

  const webhookMountIndex = getIndexOrInfinity(source, webhookMountMarker);
  const rawParserIndex = getIndexOrInfinity(source, rawParserMarker);
  const jsonParserIndex = getIndexOrInfinity(source, jsonParserMarker);
  const webhookRouteIndex = getIndexOrInfinity(source, webhookRouteMarker);

  if (!Number.isFinite(webhookMountIndex) || !Number.isFinite(webhookRouteIndex)) {
    addIssue(issues, "Payment webhook route mount was not found in backend/server.js.");
    return;
  }

  if (!Number.isFinite(rawParserIndex)) {
    addIssue(issues, "Payment webhook raw-body parser was not found in backend/server.js.");
  }

  if (
    Number.isFinite(rawParserIndex) &&
    Number.isFinite(jsonParserIndex) &&
    rawParserIndex > jsonParserIndex
  ) {
    addIssue(
      issues,
      "Payment webhook raw-body parser appears after express.json(). Razorpay signature verification can break in production."
    );
  }

  if (
    fs.existsSync(PAYMENT_WEBHOOKS_ROUTE_PATH) &&
    !fs
      .readFileSync(PAYMENT_WEBHOOKS_ROUTE_PATH, "utf8")
      .includes('res.set("x-webhook-event-id", eventId);')
  ) {
    addWarning(
      warnings,
      "payment-webhooks.js is missing x-webhook-event-id response tagging, which makes replay/debug tracing harder."
    );
  }
}

function run() {
  const issues = [];
  const warnings = [];
  const nodeEnv = getEnv("NODE_ENV", "development");

  console.log("Production config verification");
  console.log("------------------------------");
  console.log(`NODE_ENV: ${nodeEnv}`);
  console.log(`PORT: ${getEnv("PORT", "5000")}`);
  console.log(`FRONTEND_URL: ${getEnv("FRONTEND_URL", "missing")}`);
  console.log(`FRONTEND_ORIGINS: ${getEnv("FRONTEND_ORIGINS", "missing")}`);
  console.log(`ADMIN_URL: ${getEnv("ADMIN_URL", "missing")}`);
  console.log(`APP_BACKEND_BASE_URL: ${getEnv("APP_BACKEND_BASE_URL", "missing")}`);
  console.log(`APP_API_BASE_URL: ${getEnv("APP_API_BASE_URL", "missing")}`);
  console.log(`APP_CONTACT_SHEET_URL: ${getEnv("APP_CONTACT_SHEET_URL", "missing")}`);
  console.log(
    `APP_ALLOW_ORDER_WHATSAPP_FALLBACK_ON_SAVE_FAILURE: ${getEnv("APP_ALLOW_ORDER_WHATSAPP_FALLBACK_ON_SAVE_FAILURE", "missing")}`
  );
  console.log(
    `APP_OPEN_WHATSAPP_AFTER_VERIFIED_ONLINE_PAYMENT: ${getEnv("APP_OPEN_WHATSAPP_AFTER_VERIFIED_ONLINE_PAYMENT", "missing")}`
  );
  console.log(
    `APP_ROOM_COMBINED_CHECKOUT_FRONTEND_ENABLED: ${getEnv("APP_ROOM_COMBINED_CHECKOUT_FRONTEND_ENABLED", "false")}`
  );
  console.log(`SUPABASE_URL: ${getEnv("SUPABASE_URL", "missing")}`);
  console.log(`PAYMENT_GATEWAY_ENABLED: ${getEnv("PAYMENT_GATEWAY_ENABLED", "false")}`);
  console.log(
    `ROOM_COMBINED_CHECKOUT_ENABLED: ${getEnv("ROOM_COMBINED_CHECKOUT_ENABLED", "false")}`
  );
  console.log(
    `TASK6_ROOM_CHECKOUT_FINALIZER_ENABLED: ${getEnv("TASK6_ROOM_CHECKOUT_FINALIZER_ENABLED", "false")}`
  );
  console.log(`RAZORPAY_KEY_ID: ${maskValue(getEnv("RAZORPAY_KEY_ID"))}`);
  console.log("");

  if (nodeEnv !== "production") {
    addWarning(warnings, "NODE_ENV is not production. Run this check with production env values before launch.");
  }

  checkRequiredProductionEnv(issues);
  checkFrontendRuntimeEnv(issues);
  checkRoomCombinedCheckoutEnv(issues, warnings);
  checkPaymentEnv(issues, warnings);
  checkNotificationEnv(issues, warnings);
  checkFrontendConfig(issues, warnings);
  checkStampedFrontendRuntimePages(issues, warnings);
  checkServerDeploymentHints(warnings);
  checkWebhookMountSafety(issues, warnings);

  if (warnings.length) {
    console.log("Warnings:");
    warnings.forEach((warning) => console.log(`- ${warning}`));
    console.log("");
  }

  if (issues.length) {
    console.log("Production blockers:");
    issues.forEach((issue) => console.log(`- ${issue}`));
    process.exit(1);
  }

  console.log("Production config baseline passed.");
}

run();
