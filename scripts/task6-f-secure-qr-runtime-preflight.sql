-- TASK6-F: read-only preflight for secure QR atomic writes.
-- No data is modified by this file.

set local search_path = pg_catalog, public;

with required_relations(name) as (
  values
    ('orders'),
    ('restaurant_tables'),
    ('restaurant_table_qr_tokens'),
    ('qr_customer_sessions'),
    ('qr_order_submissions'),
    ('qr_idempotency_records'),
    ('qr_event_outbox'),
    ('qr_security_events')
),
required_routines(identity) as (
  values
    (to_regprocedure('public.submit_secure_qr_table_order(text,text,text,text,jsonb,text)')),
    (to_regprocedure('public.merge_qr_order_totals(jsonb,jsonb)')),
    (to_regprocedure('public.replace_qr_order_totals(jsonb,jsonb,jsonb)')),
    (to_regprocedure('public.task6_order_snapshot_valid(jsonb,jsonb)'))
),
routine_metadata as (
  select
    p.oid,
    p.oid::regprocedure::text as identity,
    p.prosecdef,
    p.proconfig,
    owner_role.rolname as owner_name,
    owner_role.rolsuper as owner_superuser,
    owner_role.rolbypassrls as owner_bypassrls
  from pg_proc p
  join pg_roles owner_role on owner_role.oid = p.proowner
  where p.oid in (select identity from required_routines)
),
checks(check_name, expected, actual, result) as (
  select
    'required_relations_missing',
    '0',
    count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from required_relations expected
  where to_regclass(format('public.%I', expected.name)) is null

  union all

  select
    'required_relations_force_rls_missing',
    '0',
    count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from required_relations expected
  left join pg_class relation on relation.oid = to_regclass(format('public.%I', expected.name))
  where relation.oid is null or not relation.relrowsecurity or not relation.relforcerowsecurity

  union all

  select
    'required_routines_missing',
    '0',
    count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from required_routines
  where identity is null

  union all

  select
    'secure_qr_submit_owner_safe',
    'app_tenant_rpc_owner',
    coalesce((select owner_name from routine_metadata
      where identity = 'submit_secure_qr_table_order(text,text,text,text,jsonb,text)'), '<missing>'),
    case when coalesce((select owner_name from routine_metadata
      where identity = 'submit_secure_qr_table_order(text,text,text,text,jsonb,text)'), '') = 'app_tenant_rpc_owner'
      then 'PASS' else 'FAIL' end

  union all

  select
    'secure_qr_submit_security_invoker',
    'true',
    coalesce((select (not prosecdef)::text from routine_metadata
      where identity = 'submit_secure_qr_table_order(text,text,text,text,jsonb,text)'), 'false'),
    case when coalesce((select not prosecdef from routine_metadata
      where identity = 'submit_secure_qr_table_order(text,text,text,text,jsonb,text)'), false)
      then 'PASS' else 'FAIL' end

  union all

  select
    'secure_qr_submit_search_path_pinned',
    'true',
    coalesce((select (proconfig @> array['search_path=public, pg_temp'])::text from routine_metadata
      where identity = 'submit_secure_qr_table_order(text,text,text,text,jsonb,text)'), 'false'),
    case when coalesce((select proconfig @> array['search_path=public, pg_temp'] from routine_metadata
      where identity = 'submit_secure_qr_table_order(text,text,text,text,jsonb,text)'), false)
      then 'PASS' else 'FAIL' end

  union all

  select
    'runtime_execute:merge_qr_order_totals',
    'true',
    has_function_privilege('app_tenant_runtime',
      'public.merge_qr_order_totals(jsonb,jsonb)', 'EXECUTE')::text,
    case when has_function_privilege('app_tenant_runtime',
      'public.merge_qr_order_totals(jsonb,jsonb)', 'EXECUTE') then 'PASS' else 'FAIL' end

  union all

  select
    'runtime_execute:replace_qr_order_totals',
    'true',
    has_function_privilege('app_tenant_runtime',
      'public.replace_qr_order_totals(jsonb,jsonb,jsonb)', 'EXECUTE')::text,
    case when has_function_privilege('app_tenant_runtime',
      'public.replace_qr_order_totals(jsonb,jsonb,jsonb)', 'EXECUTE') then 'PASS' else 'FAIL' end

  union all

  select
    'service_role_execute:merge_qr_order_totals',
    'true',
    has_function_privilege('service_role',
      'public.merge_qr_order_totals(jsonb,jsonb)', 'EXECUTE')::text,
    case when has_function_privilege('service_role',
      'public.merge_qr_order_totals(jsonb,jsonb)', 'EXECUTE') then 'PASS' else 'FAIL' end

  union all

  select
    'service_role_execute:replace_qr_order_totals',
    'true',
    has_function_privilege('service_role',
      'public.replace_qr_order_totals(jsonb,jsonb,jsonb)', 'EXECUTE')::text,
    case when has_function_privilege('service_role',
      'public.replace_qr_order_totals(jsonb,jsonb,jsonb)', 'EXECUTE') then 'PASS' else 'FAIL' end
)
select check_name, expected, actual, result
from checks
order by check_name;
