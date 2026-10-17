-- TASK6-B runtime fix verification (READ ONLY).

set statement_timeout = '30s';
set lock_timeout = '5s';
set search_path = pg_catalog, public;

with routine as (
  select p.*, owner.rolname as owner_name, lower(pg_get_functiondef(p.oid)) as definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles owner on owner.oid = p.proowner
  where n.nspname = 'public'
    and p.proname = 'task6_create_room_booking_atomic'
), checks as (
  select 'routine_present'::text check_name, '1'::text expected, count(*)::text actual from routine
  union all select 'routine_owner_safe', 'app_tenant_rpc_owner', min(owner_name) from routine
  union all select 'routine_security_invoker', 'true', min((not prosecdef)::text) from routine
  union all select 'routine_reads_hotels', 'true', min((position('from public.hotels' in definition) > 0)::text) from routine
  union all select 'routine_does_not_lock_hotels', 'true', min((position('for key share' in definition) = 0)::text) from routine
  union all select 'routine_keeps_room_lock', 'true', min((position('from public.rooms' in definition) > 0 and position('for update' in definition) > 0)::text) from routine
  union all select 'routine_keeps_idempotency_lock', 'true', min((position('pg_advisory_xact_lock' in definition) > 0)::text) from routine
  union all select 'routine_keeps_digest_conflict', 'true', min((position('task6_booking_idempotency_conflict' in definition) > 0)::text) from routine
  union all select 'routine_keeps_financial_validation', 'true', min((position('task6_booking_financial_snapshot_invalid' in definition) > 0)::text) from routine
  union all select 'runtime_execute', 'true', min(has_function_privilege('app_tenant_runtime', oid, 'EXECUTE')::text) from routine
  union all select 'service_role_execute', 'true', min(has_function_privilege('service_role', oid, 'EXECUTE')::text) from routine
  union all select 'untrusted_execute_grants', '0', count(*)::text
    from routine r
    cross join lateral aclexplode(coalesce(r.proacl, acldefault('f', r.proowner))) acl
    left join pg_roles grantee on grantee.oid = acl.grantee
    where acl.privilege_type = 'EXECUTE'
      and (acl.grantee = 0 or grantee.rolname in ('anon', 'authenticated'))
  union all select 'runtime_hotels_select', 'true', has_table_privilege('app_tenant_runtime', 'public.hotels', 'SELECT')::text
  union all select 'runtime_hotels_update', 'false', has_table_privilege('app_tenant_runtime', 'public.hotels', 'UPDATE')::text
  union all select 'required_force_rls_missing', '0', count(*)::text
    from (values ('hotels'), ('rooms'), ('room_bookings'), ('room_maintenance')) required(name)
    where not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = required.name
        and c.relrowsecurity and c.relforcerowsecurity
    )
  union all select 'rpc_owner_effective_memberships', '0', count(*)::text
    from pg_auth_members membership
    where membership.roleid = (select oid from pg_roles where rolname = 'app_tenant_rpc_owner')
      and (membership.inherit_option or membership.set_option)
  union all select 'rpc_owner_schema_create', 'false', has_schema_privilege('app_tenant_rpc_owner', 'public', 'CREATE')::text
)
select check_name, expected, actual,
  case when actual = expected then 'PASS' else 'FAIL' end as result
from checks
order by check_name;
