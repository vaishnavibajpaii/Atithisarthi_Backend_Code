-- Task 3 / TASK3-E2 read-only runtime-login catalog verification.
-- Run after backend/scripts/task3-activate-runtime-login.sql succeeds.
-- Does not connect as the role and does not expose its password hash.

with
runtime_role as (
  select * from pg_roles where rolname = 'app_tenant_runtime'
),
checks as (
  select 'runtime_role_exists'::text as check_name, '1'::text as expected,
    (select count(*)::text from runtime_role) as actual
  union all
  select 'runtime_role_login_enabled', 'true',
    coalesce((select rolcanlogin::text from runtime_role), 'false')
  union all
  select 'runtime_role_attributes_safe', 'true',
    coalesce((select (
      not rolsuper and not rolcreatedb and not rolcreaterole
      and not rolinherit and not rolreplication and not rolbypassrls
    )::text from runtime_role), 'false')
  union all
  select 'runtime_role_password_configured', 'true',
    coalesce((select (rolpassword is not null)::text from runtime_role), 'false')
  union all
  select 'runtime_role_valid_until_safe', 'true',
    coalesce((select (
      rolvaliduntil is null or rolvaliduntil > now() + interval '30 days'
    )::text from runtime_role), 'false')
  union all
  select 'runtime_role_unexpected_memberships', '0',
    (select count(*)::text
     from pg_auth_members m
     cross join runtime_role r
     left join pg_roles member_role on member_role.oid = m.member
     left join pg_roles grantor_role on grantor_role.oid = m.grantor
     where (m.roleid = r.oid or m.member = r.oid)
       and not (
         m.roleid = r.oid
         and member_role.rolname = 'postgres'
         and m.admin_option
         and not m.inherit_option
         and not m.set_option
         and (m.grantor = 10 or coalesce(grantor_role.rolsuper, false))
       ))
  union all
  select 'runtime_role_owned_application_objects', '0',
    (select count(*)::text from (
      select c.oid
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join runtime_role r
      where n.nspname = 'public' and c.relowner = r.oid
      union all
      select p.oid
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join runtime_role r
      where n.nspname = 'public' and p.proowner = r.oid
    ) owned)
  union all
  select 'tenant_policy_count_preserved', '199',
    (select count(*)::text
     from pg_policies
     where schemaname = 'public'
       and policyname in (
         'task3e_tenant_select', 'task3e_tenant_insert',
         'task3e_tenant_update', 'task3e_tenant_delete'
       )
       and roles is not distinct from array['app_tenant_runtime']::name[])
  union all
  select 'force_rls_not_yet_enabled', '0',
    (select count(*)::text
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p')
       and c.relforcerowsecurity)
  union all
  select 'service_role_bypass_path_preserved', 'true',
    coalesce((select rolbypassrls::text from pg_roles where rolname = 'service_role'), 'false')
)
select
  check_name,
  expected,
  actual,
  case when actual = expected then 'PASS' else 'FAIL' end as result
from checks
order by check_name;
