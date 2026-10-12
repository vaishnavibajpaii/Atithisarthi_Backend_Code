-- Task 4 session-security read-only verification.
-- Run manually in Supabase SQL Editor only after
-- backend/scripts/task4-session-security.sql succeeds.

begin;
set transaction read only;
set local statement_timeout = '5min';
set local search_path = pg_catalog, public;

with
expected_tables(relation_name) as (
  values
    ('auth_sessions'::text),
    ('auth_refresh_token_history'::text),
    ('auth_security_events'::text)
),
expected_exposed_routines(signature) as (
  values
    ('public.task4_get_admin_login_principal(text)'::text),
    ('public.task4_get_staff_login_candidates(text)'::text),
    ('public.task4_record_auth_security_event(text,text,text,bigint,uuid,uuid,bigint,text,jsonb)'::text),
    ('public.task4_create_auth_session(uuid,text,bigint,uuid,bytea,timestamptz,timestamptz,bytea,text)'::text),
    ('public.task4_validate_auth_session(uuid,text,bigint)'::text),
    ('public.task4_rotate_auth_refresh(uuid,text,bigint,bytea,bytea,timestamptz,text)'::text),
    ('public.task4_revoke_auth_session(uuid,text,bigint,text,text)'::text),
    ('public.task4_revoke_principal_sessions(text,bigint,text,text)'::text)
),
resolved_exposed_routines as (
  select
    expected.signature,
    to_regprocedure(expected.signature) as routine_oid
  from expected_exposed_routines expected
),
task4_routines as (
  select
    p.oid,
    p.oid::regprocedure::text as signature,
    p.proname,
    p.prosecdef,
    p.proconfig,
    owner_role.rolname as owner_name,
    owner_role.rolbypassrls as owner_bypassrls
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles owner_role on owner_role.oid = p.proowner
  where n.nspname = 'public'
    and p.proname in (
      'task4_resolve_auth_principal',
      'task4_get_admin_login_principal',
      'task4_get_staff_login_candidates',
      'task4_record_auth_security_event',
      'task4_create_auth_session',
      'task4_validate_auth_session',
      'task4_rotate_auth_refresh',
      'task4_revoke_auth_session',
      'task4_revoke_principal_sessions'
    )
),
checks as (
  select
    'transaction_read_only'::text as check_name,
    'on'::text as expected,
    current_setting('transaction_read_only')::text as actual

  union all
  select
    'auth_rpc_owner_exists',
    '1',
    count(*)::text
  from pg_roles
  where rolname = 'app_auth_rpc_owner'

  union all
  select
    'auth_rpc_owner_attributes_safe',
    'true',
    coalesce((
      select (
        not rolcanlogin
        and not rolsuper
        and not rolcreatedb
        and not rolcreaterole
        and not rolinherit
        and not rolreplication
        and not rolbypassrls
      )::text
      from pg_roles
      where rolname = 'app_auth_rpc_owner'
    ), 'false')

  union all
  select
    'auth_rpc_owner_effective_memberships',
    '0',
    count(*)::text
  from pg_auth_members m
  where m.roleid = (
    select oid from pg_roles where rolname = 'app_auth_rpc_owner'
  )
    and (m.inherit_option or m.set_option)

  union all
  select
    'auth_rpc_owner_schema_create',
    'false',
    coalesce((
      select has_schema_privilege(oid, 'public', 'CREATE')::text
      from pg_roles
      where rolname = 'app_auth_rpc_owner'
    ), 'true')

  union all
  select
    'session_tables_exist',
    '3',
    count(*)::text
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join expected_tables expected on expected.relation_name = c.relname
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')

  union all
  select
    'session_tables_force_rls',
    '3',
    count(*)::text
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join expected_tables expected on expected.relation_name = c.relname
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
    and c.relrowsecurity
    and c.relforcerowsecurity

  union all
  select
    'session_table_rows_before_rollout',
    '0',
    (
      (select count(*) from public.auth_sessions)
      + (select count(*) from public.auth_refresh_token_history)
      + (select count(*) from public.auth_security_events)
    )::text

  union all
  select
    'raw_credential_columns',
    '0',
    count(*)::text
  from information_schema.columns c
  join expected_tables expected on expected.relation_name = c.table_name
  where c.table_schema = 'public'
    and (
      c.column_name in (
        'access_token',
        'refresh_token',
        'raw_token',
        'raw_refresh_token',
        'password',
        'pin',
        'authorization'
      )
      or (
        c.column_name like '%token%'
        and c.column_name not like '%token_hash%'
      )
    )

  union all
  select
    'refresh_hash_columns_bytea',
    '2',
    count(*)::text
  from information_schema.columns
  where table_schema = 'public'
    and (
      (table_name = 'auth_sessions'
        and column_name = 'refresh_token_hash'
        and udt_name = 'bytea')
      or
      (table_name = 'auth_refresh_token_history'
        and column_name = 'token_hash'
        and udt_name = 'bytea')
    )

  union all
  select
    'session_security_snapshot_columns',
    '2',
    count(*)::text
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'auth_sessions'
    and column_name in ('role_snapshot', 'kds_role_snapshot')

  union all
  select
    'session_foreign_keys',
    '4',
    count(*)::text
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in (
      'auth_sessions',
      'auth_refresh_token_history'
    )
    and con.contype = 'f'
    and con.convalidated

  union all
  select
    'task4_policies',
    '11',
    count(*)::text
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and p.polname like 'task4_auth_%'

  union all
  select
    'task4_policy_role_leaks',
    '0',
    count(*)::text
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and p.polname like 'task4_auth_%'
    and p.polroles <> array[
      (select oid from pg_roles where rolname = 'app_auth_rpc_owner')
    ]::oid[]

  union all
  select
    'forbidden_direct_session_table_grants',
    '0',
    count(*)::text
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in (
      'auth_sessions',
      'auth_refresh_token_history',
      'auth_security_events'
    )
    and grantee in (
      'PUBLIC',
      'anon',
      'authenticated',
      'service_role',
      'app_tenant_runtime',
      'app_tenant_rpc_owner'
    )

  union all
  select
    'forbidden_direct_session_column_grants',
    '0',
    count(*)::text
  from information_schema.column_privileges
  where table_schema = 'public'
    and table_name in (
      'auth_sessions',
      'auth_refresh_token_history',
      'auth_security_events'
    )
    and grantee in (
      'PUBLIC',
      'anon',
      'authenticated',
      'service_role',
      'app_tenant_runtime',
      'app_tenant_rpc_owner'
    )

  union all
  select
    'auth_owner_session_table_grants',
    '7',
    count(*)::text
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in (
      'auth_sessions',
      'auth_refresh_token_history',
      'auth_security_events'
    )
    and grantee = 'app_auth_rpc_owner'

  union all
  select
    'exposed_auth_routines_exist',
    '8',
    count(routine_oid)::text
  from resolved_exposed_routines

  union all
  select
    'auth_routine_total',
    '9',
    count(*)::text
  from task4_routines

  union all
  select
    'exposed_auth_routine_definition_unsafe',
    '0',
    count(*)::text
  from resolved_exposed_routines expected
  join task4_routines routine on routine.oid = expected.routine_oid
  where routine.owner_name <> 'app_auth_rpc_owner'
    or routine.owner_bypassrls
    or not routine.prosecdef
    or not (
      coalesce(routine.proconfig, array[]::text[])
      @> array['search_path=pg_catalog, public']::text[]
    )

  union all
  select
    'internal_principal_resolver_safe',
    '1',
    count(*)::text
  from task4_routines
  where proname = 'task4_resolve_auth_principal'
    and owner_name = 'app_auth_rpc_owner'
    and not owner_bypassrls
    and not prosecdef
    and (
      coalesce(proconfig, array[]::text[])
      @> array['search_path=pg_catalog, public']::text[]
    )
    and not has_function_privilege(
      'app_tenant_runtime',
      oid,
      'EXECUTE'
    )

  union all
  select
    'runtime_execute_missing',
    '0',
    count(*)::text
  from resolved_exposed_routines
  where routine_oid is null
    or not has_function_privilege(
      'app_tenant_runtime',
      routine_oid,
      'EXECUTE'
    )

  union all
  select
    'forbidden_execute_grants',
    '0',
    count(*)::text
  from resolved_exposed_routines expected
  join pg_proc p on p.oid = expected.routine_oid
  cross join lateral aclexplode(
    coalesce(p.proacl, acldefault('f', p.proowner))
  ) acl
  left join pg_roles granted_role on granted_role.oid = acl.grantee
  where acl.privilege_type = 'EXECUTE'
    and (
      acl.grantee = 0
      or granted_role.rolname in (
        'anon',
        'authenticated',
        'service_role',
        'app_tenant_rpc_owner'
      )
    )

  union all
  select
    'task3_runtime_role_still_safe',
    'true',
    coalesce((
      select (
        rolcanlogin
        and not rolsuper
        and not rolcreatedb
        and not rolcreaterole
        and not rolreplication
        and not rolbypassrls
      )::text
      from pg_roles
      where rolname = 'app_tenant_runtime'
    ), 'false')

  union all
  select
    'task3_runtime_policy_count_preserved',
    '199',
    count(*)::text
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and (
      select oid from pg_roles where rolname = 'app_tenant_runtime'
    ) = any(p.polroles)

  union all
  select
    'task3_core_force_rls_preserved',
    '2',
    count(*)::text
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('hotel_staff_access', 'hotels')
    and c.relkind in ('r', 'p')
    and c.relrowsecurity
    and c.relforcerowsecurity
)
select
  check_name,
  expected,
  actual,
  case when actual = expected then 'PASS' else 'FAIL' end as result
from checks
order by check_name;

rollback;
