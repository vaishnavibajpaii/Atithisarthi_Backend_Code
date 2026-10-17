-- TASK6-C read-only verification.
-- Run only after task6-c-order-atomic-idempotency.sql commits.

begin transaction read only;
set local search_path = pg_catalog, public;

with routine as (
  select p.*
  from pg_proc p
  where p.oid = to_regprocedure(
    'public.task6_create_order_atomic(text,text,text,jsonb)'
  )
),
checks(check_name, expected, actual, result) as (
  select 'routine_present', '1', count(*)::text,
    case when count(*) = 1 then 'PASS' else 'FAIL' end
  from routine

  union all

  select 'routine_security_invoker', 'true',
    coalesce((select (not prosecdef)::text from routine), 'false'),
    case when exists (select 1 from routine where not prosecdef) then 'PASS' else 'FAIL' end

  union all

  select 'routine_search_path_pinned', 'true',
    exists (
      select 1 from routine
      where 'search_path=pg_catalog, public' = any(coalesce(proconfig, array[]::text[]))
    )::text,
    case when exists (
      select 1 from routine
      where 'search_path=pg_catalog, public' = any(coalesce(proconfig, array[]::text[]))
    ) then 'PASS' else 'FAIL' end

  union all

  select 'routine_owner_safe', 'app_tenant_rpc_owner',
    coalesce((
      select owner_role.rolname
      from routine
      join pg_roles owner_role on owner_role.oid = routine.proowner
    ), '<missing>'),
    case when exists (
      select 1
      from routine
      join pg_roles owner_role on owner_role.oid = routine.proowner
      where owner_role.rolname = 'app_tenant_rpc_owner'
        and not owner_role.rolcanlogin
        and not owner_role.rolsuper
        and not owner_role.rolbypassrls
    ) then 'PASS' else 'FAIL' end

  union all

  select 'tenant_runtime_execute', 'true',
    has_function_privilege(
      'app_tenant_runtime',
      'public.task6_create_order_atomic(text,text,text,jsonb)',
      'EXECUTE'
    )::text,
    case when has_function_privilege(
      'app_tenant_runtime',
      'public.task6_create_order_atomic(text,text,text,jsonb)',
      'EXECUTE'
    ) then 'PASS' else 'FAIL' end

  union all

  select 'service_role_execute', 'true',
    has_function_privilege(
      'service_role',
      'public.task6_create_order_atomic(text,text,text,jsonb)',
      'EXECUTE'
    )::text,
    case when has_function_privilege(
      'service_role',
      'public.task6_create_order_atomic(text,text,text,jsonb)',
      'EXECUTE'
    ) then 'PASS' else 'FAIL' end

  union all

  select 'untrusted_execute_grants', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from routine
  cross join lateral aclexplode(coalesce(routine.proacl, acldefault('f', routine.proowner))) routine_acl
  where routine_acl.privilege_type = 'EXECUTE'
    and routine_acl.grantee in (
      0,
      (select oid from pg_roles where rolname = 'anon'),
      (select oid from pg_roles where rolname = 'authenticated')
    )

  union all

  select 'routine_has_idempotency_lock', 'true',
    coalesce((select pg_get_functiondef(oid) ilike '%task6-order-create:%' from routine), false)::text,
    case when coalesce((select pg_get_functiondef(oid) ilike '%task6-order-create:%' from routine), false)
      then 'PASS' else 'FAIL' end

  union all

  select 'routine_checks_digest_conflict', 'true',
    coalesce((select pg_get_functiondef(oid) ilike '%TASK6_ORDER_IDEMPOTENCY_CONFLICT%' from routine), false)::text,
    case when coalesce((select pg_get_functiondef(oid) ilike '%TASK6_ORDER_IDEMPOTENCY_CONFLICT%' from routine), false)
      then 'PASS' else 'FAIL' end

  union all

  select 'routine_checks_exact_snapshot', 'true',
    coalesce((select pg_get_functiondef(oid) ilike '%task6_order_snapshot_valid%' from routine), false)::text,
    case when coalesce((select pg_get_functiondef(oid) ilike '%task6_order_snapshot_valid%' from routine), false)
      then 'PASS' else 'FAIL' end

  union all

  select 'routine_locks_addon_parent', 'true',
    coalesce((select pg_get_functiondef(oid) ~* 'from public[.]orders[[:space:][:print:]]*for update' from routine), false)::text,
    case when coalesce((select pg_get_functiondef(oid) ~* 'from public[.]orders[[:space:][:print:]]*for update' from routine), false)
      then 'PASS' else 'FAIL' end

  union all

  select 'routine_locks_room_booking_for_update', 'true',
    coalesce((select pg_get_functiondef(oid) ~* 'from public[.]room_bookings[[:space:][:print:]]*for update' from routine), false)::text,
    case when coalesce((select pg_get_functiondef(oid) ~* 'from public[.]room_bookings[[:space:][:print:]]*for update' from routine), false)
      then 'PASS' else 'FAIL' end

  union all

  select 'routine_locks_table_scope', 'true',
    coalesce((select pg_get_functiondef(oid) ilike '%get_staff_active_table_order%' from routine), false)::text,
    case when coalesce((select pg_get_functiondef(oid) ilike '%get_staff_active_table_order%' from routine), false)
      then 'PASS' else 'FAIL' end

  union all

  select 'routine_derives_canonical_owner', 'true',
    coalesce((select pg_get_functiondef(oid) ilike '%v_hotel.tenant_id, v_hotel.id%' from routine), false)::text,
    case when coalesce((select pg_get_functiondef(oid) ilike '%v_hotel.tenant_id, v_hotel.id%' from routine), false)
      then 'PASS' else 'FAIL' end

  union all

  select 'required_force_rls_missing', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from (values
    ('hotels'), ('hotel_ordering_settings'), ('orders'),
    ('restaurant_tables'), ('room_bookings'), ('rooms')
  ) expected(name)
  left join pg_class relation
    on relation.relnamespace = 'public'::regnamespace
   and relation.relname = expected.name
   and relation.relkind in ('r', 'p')
  where relation.oid is null
     or not relation.relrowsecurity
     or not relation.relforcerowsecurity

  union all

  select 'creation_index_valid', 'true',
    coalesce((
      select (index_state.indisvalid and index_state.indisready and index_state.indisunique)::text
      from pg_class index_relation
      join pg_index index_state on index_state.indexrelid = index_relation.oid
      where index_relation.relnamespace = 'public'::regnamespace
        and index_relation.relname = 'task6_orders_creation_idempotency_uq'
    ), 'false'),
    case when exists (
      select 1
      from pg_class index_relation
      join pg_index index_state on index_state.indexrelid = index_relation.oid
      where index_relation.relnamespace = 'public'::regnamespace
        and index_relation.relname = 'task6_orders_creation_idempotency_uq'
        and index_state.indisvalid and index_state.indisready and index_state.indisunique
    ) then 'PASS' else 'FAIL' end

  union all

  select 'historical_rows_versioned_by_migration', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.orders
  where financial_snapshot_version is not null

  union all

  select 'legacy_invalid_order_snapshots_preserved', 'informational', count(*)::text, 'INFO'
  from public.orders
  where not public.task6_order_snapshot_valid(items, totals)

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
)
select check_name, expected, actual, result
from checks
order by check_name;

rollback;
