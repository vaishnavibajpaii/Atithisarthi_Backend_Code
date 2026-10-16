-- TASK6-B read-only verification. Run after task6-b-booking-atomic-create.sql.

begin transaction read only;
set local search_path = pg_catalog, public;

with target as (
  select p.oid, p.prosecdef, p.proowner, p.proconfig,
    pg_get_functiondef(p.oid) as definition
  from pg_proc p
  where p.oid = to_regprocedure('public.task6_create_room_booking_atomic(text,jsonb,text)')
), checks(check_name, expected, actual, result) as (
  select 'routine_present', '1', count(*)::text,
    case when count(*) = 1 then 'PASS' else 'FAIL' end from target
  union all
  select 'routine_security_invoker', 'true',
    coalesce((select (not prosecdef)::text from target), 'false'),
    case when (select not prosecdef from target) then 'PASS' else 'FAIL' end
  union all
  select 'routine_owner_safe', 'app_tenant_rpc_owner',
    coalesce((select r.rolname from target t join pg_roles r on r.oid = t.proowner), 'missing'),
    case when (select r.rolname = 'app_tenant_rpc_owner' and not r.rolbypassrls
      from target t join pg_roles r on r.oid = t.proowner) then 'PASS' else 'FAIL' end
  union all
  select 'rpc_owner_effective_memberships', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from pg_auth_members membership
  where membership.roleid = (
    select oid from pg_roles where rolname = 'app_tenant_rpc_owner'
  )
    and (membership.inherit_option or membership.set_option)
  union all
  select 'rpc_owner_schema_create', 'false',
    has_schema_privilege('app_tenant_rpc_owner', 'public', 'CREATE')::text,
    case when not has_schema_privilege('app_tenant_rpc_owner', 'public', 'CREATE')
      then 'PASS' else 'FAIL' end
  union all
  select 'routine_search_path_pinned', 'true',
    coalesce((select (proconfig @> array['search_path=pg_catalog, public'])::text from target), 'false'),
    case when (select proconfig @> array['search_path=pg_catalog, public'] from target)
      then 'PASS' else 'FAIL' end
  union all
  select 'tenant_runtime_execute', 'true',
    has_function_privilege('app_tenant_runtime', 'public.task6_create_room_booking_atomic(text,jsonb,text)', 'EXECUTE')::text,
    case when has_function_privilege('app_tenant_runtime', 'public.task6_create_room_booking_atomic(text,jsonb,text)', 'EXECUTE')
      then 'PASS' else 'FAIL' end
  union all
  select 'service_role_execute', 'true',
    has_function_privilege('service_role', 'public.task6_create_room_booking_atomic(text,jsonb,text)', 'EXECUTE')::text,
    case when has_function_privilege('service_role', 'public.task6_create_room_booking_atomic(text,jsonb,text)', 'EXECUTE')
      then 'PASS' else 'FAIL' end
  union all
  select 'untrusted_execute_grants', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from target t
  cross join lateral aclexplode(coalesce(
    (select proacl from pg_proc where oid = t.oid),
    acldefault('f', t.proowner)
  )) acl
  left join pg_roles grantee on grantee.oid = acl.grantee
  where acl.privilege_type = 'EXECUTE'
    and (acl.grantee = 0 or grantee.rolname in ('anon', 'authenticated'))
  union all
  select 'required_force_rls_missing', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from (values ('hotels'), ('rooms'), ('room_bookings'), ('room_maintenance')) expected(name)
  left join pg_class c on c.relname = expected.name
    and c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
  where c.oid is null or not c.relrowsecurity or not c.relforcerowsecurity
  union all
  select 'overlap_constraint_valid', 'true',
    coalesce((select convalidated::text from pg_constraint
      where conrelid = 'public.room_bookings'::regclass
        and conname = 'room_bookings_no_active_overlap'), 'false'),
    case when exists (select 1 from pg_constraint
      where conrelid = 'public.room_bookings'::regclass
        and conname = 'room_bookings_no_active_overlap' and convalidated)
      then 'PASS' else 'FAIL' end
  union all
  select 'routine_has_idempotency_lock', 'true',
    coalesce((select (definition like '%pg_advisory_xact_lock%')::text from target), 'false'),
    case when (select definition like '%pg_advisory_xact_lock%' from target)
      then 'PASS' else 'FAIL' end
  union all
  select 'routine_has_room_lock', 'true',
    coalesce((select (definition ~* 'from public[.]rooms[[:space:][:print:]]*for update')::text from target), 'false'),
    case when (select definition ~* 'from public[.]rooms[[:space:][:print:]]*for update' from target)
      then 'PASS' else 'FAIL' end
  union all
  select 'routine_checks_digest_conflict', 'true',
    coalesce((select (definition like '%TASK6_BOOKING_IDEMPOTENCY_CONFLICT%')::text from target), 'false'),
    case when (select definition like '%TASK6_BOOKING_IDEMPOTENCY_CONFLICT%' from target)
      then 'PASS' else 'FAIL' end
  union all
  select 'routine_checks_maintenance', 'true',
    coalesce((select (definition like '%TASK6_BOOKING_MAINTENANCE_CONFLICT%')::text from target), 'false'),
    case when (select definition like '%TASK6_BOOKING_MAINTENANCE_CONFLICT%' from target)
      then 'PASS' else 'FAIL' end
  union all
  select 'routine_checks_exact_financial_snapshot', 'true',
    coalesce((select (definition like '%TASK6_BOOKING_FINANCIAL_SNAPSHOT_INVALID%')::text from target), 'false'),
    case when (select definition like '%TASK6_BOOKING_FINANCIAL_SNAPSHOT_INVALID%' from target)
      then 'PASS' else 'FAIL' end
  union all
  select 'historical_rows_with_task6_digest', 'informational', count(*)::text, 'INFO'
  from public.room_bookings where request_fingerprint is not null
)
select check_name, expected, actual, result
from checks
order by check_name;

rollback;
