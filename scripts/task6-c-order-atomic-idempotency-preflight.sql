-- TASK6-C preflight: read-only readiness for atomic/idempotent POS order creation.
--
-- Scope:
--   * ordinary public website order creation
--   * staff-assisted root table order creation
--   * staff room-service order creation
--   * legacy public tracked-order add-items creation
--
-- This script returns aggregate/schema metadata only. It does not expose guest
-- PII, mutate data, validate constraints, or install routines.

begin transaction read only;
set local search_path = pg_catalog, public;

with
required_relations(name) as (
  values
    ('hotels'),
    ('hotel_profiles'),
    ('hotel_ordering_settings'),
    ('menu_items'),
    ('menu_combo_items'),
    ('menu_combo_settings'),
    ('orders'),
    ('order_rounds'),
    ('restaurant_tables'),
    ('room_bookings'),
    ('rooms')
),
required_columns(table_name, column_name) as (
  values
    ('orders', 'id'),
    ('orders', 'tenant_id'),
    ('orders', 'property_id'),
    ('orders', 'hotel_slug'),
    ('orders', 'items'),
    ('orders', 'totals'),
    ('orders', 'status'),
    ('orders', 'kitchen_status'),
    ('orders', 'payment_status'),
    ('orders', 'billing_status'),
    ('orders', 'order_type'),
    ('orders', 'order_source'),
    ('orders', 'table_number'),
    ('orders', 'restaurant_table_id'),
    ('orders', 'room_id'),
    ('orders', 'room_booking_id'),
    ('orders', 'room_service_charge_to_room'),
    ('orders', 'parent_order_id'),
    ('orders', 'order_group_id'),
    ('orders', 'order_entry_type'),
    ('orders', 'addon_sequence'),
    ('orders', 'order_sequence_label'),
    ('orders', 'created_by_staff_id'),
    ('orders', 'tracking_token'),
    ('orders', 'creation_idempotency_scope'),
    ('orders', 'creation_idempotency_key'),
    ('orders', 'creation_request_fingerprint'),
    ('orders', 'financial_snapshot_version'),
    ('restaurant_tables', 'tenant_id'),
    ('restaurant_tables', 'property_id'),
    ('restaurant_tables', 'hotel_slug'),
    ('room_bookings', 'tenant_id'),
    ('room_bookings', 'property_id'),
    ('room_bookings', 'hotel_slug'),
    ('rooms', 'tenant_id'),
    ('rooms', 'property_id'),
    ('rooms', 'hotel_slug')
),
reviewed_routines(signature) as (
  values
    ('public.task6_safe_numeric(text)'::regprocedure),
    ('public.task6_order_snapshot_valid(jsonb,jsonb)'::regprocedure),
    ('public.task6_order_payable_total(jsonb,jsonb)'::regprocedure),
    ('public.create_staff_table_order_if_available(jsonb)'::regprocedure),
    ('public.add_staff_items_to_active_order(text,text,text,bigint,text,text,jsonb,jsonb,jsonb,text,bigint,text)'::regprocedure),
    ('public.submit_secure_qr_table_order(text,text,text,text,jsonb,text)'::regprocedure)
),
checks(check_name, expected, actual, result) as (
  select
    'app_tenant_rpc_owner_safe',
    'true',
    exists (
      select 1
      from pg_roles
      where rolname = 'app_tenant_rpc_owner'
        and not rolcanlogin
        and not rolsuper
        and not rolcreatedb
        and not rolcreaterole
        and not rolinherit
        and not rolreplication
        and not rolbypassrls
    )::text,
    case when exists (
      select 1
      from pg_roles
      where rolname = 'app_tenant_rpc_owner'
        and not rolcanlogin
        and not rolsuper
        and not rolcreatedb
        and not rolcreaterole
        and not rolinherit
        and not rolreplication
        and not rolbypassrls
    ) then 'PASS' else 'FAIL' end

  union all

  select
    'app_tenant_runtime_safe',
    'true',
    exists (
      select 1
      from pg_roles
      where rolname = 'app_tenant_runtime'
        and rolcanlogin
        and not rolsuper
        and not rolcreatedb
        and not rolcreaterole
        and not rolinherit
        and not rolreplication
        and not rolbypassrls
    )::text,
    case when exists (
      select 1
      from pg_roles
      where rolname = 'app_tenant_runtime'
        and rolcanlogin
        and not rolsuper
        and not rolcreatedb
        and not rolcreaterole
        and not rolinherit
        and not rolreplication
        and not rolbypassrls
    ) then 'PASS' else 'FAIL' end

  union all

  select 'required_relations_missing', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from required_relations expected_relation
  left join pg_class relation
    on relation.relname = expected_relation.name
   and relation.relnamespace = 'public'::regnamespace
   and relation.relkind in ('r', 'p')
  where relation.oid is null

  union all

  select 'required_relations_force_rls_missing', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from required_relations expected_relation
  left join pg_class relation
    on relation.relname = expected_relation.name
   and relation.relnamespace = 'public'::regnamespace
   and relation.relkind in ('r', 'p')
  where relation.oid is null
     or not relation.relrowsecurity
     or not relation.relforcerowsecurity

  union all

  select 'required_columns_missing', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from required_columns expected_column
  left join information_schema.columns actual_column
    on actual_column.table_schema = 'public'
   and actual_column.table_name = expected_column.table_name
   and actual_column.column_name = expected_column.column_name
  where actual_column.column_name is null

  union all

  select 'orders_missing_canonical_owner', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.orders
  where tenant_id is null or property_id is null or nullif(btrim(hotel_slug), '') is null

  union all

  select 'partial_creation_idempotency_tuples', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.orders
  where num_nonnulls(
    creation_idempotency_scope,
    creation_idempotency_key,
    creation_request_fingerprint
  ) not in (0, 3)

  union all

  select 'invalid_creation_request_fingerprints', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.orders
  where creation_request_fingerprint is not null
    and creation_request_fingerprint !~ '^[0-9a-f]{64}$'

  union all

  select 'duplicate_creation_idempotency_keys', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from (
    select tenant_id, property_id, creation_idempotency_scope, creation_idempotency_key
    from public.orders
    where creation_idempotency_key is not null
    group by tenant_id, property_id, creation_idempotency_scope, creation_idempotency_key
    having count(*) > 1
  ) duplicate_key_groups

  union all

  select 'versioned_orders_with_invalid_snapshot', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.orders
  where financial_snapshot_version is not null
    and not public.task6_order_snapshot_valid(items, totals)

  union all

  select 'task6_creation_index_valid', 'true',
    coalesce((
      select (index_state.indisvalid and index_state.indisready and index_state.indisunique)::text
      from pg_class index_relation
      join pg_index index_state on index_state.indexrelid = index_relation.oid
      where index_relation.relnamespace = 'public'::regnamespace
        and index_relation.relname = 'task6_orders_creation_idempotency_uq'
        and index_relation.relkind = 'i'
    ), 'false'),
    case when exists (
      select 1
      from pg_class index_relation
      join pg_index index_state on index_state.indexrelid = index_relation.oid
      where index_relation.relnamespace = 'public'::regnamespace
        and index_relation.relname = 'task6_orders_creation_idempotency_uq'
        and index_relation.relkind = 'i'
        and index_state.indisvalid
        and index_state.indisready
        and index_state.indisunique
    ) then 'PASS' else 'FAIL' end

  union all

  select 'task6_creation_shape_constraint_present', 'true',
    exists (
      select 1 from pg_constraint
      where conrelid = 'public.orders'::regclass
        and conname = 'task6_orders_creation_idempotency_shape_ck'
    )::text,
    case when exists (
      select 1 from pg_constraint
      where conrelid = 'public.orders'::regclass
        and conname = 'task6_orders_creation_idempotency_shape_ck'
    ) then 'PASS' else 'FAIL' end

  union all

  select 'active_table_guard_trigger_enabled', 'true',
    exists (
      select 1
      from pg_trigger
      where tgrelid = 'public.orders'::regclass
        and tgname = 'orders_one_active_root_dine_in_table_guard'
        and not tgisinternal
        and tgenabled <> 'D'
    )::text,
    case when exists (
      select 1
      from pg_trigger
      where tgrelid = 'public.orders'::regclass
        and tgname = 'orders_one_active_root_dine_in_table_guard'
        and not tgisinternal
        and tgenabled <> 'D'
    ) then 'PASS' else 'FAIL' end

  union all

  select 'room_service_scope_trigger_enabled', 'true',
    exists (
      select 1
      from pg_trigger
      where tgrelid = 'public.orders'::regclass
        and tgname = 'orders_validate_room_service_booking_link'
        and not tgisinternal
        and tgenabled <> 'D'
    )::text,
    case when exists (
      select 1
      from pg_trigger
      where tgrelid = 'public.orders'::regclass
        and tgname = 'orders_validate_room_service_booking_link'
        and not tgisinternal
        and tgenabled <> 'D'
    ) then 'PASS' else 'FAIL' end

  union all

  select 'reviewed_routines_missing', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from reviewed_routines expected_routine
  left join pg_proc routine on routine.oid = expected_routine.signature
  where routine.oid is null

  union all

  select 'reviewed_routines_security_definer', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from reviewed_routines expected_routine
  join pg_proc routine on routine.oid = expected_routine.signature
  where routine.prosecdef

  union all

  select 'reviewed_routines_untrusted_execute', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from reviewed_routines expected_routine
  join pg_proc routine on routine.oid = expected_routine.signature
  where exists (
    select 1
    from aclexplode(coalesce(routine.proacl, acldefault('f', routine.proowner))) routine_acl
    where routine_acl.privilege_type = 'EXECUTE'
      and routine_acl.grantee in (
        0,
        (select oid from pg_roles where rolname = 'anon'),
        (select oid from pg_roles where rolname = 'authenticated')
      )
  )

  union all

  select 'reviewed_routines_runtime_execute_missing', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from reviewed_routines expected_routine
  where not has_function_privilege('app_tenant_runtime', expected_routine.signature, 'EXECUTE')

  union all

  select 'runtime_required_table_privileges_missing', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from (values
    ('orders', 'SELECT'),
    ('orders', 'INSERT'),
    ('hotels', 'SELECT'),
    ('restaurant_tables', 'SELECT'),
    ('restaurant_tables', 'UPDATE'),
    ('room_bookings', 'SELECT'),
    ('room_bookings', 'UPDATE'),
    ('rooms', 'SELECT')
  ) expected(table_name, privilege_name)
  where not has_table_privilege(
    'app_tenant_runtime',
    format('public.%I', expected.table_name),
    expected.privilege_name
  )

  union all

  select 'orders_sequence_runtime_usage', 'true',
    exists (
      select 1
      from pg_class sequence_relation
      where sequence_relation.oid = pg_get_serial_sequence('public.orders', 'id')::regclass
        and has_sequence_privilege('app_tenant_runtime', sequence_relation.oid, 'USAGE')
    )::text,
    case when exists (
      select 1
      from pg_class sequence_relation
      where sequence_relation.oid = pg_get_serial_sequence('public.orders', 'id')::regclass
        and has_sequence_privilege('app_tenant_runtime', sequence_relation.oid, 'USAGE')
    ) then 'PASS' else 'FAIL' end

  union all

  select 'proposed_routines_already_present', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from pg_proc routine
  where routine.pronamespace = 'public'::regnamespace
    and routine.proname in (
      'task6_create_order_atomic',
      'task6_create_public_order_addon_atomic'
    )

  union all

  select 'task6_keyed_orders', 'informational', count(*)::text, 'INFO'
  from public.orders
  where creation_idempotency_key is not null

  union all

  select 'legacy_invalid_order_snapshots', 'informational', count(*)::text, 'INFO'
  from public.orders
  where not public.task6_order_snapshot_valid(items, totals)

  union all

  select 'order_status_values', 'informational',
    coalesce((
      select jsonb_object_agg(status_value, row_count order by status_value)::text
      from (
        select coalesce(nullif(lower(btrim(status)), ''), '<empty>') as status_value,
               count(*) as row_count
        from public.orders
        group by 1
      ) status_counts
    ), '{}'::jsonb::text),
    'INFO'

  union all

  select 'order_kitchen_status_values', 'informational',
    coalesce((
      select jsonb_object_agg(status_value, row_count order by status_value)::text
      from (
        select coalesce(nullif(lower(btrim(kitchen_status)), ''), '<empty>') as status_value,
               count(*) as row_count
        from public.orders
        group by 1
      ) status_counts
    ), '{}'::jsonb::text),
    'INFO'

  union all

  select 'order_payment_status_values', 'informational',
    coalesce((
      select jsonb_object_agg(status_value, row_count order by status_value)::text
      from (
        select coalesce(nullif(lower(btrim(payment_status)), ''), '<empty>') as status_value,
               count(*) as row_count
        from public.orders
        group by 1
      ) status_counts
    ), '{}'::jsonb::text),
    'INFO'

  union all

  select 'order_billing_status_values', 'informational',
    coalesce((
      select jsonb_object_agg(status_value, row_count order by status_value)::text
      from (
        select coalesce(nullif(lower(btrim(billing_status)), ''), '<empty>') as status_value,
               count(*) as row_count
        from public.orders
        group by 1
      ) status_counts
    ), '{}'::jsonb::text),
    'INFO'
)
select check_name, expected, actual, result
from checks
order by check_name;

rollback;
