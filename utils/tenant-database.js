const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { env } = require("../config/env");
const logger = require("./logger");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TENANT_DB_CA_PATH = path.resolve(
  __dirname,
  "../certs/prod-ca-2021.crt"
);

let tenantPool;
let tenantDbCa;

function createConfigError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function getTenantDbCa() {
  if (tenantDbCa) {
    return tenantDbCa;
  }

  try {
    tenantDbCa = fs.readFileSync(TENANT_DB_CA_PATH, "utf8");
    return tenantDbCa;
  } catch (error) {
    const configError = createConfigError(
      "TENANT_DATABASE_CA_MISSING",
      `Tenant database CA certificate could not be loaded: ${TENANT_DB_CA_PATH}`
    );

    configError.cause = error;
    throw configError;
  }
}

function normalizePositiveInteger(value, fallback, name) {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    if (fallback !== undefined) {
      return fallback;
    }

    throw createConfigError(
      "TENANT_DATABASE_CONFIG_INVALID",
      `${name} must be a positive integer`
    );
  }

  return parsed;
}

function normalizeTenantContext(context = {}) {
  const tenantId = String(context.tenantId || "")
    .trim()
    .toLowerCase();

  const rawPropertyId = String(context.propertyId || "").trim();

  if (!UUID_PATTERN.test(tenantId)) {
    throw createConfigError(
      "TENANT_CONTEXT_INVALID",
      "A valid canonical tenant ID is required"
    );
  }

  if (!/^[1-9][0-9]*$/.test(rawPropertyId)) {
    throw createConfigError(
      "TENANT_CONTEXT_INVALID",
      "A valid canonical property ID is required"
    );
  }

  return {
    tenantId,
    propertyId: BigInt(rawPropertyId).toString()
  };
}

function getTenantPool() {
  if (!env.tenantRuntimeEnabled) {
    throw createConfigError(
      "TENANT_RUNTIME_DISABLED",
      "Restricted tenant database runtime is disabled"
    );
  }

  if (!String(env.tenantDatabaseUrl || "").trim()) {
    throw createConfigError(
      "TENANT_DATABASE_URL_MISSING",
      "Restricted tenant database URL is not configured"
    );
  }

  const databaseUrl = new URL(env.tenantDatabaseUrl);

// The verifier requires sslmode=verify-full in the configured URL.
// node-postgres can override the explicit `ssl` object when SSL
// parameters are present in the connection string, so remove only
// sslmode from the connection string passed to Pool and configure
// certificate verification explicitly below.
databaseUrl.searchParams.delete("sslmode");

  if (!tenantPool) {
    
tenantPool = new Pool({
  connectionString: databaseUrl.toString(),
  ssl: {
    ca: getTenantDbCa(),
    rejectUnauthorized: true
  },

      max: normalizePositiveInteger(
        env.tenantDatabasePoolMax,
        10
      ),

      idleTimeoutMillis: normalizePositiveInteger(
        env.tenantDatabaseIdleTimeoutMs,
        30000
      ),

      connectionTimeoutMillis: normalizePositiveInteger(
        env.tenantDatabaseConnectionTimeoutMs,
        10000
      ),

      allowExitOnIdle: env.isDevelopment
    });

    tenantPool.on("error", (error) => {
      logger.error("Tenant database pool error", {
        code:
          error && error.code
            ? error.code
            : "UNKNOWN",
        message:
          error && error.message
            ? error.message
            : "Unknown pool error"
      });
    });
  }

  return tenantPool;
}

async function runTenantTransaction(
  pool,
  context,
  work,
  options = {}
) {
  if (!pool || typeof pool.connect !== "function") {
    throw createConfigError(
      "TENANT_DATABASE_POOL_INVALID",
      "A PostgreSQL pool is required"
    );
  }

  if (typeof work !== "function") {
    throw createConfigError(
      "TENANT_DATABASE_WORK_INVALID",
      "Tenant transaction work callback is required"
    );
  }

  const scope = normalizeTenantContext(context);

  const statementTimeoutMs = normalizePositiveInteger(
    options.statementTimeoutMs,
    normalizePositiveInteger(
      env.tenantDatabaseStatementTimeoutMs,
      15000
    ),
    "statementTimeoutMs"
  );

  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    if (options.readOnly === true) {
      await client.query("SET TRANSACTION READ ONLY");
    }

    const identityResult = await client.query(
      "SELECT rolname, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
    );

    const identity =
      identityResult.rows &&
      identityResult.rows[0];

    if (
      !identity ||
      identity.rolname !== "app_tenant_runtime" ||
      identity.rolcanlogin !== true ||
      identity.rolsuper !== false ||
      identity.rolbypassrls !== false
    ) {
      throw createConfigError(
        "TENANT_DATABASE_ROLE_UNSAFE",
        "Tenant database connection is not using the restricted runtime role"
      );
    }

    await client.query(
      "SELECT set_config('statement_timeout', $1, true)",
      [`${statementTimeoutMs}ms`]
    );

    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.property_id', $2, true)",
      [
        scope.tenantId,
        scope.propertyId
      ]
    );

    const result = await work(
      client,
      Object.freeze({
        ...scope
      })
    );

    await client.query("COMMIT");

    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        logger.error(
          "Tenant database rollback failed",
          {
            code:
              rollbackError &&
              rollbackError.code
                ? rollbackError.code
                : "UNKNOWN",
            message:
              rollbackError &&
              rollbackError.message
                ? rollbackError.message
                : "Unknown rollback error"
          }
        );
      }
    }

    throw error;
  } finally {
    client.release();
  }
}

async function withTenantTransaction(
  context,
  work,
  options = {}
) {
  return runTenantTransaction(
    getTenantPool(),
    context,
    work,
    options
  );
}

async function closeTenantPool() {
  if (!tenantPool) {
    return;
  }

  const pool = tenantPool;
  tenantPool = undefined;

  await pool.end();
}

module.exports = {
  closeTenantPool,
  normalizeTenantContext,
  runTenantTransaction,
  withTenantTransaction
};