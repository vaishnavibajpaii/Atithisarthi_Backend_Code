-- Read-only verification for Task 4 security-change invalidation hooks.

begin transaction read only;

with checks as (
  select 'transaction_read_only'::text as check_name,
    'on'::text as expected,
    current_setting('transaction_read_only')::text as actual

  union all
  select 'invalidation_function_safe', '1', count(*)::text
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles r on r.oid = p.proowner
  where n.nspname = 'public'
    and p.proname = 'task4_invalidate_principal_sessions_on_change'
    and p.prosecdef
    and r.rolname = 'app_auth_rpc_owner'
    and not r.rolbypassrls
    and coalesce(p.proconfig, array[]::text[])
      @> array['search_path=pg_catalog, public']::text[]

  union all
  select 'invalidation_triggers_enabled', '2', count(*)::text
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('admin_users', 'hotel_staff_access')
    and t.tgname in (
      'task4_admin_security_change_revoke_sessions',
      'task4_staff_security_change_revoke_sessions'
    )
    and not t.tgisinternal
    and t.tgenabled = 'O'

  union all
  select 'invalidation_function_execute_leaks', '0', count(*)::text
  from (values ('public'),('anon'),('authenticated'),('service_role'),
    ('app_tenant_runtime'),('app_tenant_rpc_owner')) as roles(role_name)
  where has_function_privilege(
    roles.role_name,
    'public.task4_invalidate_principal_sessions_on_change()'::regprocedure,
    'EXECUTE'
  )

  union all
  select 'auth_rpc_owner_effective_memberships', '0', count(*)::text
  from pg_auth_members m
  where m.roleid = (
    select oid from pg_roles where rolname = 'app_auth_rpc_owner'
  )
    and (m.inherit_option or m.set_option)

  union all
  select 'auth_rpc_owner_trigger_grants', '0', count(*)::text
  from (values ('public.admin_users'), ('public.hotel_staff_access')) as target(relation_name)
  where has_table_privilege(
    'app_auth_rpc_owner',
    target.relation_name,
    'TRIGGER'
  )

  union all
  select 'task4_session_tables_force_rls', '3', count(*)::text
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in (
      'auth_sessions', 'auth_refresh_token_history', 'auth_security_events'
    )
    and c.relrowsecurity and c.relforcerowsecurity

  union all
  select 'task3_runtime_policy_count_preserved', '199', count(*)::text
  from pg_policies
  where schemaname = 'public'
    and 'app_tenant_runtime' = any(roles)
)
select check_name, expected, actual,
  case when expected = actual then 'PASS' else 'FAIL' end as result
from checks
order by check_name;

rollback;
