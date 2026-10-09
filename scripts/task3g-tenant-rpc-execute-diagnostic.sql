-- Task 3 / TASK3-G read-only diagnostic for reviewed tenant RPC EXECUTE grants.
-- Returns routine metadata only; it does not read application/customer rows.

with tenant_rpc_names(name) as (
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
  select
    p.oid,
    p.oid::regprocedure::text as routine_signature,
    p.proname,
    p.prokind,
    p.prosecdef,
    owner_role.rolname as owner_name,
    owner_role.rolbypassrls as owner_bypassrls,
    has_function_privilege('app_tenant_runtime',p.oid,'EXECUTE') as runtime_execute,
    has_function_privilege('app_tenant_rpc_owner',p.oid,'EXECUTE') as rpc_owner_execute,
    has_function_privilege('service_role',p.oid,'EXECUTE') as service_role_execute
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  join pg_roles owner_role on owner_role.oid=p.proowner
  join tenant_rpc_names requested on requested.name=p.proname
  where n.nspname='public' and p.prokind in ('f','p')
    and not exists (
      select 1 from pg_depend d
      where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e'
    )
)
select
  routine_signature,
  case prokind when 'p' then 'PROCEDURE' else 'FUNCTION' end as routine_kind,
  prosecdef as security_definer,
  owner_name,
  owner_bypassrls,
  runtime_execute,
  rpc_owner_execute,
  service_role_execute,
  case
    when not runtime_execute then 'MISSING_RUNTIME_EXECUTE'
    when prosecdef and (owner_name<>'app_tenant_rpc_owner' or owner_bypassrls)
      then 'UNSAFE_DEFINER_OWNER'
    else 'PASS'
  end as result
from application_routines
order by
  case when not runtime_execute then 0 else 1 end,
  routine_signature;
