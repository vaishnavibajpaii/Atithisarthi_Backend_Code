-- Task 3 / TASK3-G read-only preflight.
-- This query changes nothing and returns no application/customer rows.
-- Run before task3g-tenant-rpc-owner.sql.

with
required_tenant_rpc_names(name) as (
  select unnest(array[
    'acknowledge_notification_card','activate_room_tax_rule',
    'add_staff_items_to_active_order','correct_secure_qr_submission_staff',
    'create_room_booking_with_advance','create_staff_table_order_if_available',
    'delete_room_image','edit_secure_qr_submission','extend_room_booking',
    'get_staff_active_table_order','is_dine_in_order_open',
    'record_room_booking_payment','record_room_booking_refund',
    'reorder_room_images','room_negotiated_rate_ready',
    'settle_room_combined_checkout','shift_room_booking',
    'submit_secure_qr_table_order'
  ]::text[])
),
application_routines as (
  select p.oid,p.proname,p.prokind,p.prosecdef,p.proconfig,p.proowner,
    owner_role.rolname owner_name,owner_role.rolsuper owner_superuser,
    owner_role.rolbypassrls owner_bypassrls
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  join pg_roles owner_role on owner_role.oid=p.proowner
  where n.nspname='public' and p.prokind in ('f','p')
    and not exists (
      select 1 from pg_depend d
      where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e'
    )
),
rpc_owner as (
  select * from pg_roles where rolname='app_tenant_rpc_owner'
),
runtime_role as (
  select * from pg_roles where rolname='app_tenant_runtime'
),
checks as (
  select 'database_name'::text check_name,'postgres'::text expected,
    current_database()::text actual,'INFO'::text pass_mode
  union all
  select 'postgres_major_version','>=16',current_setting('server_version_num'),
    case when current_setting('server_version_num')::integer>=160000 then 'PASS' else 'FAIL' end
  union all
  select 'runtime_role_exists','1',(select count(*)::text from runtime_role),'EQUAL'
  union all
  select 'runtime_role_attributes_safe','true',coalesce((select (
    rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole
    and not rolinherit and not rolreplication and not rolbypassrls
  )::text from runtime_role),'false'),'EQUAL'
  union all
  select 'runtime_policy_count','199',(select count(*)::text
    from pg_policy p join pg_class c on c.oid=p.polrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and (select oid from runtime_role)=any(p.polroles)),'EQUAL'
  union all
  select 'force_rls_not_yet_enabled','0',(select count(*)::text
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p') and c.relforcerowsecurity),'EQUAL'
  union all
  select 'required_tenant_rpc_names_missing','0',(select count(*)::text
    from required_tenant_rpc_names n
    where not exists(select 1 from application_routines r where r.proname=n.name)),'EQUAL'
  union all
  select 'tenant_rpc_unsafe_search_path','0',(select count(*)::text
    from application_routines r join required_tenant_rpc_names n on n.name=r.proname
    where r.prosecdef and not exists(
      select 1 from unnest(coalesce(r.proconfig,array[]::text[])) setting
      where setting like 'search_path=%'
    )),'EQUAL'
  union all
  select 'existing_rpc_owner_count','0 or 1',(select count(*)::text from rpc_owner),'ZERO_OR_ONE'
  union all
  select 'existing_rpc_owner_attributes_safe','true',coalesce((select (
    not rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole
    and not rolinherit and not rolreplication and not rolbypassrls
  )::text from rpc_owner),'true'),'EQUAL'
  union all
  select 'existing_rpc_owner_effective_memberships','0',(select count(*)::text
    from pg_auth_members m where m.roleid=(select oid from rpc_owner)
      and (m.inherit_option or m.set_option)),'EQUAL'
)
select check_name,expected,actual,
  case
    when pass_mode='INFO' then 'INFO'
    when pass_mode='PASS' then pass_mode
    when pass_mode='FAIL' then pass_mode
    when pass_mode='ZERO_OR_ONE' and actual in ('0','1') then 'PASS'
    when pass_mode='EQUAL' and actual=expected then 'PASS'
    else 'FAIL'
  end result
from checks
order by check_name;

-- Safe routine metadata only: no arguments, source code, secrets, or data rows.
select
  p.proname as routine_name,
  case p.prokind when 'p' then 'PROCEDURE' else 'FUNCTION' end as routine_kind,
  p.prosecdef as security_definer,
  owner_role.rolname as current_owner,
  owner_role.rolsuper as owner_superuser,
  owner_role.rolbypassrls as owner_bypassrls,
  exists (
    select 1 from unnest(coalesce(p.proconfig,array[]::text[])) setting
    where setting like 'search_path=%'
  ) as search_path_pinned
from pg_proc p
join pg_namespace n on n.oid=p.pronamespace
join pg_roles owner_role on owner_role.oid=p.proowner
where n.nspname='public' and p.proname=any(array[
  'acknowledge_notification_card','activate_room_tax_rule',
  'add_staff_items_to_active_order','correct_secure_qr_submission_staff',
  'create_room_booking_with_advance','create_staff_table_order_if_available',
  'delete_room_image','edit_secure_qr_submission','extend_room_booking',
  'get_staff_active_table_order','is_dine_in_order_open',
  'record_room_booking_payment','record_room_booking_refund',
  'reorder_room_images','room_negotiated_rate_ready',
  'settle_room_combined_checkout','shift_room_booking',
  'submit_secure_qr_table_order'
]::text[])
order by p.proname,p.oid;
