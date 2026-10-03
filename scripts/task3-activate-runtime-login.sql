-- Task 3 / TASK3-E2: activate the restricted runtime role for PostgreSQL login.
-- Authorized pre-production database only. Run manually in Supabase SQL Editor.
--
-- IMPORTANT:
--   1. Copy this SQL into the editor without saving a real password to Git.
--   2. Replace the placeholder only in the SQL Editor with a password-manager
--      generated secret of at least 40 characters.
--   3. Never return or paste that secret into chat, logs, screenshots, or docs.
--
-- This does not assign another role, change table grants/policies, deploy code,
-- switch Railway traffic, enable FORCE RLS, or modify application data.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '2min';
set local search_path = pg_catalog, public;

do $task3e2_activate$
declare
  requested_password constant text := 'TASK3E_REPLACE_WITH_PASSWORD_MANAGER_SECRET';
  runtime_role pg_roles%rowtype;
begin
  if requested_password = 'TASK3E_REPLACE_WITH_PASSWORD_MANAGER_SECRET'
     or length(requested_password) < 40
     or requested_password ~ '[[:space:]]' then
    raise exception 'TASK3E2_REPLACE_PASSWORD_WITH_40_PLUS_NONSPACE_CHARACTERS';
  end if;

  select * into runtime_role
  from pg_roles
  where rolname = 'app_tenant_runtime';

  if runtime_role.oid is null then
    raise exception 'TASK3E2_RUNTIME_ROLE_MISSING';
  end if;

  if runtime_role.rolsuper
     or runtime_role.rolcreatedb
     or runtime_role.rolcreaterole
     or runtime_role.rolinherit
     or runtime_role.rolreplication
     or runtime_role.rolbypassrls then
    raise exception 'TASK3E2_RUNTIME_ROLE_UNSAFE';
  end if;

  if exists (
    select 1
    from pg_auth_members m
    left join pg_roles member_role on member_role.oid = m.member
    left join pg_roles grantor_role on grantor_role.oid = m.grantor
    where (m.roleid = runtime_role.oid or m.member = runtime_role.oid)
      and not (
        m.roleid = runtime_role.oid
        and member_role.rolname = 'postgres'
        and m.admin_option
        and not m.inherit_option
        and not m.set_option
        and (m.grantor = 10 or coalesce(grantor_role.rolsuper, false))
      )
  ) then
    raise exception 'TASK3E2_RUNTIME_ROLE_HAS_UNEXPECTED_MEMBERSHIP';
  end if;

  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relowner = runtime_role.oid
  ) or exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proowner = runtime_role.oid
  ) then
    raise exception 'TASK3E2_RUNTIME_ROLE_OWNS_APPLICATION_OBJECT';
  end if;

  execute format(
    'alter role app_tenant_runtime login password %L valid until %L',
    requested_password,
    'infinity'
  );
end;
$task3e2_activate$;

commit;

-- Emergency disable (does not delete evidence or grants):
--   ALTER ROLE app_tenant_runtime NOLOGIN;
-- Also remove/disable TENANT_DATABASE_URL and TENANT_RUNTIME_ENABLED in the
-- application environment before redeploying.
