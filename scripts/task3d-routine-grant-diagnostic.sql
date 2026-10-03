-- Task 3 / TASK3-D read-only routine grant diagnostic.
-- Run manually in Supabase SQL Editor. This query does not modify database state.

with public_routines as (
  select
    p.oid,
    p.proname,
    p.prokind,
    p.prosecdef,
    p.proowner,
    owner_role.rolname as owner_name,
    extension_info.extension_name,
    case when extension_info.extension_name is null
      then 'APPLICATION'
      else 'EXTENSION'
    end as routine_class,
    exists (
      select 1
      from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
    ) as public_execute,
    has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
    has_function_privilege('app_tenant_runtime', p.oid, 'EXECUTE') as runtime_execute,
    (
      p.proowner = current_user::regrole
      or pg_has_role(current_user, owner_role.rolname, 'MEMBER')
    ) as current_user_can_admin_owner
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles owner_role on owner_role.oid = p.proowner
  left join lateral (
    select e.extname as extension_name
    from pg_depend d
    join pg_extension e
      on e.oid = d.refobjid
     and d.refclassid = 'pg_extension'::regclass
    where d.classid = 'pg_proc'::regclass
      and d.objid = p.oid
      and d.deptype = 'e'
    limit 1
  ) extension_info on true
  where n.nspname = 'public'
),
grouped as (
  select
    routine_class,
    coalesce(extension_name, '') as extension_name,
    owner_name,
    case prokind
      when 'f' then 'FUNCTION'
      when 'p' then 'PROCEDURE'
      when 'a' then 'AGGREGATE'
      when 'w' then 'WINDOW'
      else prokind::text
    end as routine_kind,
    prosecdef as security_definer,
    current_user_can_admin_owner,
    count(*) as routine_count,
    count(*) filter (where public_execute) as public_execute_count,
    count(*) filter (where anon_execute) as anon_execute_count,
    count(*) filter (where authenticated_execute) as authenticated_execute_count,
    count(*) filter (where runtime_execute) as runtime_execute_count,
    string_agg(proname, ', ' order by proname) filter (where public_execute) as public_execute_names
  from public_routines
  group by routine_class, coalesce(extension_name, ''), owner_name,
    prokind, prosecdef, current_user_can_admin_owner
)
select
  routine_class,
  extension_name,
  owner_name,
  routine_kind,
  security_definer,
  current_user_can_admin_owner,
  routine_count,
  public_execute_count,
  anon_execute_count,
  authenticated_execute_count,
  runtime_execute_count,
  coalesce(public_execute_names, '') as public_execute_names
from grouped
where public_execute_count > 0
   or anon_execute_count > 0
   or authenticated_execute_count > 0
   or runtime_execute_count > 0
order by routine_class, extension_name, owner_name, routine_kind, security_definer;
