-- Task 3 / TASK3-G read-only verification.
-- Run only after task3g-tenant-rpc-owner.sql succeeds.

with
rpc_owner as (
  select * from pg_roles where rolname='app_tenant_rpc_owner'
),
runtime_role as (
  select * from pg_roles where rolname='app_tenant_runtime'
),
tenant_rpc_names as (
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
  ]::text[]) as name
),
privileged_payment_rpc_names as (
  select unnest(array[
    'attach_payment_intent_provider_order',
    'claim_payment_intent_provider_creation',
    'claim_payment_webhook','complete_payment_webhook',
    'finalize_captured_payment'
  ]::text[]) as name
),
application_functions as (
  select p.*, n.nspname, owner_role.rolname as owner_name,
    owner_role.rolbypassrls as owner_bypassrls
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  join pg_roles owner_role on owner_role.oid=p.proowner
  where n.nspname='public' and p.prokind in ('f','p')
    and not exists (
      select 1 from pg_depend d
      where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e'
    )
),
checks as (
  select 'rpc_owner_exists'::text check_name,'1'::text expected,
    (select count(*)::text from rpc_owner) actual
  union all
  select 'rpc_owner_attributes_safe','true',
    coalesce((select (
      not rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole
      and not rolinherit and not rolreplication and not rolbypassrls
    )::text from rpc_owner),'false')
  union all
  select 'rpc_owner_schema_create','false',
    coalesce((select has_schema_privilege(oid,'public','CREATE')::text from rpc_owner),'true')
  union all
  select 'rpc_owner_effective_memberships','0',
    (select count(*)::text from pg_auth_members m
      where m.roleid=(select oid from rpc_owner)
        and (m.inherit_option or m.set_option))
  union all
  select 'tenant_rpc_names_missing','0',
    (select count(*)::text from tenant_rpc_names n
      where not exists(select 1 from application_functions f where f.proname=n.name))
  union all
  select 'tenant_rpc_runtime_execute_missing','0',
    (select count(*)::text from application_functions f
      join tenant_rpc_names n on n.name=f.proname
      where not has_function_privilege('app_tenant_runtime',f.oid,'EXECUTE'))
  union all
  select 'tenant_security_definer_owner_unsafe','0',
    (select count(*)::text from application_functions f
      join tenant_rpc_names n on n.name=f.proname
      where f.prosecdef and (f.owner_name<>'app_tenant_rpc_owner' or f.owner_bypassrls))
  union all
  select 'privileged_payment_rpc_runtime_execute','0',
    (select count(*)::text from application_functions f
      join privileged_payment_rpc_names n on n.name=f.proname
      where has_function_privilege('app_tenant_runtime',f.oid,'EXECUTE'))
  union all
  select 'rpc_owner_policy_gaps','0',
    (select count(*)::text
      from pg_policy p
      join pg_class c on c.oid=p.polrelid
      join pg_namespace ns on ns.oid=c.relnamespace
      where ns.nspname='public'
        and (select oid from runtime_role)=any(p.polroles)
        and not ((select oid from rpc_owner)=any(p.polroles)))
  union all
  select 'runtime_policy_count_preserved','199',
    (select count(*)::text
      from pg_policy p
      join pg_class c on c.oid=p.polrelid
      join pg_namespace ns on ns.oid=c.relnamespace
      where ns.nspname='public'
        and (select oid from runtime_role)=any(p.polroles))
  union all
  select 'force_rls_not_yet_enabled','0',
    (select count(*)::text from pg_class c
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p') and c.relforcerowsecurity)
)
select check_name,expected,actual,
  case
    when check_name='rpc_owner_exists' and actual=expected then 'PASS'
    when check_name='rpc_owner_attributes_safe' and actual=expected then 'PASS'
    when check_name='rpc_owner_schema_create' and actual=expected then 'PASS'
    when check_name='rpc_owner_effective_memberships' and actual=expected then 'PASS'
    when check_name='tenant_rpc_names_missing' and actual=expected then 'PASS'
    when check_name='tenant_rpc_runtime_execute_missing' and actual=expected then 'PASS'
    when check_name='tenant_security_definer_owner_unsafe' and actual=expected then 'PASS'
    when check_name='privileged_payment_rpc_runtime_execute' and actual=expected then 'PASS'
    when check_name='rpc_owner_policy_gaps' and actual=expected then 'PASS'
    when check_name='runtime_policy_count_preserved' and actual=expected then 'PASS'
    when check_name='force_rls_not_yet_enabled' and actual=expected then 'PASS'
    else 'FAIL'
  end result
from checks
order by check_name;
