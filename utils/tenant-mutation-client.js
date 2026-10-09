"use strict";

const { withTenantTransaction } = require("./tenant-database");

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const TENANT_TABLES = new Set([
  "contact_submissions", "food_order_bill_audit", "food_order_bill_formats",
  "food_order_bill_snapshots", "gallery_items", "guest_stays",
  "hotel_feature_setting_audit", "hotel_feature_settings", "hotel_floors",
  "hotel_guest_profiles", "hotel_notification_settings",
  "hotel_ordering_settings", "hotel_ordering_settings_audit",
  "hotel_payment_route_settings", "hotel_popup_notifications", "hotel_profiles",
  "hotel_room_advance_policies", "hotel_room_amenities",
  "hotel_room_tax_settings", "hotel_staff_access", "inquiries",
  "kds_settings", "kds_status_history", "kitchen_stations",
  "login_page_branding", "login_page_branding_audit", "menu_categories",
  "menu_category_audit", "menu_combo_items", "menu_combo_settings",
  "menu_items", "notification_card_acknowledgements", "notification_events",
  "order_rounds", "order_support_requests", "orders", "payment_attempts",
  "payment_intents", "payment_webhook_inbox", "qr_customer_sessions",
  "qr_event_outbox", "qr_idempotency_records", "qr_order_submissions",
  "qr_security_events", "qr_staff_idempotency_records", "reservations",
  "restaurant_table_qr_tokens", "restaurant_tables", "room_booking_payments",
  "room_booking_refunds", "room_bookings", "room_checkout_bill_audit",
  "room_checkout_bill_formats", "room_checkout_bill_snapshots",
  "room_checkout_receipts", "room_housekeeping_tasks", "room_images",
  "room_maintenance", "room_negotiated_rate_approvals", "room_operation_audit",
  "room_rate_plans", "room_shifts", "room_stay_rate_adjustments",
  "room_tax_rules", "room_types", "rooms", "testimonials"
]);
const IMMUTABLE_OWNERSHIP_COLUMNS = new Set([
  "tenant_id",
  "property_id",
  "hotel_slug"
]);
const TENANT_RPCS = new Set([
  "acknowledge_notification_card", "activate_room_tax_rule",
  "add_staff_items_to_active_order",
  "correct_secure_qr_submission_staff", "create_staff_table_order_if_available",
  "create_room_booking_with_advance",
  "delete_room_image", "edit_secure_qr_submission", "extend_room_booking",
  "get_staff_active_table_order",
  "is_dine_in_order_open", "record_room_booking_refund", "reorder_room_images",
  "record_room_booking_payment",
  "room_negotiated_rate_ready", "settle_room_combined_checkout",
  "shift_room_booking", "submit_secure_qr_table_order"
]);

function createTenantMutationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function quoteIdentifier(value, label = "identifier") {
  const identifier = String(value || "").trim();
  if (!IDENTIFIER.test(identifier)) {
    throw createTenantMutationError(
      "TENANT_MUTATION_IDENTIFIER_INVALID",
      `Invalid ${label}`
    );
  }
  return `"${identifier}"`;
}

function normalizeTable(value) {
  const table = String(value || "").trim();
  if (!TENANT_TABLES.has(table)) {
    throw createTenantMutationError(
      "TENANT_MUTATION_TABLE_FORBIDDEN",
      "Table is not approved for tenant-scoped mutations"
    );
  }
  return table;
}

function normalizeRows(value) {
  const rows = Array.isArray(value) ? value : [value];
  if (!rows.length || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    throw createTenantMutationError(
      "TENANT_MUTATION_PAYLOAD_INVALID",
      "A non-empty mutation payload is required"
    );
  }
  return rows;
}

function bindRowsToScope(rows, scope) {
  const expected = {
    tenant_id: scope.tenantId,
    property_id: scope.propertyId,
    hotel_slug: scope.propertySlug
  };
  return rows.map((row) => {
    const bound = { ...row };
    for (const [column, value] of Object.entries(expected)) {
      if (value === undefined || value === null || value === "") {
        throw createTenantMutationError(
          "TENANT_MUTATION_SCOPE_INVALID",
          "Complete canonical tenant ownership is required"
        );
      }
      if (
        Object.prototype.hasOwnProperty.call(bound, column) &&
        String(bound[column]) !== String(value)
      ) {
        throw createTenantMutationError(
          "TENANT_MUTATION_SCOPE_CONFLICT",
          "Mutation ownership conflicts with canonical tenant context"
        );
      }
      bound[column] = value;
    }
    return bound;
  });
}

function bindRpcArgsToScope(args, scope) {
  const bound = { ...args };
  const scopedArguments = {
    p_tenant_id: scope.tenantId,
    p_property_id: scope.propertyId,
    p_hotel_slug: scope.propertySlug
  };
  for (const [argument, expected] of Object.entries(scopedArguments)) {
    if (!Object.prototype.hasOwnProperty.call(bound, argument)) continue;
    if (expected === undefined || expected === null || expected === "") {
      throw createTenantMutationError(
        "TENANT_MUTATION_SCOPE_INVALID",
        "Complete canonical tenant ownership is required"
      );
    }
    if (String(bound[argument]) !== String(expected)) {
      throw createTenantMutationError(
        "TENANT_RPC_SCOPE_CONFLICT",
        "Function ownership conflicts with canonical tenant context"
      );
    }
    bound[argument] = expected;
  }
  return bound;
}

function normalizeReturning(value = "*") {
  const input = String(value || "*").trim();
  if (input === "*") return "*";
  const columns = input.split(",").map((column) => column.trim()).filter(Boolean);
  if (!columns.length) return "*";
  return columns.map((column) => quoteIdentifier(column, "returning column")).join(", ");
}

function toSafeError(error) {
  return {
    code: String(error?.code || "TENANT_MUTATION_FAILED"),
    message: String(error?.message || "Tenant mutation failed"),
    details: error?.details ? String(error.details) : "",
    hint: error?.hint ? String(error.hint) : ""
  };
}

class TenantMutationBuilder {
  constructor(scope, table, transactionRunner) {
    this.scope = scope;
    this.table = normalizeTable(table);
    this.transactionRunner = transactionRunner;
    this.operation = null;
    this.rows = null;
    this.filters = [];
    this.returning = null;
    this.singleMode = null;
    this.onConflict = [];
    this.limitCount = null;
    this.rangeStart = null;
    this.rangeEnd = null;
    this.orders = [];
    this.selectOptions = {};
    this.executed = null;
  }

  insert(value) {
    this.operation = "insert";
    this.rows = bindRowsToScope(normalizeRows(value), this.scope);
    return this;
  }

  upsert(value, options = {}) {
    this.operation = "upsert";
    this.rows = bindRowsToScope(normalizeRows(value), this.scope);
    this.onConflict = String(options.onConflict || "")
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean);
    if (!this.onConflict.length) {
      throw createTenantMutationError(
        "TENANT_MUTATION_CONFLICT_TARGET_REQUIRED",
        "A reviewed upsert conflict target is required"
      );
    }
    this.onConflict.forEach((column) => quoteIdentifier(column, "conflict column"));
    return this;
  }

  update(value) {
    this.operation = "update";
    this.rows = normalizeRows(value);
    if (this.rows.length !== 1) {
      throw createTenantMutationError(
        "TENANT_MUTATION_PAYLOAD_INVALID",
        "Update requires exactly one payload object"
      );
    }
    return this;
  }

  delete() {
    this.operation = "delete";
    return this;
  }

  select(columns = "*", options = {}) {
    this.returning = normalizeReturning(columns);
    this.selectOptions = options && typeof options === "object" ? options : {};
    if (!this.operation) this.operation = "select";
    return this;
  }

  eq(column, value) {
    this.filters.push({ operator: "=", column, value });
    return this;
  }

  neq(column, value) {
    this.filters.push({ operator: "<>", column, value });
    return this;
  }

  gt(column, value) {
    this.filters.push({ operator: ">", column, value });
    return this;
  }

  gte(column, value) {
    this.filters.push({ operator: ">=", column, value });
    return this;
  }

  lt(column, value) {
    this.filters.push({ operator: "<", column, value });
    return this;
  }

  lte(column, value) {
    this.filters.push({ operator: "<=", column, value });
    return this;
  }

  like(column, value) {
    this.filters.push({ operator: "LIKE", column, value });
    return this;
  }

  ilike(column, value) {
    this.filters.push({ operator: "ILIKE", column, value });
    return this;
  }

  contains(column, value) {
    this.filters.push({ operator: "JSON_CONTAINS", column, value });
    return this;
  }

  not(column, operator, value) {
    if (String(operator).toLowerCase() === "is" && value === null) {
      this.filters.push({ operator: "IS NOT NULL", column, value: null });
      return this;
    }
    throw createTenantMutationError(
      "TENANT_MUTATION_FILTER_INVALID",
      "Unsupported NOT filter for tenant query"
    );
  }

  in(column, values) {
    if (!Array.isArray(values) || values.length === 0) {
      this.filters.push({ operator: "FALSE", column, value: null });
    } else {
      this.filters.push({ operator: "ANY", column, value: values });
    }
    return this;
  }

  is(column, value) {
    if (value !== null) {
      throw createTenantMutationError(
        "TENANT_MUTATION_FILTER_INVALID",
        "Only IS NULL is supported for tenant mutations"
      );
    }
    this.filters.push({ operator: "IS NULL", column, value: null });
    return this;
  }

  limit(value) {
    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw createTenantMutationError(
        "TENANT_MUTATION_LIMIT_INVALID",
        "Mutation limit must be a positive integer"
      );
    }
    this.limitCount = limit;
    return this;
  }

  range(from, to) {
    const start = Number(from);
    const end = Number(to);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start
    ) {
      throw createTenantMutationError(
        "TENANT_MUTATION_RANGE_INVALID",
        "A valid tenant query range is required"
      );
    }
    this.rangeStart = start;
    this.rangeEnd = end;
    return this;
  }

  order(column, options = {}) {
    quoteIdentifier(column, "order column");
    this.orders.push({
      column,
      ascending: options.ascending !== false,
      nullsFirst: options.nullsFirst === true
    });
    return this;
  }

  single() {
    this.singleMode = "single";
    return this.execute();
  }

  maybeSingle() {
    this.singleMode = "maybeSingle";
    return this.execute();
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }

  buildFilters(values) {
    if (!this.filters.length) return "";
    const fragments = this.filters.map((filter) => {
      const column = quoteIdentifier(filter.column, "filter column");
      if (filter.operator === "FALSE") return "FALSE";
      if (filter.operator === "IS NULL") return `${column} IS NULL`;
      if (filter.operator === "IS NOT NULL") return `${column} IS NOT NULL`;
      values.push(filter.value);
      if (filter.operator === "ANY") {
        return `${column} = ANY($${values.length})`;
      }
      if (filter.operator === "JSON_CONTAINS") {
        values[values.length - 1] = JSON.stringify(filter.value);
        return `${column} @> $${values.length}::jsonb`;
      }
      return `${column} ${filter.operator} $${values.length}`;
    });
    return ` WHERE ${fragments.join(" AND ")}`;
  }

  buildInsert(values) {
    const columns = [...new Set(this.rows.flatMap((row) => Object.keys(row)))];
    if (!columns.length) {
      throw createTenantMutationError(
        "TENANT_MUTATION_PAYLOAD_INVALID",
        "Mutation payload has no columns"
      );
    }
    columns.forEach((column) => quoteIdentifier(column, "payload column"));
    const tuples = this.rows.map((row) => {
      const placeholders = columns.map((column) => {
        values.push(Object.prototype.hasOwnProperty.call(row, column) ? row[column] : null);
        return `$${values.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    let sql = `INSERT INTO public.${quoteIdentifier(this.table, "table")} (${columns.map((column) => quoteIdentifier(column)).join(", ")}) VALUES ${tuples.join(", ")}`;
    if (this.operation === "upsert") {
      const target = this.onConflict.map((column) => quoteIdentifier(column)).join(", ");
      const mutable = columns.filter((column) => !this.onConflict.includes(column) && !IMMUTABLE_OWNERSHIP_COLUMNS.has(column));
      sql += mutable.length
        ? ` ON CONFLICT (${target}) DO UPDATE SET ${mutable.map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`).join(", ")}`
        : ` ON CONFLICT (${target}) DO NOTHING`;
    }
    return sql;
  }

  buildUpdate(values) {
    const payload = this.rows[0];
    const columns = Object.keys(payload);
    if (!columns.length || columns.some((column) => IMMUTABLE_OWNERSHIP_COLUMNS.has(column))) {
      throw createTenantMutationError(
        "TENANT_MUTATION_OWNERSHIP_IMMUTABLE",
        "Tenant ownership columns cannot be updated"
      );
    }
    const assignments = columns.map((column) => {
      quoteIdentifier(column, "payload column");
      values.push(payload[column]);
      return `${quoteIdentifier(column)} = $${values.length}`;
    });
    return `UPDATE public.${quoteIdentifier(this.table, "table")} SET ${assignments.join(", ")}${this.buildFilters(values)}`;
  }

  buildDelete(values) {
    if (!this.filters.length) {
      throw createTenantMutationError(
        "TENANT_MUTATION_UNSCOPED_DELETE",
        "Tenant delete requires an explicit record filter"
      );
    }
    return `DELETE FROM public.${quoteIdentifier(this.table, "table")}${this.buildFilters(values)}`;
  }

  buildSelect(values) {
    if (this.selectOptions.head === true) {
      return `SELECT COUNT(*)::bigint AS "__tenant_count" FROM public.${quoteIdentifier(this.table, "table")}${this.buildFilters(values)}`;
    }
    const countProjection = this.selectOptions.count === "exact"
      ? ', COUNT(*) OVER()::bigint AS "__tenant_total_count"'
      : "";
    let sql = `SELECT ${this.returning || "*"}${countProjection} FROM public.${quoteIdentifier(this.table, "table")}${this.buildFilters(values)}`;
    if (this.orders.length) {
      sql += ` ORDER BY ${this.orders.map((item) =>
        `${quoteIdentifier(item.column)} ${item.ascending ? "ASC" : "DESC"} NULLS ${item.nullsFirst ? "FIRST" : "LAST"}`
      ).join(", ")}`;
    }
    if (this.rangeStart !== null) {
      sql += ` LIMIT ${this.rangeEnd - this.rangeStart + 1} OFFSET ${this.rangeStart}`;
    } else if (this.limitCount) {
      sql += ` LIMIT ${this.limitCount}`;
    }
    return sql;
  }

  async execute() {
    if (this.executed) return this.executed;
    this.executed = this.executeOnce();
    return this.executed;
  }

  async executeOnce() {
    try {
      if (!this.operation) {
        throw createTenantMutationError(
          "TENANT_MUTATION_OPERATION_REQUIRED",
          "A tenant mutation operation is required"
        );
      }
      const result = await this.transactionRunner(
        {
          tenantId: this.scope.tenantId,
          propertyId: this.scope.propertyId
        },
        async (client) => {
          const values = [];
          let sql = this.operation === "select"
            ? this.buildSelect(values)
            : this.operation === "insert" || this.operation === "upsert"
              ? this.buildInsert(values)
              : this.operation === "update"
                ? this.buildUpdate(values)
                : this.buildDelete(values);
          if (this.returning && this.operation !== "select") sql += ` RETURNING ${this.returning}`;
          if (
            this.limitCount &&
            !["select", "insert", "upsert"].includes(this.operation)
          ) {
            throw createTenantMutationError(
              "TENANT_MUTATION_LIMIT_UNSUPPORTED",
              "Mutation limits are not supported without an explicit key query"
            );
          }
          return client.query(sql, values);
        },
        { readOnly: this.operation === "select" }
      );
      let rows = Array.isArray(result?.rows) ? result.rows : [];
      let count = rows.length;
      if (this.selectOptions.head === true) {
        count = Number(rows[0]?.__tenant_count || 0);
        rows = [];
      } else if (this.selectOptions.count === "exact") {
        count = rows.length ? Number(rows[0]?.__tenant_total_count || 0) : 0;
        rows = rows.map(({ __tenant_total_count, ...row }) => row);
      }
      let data = this.returning || this.operation === "select" ? rows : null;
      if (this.selectOptions.head === true) data = null;
      if (this.singleMode === "single") {
        if (rows.length !== 1) {
          throw createTenantMutationError(
            "PGRST116",
            "Expected exactly one tenant mutation row"
          );
        }
        data = rows[0];
      } else if (this.singleMode === "maybeSingle") {
        if (rows.length > 1) {
          throw createTenantMutationError(
            "PGRST116",
            "Expected at most one tenant mutation row"
          );
        }
        data = rows[0] || null;
      }
      return { data, error: null, count };
    } catch (error) {
      return { data: null, error: toSafeError(error), count: null };
    }
  }
}

class TenantRpcBuilder {
  constructor(scope, name, args, transactionRunner) {
    this.scope = scope;
    this.name = String(name || "").trim();
    const inputArgs = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    this.args = bindRpcArgsToScope(inputArgs, scope);
    this.transactionRunner = transactionRunner;
    this.singleMode = null;
    this.executed = null;
    if (!TENANT_RPCS.has(this.name)) {
      throw createTenantMutationError(
        "TENANT_RPC_FORBIDDEN",
        "Function is not approved for the tenant runtime role"
      );
    }
  }

  single() {
    this.singleMode = "single";
    return this.execute();
  }

  maybeSingle() {
    this.singleMode = "maybeSingle";
    return this.execute();
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }

  async execute() {
    if (this.executed) return this.executed;
    this.executed = this.executeOnce();
    return this.executed;
  }

  async executeOnce() {
    try {
      const entries = Object.entries(this.args);
      const values = entries.map(([, value]) => value);
      const namedArgs = entries.map(([name], index) =>
        `${quoteIdentifier(name, "function argument")} => $${index + 1}`
      );
      const result = await this.transactionRunner(
        { tenantId: this.scope.tenantId, propertyId: this.scope.propertyId },
        (client) => client.query(
          `SELECT * FROM public.${quoteIdentifier(this.name, "function")}(${namedArgs.join(", ")})`,
          values
        ),
        { readOnly: false }
      );
      const rows = Array.isArray(result?.rows) ? result.rows : [];
      let data = rows;
      if (this.singleMode === "single") {
        if (rows.length !== 1) {
          throw createTenantMutationError("PGRST116", "Expected exactly one tenant RPC row");
        }
        data = rows[0];
      } else if (this.singleMode === "maybeSingle") {
        if (rows.length > 1) {
          throw createTenantMutationError("PGRST116", "Expected at most one tenant RPC row");
        }
        data = rows[0] || null;
      }
      return { data, error: null, count: rows.length };
    } catch (error) {
      return { data: null, error: toSafeError(error), count: null };
    }
  }
}

function createTenantMutationClient(scope = {}, options = {}) {
  const transactionRunner = options.transactionRunner || withTenantTransaction;
  if (typeof transactionRunner !== "function") {
    throw createTenantMutationError(
      "TENANT_MUTATION_RUNNER_INVALID",
      "Tenant transaction runner is required"
    );
  }
  return Object.freeze({
    from(table) {
      return new TenantMutationBuilder(scope, table, transactionRunner);
    },
    rpc(name, args) {
      return new TenantRpcBuilder(scope, name, args, transactionRunner);
    }
  });
}

module.exports = {
  TENANT_RPCS,
  TENANT_TABLES,
  createTenantMutationClient,
  createTenantMutationError,
  normalizeReturning,
  quoteIdentifier
};
