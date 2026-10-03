-- Task 3 / TASK3-E: tenant/property RLS policy installation.
-- Authorized pre-production database only. Run manually in Supabase SQL Editor.
--
-- Preconditions:
--   * TASK3-C completed successfully (21/21 PASS);
--   * TASK3-D completed successfully (23/23 PASS);
--   * app_tenant_runtime remains NOLOGIN, NOINHERIT, NOBYPASSRLS and unassigned.
--
-- This checkpoint installs policies only for app_tenant_runtime. It does not
-- assign that role to a login, switch the backend away from service_role, enable
-- FORCE RLS, change storage policies, or modify application rows. Missing or
-- malformed transaction-local context yields no tenant rows.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '10min';
set local search_path = pg_catalog, public;

do $task3e_preflight$
declare
  runtime_role pg_roles%rowtype;
  required_tables constant text[] := array[
    'hotels',
    'gallery_items', 'hotel_popup_notifications', 'login_page_branding',
    'menu_categories', 'menu_combo_items', 'menu_combo_settings', 'menu_items',
    'notification_events', 'room_booking_payments', 'room_bookings',
    'room_images', 'testimonials',
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
    'room_types', 'rooms',
    'food_order_bill_audit', 'hotel_feature_setting_audit',
    'hotel_ordering_settings_audit', 'kds_status_history',
    'login_page_branding_audit', 'menu_category_audit', 'payment_attempts',
    'payment_webhook_inbox', 'qr_security_events', 'room_booking_refunds',
    'room_checkout_bill_audit', 'room_checkout_receipts',
    'room_operation_audit', 'room_shifts', 'room_stay_rate_adjustments'
  ];
  table_name text;
  issue_count bigint;
begin
  select * into runtime_role
  from pg_roles
  where rolname = 'app_tenant_runtime';

  if runtime_role.oid is null then
    raise exception 'TASK3E_RUNTIME_ROLE_MISSING';
  end if;

  if runtime_role.rolcanlogin
     or runtime_role.rolsuper
     or runtime_role.rolcreatedb
     or runtime_role.rolcreaterole
     or runtime_role.rolinherit
     or runtime_role.rolreplication
     or runtime_role.rolbypassrls then
    raise exception 'TASK3E_RUNTIME_ROLE_UNSAFE';
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
    raise exception 'TASK3E_RUNTIME_ROLE_ALREADY_ASSIGNED';
  end if;

  foreach table_name in array required_tables loop
    if to_regclass(format('public.%I', table_name)) is null then
      raise exception 'TASK3E_REQUIRED_TABLE_MISSING table=%', table_name;
    end if;

    select count(*) into issue_count
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = table_name
      and c.column_name in (
        'tenant_id',
        case when table_name = 'hotels' then 'id' else 'property_id' end
      );

    if issue_count <> 2 then
      raise exception 'TASK3E_OWNER_COLUMNS_MISSING table=% count=%',
        table_name, issue_count;
    end if;
  end loop;

  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = any(required_tables)
      and c.relforcerowsecurity
  ) then
    raise exception 'TASK3E_FORCE_RLS_PREMATURELY_ENABLED';
  end if;

  if exists (
    select 1
    from pg_policies p
    where p.schemaname = 'public'
      and p.tablename = any(required_tables)
      and p.policyname not in (
        'task3e_tenant_select', 'task3e_tenant_insert',
        'task3e_tenant_update', 'task3e_tenant_delete'
      )
  ) then
    raise exception 'TASK3E_UNREVIEWED_POLICY_EXISTS';
  end if;

  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) v(privilege_type)
    where n.nspname = 'public'
      and c.relname = any(required_tables)
      and (
        has_table_privilege('anon', c.oid, v.privilege_type)
        or has_table_privilege('authenticated', c.oid, v.privilege_type)
      )
  ) then
    raise exception 'TASK3E_DIRECT_ACCESS_LOCKDOWN_DRIFT';
  end if;
end;
$task3e_preflight$;

do $task3e_policies$
declare
  managed_tables constant text[] := array[
    'gallery_items', 'hotel_popup_notifications', 'login_page_branding',
    'menu_categories', 'menu_combo_items', 'menu_combo_settings', 'menu_items',
    'notification_events', 'room_booking_payments', 'room_bookings',
    'room_images', 'testimonials'
  ];
  mutable_tables constant text[] := array[
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
  ];
  append_tables constant text[] := array[
    'food_order_bill_audit', 'hotel_feature_setting_audit',
    'hotel_ordering_settings_audit', 'kds_status_history',
    'login_page_branding_audit', 'menu_category_audit', 'payment_attempts',
    'payment_webhook_inbox', 'qr_security_events', 'room_booking_refunds',
    'room_checkout_bill_audit', 'room_checkout_receipts',
    'room_operation_audit', 'room_shifts', 'room_stay_rate_adjustments'
  ];
  tenant_scope constant text := $scope$
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and property_id = nullif(current_setting('app.property_id', true), '')::bigint
  $scope$;
  hotel_scope constant text := $scope$
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and id = nullif(current_setting('app.property_id', true), '')::bigint
  $scope$;
  table_name text;
  can_update boolean;
  can_delete boolean;
begin
  alter table public.hotels enable row level security;
  drop policy if exists task3e_tenant_select on public.hotels;
  drop policy if exists task3e_tenant_insert on public.hotels;
  drop policy if exists task3e_tenant_update on public.hotels;
  drop policy if exists task3e_tenant_delete on public.hotels;
  execute format(
    'create policy task3e_tenant_select on public.hotels as permissive for select to app_tenant_runtime using (%s)',
    hotel_scope
  );

  foreach table_name in array managed_tables || mutable_tables || append_tables loop
    can_update := table_name = any(managed_tables || mutable_tables);
    can_delete := table_name = any(managed_tables);

    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists task3e_tenant_select on public.%I', table_name);
    execute format('drop policy if exists task3e_tenant_insert on public.%I', table_name);
    execute format('drop policy if exists task3e_tenant_update on public.%I', table_name);
    execute format('drop policy if exists task3e_tenant_delete on public.%I', table_name);

    execute format(
      'create policy task3e_tenant_select on public.%I as permissive for select to app_tenant_runtime using (%s)',
      table_name, tenant_scope
    );
    execute format(
      'create policy task3e_tenant_insert on public.%I as permissive for insert to app_tenant_runtime with check (%s)',
      table_name, tenant_scope
    );

    if can_update then
      execute format(
        'create policy task3e_tenant_update on public.%I as permissive for update to app_tenant_runtime using (%s) with check (%s)',
        table_name, tenant_scope, tenant_scope
      );
    end if;

    if can_delete then
      execute format(
        'create policy task3e_tenant_delete on public.%I as permissive for delete to app_tenant_runtime using (%s)',
        table_name, tenant_scope
      );
    end if;
  end loop;
end;
$task3e_policies$;

commit;

-- Rollback/disable note:
-- Do not drop ownership columns or financial evidence. Before runtime activation,
-- removing only the task3e_* policies returns app_tenant_runtime to fail-closed.
-- The current service_role backend remains unchanged by this checkpoint.
