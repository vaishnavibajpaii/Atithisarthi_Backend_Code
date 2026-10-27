-- TASK6-F: read-only verification after activation.

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
submit_routine as (
  select p.*, owner_role.rolname as owner_name, owner_role.rolsuper as owner_superuser,
    owner_role.rolbypassrls as owner_bypassrls
  from pg_proc p
  join pg_roles owner_role on owner_role.oid = p.proowner
  where p.oid = 'public.submit_secure_qr_table_order(text,text,text,text,jsonb,text)'::regprocedure
),
checks(check_name, expected, actual, result) as (
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
    'secure_qr_submit_present_once',
    '1',
    count(*)::text,
    case when count(*) = 1 then 'PASS' else 'FAIL' end
  from submit_routine

  union all

  select
    'secure_qr_submit_owner_safe',
    'app_tenant_rpc_owner',
    coalesce((select owner_name from submit_routine), '<missing>'),
    case when coalesce((select owner_name from submit_routine), '') = 'app_tenant_rpc_owner'
           and not coalesce((select owner_superuser from submit_routine), true)
           and not coalesce((select owner_bypassrls from submit_routine), true)
      then 'PASS' else 'FAIL' end

  union all

  select
    'secure_qr_submit_security_invoker',
    'true',
    coalesce((select (not prosecdef)::text from submit_routine), 'false'),
    case when coalesce((select not prosecdef from submit_routine), false) then 'PASS' else 'FAIL' end

  union all

  select
    'secure_qr_submit_search_path_pinned',
    'true',
    coalesce((select (proconfig @> array['search_path=public, pg_temp'])::text from submit_routine), 'false'),
    case when coalesce((select proconfig @> array['search_path=public, pg_temp'] from submit_routine), false)
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

  union all

  select
    'untrusted_helper_execute_grants',
    '0',
    count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from pg_roles role
  cross join (values
    ('public.merge_qr_order_totals(jsonb,jsonb)'::regprocedure),
    ('public.replace_qr_order_totals(jsonb,jsonb,jsonb)'::regprocedure)
  ) helper(identity)
  where role.rolname in ('anon', 'authenticated')
    and has_function_privilege(role.oid, helper.identity, 'EXECUTE')

  union all

  select
    'routine_has_snapshot_validation',
    'true',
    coalesce((select (prosrc like '%task6_order_snapshot_valid%')::text from submit_routine), 'false'),
    case when coalesce((select prosrc like '%task6_order_snapshot_valid%' from submit_routine), false)
      then 'PASS' else 'FAIL' end

  union all

  select
    'routine_sets_new_root_snapshot_version',
    'true',
    coalesce((select (prosrc like '%financial_snapshot_version%')::text from submit_routine), 'false'),
    case when coalesce((select prosrc like '%financial_snapshot_version%' from submit_routine), false)
      then 'PASS' else 'FAIL' end

  union all

  select
    'routine_keeps_qr_idempotency_lock',
    'true',
    coalesce((select (prosrc like '%qr_idempotency_records%')::text from submit_routine), 'false'),
    case when coalesce((select prosrc like '%qr_idempotency_records%' from submit_routine), false)
      then 'PASS' else 'FAIL' end

  union all

  select
    'routine_keeps_durable_outbox',
    'true',
    coalesce((select (prosrc like '%qr_event_outbox%')::text from submit_routine), 'false'),
    case when coalesce((select prosrc like '%qr_event_outbox%' from submit_routine), false)
      then 'PASS' else 'FAIL' end
)
select check_name, expected, actual, result
from checks
order by check_name;
