-- Task 3 / TASK3-E read-only RLS policy verification.
-- Run only after backend/scripts/task3-rls.sql succeeds.
-- Returns one row per check and does not modify database state.

with
runtime_role as (
  select * from pg_roles where rolname = 'app_tenant_runtime'
),
managed_tables as (
  select unnest(array[
    'gallery_items', 'hotel_popup_notifications', 'login_page_branding',
    'menu_categories', 'menu_combo_items', 'menu_combo_settings', 'menu_items',
    'notification_events', 'room_booking_payments', 'room_bookings',
    'room_images', 'testimonials'
  ]::text[]) as table_name
),
mutable_tables as (
  select unnest(array[
    'contact_submissions', 'food_order_bill_formats', 'food_order_bill_snapshots',
    'guest_stays', 'hotel_feature_settings', 'hotel_floors',
    'hotel_guest_profiles', 'hotel_notification_settings',
    'hotel_ordering_settings', 'hotel_payment_route_settings',
    'hotel_profiles', 'hotel_room_advance_policies', 'hotel_room_amenities',
    'hotel_room_tax_settings', 'hotel_staff_access', 'inquiries',
    'kds_settings', 'kitchen_stations', 'notification_card_acknowledgements',
    'order_rounds', 'order_support_requests', 'orders', 'payment_intents',
    'qr_customer_sessions', 'qr_event_outbox', 'qr_idempotency_records',
    'qr_order_submissions', 'qr_staff_idempotency_records', 'reservations',
    'restaurant_table_qr_tokens', 'restaurant_tables',
    'room_checkout_bill_formats', 'room_checkout_bill_snapshots',
    'room_housekeeping_tasks', 'room_maintenance',
    'room_negotiated_rate_approvals', 'room_rate_plans', 'room_tax_rules',
    'room_types', 'rooms'
  ]::text[]) as table_name
),
append_tables as (
  select unnest(array[
    'food_order_bill_audit', 'hotel_feature_setting_audit',
    'hotel_ordering_settings_audit', 'kds_status_history',
    'login_page_branding_audit', 'menu_category_audit', 'payment_attempts',
    'payment_webhook_inbox', 'qr_security_events', 'room_booking_refunds',
    'room_checkout_bill_audit', 'room_checkout_receipts',
    'room_operation_audit', 'room_shifts', 'room_stay_rate_adjustments'
  ]::text[]) as table_name
),
table_manifest as (
  select 'hotels'::text as table_name,
    true as can_select, false as can_insert,
    false as can_update, false as can_delete
  union all
  select table_name, true, true, true, true from managed_tables
  union all
  select table_name, true, true, true, false from mutable_tables
  union all
  select table_name, true, true, false, false from append_tables
),
expected_policies as (
  select table_name, 'task3e_tenant_select'::text as policy_name,
    'SELECT'::text as command
  from table_manifest where can_select
  union all
  select table_name, 'task3e_tenant_insert', 'INSERT'
  from table_manifest where can_insert
  union all
  select table_name, 'task3e_tenant_update', 'UPDATE'
  from table_manifest where can_update
  union all
  select table_name, 'task3e_tenant_delete', 'DELETE'
  from table_manifest where can_delete
),
actual_policies as (
  select p.tablename as table_name, p.policyname as policy_name,
    p.permissive, p.roles, p.cmd as command, p.qual, p.with_check
  from pg_policies p
  join table_manifest t on t.table_name = p.tablename
  where p.schemaname = 'public'
),
policy_validation as (
  select
    e.table_name,
    e.policy_name,
    e.command,
    a.permissive,
    a.roles,
    a.qual,
    a.with_check,
    (
      coalesce(a.qual, '') like '%app.tenant_id%'
      and coalesce(a.qual, '') like '%app.property_id%'
      and coalesce(a.qual, '') like '%tenant_id =%'
      and case when e.table_name = 'hotels'
        then coalesce(a.qual, '') ~ '(^|[^a-z_])id[[:space:]]*='
        else coalesce(a.qual, '') ~ '(^|[^a-z_])property_id[[:space:]]*='
      end
      and coalesce(a.qual, '') !~* '(^|[^a-z])or([^a-z]|$)'
    ) as using_is_scoped,
    (
      coalesce(a.with_check, '') like '%app.tenant_id%'
      and coalesce(a.with_check, '') like '%app.property_id%'
      and coalesce(a.with_check, '') like '%tenant_id =%'
      and case when e.table_name = 'hotels'
        then coalesce(a.with_check, '') ~ '(^|[^a-z_])id[[:space:]]*='
        else coalesce(a.with_check, '') ~ '(^|[^a-z_])property_id[[:space:]]*='
      end
      and coalesce(a.with_check, '') !~* '(^|[^a-z])or([^a-z]|$)'
    ) as check_is_scoped
  from expected_policies e
  left join actual_policies a
    on a.table_name = e.table_name
   and a.policy_name = e.policy_name
   and a.command = e.command
),
public_target_tables as (
  select c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join table_manifest t on t.table_name = c.relname
  where n.nspname = 'public' and c.relkind in ('r', 'p')
),
checks as (
  select 'runtime_role_exists'::text as check_name, '1'::text as expected,
    (select count(*)::text from runtime_role) as actual
  union all
  select 'runtime_role_attributes_safe', 'true',
    coalesce((select (
      not rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole
      and not rolinherit and not rolreplication and not rolbypassrls
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
  select 'target_table_manifest_count', '68',
    (select count(*)::text from table_manifest)
  union all
  select 'target_tables_missing', '0',
    (select count(*)::text
     from table_manifest t
     where to_regclass(format('public.%I', t.table_name)) is null)
  union all
  select 'owner_columns_missing', '0',
    (select count(*)::text
     from table_manifest t
     where not exists (
       select 1 from information_schema.columns c
       where c.table_schema = 'public'
         and c.table_name = t.table_name
         and c.column_name = 'tenant_id'
     ) or not exists (
       select 1 from information_schema.columns c
       where c.table_schema = 'public'
         and c.table_name = t.table_name
         and c.column_name = case
           when t.table_name = 'hotels' then 'id' else 'property_id'
         end
     ))
  union all
  select 'target_tables_rls_disabled', '0',
    (select count(*)::text from public_target_tables where not relrowsecurity)
  union all
  select 'force_rls_not_yet_enabled', '0',
    (select count(*)::text from public_target_tables where relforcerowsecurity)
  union all
  select 'expected_policy_manifest_count', '199',
    (select count(*)::text from expected_policies)
  union all
  select 'installed_target_policy_count', '199',
    (select count(*)::text from actual_policies)
  union all
  select 'expected_policies_missing', '0',
    (select count(*)::text
     from expected_policies e
     left join actual_policies a
       on a.table_name = e.table_name
      and a.policy_name = e.policy_name
      and a.command = e.command
     where a.policy_name is null)
  union all
  select 'unexpected_target_policies', '0',
    (select count(*)::text
     from actual_policies a
     left join expected_policies e
       on e.table_name = a.table_name
      and e.policy_name = a.policy_name
      and e.command = a.command
     where e.policy_name is null)
  union all
  select 'policy_role_mismatch', '0',
    (select count(*)::text
     from actual_policies
     where roles is distinct from array['app_tenant_runtime']::name[])
  union all
  select 'policy_mode_mismatch', '0',
    (select count(*)::text
     from actual_policies
     where permissive is distinct from 'PERMISSIVE')
  union all
  select 'select_policy_scope_invalid', '0',
    (select count(*)::text
     from policy_validation
     where command = 'SELECT'
       and (not using_is_scoped or with_check is not null))
  union all
  select 'insert_policy_scope_invalid', '0',
    (select count(*)::text
     from policy_validation
     where command = 'INSERT'
       and (qual is not null or not check_is_scoped))
  union all
  select 'update_using_scope_invalid', '0',
    (select count(*)::text
     from policy_validation
     where command = 'UPDATE' and not using_is_scoped)
  union all
  select 'update_with_check_scope_invalid', '0',
    (select count(*)::text
     from policy_validation
     where command = 'UPDATE' and not check_is_scoped)
  union all
  select 'delete_policy_scope_invalid', '0',
    (select count(*)::text
     from policy_validation
     where command = 'DELETE'
       and (not using_is_scoped or with_check is not null))
  union all
  select 'broad_true_or_or_policy_expressions', '0',
    (select count(*)::text
     from actual_policies
     where lower(btrim(coalesce(qual, ''), '() ')) = 'true'
        or lower(btrim(coalesce(with_check, ''), '() ')) = 'true'
        or coalesce(qual, '') ~* '(^|[^a-z])or([^a-z]|$)'
        or coalesce(with_check, '') ~* '(^|[^a-z])or([^a-z]|$)')
  union all
  select 'anon_authenticated_effective_table_privileges', '0',
    (select count(*)::text
     from public_target_tables t
     cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) v(privilege_type)
     where has_table_privilege('anon', t.oid, v.privilege_type)
        or has_table_privilege('authenticated', t.oid, v.privilege_type))
  union all
  select 'forbidden_global_runtime_privileges', '0',
    (select count(*)::text
     from (values ('admin_users'), ('tenants'), ('payment_webhook_events')) g(table_name)
     cross join runtime_role r
     cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) v(privilege_type)
     where to_regclass(format('public.%I', g.table_name)) is not null
       and has_table_privilege(r.oid, format('public.%I', g.table_name), v.privilege_type))
)
select
  check_name,
  expected,
  actual,
  case when actual = expected then 'PASS' else 'FAIL' end as result
from checks
order by check_name;
