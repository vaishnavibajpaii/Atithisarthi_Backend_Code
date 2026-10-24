-- TASK6-E-B2 read-only post-migration verification. No writes and no PII.

begin transaction read only;
set local search_path = pg_catalog, public;

with target_function as (
  select routine.oid, routine.prosecdef, routine.proconfig,
         owner_role.rolname as owner_name,
         owner_role.rolcanlogin, owner_role.rolsuper, owner_role.rolcreatedb,
         owner_role.rolcreaterole, owner_role.rolinherit, owner_role.rolreplication,
         owner_role.rolbypassrls,
         pg_catalog.pg_get_functiondef(routine.oid) as definition
  from pg_catalog.pg_proc routine
  join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
  join pg_catalog.pg_roles owner_role on owner_role.oid = routine.proowner
  where namespace.nspname = 'public'
    and routine.proname = 'task6_guard_finalized_order_operational_state'
    and pg_catalog.pg_get_function_identity_arguments(routine.oid) = ''
), checks(check_name, expected, actual, result) as (
  select 'orders_force_rls_preserved', 'true',
    exists (select 1 from pg_catalog.pg_class where oid = 'public.orders'::regclass and relrowsecurity and relforcerowsecurity)::text,
    case when exists (select 1 from pg_catalog.pg_class where oid = 'public.orders'::regclass and relrowsecurity and relforcerowsecurity) then 'PASS' else 'FAIL' end

  union all

  select 'prerequisite_guard_present', 'true',
    (to_regprocedure('public.task6_guard_order_state_and_finality()') is not null)::text,
    case when to_regprocedure('public.task6_guard_order_state_and_finality()') is not null then 'PASS' else 'FAIL' end

  union all

  select 'final_operational_guard_present_once', '1', count(*)::text,
    case when count(*) = 1 then 'PASS' else 'FAIL' end
  from target_function

  union all

  select 'final_operational_guard_security_invoker', 'true', coalesce(bool_and(not prosecdef), false)::text,
    case when coalesce(bool_and(not prosecdef), false) then 'PASS' else 'FAIL' end
  from target_function

  union all

  select 'final_operational_guard_owner_safe', 'app_tenant_rpc_owner',
    coalesce((select owner_name from target_function limit 1), '<missing>'),
    case when exists (
      select 1 from target_function
      where owner_name = 'app_tenant_rpc_owner'
        and not rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole
        and not rolinherit and not rolreplication and not rolbypassrls
    ) then 'PASS' else 'FAIL' end

  union all

  select 'final_operational_guard_search_path_pinned', 'true', coalesce((
    select exists (select 1 from target_function, pg_catalog.unnest(proconfig) setting where setting = 'search_path=pg_catalog, public')
  ), false)::text,
  case when coalesce((
    select exists (select 1 from target_function, pg_catalog.unnest(proconfig) setting where setting = 'search_path=pg_catalog, public')
  ), false) then 'PASS' else 'FAIL' end

  union all

  select 'final_operational_guard_trigger_enabled', 'true', exists (
    select 1 from pg_catalog.pg_trigger trigger
    where trigger.tgrelid = 'public.orders'::regclass
      and trigger.tgname = 'orders_11_task6_finalized_operational_guard'
      and trigger.tgfoid = to_regprocedure('public.task6_guard_finalized_order_operational_state()')
      and not trigger.tgisinternal and trigger.tgenabled <> 'D'
  )::text,
  case when exists (
    select 1 from pg_catalog.pg_trigger trigger
    where trigger.tgrelid = 'public.orders'::regclass
      and trigger.tgname = 'orders_11_task6_finalized_operational_guard'
      and trigger.tgfoid = to_regprocedure('public.task6_guard_finalized_order_operational_state()')
      and not trigger.tgisinternal and trigger.tgenabled <> 'D'
  ) then 'PASS' else 'FAIL' end

  union all

  select 'final_operational_guard_blocks_terminal_mutation', 'true',
    coalesce((select position('TASK6_ORDER_FINAL_OPERATIONAL_STATE_IMMUTABLE' in definition) > 0 from target_function), false)::text,
    case when coalesce((select position('TASK6_ORDER_FINAL_OPERATIONAL_STATE_IMMUTABLE' in definition) > 0 from target_function), false) then 'PASS' else 'FAIL' end

  union all

  select 'runtime_execute', 'true',
    coalesce((select has_function_privilege('app_tenant_runtime', oid, 'EXECUTE') from target_function), false)::text,
    case when coalesce((select has_function_privilege('app_tenant_runtime', oid, 'EXECUTE') from target_function), false) then 'PASS' else 'FAIL' end

  union all

  select 'service_role_execute', 'true',
    coalesce((select has_function_privilege('service_role', oid, 'EXECUTE') from target_function), false)::text,
    case when coalesce((select has_function_privilege('service_role', oid, 'EXECUTE') from target_function), false) then 'PASS' else 'FAIL' end

  union all

  select 'untrusted_execute_grants', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from target_function, (values ('public'), ('anon'), ('authenticated')) untrusted(role_name)
  where has_function_privilege(untrusted.role_name, target_function.oid, 'EXECUTE')

  union all

  select 'legacy_paid_terminal_orders_preserved', 'informational', count(*)::text, 'INFO'
  from public.orders
  where lower(coalesce(payment_status, '')) = 'paid'
    and lower(coalesce(status, '')) in ('cancelled', 'payment_failed')
)
select check_name, expected, actual, result
from checks
order by check_name;

commit;
