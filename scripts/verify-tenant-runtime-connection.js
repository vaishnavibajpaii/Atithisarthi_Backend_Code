"use strict";

require("dotenv").config({ quiet: true });

// This verifier is intentionally independent of the deployed application flag.
// It enables the already-prepared helper only inside this one read-only process.
process.env.TENANT_RUNTIME_ENABLED = "true";
process.env.SUPABASE_URL ||= "https://tenant-runtime-verifier.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "not-used-by-tenant-runtime-verifier";
process.env.JWT_SECRET ||= "not-used-by-tenant-runtime-verifier";

const {
  closeTenantPool,
  normalizeTenantContext,
  withTenantTransaction
} = require("../utils/tenant-database");

const EXPECTED_CONFIRMATION = "TASK3E_READ_ONLY";
const EXPECTED_ROLE = "app_tenant_runtime";
const DEFAULT_CONCURRENCY_ITERATIONS = 10;

const DIRECT_SCOPED_TABLES = Object.freeze([
  "gallery_items",
  "hotel_popup_notifications",
  "login_page_branding",
  "menu_categories",
  "menu_combo_items",
  "menu_combo_settings",
  "menu_items",
  "notification_events",
  "room_booking_payments",
  "room_bookings",
  "room_images",
  "testimonials",
  "contact_submissions",
  "food_order_bill_formats",
  "food_order_bill_snapshots",
  "guest_stays",
  "hotel_feature_settings",
  "hotel_floors",
  "hotel_guest_profiles",
  "hotel_notification_settings",
  "hotel_ordering_settings",
  "hotel_payment_route_settings",
  "hotel_profiles",
  "hotel_room_advance_policies",
  "hotel_room_amenities",
  "hotel_room_tax_settings",
  "hotel_staff_access",
  "inquiries",
  "kds_settings",
  "kitchen_stations",
  "notification_card_acknowledgements",
  "order_rounds",
  "order_support_requests",
  "orders",
  "payment_intents",
  "qr_customer_sessions",
  "qr_event_outbox",
  "qr_idempotency_records",
  "qr_order_submissions",
  "qr_staff_idempotency_records",
  "reservations",
  "restaurant_table_qr_tokens",
  "restaurant_tables",
  "room_checkout_bill_formats",
  "room_checkout_bill_snapshots",
  "room_housekeeping_tasks",
  "room_maintenance",
  "room_negotiated_rate_approvals",
  "room_rate_plans",
  "room_tax_rules",
  "room_types",
  "rooms",
  "food_order_bill_audit",
  "hotel_feature_setting_audit",
  "hotel_ordering_settings_audit",
  "kds_status_history",
  "login_page_branding_audit",
  "menu_category_audit",
  "payment_attempts",
  "payment_webhook_inbox",
  "qr_security_events",
  "room_booking_refunds",
  "room_checkout_bill_audit",
  "room_checkout_receipts",
  "room_operation_audit",
  "room_shifts",
  "room_stay_rate_adjustments"
]);

function createVerifierError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function quoteIdentifier(identifier) {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) {
    throw createVerifierError(
      "TASK3_RUNTIME_IDENTIFIER_INVALID",
      "The verifier contains an invalid table identifier"
    );
  }
  return `"${identifier}"`;
}

function parseCount(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw createVerifierError(
      "TASK3_RUNTIME_RESULT_INVALID",
      `Database returned an invalid ${label}`
    );
  }
  return parsed;
}

function readContext(prefix) {
  return normalizeTenantContext({
    tenantId: process.env[`TASK3_TEST_TENANT_${prefix}_ID`],
    propertyId: process.env[`TASK3_TEST_PROPERTY_${prefix}_ID`]
  });
}

function readConcurrencyIterations() {
  const raw = process.env.TASK3_RUNTIME_CONCURRENCY_ITERATIONS ||
    String(DEFAULT_CONCURRENCY_ITERATIONS);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 50) {
    throw createVerifierError(
      "TASK3_RUNTIME_ITERATIONS_INVALID",
      "TASK3_RUNTIME_CONCURRENCY_ITERATIONS must be an integer from 1 to 50"
    );
  }
  return parsed;
}

function validateTenantDatabaseUrl(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    throw createVerifierError(
      "TENANT_DATABASE_URL_MISSING",
      "TENANT_DATABASE_URL is required"
    );
  }
  if (
    /PROJECT_REF|POOLER_HOST|replace_with|URL_ENCODED|your-project/i.test(raw)
  ) {
    throw createVerifierError(
      "TENANT_DATABASE_URL_PLACEHOLDER",
      "TENANT_DATABASE_URL still contains a template placeholder"
    );
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw createVerifierError(
      "TENANT_DATABASE_URL_INVALID",
      "TENANT_DATABASE_URL is not a valid PostgreSQL URL"
    );
  }

  const username = decodeURIComponent(parsed.username || "");
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    !parsed.password ||
    !(
      username === EXPECTED_ROLE ||
      username.startsWith(`${EXPECTED_ROLE}.`)
    )
  ) {
    throw createVerifierError(
      "TENANT_DATABASE_URL_INVALID",
      "TENANT_DATABASE_URL must use the app_tenant_runtime role and include a host and role password"
    );
  }
  if (parsed.searchParams.get("sslmode") !== "verify-full") {
    throw createVerifierError(
      "TENANT_DATABASE_SSL_MODE_UNSAFE",
      "TENANT_DATABASE_URL must use sslmode=verify-full"
    );
  }

  return true;
}

function assertSafeInputs(contextA, contextB) {
  if (process.env.TASK3_RUNTIME_VERIFY_CONFIRM !== EXPECTED_CONFIRMATION) {
    throw createVerifierError(
      "TASK3_RUNTIME_CONFIRMATION_MISSING",
      `Set TASK3_RUNTIME_VERIFY_CONFIRM=${EXPECTED_CONFIRMATION} to run the read-only verifier`
    );
  }
  validateTenantDatabaseUrl(process.env.TENANT_DATABASE_URL);
  if (
    contextA.tenantId === contextB.tenantId ||
    contextA.propertyId === contextB.propertyId
  ) {
    throw createVerifierError(
      "TASK3_RUNTIME_CONTEXTS_NOT_DISTINCT",
      "Tenant A and tenant B must use distinct tenant and property identifiers"
    );
  }
  if (DIRECT_SCOPED_TABLES.length !== 67) {
    throw createVerifierError(
      "TASK3_RUNTIME_TABLE_MANIFEST_INVALID",
      "The runtime verifier table manifest must contain exactly 67 directly scoped tables"
    );
  }
  if (new Set(DIRECT_SCOPED_TABLES).size !== DIRECT_SCOPED_TABLES.length) {
    throw createVerifierError(
      "TASK3_RUNTIME_TABLE_MANIFEST_INVALID",
      "The runtime verifier table manifest contains a duplicate"
    );
  }
}

async function querySingleRow(client, sql, params, label) {
  const result = await client.query(sql, params);
  if (!result.rows || result.rows.length !== 1) {
    throw createVerifierError(
      "TASK3_RUNTIME_RESULT_INVALID",
      `Database returned an invalid ${label} result`
    );
  }
  return result.rows[0];
}

async function verifyFullScope(context, otherContext) {
  return withTenantTransaction(
    context,
    async (client, scope) => {
      const identity = await querySingleRow(
        client,
        "SELECT current_user AS role_name, current_setting('app.tenant_id', true) AS tenant_id, current_setting('app.property_id', true) AS property_id, current_setting('transaction_read_only') AS transaction_read_only",
        [],
        "runtime identity"
      );
      if (
        identity.role_name !== EXPECTED_ROLE ||
        identity.tenant_id !== scope.tenantId ||
        identity.property_id !== scope.propertyId ||
        identity.transaction_read_only !== "on"
      ) {
        throw createVerifierError(
          "TASK3_RUNTIME_IDENTITY_MISMATCH",
          "Restricted role, transaction-local scope, or read-only mode was not established"
        );
      }

      const hotelCounts = await querySingleRow(
        client,
        "SELECT count(*)::text AS visible_count, count(*) FILTER (WHERE tenant_id IS DISTINCT FROM $1::uuid OR id IS DISTINCT FROM $2::bigint)::text AS wrong_scope_count FROM public.hotels",
        [scope.tenantId, scope.propertyId],
        "hotel scope"
      );
      const visibleHotelCount = parseCount(
        hotelCounts.visible_count,
        "visible hotel count"
      );
      const wrongHotelScopeCount = parseCount(
        hotelCounts.wrong_scope_count,
        "wrong-scope hotel count"
      );
      if (visibleHotelCount !== 1 || wrongHotelScopeCount !== 0) {
        throw createVerifierError(
          "TASK3_RUNTIME_HOTEL_SCOPE_FAILED",
          "The current tenant did not see exactly its own canonical hotel row"
        );
      }

      const crossHotel = await querySingleRow(
        client,
        "SELECT count(*)::text AS cross_count FROM public.hotels WHERE tenant_id = $1::uuid OR id = $2::bigint",
        [otherContext.tenantId, otherContext.propertyId],
        "cross-tenant hotel probe"
      );
      const crossHotelCount = parseCount(
        crossHotel.cross_count,
        "cross-tenant hotel count"
      );
      if (crossHotelCount !== 0) {
        throw createVerifierError(
          "TASK3_RUNTIME_CROSS_TENANT_VISIBLE",
          "The current tenant can see another tenant or property's hotel row"
        );
      }

      let visibleRows = visibleHotelCount;
      let wrongScopeRows = wrongHotelScopeCount;
      for (const tableName of DIRECT_SCOPED_TABLES) {
        const quotedTable = quoteIdentifier(tableName);
        const counts = await querySingleRow(
          client,
          `SELECT count(*)::text AS visible_count, count(*) FILTER (WHERE tenant_id IS DISTINCT FROM $1::uuid OR property_id IS DISTINCT FROM $2::bigint)::text AS wrong_scope_count FROM public.${quotedTable}`,
          [scope.tenantId, scope.propertyId],
          `${tableName} scope`
        );
        const tableVisibleRows = parseCount(
          counts.visible_count,
          `${tableName} visible row count`
        );
        const tableWrongScopeRows = parseCount(
          counts.wrong_scope_count,
          `${tableName} wrong-scope row count`
        );
        visibleRows += tableVisibleRows;
        wrongScopeRows += tableWrongScopeRows;
        if (tableWrongScopeRows !== 0) {
          throw createVerifierError(
            "TASK3_RUNTIME_CROSS_TENANT_VISIBLE",
            `Cross-scope rows are visible in ${tableName}`
          );
        }
      }

      return {
        role: identity.role_name,
        ownHotelCount: visibleHotelCount,
        crossHotelCount,
        visibleRows,
        wrongScopeRows
      };
    },
    { readOnly: true }
  );
}

async function runConcurrentProbe(context, otherContext) {
  return withTenantTransaction(
    context,
    async (client, scope) => {
      const result = await querySingleRow(
        client,
        "SELECT count(*)::text AS own_count, count(*) FILTER (WHERE tenant_id IS DISTINCT FROM $1::uuid OR id IS DISTINCT FROM $2::bigint)::text AS wrong_scope_count, count(*) FILTER (WHERE tenant_id = $3::uuid OR id = $4::bigint)::text AS cross_count FROM public.hotels",
        [
          scope.tenantId,
          scope.propertyId,
          otherContext.tenantId,
          otherContext.propertyId
        ],
        "concurrent hotel probe"
      );
      const ownCount = parseCount(result.own_count, "concurrent own count");
      const wrongScopeCount = parseCount(
        result.wrong_scope_count,
        "concurrent wrong-scope count"
      );
      const crossCount = parseCount(result.cross_count, "concurrent cross count");
      if (ownCount !== 1 || wrongScopeCount !== 0 || crossCount !== 0) {
        throw createVerifierError(
          "TASK3_RUNTIME_CONCURRENT_SCOPE_FAILED",
          "Concurrent tenant scope probe failed"
        );
      }
      return true;
    },
    { readOnly: true }
  );
}

function safeFailure(error) {
  const knownCode = error && error.code ? String(error.code) : "TASK3_RUNTIME_VERIFY_FAILED";
  const isSafeVerifierError =
    knownCode.startsWith("TASK3_") || knownCode.startsWith("TENANT_");
  const knownMessage = isSafeVerifierError && error && error.message
    ? String(error.message)
    : "Restricted tenant database connection or read-only query failed";
  const connectionString = String(process.env.TENANT_DATABASE_URL || "");
  return {
    success: false,
    code: knownCode,
    message: connectionString
      ? knownMessage.split(connectionString).join("[REDACTED]")
      : knownMessage
  };
}

async function main() {
  const contextA = readContext("A");
  const contextB = readContext("B");
  const iterations = readConcurrencyIterations();
  assertSafeInputs(contextA, contextB);

  const tenantA = await verifyFullScope(contextA, contextB);
  const tenantB = await verifyFullScope(contextB, contextA);

  let concurrentPasses = 0;
  for (let index = 0; index < iterations; index += 1) {
    const results = await Promise.all([
      runConcurrentProbe(contextA, contextB),
      runConcurrentProbe(contextB, contextA)
    ]);
    concurrentPasses += results.filter(Boolean).length;
  }

  process.stdout.write(`${JSON.stringify({
    success: true,
    mode: "READ_ONLY",
    role: EXPECTED_ROLE,
    tableManifestCount: DIRECT_SCOPED_TABLES.length + 1,
    tenantA,
    tenantB,
    concurrency: {
      iterations,
      expectedPasses: iterations * 2,
      actualPasses: concurrentPasses,
      result: concurrentPasses === iterations * 2 ? "PASS" : "FAIL"
    },
    result: "PASS",
    timestamp: new Date().toISOString()
  }, null, 2)}\n`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`${JSON.stringify(safeFailure(error), null, 2)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await closeTenantPool();
      } catch (error) {
        process.stderr.write(`${JSON.stringify({
          success: false,
          code: "TASK3_RUNTIME_POOL_CLOSE_FAILED",
          message: "Tenant runtime verifier could not close its database pool cleanly"
        }, null, 2)}\n`);
        process.exitCode = 1;
      }
    });
}

module.exports = {
  DIRECT_SCOPED_TABLES,
  assertSafeInputs,
  parseCount,
  quoteIdentifier,
  readConcurrencyIterations,
  validateTenantDatabaseUrl
};
