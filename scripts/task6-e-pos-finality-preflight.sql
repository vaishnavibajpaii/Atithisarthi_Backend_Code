-- TASK6-E POS finality and state-machine preflight.
--
-- READ ONLY. Run in the TEST Supabase SQL Editor before designing a finality
-- routine/constraint. It returns catalog and aggregate evidence only: no PII,
-- no order identifiers, and no writes.

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
required_columns(table_name, column_name) as (
  values
    ('orders', 'id'),
    ('orders', 'tenant_id'),
    ('orders', 'property_id'),
    ('orders', 'hotel_slug'),
    ('orders', 'parent_order_id'),
    ('orders', 'order_group_id'),
    ('orders', 'status'),
    ('orders', 'kitchen_status'),
    ('orders', 'payment_status'),
    ('orders', 'billing_status'),
    ('orders', 'order_version'),
    ('orders', 'bill_number'),
    ('orders', 'billed_at'),
    ('orders', 'paid_at'),
    ('orders', 'financial_snapshot_version'),
    ('orders', 'items'),
    ('orders', 'totals'),
    ('food_order_bill_snapshots', 'id'),
    ('food_order_bill_snapshots', 'tenant_id'),
    ('food_order_bill_snapshots', 'property_id'),
    ('food_order_bill_snapshots', 'hotel_slug'),
    ('food_order_bill_snapshots', 'order_id'),
    ('food_order_bill_snapshots', 'invoice_number'),
    ('food_order_bill_snapshots', 'snapshot_json'),
    ('food_order_bill_snapshots', 'payload_hash'),
    ('food_order_bill_audit', 'tenant_id'),
    ('food_order_bill_audit', 'property_id'),
    ('food_order_bill_audit', 'hotel_slug'),
    ('food_order_bill_audit', 'order_id'),
    ('food_order_bill_audit', 'snapshot_id')
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
    'app_tenant_rpc_owner_safe',
    'true',
    exists (
      select 1 from pg_catalog.pg_roles
      where rolname = 'app_tenant_rpc_owner'
        and not rolcanlogin and not rolsuper and not rolcreatedb
        and not rolcreaterole and not rolinherit and not rolreplication
        and not rolbypassrls
    )::text,
    case when exists (
      select 1 from pg_catalog.pg_roles
      where rolname = 'app_tenant_rpc_owner'
        and not rolcanlogin and not rolsuper and not rolcreatedb
        and not rolcreaterole and not rolinherit and not rolreplication
        and not rolbypassrls
    ) then 'PASS' else 'FAIL' end

  union all

  select
    'app_tenant_runtime_safe',
    'true',
    exists (
      select 1 from pg_catalog.pg_roles
      where rolname = 'app_tenant_runtime'
        and rolcanlogin and not rolsuper and not rolcreatedb
        and not rolcreaterole and not rolinherit and not rolreplication
        and not rolbypassrls
    )::text,
    case when exists (
      select 1 from pg_catalog.pg_roles
      where rolname = 'app_tenant_runtime'
        and rolcanlogin and not rolsuper and not rolcreatedb
        and not rolcreaterole and not rolinherit and not rolreplication
        and not rolbypassrls
    ) then 'PASS' else 'FAIL' end

  union all

  select 'required_relations_missing', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from required_relations expected_relation
  left join pg_catalog.pg_class relation
    on relation.relname = expected_relation.name
   and relation.relnamespace = 'public'::regnamespace
   and relation.relkind in ('r', 'p')
  where relation.oid is null

  union all

  select 'required_relations_force_rls_missing', '0', count(*)::text,
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

  select 'required_columns_missing', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from required_columns expected_column
  left join information_schema.columns actual_column
    on actual_column.table_schema = 'public'
   and actual_column.table_name = expected_column.table_name
   and actual_column.column_name = expected_column.column_name
  where actual_column.column_name is null

  union all

  select 'runtime_required_table_privileges_missing', '0',
    count(*) filter (where not has_privilege)::text,
    case when count(*) filter (where not has_privilege) = 0 then 'PASS' else 'FAIL' end
  from table_privilege_results

  union all

  select 'runtime_required_sequence_usage_missing', '0',
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
      select 1 from pg_catalog.pg_trigger
      where tgrelid = 'public.food_order_bill_snapshots'::regclass
        and tgname = 'food_order_bill_snapshots_protect'
        and not tgisinternal and tgenabled <> 'D'
    )::text,
    case when exists (
      select 1 from pg_catalog.pg_trigger
      where tgrelid = 'public.food_order_bill_snapshots'::regclass
        and tgname = 'food_order_bill_snapshots_protect'
        and not tgisinternal and tgenabled <> 'D'
    ) then 'PASS' else 'FAIL' end

  union all

  select 'orders_missing_canonical_owner', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.orders
  where tenant_id is null or property_id is null or nullif(btrim(hotel_slug), '') is null

  union all

  select 'versioned_orders_with_invalid_snapshot', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.orders
  where financial_snapshot_version is not null
    and not public.task6_order_snapshot_valid(items, totals)

  union all

  select 'new_finalizer_already_present', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from pg_catalog.pg_proc routine
  where routine.pronamespace = 'public'::regnamespace
    and routine.proname = 'task6_finalize_order_family'

  union all

  select 'legacy_billed_orders_missing_snapshot', 'informational', count(*)::text, 'INFO'
  from public.orders source_order
  where lower(coalesce(source_order.billing_status, '')) = 'billed'
    and not exists (
      select 1 from public.food_order_bill_snapshots snapshot
      where snapshot.tenant_id = source_order.tenant_id
        and snapshot.property_id = source_order.property_id
        and snapshot.hotel_slug = source_order.hotel_slug
        and snapshot.order_id = source_order.id::text
    )

  union all

  select 'versioned_billed_orders_missing_snapshot', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.orders source_order
  where source_order.financial_snapshot_version is not null
    and lower(coalesce(source_order.billing_status, '')) = 'billed'
    and not exists (
      select 1 from public.food_order_bill_snapshots snapshot
      where snapshot.tenant_id = source_order.tenant_id
        and snapshot.property_id = source_order.property_id
        and snapshot.hotel_slug = source_order.hotel_slug
        and snapshot.order_id = source_order.id::text
    )

  union all

  select 'finalized_order_without_bill_number', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.orders
  where lower(coalesce(billing_status, '')) = 'billed'
    and nullif(btrim(coalesce(bill_number, '')), '') is null

  union all

  select 'duplicate_food_snapshot_invoice_numbers', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from (
    select tenant_id, property_id, invoice_number
    from public.food_order_bill_snapshots
    where nullif(btrim(coalesce(invoice_number, '')), '') is not null
    group by tenant_id, property_id, invoice_number
    having count(*) > 1
  ) duplicate_group

  union all

  select 'snapshot_source_scope_mismatch', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.food_order_bill_snapshots snapshot
  left join public.orders source_order
    on source_order.id::text = snapshot.order_id
  where source_order.id is null
     or source_order.tenant_id is distinct from snapshot.tenant_id
     or source_order.property_id is distinct from snapshot.property_id
     or source_order.hotel_slug is distinct from snapshot.hotel_slug

  union all

  select 'order_status_values', 'informational',
    coalesce(jsonb_object_agg(status_value, row_count order by status_value)::text, '{}'::jsonb::text),
    'INFO'
  from (
    select coalesce(nullif(lower(btrim(status)), ''), '<empty>') as status_value, count(*) as row_count
    from public.orders
    group by 1
  ) status_counts

  union all

  select 'order_kitchen_status_values', 'informational',
    coalesce(jsonb_object_agg(status_value, row_count order by status_value)::text, '{}'::jsonb::text),
    'INFO'
  from (
    select coalesce(nullif(lower(btrim(kitchen_status)), ''), '<empty>') as status_value, count(*) as row_count
    from public.orders
    group by 1
  ) status_counts

  union all

  select 'order_billing_status_values', 'informational',
    coalesce(jsonb_object_agg(status_value, row_count order by status_value)::text, '{}'::jsonb::text),
    'INFO'
  from (
    select coalesce(nullif(lower(btrim(billing_status)), ''), '<empty>') as status_value, count(*) as row_count
    from public.orders
    group by 1
  ) status_counts

  union all

  select 'order_payment_status_values', 'informational',
    coalesce(jsonb_object_agg(status_value, row_count order by status_value)::text, '{}'::jsonb::text),
    'INFO'
  from (
    select coalesce(nullif(lower(btrim(payment_status)), ''), '<empty>') as status_value, count(*) as row_count
    from public.orders
    group by 1
  ) status_counts

  union all

  select 'mixed_finality_order_families', 'informational', count(*)::text, 'INFO'
  from (
    select
      coalesce(parent_order_id::text, id::text) as family_key,
      tenant_id,
      property_id
    from public.orders
    group by 1, 2, 3
    having count(distinct lower(coalesce(payment_status, ''))) > 1
        or count(distinct lower(coalesce(billing_status, ''))) > 1
  ) family
)
select check_name, expected, actual, result
from checks
order by check_name;

rollback;
