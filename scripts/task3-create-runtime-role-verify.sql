-- Task 3 / TASK3-D read-only verification.
-- Run only after backend/scripts/task3-create-runtime-role.sql succeeds.
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
    'room_checkout_bill_audit',
    'room_checkout_receipts', 'room_operation_audit', 'room_shifts',
    'room_stay_rate_adjustments'
  ]::text[]) as table_name
),
insert_tables as (
  select table_name from managed_tables
  union all select table_name from mutable_tables
  union all select table_name from append_tables
),
expected_table_privileges as (
  select 'hotels'::text as table_name, 'SELECT'::text as privilege_type
  union all
  select m.table_name, p.privilege_type
  from managed_tables m
  cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(privilege_type)
  union all
  select m.table_name, p.privilege_type
  from mutable_tables m
  cross join (values ('SELECT'), ('INSERT'), ('UPDATE')) p(privilege_type)
  union all
  select a.table_name, p.privilege_type
  from append_tables a
  cross join (values ('SELECT'), ('INSERT')) p(privilege_type)
),
public_tables as (
  select c.oid, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
),
actual_table_privileges as (
  select t.relname as table_name, p.privilege_type
  from public_tables t
  cross join runtime_role r
  cross join (values
    ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
    ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')
  ) p(privilege_type)
  where has_table_privilege(r.oid, t.oid, p.privilege_type)
),
expected_sequences as (
  select distinct seq.oid, seq.relname
  from pg_class seq
  join pg_namespace seq_ns on seq_ns.oid = seq.relnamespace
  join pg_depend dep on dep.objid = seq.oid and dep.deptype in ('a', 'i')
  join pg_class tbl on tbl.oid = dep.refobjid
  join pg_namespace tbl_ns on tbl_ns.oid = tbl.relnamespace
  join insert_tables allowed on allowed.table_name = tbl.relname
  where seq_ns.nspname = 'public'
    and seq.relkind = 'S'
    and tbl_ns.nspname = 'public'
),
public_sequences as (
  select c.oid, c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'S'
),
actual_sequence_privileges as (
  select s.oid, s.relname, p.privilege_type
  from public_sequences s
  cross join runtime_role r
  cross join (values ('USAGE'), ('SELECT'), ('UPDATE')) p(privilege_type)
  where has_sequence_privilege(r.oid, s.oid, p.privilege_type)
),
reviewed_rpc_names as (
  select unnest(array[
    'acknowledge_notification_card', 'activate_room_tax_rule',
    'attach_payment_intent_provider_order', 'claim_payment_intent_provider_creation',
    'claim_payment_webhook', 'complete_payment_webhook',
    'correct_secure_qr_submission_staff', 'create_staff_table_order_if_available',
    'delete_room_image', 'edit_secure_qr_submission', 'extend_room_booking',
    'finalize_captured_payment', 'get_staff_active_table_order',
    'is_dine_in_order_open',
    'record_room_booking_refund', 'reorder_room_images',
    'room_negotiated_rate_ready', 'settle_room_combined_checkout',
    'shift_room_booking', 'submit_secure_qr_table_order'
  ]::text[]) as function_name
),
-- Application routines intentionally exclude extension-owned functions. Supabase
-- may install managed extensions such as btree_gist into public; their ACLs and
-- ownership are controlled by the platform, not by the application migration.
public_functions as (
  select p.oid, p.proname, p.proowner, p.proacl
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind in ('f', 'p')
    and not exists (
      select 1
      from pg_depend d
      where d.classid = 'pg_proc'::regclass
        and d.objid = p.oid
        and d.deptype = 'e'
    )
),
public_extension_functions as (
  select p.oid, p.proowner, p.proacl, p.prosecdef
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind in ('f', 'p')
    and exists (
      select 1
      from pg_depend d
      where d.classid = 'pg_proc'::regclass
        and d.objid = p.oid
        and d.deptype = 'e'
    )
),
actual_runtime_functions as (
  select f.oid, f.proname
  from public_functions f
  cross join runtime_role r
  where has_function_privilege(r.oid, f.oid, 'EXECUTE')
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
  select 'runtime_role_owned_application_objects', '0',
    (select count(*)::text from (
      select n.oid from pg_namespace n cross join runtime_role r
      where n.nspowner = r.oid
      union all
      select c.oid from pg_class c cross join runtime_role r
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relowner = r.oid
      union all
      select p.oid from pg_proc p cross join runtime_role r
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proowner = r.oid
    ) owned)
  union all
  select 'public_schema_usage', 'true',
    coalesce((select has_schema_privilege(r.oid, n.oid, 'USAGE')::text
      from runtime_role r cross join pg_namespace n where n.nspname = 'public'), 'false')
  union all
  select 'public_schema_create', 'false',
    coalesce((select has_schema_privilege(r.oid, n.oid, 'CREATE')::text
      from runtime_role r cross join pg_namespace n where n.nspname = 'public'), 'true')
  union all
  select 'expected_table_privileges_missing', '0',
    (select count(*)::text
     from expected_table_privileges e
     left join actual_table_privileges a using (table_name, privilege_type)
     where a.table_name is null)
  union all
  select 'unexpected_table_privileges', '0',
    (select count(*)::text
     from actual_table_privileges a
     left join expected_table_privileges e using (table_name, privilege_type)
     where e.table_name is null)
  union all
  select 'forbidden_global_table_privileges', '0',
    (select count(*)::text from actual_table_privileges
     where table_name in ('admin_users', 'tenants', 'payment_webhook_events'))
  union all
  select 'dangerous_table_privileges', '0',
    (select count(*)::text from actual_table_privileges
     where privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'))
  union all
  select 'expected_sequence_usage_missing', '0',
    (select count(*)::text
     from expected_sequences e
     left join actual_sequence_privileges a
       on a.oid = e.oid and a.privilege_type = 'USAGE'
     where a.oid is null)
  union all
  select 'unexpected_sequence_privileges', '0',
    (select count(*)::text
     from actual_sequence_privileges a
     left join expected_sequences e on e.oid = a.oid
     where e.oid is null or a.privilege_type <> 'USAGE')
  union all
  select 'reviewed_rpc_names_missing', '0',
    (select count(*)::text
     from reviewed_rpc_names r
     where not exists (select 1 from public_functions f where f.proname = r.function_name))
  union all
  select 'reviewed_rpc_execute_missing', '0',
    (select count(*)::text
     from public_functions f
     join reviewed_rpc_names r on r.function_name = f.proname
     left join actual_runtime_functions a on a.oid = f.oid
     where a.oid is null)
  union all
  select 'unexpected_function_execute', '0',
    (select count(*)::text
     from actual_runtime_functions a
     left join reviewed_rpc_names r on r.function_name = a.proname
     where r.function_name is null)
  union all
  select 'public_function_execute_grants', '0',
    (select count(*)::text
     from public_functions f
     where exists (
       select 1
       from aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) acl
       where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
     ))
  union all
  select 'anon_authenticated_function_execute', '0',
    (select count(*)::text
     from public_functions f
     where has_function_privilege('anon', f.oid, 'EXECUTE')
        or has_function_privilege('authenticated', f.oid, 'EXECUTE'))
  union all
  select 'extension_security_definer_execute_exposure', '0',
    (select count(*)::text
     from public_extension_functions f
     cross join runtime_role r
     where f.prosecdef
       and (
         exists (
           select 1
           from aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) acl
           where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
         )
         or has_function_privilege('anon', f.oid, 'EXECUTE')
         or has_function_privilege('authenticated', f.oid, 'EXECUTE')
         or has_function_privilege(r.oid, f.oid, 'EXECUTE')
       ))
  union all
  select 'service_role_payment_rpc_preserved', '5',
    (select count(distinct f.proname)::text
     from public_functions f
     where f.proname in (
       'claim_payment_intent_provider_creation',
       'attach_payment_intent_provider_order',
       'finalize_captured_payment',
       'claim_payment_webhook',
       'complete_payment_webhook'
     ) and has_function_privilege('service_role', f.oid, 'EXECUTE'))
  union all
  select 'all_public_tables_rls_enabled', '0',
    (select count(*)::text from public_tables where not relrowsecurity and relkind in ('r', 'p'))
  union all
  select 'rls_policies_not_yet_installed', '0',
    (select count(*)::text from pg_policies where schemaname = 'public')
  union all
  select 'force_rls_not_prematurely_enabled', '0',
    (select count(*)::text from public_tables where relforcerowsecurity and relkind in ('r', 'p'))
  union all
  select 'anon_authenticated_effective_table_privileges', '0',
    (select count(*)::text
     from public_tables t
     cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(privilege_type)
     where has_table_privilege('anon', t.oid, p.privilege_type)
        or has_table_privilege('authenticated', t.oid, p.privilege_type))
)
select
  check_name,
  expected,
  actual,
  case when actual = expected then 'PASS' else 'FAIL' end as result
from checks
order by check_name;
