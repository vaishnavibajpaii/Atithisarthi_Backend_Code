-- TASK6-F: read-only ownership diagnostic for the secure QR routine.
-- No data definition or business data is modified.

set local search_path = pg_catalog, public;

select
  current_database() as database_name,
  session_user as session_user,
  current_user as execution_role,
  current_setting('role', true) as configured_role;

select
  p.oid::regprocedure::text as routine,
  owner_role.rolname as routine_owner,
  current_user = owner_role.rolname as execution_role_is_owner,
  pg_has_role(current_user, owner_role.oid, 'MEMBER') as execution_role_is_owner_member,
  pg_has_role(current_user, 'app_tenant_rpc_owner', 'MEMBER') as execution_role_is_safe_owner_member,
  has_schema_privilege(current_user, 'public', 'CREATE') as execution_role_can_create_public,
  owner_role.rolsuper as owner_is_superuser,
  owner_role.rolbypassrls as owner_bypasses_rls
from pg_proc p
join pg_roles owner_role on owner_role.oid = p.proowner
where p.oid in (
  'public.submit_secure_qr_table_order(text,text,text,text,jsonb,text)'::regprocedure,
  'public.merge_qr_order_totals(jsonb,jsonb)'::regprocedure,
  'public.replace_qr_order_totals(jsonb,jsonb,jsonb)'::regprocedure
)
order by routine;

select
  role_name,
  can_login,
  is_superuser,
  bypasses_rls
from (
  select
    rolname as role_name,
    rolcanlogin as can_login,
    rolsuper as is_superuser,
    rolbypassrls as bypasses_rls
  from pg_roles
  where rolname in ('postgres', 'app_tenant_runtime', 'app_tenant_rpc_owner')
) roles
order by role_name;
