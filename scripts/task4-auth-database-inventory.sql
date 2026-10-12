-- Task 4 authentication/session database inventory
-- READ ONLY. This script creates, alters, or deletes nothing.
-- It deliberately returns no password hashes, tokens, email addresses, phone
-- numbers, names, IP addresses, user agents, or other row-level PII.

begin;
set transaction read only;

select
  'task4_auth_inventory'::text as inventory,
  current_database()::text as database_name,
  current_user::text as executed_as,
  statement_timestamp() as observed_at,
  current_setting('server_version')::text as postgres_version;

-- 1. Relevant identity, role, permission, session, token, and credential
-- relations. n_live_tup is a safe planner/statistics estimate, not an exact
-- row count.
select
  n.nspname as schema_name,
  c.relname as relation_name,
  case c.relkind
    when 'r' then 'table'
    when 'p' then 'partitioned table'
    when 'v' then 'view'
    when 'm' then 'materialized view'
    else c.relkind::text
  end as relation_kind,
  pg_get_userbyid(c.relowner) as owner_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as force_rls,
  coalesce(s.n_live_tup, 0)::bigint as estimated_live_rows
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_stat_user_tables s
  on s.relid = c.oid
where c.relkind in ('r', 'p', 'v', 'm')
  and n.nspname in ('public', 'auth')
  and (
    c.relname ~* '(admin|staff|user|auth|session|token|credential|role|permission|principal)'
    or c.relname in ('hotels', 'tenants')
  )
order by n.nspname, c.relname;

-- 2. Column metadata only. Defaults for credential/token/secret-like columns
-- are suppressed defensively.
select
  cols.table_schema,
  cols.table_name,
  cols.ordinal_position,
  cols.column_name,
  cols.data_type,
  cols.udt_name,
  cols.is_nullable,
  case
    when cols.column_name ~* '(password|pin|token|secret|credential|email|phone)'
      then '[suppressed]'
    else coalesce(cols.column_default, '')
  end as safe_column_default,
  case
    when cols.column_name ~* '(password|pin).*hash' then 'credential_hash'
    when cols.column_name ~* '(refresh|access).*token' then 'token_material'
    when cols.column_name in ('tenant_id', 'property_id', 'hotel_id', 'hotel_slug') then 'ownership'
    when cols.column_name in ('role', 'kds_role', 'permission', 'permissions') then 'authorization'
    when cols.column_name in ('is_active', 'disabled_at', 'banned_until', 'deleted_at') then 'account_state'
    when cols.column_name ~* '(created|updated|last_login|last_seen|expires|revoked|rotated).*'
      then 'lifecycle'
    else 'other'
  end as security_category
from information_schema.columns cols
where cols.table_schema in ('public', 'auth')
  and (
    cols.table_name ~* '(admin|staff|user|auth|session|token|credential|role|permission|principal)'
    or cols.table_name in ('hotels', 'tenants')
  )
order by cols.table_schema, cols.table_name, cols.ordinal_position;

-- 3. Exact safe counts for the two custom application principal tables.
-- Credential values and identifiers are never selected.
select
  'public.admin_users'::text as relation_name,
  count(*)::bigint as total_rows,
  count(*) filter (where is_active is true)::bigint as active_rows,
  count(*) filter (where is_active is not true)::bigint as inactive_rows,
  count(*) filter (
    where password_hash is not null and length(password_hash) > 0
  )::bigint as rows_with_credential_hash
from public.admin_users;

select
  'public.hotel_staff_access'::text as relation_name,
  count(*)::bigint as total_rows,
  count(*) filter (where is_active is true)::bigint as active_rows,
  count(*) filter (where is_active is not true)::bigint as inactive_rows,
  count(*) filter (
    where pin_hash is not null and length(pin_hash) > 0
  )::bigint as rows_with_credential_hash,
  count(*) filter (
    where tenant_id is not null and property_id is not null
  )::bigint as rows_with_canonical_ownership,
  count(*) filter (
    where tenant_id is null or property_id is null
  )::bigint as rows_missing_canonical_ownership
from public.hotel_staff_access;

-- 4. Actual application role distribution. These are aggregate counts only.
select
  coalesce(role, '[null]')::text as account_role,
  coalesce(kds_role, '[null]')::text as kds_role,
  is_active,
  count(*)::bigint as principal_count
from public.hotel_staff_access
group by role, kds_role, is_active
order by account_role, kds_role, is_active desc;

-- 5. Safe Supabase Auth infrastructure counts. These do not expose identities,
-- tokens, emails, phone numbers, IP data, or user-agent data. They establish
-- whether Supabase Auth sessions coexist with the custom application auth.
select 'auth.users'::text as relation_name, count(*)::bigint as exact_row_count
from auth.users
union all
select 'auth.identities'::text, count(*)::bigint from auth.identities
union all
select 'auth.sessions'::text, count(*)::bigint from auth.sessions
union all
select 'auth.refresh_tokens'::text, count(*)::bigint from auth.refresh_tokens
order by relation_name;

-- 6. Primary keys, foreign keys, unique/check constraints, and ownership links.
select
  n.nspname as schema_name,
  c.relname as relation_name,
  con.conname as constraint_name,
  case con.contype
    when 'p' then 'PRIMARY KEY'
    when 'f' then 'FOREIGN KEY'
    when 'u' then 'UNIQUE'
    when 'c' then 'CHECK'
    when 'x' then 'EXCLUSION'
    else con.contype::text
  end as constraint_type,
  pg_get_constraintdef(con.oid, true) as constraint_definition,
  con.condeferrable as is_deferrable,
  con.condeferred as initially_deferred,
  con.convalidated as is_validated
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'auth')
  and (
    c.relname ~* '(admin|staff|user|auth|session|token|credential|role|permission|principal)'
    or c.relname in ('hotels', 'tenants')
  )
order by n.nspname, c.relname, constraint_type, con.conname;

-- 7. Indexes supporting identity lookup, active-account checks, ownership,
-- sessions, expiry, revocation, and refresh rotation.
select
  schemaname as schema_name,
  tablename as relation_name,
  indexname as index_name,
  indexdef as index_definition
from pg_indexes
where schemaname in ('public', 'auth')
  and (
    tablename ~* '(admin|staff|user|auth|session|token|credential|role|permission|principal)'
    or tablename in ('hotels', 'tenants')
  )
order by schemaname, tablename, indexname;

-- 8. Focused column/constraint check for the canonical staff ownership edge.
select
  cols.column_name,
  cols.data_type,
  cols.is_nullable
from information_schema.columns cols
where cols.table_schema = 'public'
  and cols.table_name = 'hotel_staff_access'
  and cols.column_name in (
    'id', 'tenant_id', 'property_id', 'hotel_slug', 'role', 'kds_role',
    'is_active', 'pin_hash', 'last_login_at', 'created_at', 'updated_at'
  )
order by cols.ordinal_position;

-- 9. RLS state and policy metadata.
select
  n.nspname as schema_name,
  c.relname as relation_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as force_rls,
  pg_get_userbyid(c.relowner) as owner_name
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p')
  and n.nspname in ('public', 'auth')
  and (
    c.relname ~* '(admin|staff|user|auth|session|token|credential|role|permission|principal)'
    or c.relname in ('hotels', 'tenants')
  )
order by n.nspname, c.relname;

select
  schemaname as schema_name,
  tablename as relation_name,
  policyname as policy_name,
  permissive,
  roles,
  cmd,
  qual as using_expression,
  with_check as with_check_expression
from pg_policies
where schemaname in ('public', 'auth')
  and (
    tablename ~* '(admin|staff|user|auth|session|token|credential|role|permission|principal)'
    or tablename in ('hotels', 'tenants')
  )
order by schemaname, tablename, policyname;

-- 10. Table/column grants. This reveals privileges, not table data.
select
  grantor,
  grantee,
  table_schema,
  table_name,
  privilege_type,
  is_grantable
from information_schema.table_privileges
where table_schema in ('public', 'auth')
  and (
    table_name ~* '(admin|staff|user|auth|session|token|credential|role|permission|principal)'
    or table_name in ('hotels', 'tenants')
  )
order by table_schema, table_name, grantee, privilege_type;

select
  grantor,
  grantee,
  table_schema,
  table_name,
  column_name,
  privilege_type,
  is_grantable
from information_schema.column_privileges
where table_schema in ('public', 'auth')
  and (
    table_name ~* '(admin|staff|user|auth|session|token|credential|role|permission|principal)'
    or table_name in ('hotels', 'tenants')
  )
order by table_schema, table_name, column_name, grantee, privilege_type;

-- 11. Authentication/session/authorization-related routines. Function bodies
-- are intentionally not returned.
select
  n.nspname as routine_schema,
  p.proname as routine_name,
  pg_get_function_identity_arguments(p.oid) as identity_arguments,
  pg_get_function_result(p.oid) as result_type,
  l.lanname as language_name,
  p.prosecdef as security_definer,
  p.provolatile as volatility,
  pg_get_userbyid(p.proowner) as owner_name,
  p.proacl as explicit_acl
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_language l on l.oid = p.prolang
where n.nspname in ('public', 'auth')
  and (
    p.proname ~* '(admin|staff|user|auth|session|token|credential|role|permission|principal|tenant_context)'
    or pg_get_function_identity_arguments(p.oid)
      ~* '(admin|staff|user|session|token|tenant|property)'
  )
order by n.nspname, p.proname, identity_arguments;

select
  grantor,
  grantee,
  routine_schema,
  routine_name,
  privilege_type,
  is_grantable
from information_schema.routine_privileges
where routine_schema in ('public', 'auth')
  and routine_name ~* '(admin|staff|user|auth|session|token|credential|role|permission|principal|tenant_context)'
order by routine_schema, routine_name, grantee, privilege_type;

-- 12. Triggers on relevant relations. Only trigger/function metadata is shown.
select
  table_ns.nspname as table_schema,
  table_cls.relname as relation_name,
  t.tgname as trigger_name,
  t.tgenabled as enabled_mode,
  fn_ns.nspname as function_schema,
  fn.proname as function_name,
  case
    when (t.tgtype & 2) <> 0 then 'BEFORE'
    when (t.tgtype & 64) <> 0 then 'INSTEAD OF'
    else 'AFTER'
  end as timing,
  concat_ws(',',
    case when (t.tgtype & 4) <> 0 then 'INSERT' end,
    case when (t.tgtype & 8) <> 0 then 'DELETE' end,
    case when (t.tgtype & 16) <> 0 then 'UPDATE' end,
    case when (t.tgtype & 32) <> 0 then 'TRUNCATE' end
  ) as events
from pg_trigger t
join pg_class table_cls on table_cls.oid = t.tgrelid
join pg_namespace table_ns on table_ns.oid = table_cls.relnamespace
join pg_proc fn on fn.oid = t.tgfoid
join pg_namespace fn_ns on fn_ns.oid = fn.pronamespace
where not t.tgisinternal
  and table_ns.nspname in ('public', 'auth')
  and (
    table_cls.relname ~* '(admin|staff|user|auth|session|token|credential|role|permission|principal)'
    or table_cls.relname in ('hotels', 'tenants')
  )
order by table_ns.nspname, table_cls.relname, t.tgname;

-- 13. Presence check for a custom application session/RBAC model. Zero rows is
-- an expected and meaningful result if none exists yet.
select
  n.nspname as schema_name,
  c.relname as relation_name,
  c.relkind::text as relation_kind
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p', 'v', 'm')
  and c.relname ~* '(session|refresh|token_family|role|permission|principal)'
order by c.relname;

-- 14. Consolidated result grid for SQL clients that display only the final
-- SELECT. Each row is one named evidence section with a JSON payload.
with consolidated_relevant_relations as (
  select
    c.oid as relation_oid,
    n.nspname as schema_name,
    c.relname as relation_name,
    c.relkind,
    c.relowner,
    c.relrowsecurity,
    c.relforcerowsecurity
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'v', 'm')
    and n.nspname in ('public', 'auth')
    and (
      (n.nspname = 'public' and (
        c.relname in ('admin_users', 'hotel_staff_access', 'hotels', 'tenants')
        or c.relname ~* '(session|refresh|token_family|role|permission|principal)'
      ))
      or
      (n.nspname = 'auth' and
        c.relname in ('users', 'identities', 'sessions', 'refresh_tokens'))
    )
)
select
  '00_inventory_context'::text as section,
  jsonb_build_object(
    'database_name', current_database(),
    'executed_as', current_user,
    'observed_at', statement_timestamp(),
    'postgres_version', current_setting('server_version'),
    'transaction_read_only', current_setting('transaction_read_only')
  ) as payload
union all
select
  '01_application_principal_counts',
  jsonb_build_object(
    'admin_total', (select count(*) from public.admin_users),
    'admin_active', (select count(*) from public.admin_users where is_active is true),
    'admin_inactive', (select count(*) from public.admin_users where is_active is not true),
    'admin_with_password_hash', (
      select count(*) from public.admin_users
      where password_hash is not null and length(password_hash) > 0
    ),
    'staff_total', (select count(*) from public.hotel_staff_access),
    'staff_active', (select count(*) from public.hotel_staff_access where is_active is true),
    'staff_inactive', (select count(*) from public.hotel_staff_access where is_active is not true),
    'staff_with_pin_hash', (
      select count(*) from public.hotel_staff_access
      where pin_hash is not null and length(pin_hash) > 0
    ),
    'staff_with_canonical_ownership', (
      select count(*) from public.hotel_staff_access
      where tenant_id is not null and property_id is not null
    ),
    'staff_missing_canonical_ownership', (
      select count(*) from public.hotel_staff_access
      where tenant_id is null or property_id is null
    )
  )
union all
select
  '02_staff_role_distribution',
  coalesce((
    select jsonb_agg(to_jsonb(role_counts) order by role_counts.account_role, role_counts.kds_role, role_counts.is_active desc)
    from (
      select
        coalesce(role, '[null]')::text as account_role,
        coalesce(kds_role, '[null]')::text as kds_role,
        is_active,
        count(*)::bigint as principal_count
      from public.hotel_staff_access
      group by role, kds_role, is_active
    ) role_counts
  ), '[]'::jsonb)
union all
select
  '03_supabase_auth_counts',
  jsonb_build_object(
    'users', (select count(*) from auth.users),
    'identities', (select count(*) from auth.identities),
    'sessions', (select count(*) from auth.sessions),
    'refresh_tokens', (select count(*) from auth.refresh_tokens)
  )
union all
select
  '04_relevant_relations',
  coalesce((
    select jsonb_agg(to_jsonb(relation_metadata) order by relation_metadata.schema_name, relation_metadata.relation_name)
    from (
      select
        r.schema_name,
        r.relation_name,
        case r.relkind
          when 'r' then 'table'
          when 'p' then 'partitioned table'
          when 'v' then 'view'
          when 'm' then 'materialized view'
          else r.relkind::text
        end as relation_kind,
        pg_get_userbyid(r.relowner) as owner_name,
        r.relrowsecurity as rls_enabled,
        r.relforcerowsecurity as force_rls,
        coalesce(s.n_live_tup, 0)::bigint as estimated_live_rows
      from consolidated_relevant_relations r
      left join pg_stat_user_tables s on s.relid = r.relation_oid
    ) relation_metadata
  ), '[]'::jsonb)
union all
select
  '05_columns',
  coalesce((
    select jsonb_agg(to_jsonb(column_metadata) order by column_metadata.table_schema, column_metadata.table_name, column_metadata.ordinal_position)
    from (
      select
        cols.table_schema,
        cols.table_name,
        cols.ordinal_position,
        cols.column_name,
        cols.data_type,
        cols.udt_name,
        cols.is_nullable,
        case
          when cols.column_name ~* '(password|pin|token|secret|credential|email|phone)'
            then '[suppressed]'
          else coalesce(cols.column_default, '')
        end as safe_column_default
      from information_schema.columns cols
      join consolidated_relevant_relations r
        on r.schema_name = cols.table_schema
       and r.relation_name = cols.table_name
    ) column_metadata
  ), '[]'::jsonb)
union all
select
  '06_constraints',
  coalesce((
    select jsonb_agg(to_jsonb(constraint_metadata) order by constraint_metadata.schema_name, constraint_metadata.relation_name, constraint_metadata.constraint_name)
    from (
      select
        r.schema_name,
        r.relation_name,
        con.conname as constraint_name,
        case con.contype
          when 'p' then 'PRIMARY KEY'
          when 'f' then 'FOREIGN KEY'
          when 'u' then 'UNIQUE'
          when 'c' then 'CHECK'
          when 'x' then 'EXCLUSION'
          else con.contype::text
        end as constraint_type,
        pg_get_constraintdef(con.oid, true) as constraint_definition,
        con.condeferrable as is_deferrable,
        con.condeferred as initially_deferred,
        con.convalidated as is_validated
      from consolidated_relevant_relations r
      join pg_constraint con on con.conrelid = r.relation_oid
    ) constraint_metadata
  ), '[]'::jsonb)
union all
select
  '07_indexes',
  coalesce((
    select jsonb_agg(to_jsonb(index_metadata) order by index_metadata.schema_name, index_metadata.relation_name, index_metadata.index_name)
    from (
      select
        idx.schemaname as schema_name,
        idx.tablename as relation_name,
        idx.indexname as index_name,
        idx.indexdef as index_definition
      from pg_indexes idx
      join consolidated_relevant_relations r
        on r.schema_name = idx.schemaname
       and r.relation_name = idx.tablename
    ) index_metadata
  ), '[]'::jsonb)
union all
select
  '08_rls_and_policies',
  jsonb_build_object(
    'relation_state',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'schema_name', r.schema_name,
          'relation_name', r.relation_name,
          'rls_enabled', r.relrowsecurity,
          'force_rls', r.relforcerowsecurity,
          'owner_name', pg_get_userbyid(r.relowner)
        )
        order by r.schema_name, r.relation_name
      )
      from consolidated_relevant_relations r
      where r.relkind in ('r', 'p')
    ), '[]'::jsonb),
    'policies',
    coalesce((
      select jsonb_agg(to_jsonb(policy_metadata) order by policy_metadata.schema_name, policy_metadata.relation_name, policy_metadata.policy_name)
      from (
        select
          pol.schemaname as schema_name,
          pol.tablename as relation_name,
          pol.policyname as policy_name,
          pol.permissive,
          pol.roles,
          pol.cmd,
          pol.qual as using_expression,
          pol.with_check as with_check_expression
        from pg_policies pol
        join consolidated_relevant_relations r
          on r.schema_name = pol.schemaname
         and r.relation_name = pol.tablename
      ) policy_metadata
    ), '[]'::jsonb)
  )
union all
select
  '09_grants',
  jsonb_build_object(
    'table_grants',
    coalesce((
      select jsonb_agg(to_jsonb(table_grant) order by table_grant.table_schema, table_grant.table_name, table_grant.grantee, table_grant.privilege_type)
      from (
        select
          grants.grantor,
          grants.grantee,
          grants.table_schema,
          grants.table_name,
          grants.privilege_type,
          grants.is_grantable
        from information_schema.table_privileges grants
        join consolidated_relevant_relations r
          on r.schema_name = grants.table_schema
         and r.relation_name = grants.table_name
      ) table_grant
    ), '[]'::jsonb),
    'column_grants',
    coalesce((
      select jsonb_agg(to_jsonb(column_grant) order by column_grant.table_schema, column_grant.table_name, column_grant.column_name, column_grant.grantee, column_grant.privilege_type)
      from (
        select
          grants.grantor,
          grants.grantee,
          grants.table_schema,
          grants.table_name,
          grants.column_name,
          grants.privilege_type,
          grants.is_grantable
        from information_schema.column_privileges grants
        join consolidated_relevant_relations r
          on r.schema_name = grants.table_schema
         and r.relation_name = grants.table_name
      ) column_grant
    ), '[]'::jsonb)
  )
union all
select
  '10_auth_routines',
  jsonb_build_object(
    'routines',
    coalesce((
      select jsonb_agg(to_jsonb(routine_metadata) order by routine_metadata.routine_schema, routine_metadata.routine_name, routine_metadata.identity_arguments)
      from (
        select
          n.nspname as routine_schema,
          p.proname as routine_name,
          pg_get_function_identity_arguments(p.oid) as identity_arguments,
          pg_get_function_result(p.oid) as result_type,
          l.lanname as language_name,
          p.prosecdef as security_definer,
          p.provolatile as volatility,
          pg_get_userbyid(p.proowner) as owner_name,
          p.proacl as explicit_acl
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join pg_language l on l.oid = p.prolang
        where n.nspname in ('public', 'auth')
          and (
            p.proname ~* '(admin|staff|user|auth|session|token|credential|role|permission|principal|tenant_context)'
            or pg_get_function_identity_arguments(p.oid)
              ~* '(admin|staff|user|session|token|tenant|property)'
          )
      ) routine_metadata
    ), '[]'::jsonb),
    'routine_grants',
    coalesce((
      select jsonb_agg(to_jsonb(routine_grant) order by routine_grant.routine_schema, routine_grant.routine_name, routine_grant.grantee)
      from (
        select
          grants.grantor,
          grants.grantee,
          grants.routine_schema,
          grants.routine_name,
          grants.privilege_type,
          grants.is_grantable
        from information_schema.routine_privileges grants
        where grants.routine_schema in ('public', 'auth')
          and grants.routine_name ~* '(admin|staff|user|auth|session|token|credential|role|permission|principal|tenant_context)'
      ) routine_grant
    ), '[]'::jsonb)
  )
union all
select
  '11_triggers',
  coalesce((
    select jsonb_agg(to_jsonb(trigger_metadata) order by trigger_metadata.table_schema, trigger_metadata.relation_name, trigger_metadata.trigger_name)
    from (
      select
        table_ns.nspname as table_schema,
        table_cls.relname as relation_name,
        t.tgname as trigger_name,
        t.tgenabled as enabled_mode,
        fn_ns.nspname as function_schema,
        fn.proname as function_name,
        case
          when (t.tgtype & 2) <> 0 then 'BEFORE'
          when (t.tgtype & 64) <> 0 then 'INSTEAD OF'
          else 'AFTER'
        end as timing,
        concat_ws(',',
          case when (t.tgtype & 4) <> 0 then 'INSERT' end,
          case when (t.tgtype & 8) <> 0 then 'DELETE' end,
          case when (t.tgtype & 16) <> 0 then 'UPDATE' end,
          case when (t.tgtype & 32) <> 0 then 'TRUNCATE' end
        ) as events
      from pg_trigger t
      join consolidated_relevant_relations r on r.relation_oid = t.tgrelid
      join pg_class table_cls on table_cls.oid = t.tgrelid
      join pg_namespace table_ns on table_ns.oid = table_cls.relnamespace
      join pg_proc fn on fn.oid = t.tgfoid
      join pg_namespace fn_ns on fn_ns.oid = fn.pronamespace
      where not t.tgisinternal
    ) trigger_metadata
  ), '[]'::jsonb)
union all
select
  '12_custom_application_session_rbac_relations',
  coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'schema_name', r.schema_name,
        'relation_name', r.relation_name,
        'relation_kind', r.relkind::text
      )
      order by r.relation_name
    )
    from consolidated_relevant_relations r
    where r.schema_name = 'public'
      and r.relation_name ~* '(session|refresh|token_family|role|permission|principal)'
  ), '[]'::jsonb)
order by section
;

rollback;
