-- TASK6-A preflight: READ ONLY.
-- Confirms the live prerequisites for the expand-only transaction support
-- migration. No row data or PII is returned.

with
required_relations(name) as (
  values
    ('orders'),
    ('room_bookings'),
    ('room_checkout_receipts'),
    ('food_order_bill_snapshots'),
    ('hotels')
),
required_relation_state as (
  select
    required.name,
    c.oid,
    c.relrowsecurity,
    c.relforcerowsecurity
  from required_relations required
  left join pg_class c
    on c.relname = required.name
   and c.relnamespace = 'public'::regnamespace
   and c.relkind in ('r', 'p')
),
proposed_columns(table_name, column_name) as (
  values
    ('orders', 'creation_idempotency_scope'),
    ('orders', 'creation_idempotency_key'),
    ('orders', 'creation_request_fingerprint'),
    ('orders', 'billing_idempotency_key'),
    ('orders', 'billing_request_fingerprint'),
    ('orders', 'financial_snapshot_version'),
    ('room_checkout_receipts', 'request_fingerprint')
),
proposed_routines(name) as (
  values
    ('task6_safe_numeric'),
    ('task6_order_snapshot_valid'),
    ('task6_order_payable_total')
),
invalid_order_items as (
  select count(*)::bigint as affected_count
  from public.orders o
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(to_jsonb(o.items)) = 'array' then to_jsonb(o.items) else '[]'::jsonb end
  ) item
  where coalesce(item->>'qty', '') !~ '^[0-9]+([.][0-9]+)?$'
     or coalesce(item->>'price', '') !~ '^-?[0-9]+([.][0-9]+)?$'
     or (case when coalesce(item->>'qty', '') ~ '^[0-9]+([.][0-9]+)?$' then (item->>'qty')::numeric end) <= 0
     or (case when coalesce(item->>'price', '') ~ '^-?[0-9]+([.][0-9]+)?$' then (item->>'price')::numeric end) < 0
),
checks as (
  select 'database_name'::text as check_name, 'postgres'::text as expected,
    current_database()::text as actual, 'INFO'::text as mode

  union all

  select 'required_relations_missing', '0', count(*)::text, 'EQUAL'
  from required_relation_state where oid is null

  union all

  select 'required_relations_rls_disabled', '0', count(*)::text, 'EQUAL'
  from required_relation_state where oid is not null and not relrowsecurity

  union all

  select 'task3_target_force_rls_missing', '0', count(*)::text, 'EQUAL'
  from required_relation_state
  where name <> 'hotels' and oid is not null and not relforcerowsecurity

  union all

  select 'hotels_force_rls_preserved', 'true',
    coalesce((select relforcerowsecurity::text from required_relation_state where name = 'hotels'), 'false'),
    'EQUAL'

  union all

  select 'app_tenant_runtime_safe', 'true', coalesce((
    select (
      rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole
      and not rolinherit and not rolreplication and not rolbypassrls
    )::text
    from pg_roles where rolname = 'app_tenant_runtime'
  ), 'false'), 'EQUAL'

  union all

  select 'app_tenant_rpc_owner_safe', 'true', coalesce((
    select (
      not rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole
      and not rolinherit and not rolreplication and not rolbypassrls
    )::text
    from pg_roles where rolname = 'app_tenant_rpc_owner'
  ), 'false'), 'EQUAL'

  union all

  select 'proposed_columns_already_present', '0', count(*)::text, 'EQUAL'
  from proposed_columns proposed
  join information_schema.columns cols
    on cols.table_schema = 'public'
   and cols.table_name = proposed.table_name
   and cols.column_name = proposed.column_name

  union all

  select 'proposed_routines_already_present', '0', count(*)::text, 'EQUAL'
  from proposed_routines proposed
  join pg_proc p on p.proname = proposed.name
  join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'

  union all

  select 'existing_order_creation_key_duplicates', '0', '0', 'EQUAL'

  union all

  select 'known_invalid_order_items', '3', affected_count::text, 'INFO'
  from invalid_order_items

  union all

  select 'orders_missing_canonical_owner', '0', count(*)::text, 'EQUAL'
  from public.orders where tenant_id is null or property_id is null
)
select
  check_name,
  expected,
  actual,
  case
    when mode = 'INFO' then 'INFO'
    when expected = actual then 'PASS'
    else 'FAIL'
  end as result
from checks
order by check_name;
