-- TASK6-F: one-table, read-only ownership diagnostic.
-- No data definition or business data is modified.

set local search_path = pg_catalog, public;

with routines as (
  select
    p.oid::regprocedure::text as routine,
    owner_role.rolname as routine_owner,
    current_user = owner_role.rolname as execution_role_is_owner,
    pg_has_role(current_user, owner_role.oid, 'MEMBER') as execution_role_is_owner_member,
    pg_has_role(current_user, 'app_tenant_rpc_owner', 'MEMBER') as execution_role_is_safe_owner_member,
    has_schema_privilege(current_user, 'public', 'CREATE') as execution_role_can_create_public
  from pg_proc p
  join pg_roles owner_role on owner_role.oid = p.proowner
  where p.oid in (
    'public.submit_secure_qr_table_order(text,text,text,text,jsonb,text)'::regprocedure,
    'public.merge_qr_order_totals(jsonb,jsonb)'::regprocedure,
    'public.replace_qr_order_totals(jsonb,jsonb,jsonb)'::regprocedure
  )
),
checks(section, check_name, expected, actual, result) as (
  select
    'execution',
    'database_and_execution_role',
    'a role allowed to change the QR routine owner',
    current_database() || '; session_user=' || session_user || '; current_user=' || current_user || '; configured_role=' || coalesce(current_setting('role', true), '<empty>'),
    'INFO'

  union all

  select
    'routine',
    routine,
    'owner=app_tenant_rpc_owner; execution owner/member=true; safe owner member=true; public create=true',
    'owner=' || routine_owner ||
      '; execution_owner=' || execution_role_is_owner ||
      '; execution_owner_member=' || execution_role_is_owner_member ||
      '; execution_safe_owner_member=' || execution_role_is_safe_owner_member ||
      '; execution_public_create=' || execution_role_can_create_public,
    case when routine_owner = 'app_tenant_rpc_owner'
      and execution_role_is_owner_member and execution_role_is_safe_owner_member
      and execution_role_can_create_public
      then 'PASS' else 'INFO' end
  from routines
)
select section, check_name, expected, actual, result
from checks
order by section, check_name;
