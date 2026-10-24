-- TASK6-E-B POS state-machine and finality preflight.
--
-- READ ONLY. Run this in the TEST Supabase SQL Editor before any state-machine
-- or final-record mutation guard is designed. It returns only catalog data and
-- aggregate counts/status vocabularies; it returns no guest, customer, order,
-- payment-provider, invoice, or staff identifiers.
--
-- This is an EXPAND -> VERIFY checkpoint. It deliberately does not create a
-- trigger, function, constraint, index, policy, or data change.

begin transaction read only;
set local search_path = pg_catalog, public;

with
required_relations(name) as (
  values
    ('hotels'),
    ('orders'),
    ('food_order_bill_snapshots'),
    ('food_order_bill_audit')
),
required_columns(table_name, column_name, expected_type) as (
  values
    ('orders', 'id', 'bigint'),
    ('orders', 'tenant_id', 'uuid'),
    ('orders', 'property_id', 'bigint'),
    ('orders', 'hotel_slug', 'text'),
    ('orders', 'parent_order_id', 'text'),
    ('orders', 'status', 'text'),
    ('orders', 'kitchen_status', 'text'),
    ('orders', 'payment_status', 'text'),
    ('orders', 'billing_status', 'text'),
    ('orders', 'bill_number', 'text'),
    ('orders', 'billed_at', 'timestamp with time zone'),
    ('orders', 'paid_at', 'timestamp with time zone'),
    ('orders', 'order_version', 'integer'),
    ('orders', 'financial_snapshot_version', 'integer'),
    ('food_order_bill_snapshots', 'tenant_id', 'uuid'),
    ('food_order_bill_snapshots', 'property_id', 'bigint'),
    ('food_order_bill_snapshots', 'hotel_slug', 'text'),
    ('food_order_bill_snapshots', 'order_id', 'text'),
    ('food_order_bill_snapshots', 'invoice_number', 'text'),
    ('food_order_bill_snapshots', 'snapshot_json', 'jsonb'),
    ('food_order_bill_snapshots', 'payload_hash', 'text')
),
required_table_privileges(relation_name, privilege_name) as (
  values
    ('hotels', 'SELECT'),
    ('orders', 'SELECT'),
    ('orders', 'UPDATE'),
    ('food_order_bill_snapshots', 'SELECT'),
    ('food_order_bill_snapshots', 'INSERT'),
    ('food_order_bill_audit', 'INSERT')
),
table_privilege_results as (
  select
    required.relation_name,
    required.privilege_name,
    pg_catalog.has_table_privilege(
      'app_tenant_runtime',
      pg_catalog.format('public.%I', required.relation_name),
      required.privilege_name
    ) as has_privilege
  from required_table_privileges required
),
sequence_targets(table_name) as (
  values ('food_order_bill_snapshots'), ('food_order_bill_audit')
),
sequence_privileges as (
  select
    target.table_name,
    pg_catalog.pg_get_serial_sequence(
      pg_catalog.format('public.%I', target.table_name),
      'id'
    ) as sequence_name
  from sequence_targets target
),
checks(check_name, expected, actual, result) as (
  select
    'required_relations_missing',
    '0',
    count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from required_relations expected_relation
  left join pg_catalog.pg_class relation
    on relation.relname = expected_relation.name
   and relation.relnamespace = 'public'::regnamespace
   and relation.relkind in ('r', 'p')
  where relation.oid is null

  union all

  select
    'required_relations_force_rls_missing',
    '0',
    count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from required_relations expected_relation
  left join pg_catalog.pg_class relation
    on relation.relname = expected_relation.name
   and relation.relnamespace = 'public'::regnamespace
   and relation.relkind in ('r', 'p')
  where relation.oid is null
     or not relation.relrowsecurity
     or not relation.relforcerowsecurity

  union all

  select
    'required_columns_missing_or_wrong_type',
    '0',
    count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from required_columns expected_column
  left join information_schema.columns actual_column
    on actual_column.table_schema = 'public'
   and actual_column.table_name = expected_column.table_name
   and actual_column.column_name = expected_column.column_name
  where actual_column.column_name is null
     or actual_column.data_type <> expected_column.expected_type

  union all

  select
    'runtime_required_table_privileges_missing',
    '0',
    count(*) filter (where not has_privilege)::text,
    case when count(*) filter (where not has_privilege) = 0 then 'PASS' else 'FAIL' end
  from table_privilege_results

  union all

  select
    'runtime_required_sequence_usage_missing',
    '0',
    count(*) filter (
      where sequence_name is null
         or not pg_catalog.has_sequence_privilege('app_tenant_runtime', sequence_name, 'USAGE')
    )::text,
    case when count(*) filter (
      where sequence_name is null
         or not pg_catalog.has_sequence_privilege('app_tenant_runtime', sequence_name, 'USAGE')
    ) = 0 then 'PASS' else 'FAIL' end
  from sequence_privileges

  union all

  select
    'food_snapshot_immutability_trigger_enabled',
    'true',
    exists (
      select 1
      from pg_catalog.pg_trigger trigger
      where trigger.tgrelid = 'public.food_order_bill_snapshots'::regclass
        and trigger.tgname = 'food_order_bill_snapshots_protect'
        and not trigger.tgisinternal
        and trigger.tgenabled <> 'D'
    )::text,
    case when exists (
      select 1
      from pg_catalog.pg_trigger trigger
      where trigger.tgrelid = 'public.food_order_bill_snapshots'::regclass
        and trigger.tgname = 'food_order_bill_snapshots_protect'
        and not trigger.tgisinternal
        and trigger.tgenabled <> 'D'
    ) then 'PASS' else 'FAIL' end

  union all

  select
    'task6_billing_finalizer_present_once',
    '1',
    count(*)::text,
    case when count(*) = 1 then 'PASS' else 'FAIL' end
  from pg_catalog.pg_proc routine
  where routine.pronamespace = 'public'::regnamespace
    and routine.proname = 'task6_finalize_order_family'

  union all

  select
    'task6_billing_finalizer_security_invoker',
    'true',
    coalesce(bool_and(not routine.prosecdef), false)::text,
    case when coalesce(bool_and(not routine.prosecdef), false) then 'PASS' else 'FAIL' end
  from pg_catalog.pg_proc routine
  where routine.pronamespace = 'public'::regnamespace
    and routine.proname = 'task6_finalize_order_family'

  union all

  select
    'task6_billing_finalizer_search_path_pinned',
    'true',
    coalesce(bool_and(coalesce(
      (select setting from pg_catalog.unnest(routine.proconfig) setting
       where setting = 'search_path=pg_catalog, public'),
      ''
    ) = 'search_path=pg_catalog, public'), false)::text,
    case when coalesce(bool_and(coalesce(
      (select setting from pg_catalog.unnest(routine.proconfig) setting
       where setting = 'search_path=pg_catalog, public'),
      ''
    ) = 'search_path=pg_catalog, public'), false) then 'PASS' else 'FAIL' end
  from pg_catalog.pg_proc routine
  where routine.pronamespace = 'public'::regnamespace
    and routine.proname = 'task6_finalize_order_family'

  union all

  select
    'orders_missing_canonical_owner',
    '0',
    count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.orders
  where tenant_id is null
     or property_id is null
     or nullif(btrim(hotel_slug), '') is null

  union all

  select
    'versioned_billed_orders_missing_snapshot',
    '0',
    count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.orders source_order
  where source_order.financial_snapshot_version is not null
    and lower(coalesce(source_order.billing_status, '')) = 'billed'
    and not exists (
      select 1
      from public.food_order_bill_snapshots snapshot
      where snapshot.tenant_id = source_order.tenant_id
        and snapshot.property_id = source_order.property_id
        and snapshot.hotel_slug = source_order.hotel_slug
        and snapshot.order_id = source_order.id::text
    )

  union all

  select
    'final_snapshot_source_finality_mismatch',
    '0',
    count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.food_order_bill_snapshots snapshot
  join public.orders source_order
    on source_order.id::text = snapshot.order_id
   and source_order.tenant_id = snapshot.tenant_id
   and source_order.property_id = snapshot.property_id
   and source_order.hotel_slug = snapshot.hotel_slug
  where lower(coalesce(source_order.billing_status, '')) <> 'billed'
     or nullif(btrim(coalesce(source_order.bill_number, '')), '') is distinct from snapshot.invoice_number

  union all

  select
    'final_snapshot_source_scope_mismatch',
    '0',
    count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.food_order_bill_snapshots snapshot
  left join public.orders source_order
    on source_order.id::text = snapshot.order_id
  where source_order.id is null
     or source_order.tenant_id is distinct from snapshot.tenant_id
     or source_order.property_id is distinct from snapshot.property_id
     or source_order.hotel_slug is distinct from snapshot.hotel_slug

  union all

  select
    'final_snapshot_duplicate_invoice_numbers',
    '0',
    count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from (
    select tenant_id, property_id, invoice_number
    from public.food_order_bill_snapshots
    where nullif(btrim(coalesce(invoice_number, '')), '') is not null
    group by tenant_id, property_id, invoice_number
    having count(*) > 1
  ) duplicates

  union all

  select
    'finalized_orders_with_cancelled_or_failed_operational_status',
    '0',
    count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.orders
  where lower(coalesce(billing_status, '')) = 'billed'
    and lower(coalesce(status, '')) in ('cancelled', 'payment_failed')

  union all

  select
    'paid_orders_with_cancelled_or_failed_operational_status',
    '0',
    count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.orders
  where lower(coalesce(payment_status, '')) = 'paid'
    and lower(coalesce(status, '')) in ('cancelled', 'payment_failed')

  union all

  select
    'billed_orders_missing_bill_number',
    '0',
    count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.orders
  where lower(coalesce(billing_status, '')) = 'billed'
    and nullif(btrim(coalesce(bill_number, '')), '') is null

  union all

  select
    'legacy_billed_orders_missing_snapshot',
    'informational',
    count(*)::text,
    'INFO'
  from public.orders source_order
  where source_order.financial_snapshot_version is null
    and lower(coalesce(source_order.billing_status, '')) = 'billed'

  union all

  select
    'orders_trigger_inventory',
    'informational',
    coalesce(jsonb_agg(
      jsonb_build_object(
        'trigger', trigger.tgname,
        'enabled', trigger.tgenabled,
        'timing', case when (trigger.tgtype & 2) <> 0 then 'before' else 'after' end,
        'events', concat_ws(',',
          case when (trigger.tgtype & 4) <> 0 then 'insert' end,
          case when (trigger.tgtype & 16) <> 0 then 'update' end,
          case when (trigger.tgtype & 8) <> 0 then 'delete' end
        )
      ) order by trigger.tgname
    )::text, '[]'),
    'INFO'
  from pg_catalog.pg_trigger trigger
  where trigger.tgrelid = 'public.orders'::regclass
    and not trigger.tgisinternal

  union all

  select
    'order_status_values',
    'informational',
    coalesce(jsonb_object_agg(status_value, row_count order by status_value)::text, '{}'::jsonb::text),
    'INFO'
  from (
    select coalesce(nullif(lower(btrim(status)), ''), '<empty>') as status_value, count(*) as row_count
    from public.orders
    group by 1
  ) status_counts

  union all

  select
    'order_kitchen_status_values',
    'informational',
    coalesce(jsonb_object_agg(status_value, row_count order by status_value)::text, '{}'::jsonb::text),
    'INFO'
  from (
    select coalesce(nullif(lower(btrim(kitchen_status)), ''), '<empty>') as status_value, count(*) as row_count
    from public.orders
    group by 1
  ) status_counts

  union all

  select
    'order_billing_status_values',
    'informational',
    coalesce(jsonb_object_agg(status_value, row_count order by status_value)::text, '{}'::jsonb::text),
    'INFO'
  from (
    select coalesce(nullif(lower(btrim(billing_status)), ''), '<empty>') as status_value, count(*) as row_count
    from public.orders
    group by 1
  ) status_counts

  union all

  select
    'order_payment_status_values',
    'informational',
    coalesce(jsonb_object_agg(status_value, row_count order by status_value)::text, '{}'::jsonb::text),
    'INFO'
  from (
    select coalesce(nullif(lower(btrim(payment_status)), ''), '<empty>') as status_value, count(*) as row_count
    from public.orders
    group by 1
  ) status_counts
)
select check_name, expected, actual, result
from checks
order by check_name;

commit;
