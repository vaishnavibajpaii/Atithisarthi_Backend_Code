-- Task 3 / TASK3-D: restricted tenant application runtime role and grants.
-- Authorized pre-production database only. Run manually in Supabase SQL Editor.
--
-- Preconditions:
--   * TASK3-C completed successfully;
--   * backend/scripts/task3-tenant-isolation-constraints-verify.sql reports 21/21 PASS.
--
-- This checkpoint intentionally creates a NOLOGIN group role. It does not switch
-- the backend, create/store a password, install RLS policies, enable FORCE RLS,
-- or grant the role to any login. With RLS enabled and no policies, the role is
-- fail-closed until TASK3-E is explicitly approved and completed.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '10min';
set local search_path = pg_catalog, public;

do $task3d_role$
declare
  runtime_role pg_roles%rowtype;
begin
  select * into runtime_role
  from pg_roles
  where rolname = 'app_tenant_runtime';

  if runtime_role.oid is not null and exists (
    select 1
    from pg_auth_members m
    left join pg_roles member_role on member_role.oid = m.member
    left join pg_roles grantor_role on grantor_role.oid = m.grantor
    where (m.roleid = runtime_role.oid or m.member = runtime_role.oid)
      and not (
        -- PostgreSQL 16+ automatically gives a non-superuser CREATEROLE
        -- creator ADMIN OPTION on a role it creates. This exact row does not
        -- inherit the role and cannot SET ROLE into it. The grant is issued by
        -- the bootstrap user (OID 10); a true superuser grantor is equivalent.
        m.roleid = runtime_role.oid
        and member_role.rolname = 'postgres'
        and m.admin_option
        and not m.inherit_option
        and not m.set_option
        and (m.grantor = 10 or coalesce(grantor_role.rolsuper, false))
      )
  ) then
    raise exception 'TASK3D_EXISTING_ROLE_HAS_MEMBERSHIP';
  end if;

  if runtime_role.oid is null then
    -- Supabase's SQL Editor administration role can create a normal role but
    -- is intentionally not a true PostgreSQL superuser. Omitted attributes use
    -- PostgreSQL's safe defaults: NOSUPERUSER, NOCREATEDB, NOCREATEROLE,
    -- NOREPLICATION, and NOBYPASSRLS.
    create role app_tenant_runtime
      nologin
      noinherit;

    select * into runtime_role
    from pg_roles
    where rolname = 'app_tenant_runtime';
  end if;

  -- Do not attempt ALTER ... NOSUPERUSER/NOBYPASSRLS: managed Supabase
  -- correctly reserves those attribute changes for a true superuser. Instead,
  -- fail closed if a pre-existing role is not already exactly restricted.
  if runtime_role.rolcanlogin
     or runtime_role.rolsuper
     or runtime_role.rolcreatedb
     or runtime_role.rolcreaterole
     or runtime_role.rolinherit
     or runtime_role.rolreplication
     or runtime_role.rolbypassrls then
    raise exception
      'TASK3D_UNSAFE_RUNTIME_ROLE_ATTRIBUTES login=% superuser=% createdb=% createrole=% inherit=% replication=% bypassrls=%',
      runtime_role.rolcanlogin,
      runtime_role.rolsuper,
      runtime_role.rolcreatedb,
      runtime_role.rolcreaterole,
      runtime_role.rolinherit,
      runtime_role.rolreplication,
      runtime_role.rolbypassrls;
  end if;
end;
$task3d_role$;

-- A tenant runtime must never create objects in the application schema.
revoke create on schema public from public;
revoke all on schema public from app_tenant_runtime;
grant usage on schema public to app_tenant_runtime;

-- Reset only this new role's application privileges so reruns are deterministic.
do $task3d_reset$
declare
  target record;
begin
  for target in
    select c.oid::regclass as object_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
  loop
    execute format('revoke all privileges on table %s from app_tenant_runtime', target.object_name);
  end loop;

  for target in
    select c.oid::regclass as object_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S'
  loop
    execute format('revoke all privileges on sequence %s from app_tenant_runtime', target.object_name);
  end loop;
end;
$task3d_reset$;

-- Explicit table grant manifest. DELETE is limited to tables whose current
-- backend implementation has a real delete path. Evidence/audit ledgers do not
-- receive DELETE, TRUNCATE, REFERENCES, TRIGGER, or MAINTAIN.
do $task3d_tables$
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
    'room_checkout_bill_audit',
    'room_checkout_receipts', 'room_operation_audit', 'room_shifts',
    'room_stay_rate_adjustments'
  ];
  required_tables text[];
  table_name text;
  missing_tables text[];
begin
  required_tables := managed_tables || mutable_tables || append_tables || array['hotels'];

  select array_agg(name order by name)
    into missing_tables
  from unnest(required_tables) as name
  where to_regclass(format('public.%I', name)) is null;

  if missing_tables is not null then
    raise exception 'TASK3D_REQUIRED_TABLES_MISSING %', missing_tables;
  end if;

  grant select on table public.hotels to app_tenant_runtime;

  foreach table_name in array managed_tables loop
    execute format(
      'grant select, insert, update, delete on table public.%I to app_tenant_runtime',
      table_name
    );
  end loop;

  foreach table_name in array mutable_tables loop
    execute format(
      'grant select, insert, update on table public.%I to app_tenant_runtime',
      table_name
    );
  end loop;

  foreach table_name in array append_tables loop
    execute format(
      'grant select, insert on table public.%I to app_tenant_runtime',
      table_name
    );
  end loop;
end;
$task3d_tables$;

-- Permit nextval only for sequences owned by columns on INSERT-capable tables.
-- No standalone or unrelated sequence is granted.
do $task3d_sequences$
declare
  insert_tables constant text[] := array[
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
    'room_checkout_bill_formats', 'room_housekeeping_tasks', 'room_maintenance',
    'room_negotiated_rate_approvals', 'room_rate_plans', 'room_tax_rules',
    'room_types', 'rooms',
    'food_order_bill_audit', 'hotel_feature_setting_audit',
    'hotel_ordering_settings_audit', 'kds_status_history',
    'login_page_branding_audit', 'menu_category_audit', 'payment_attempts',
    'payment_webhook_inbox', 'qr_security_events', 'room_booking_refunds',
    'room_checkout_bill_audit', 'room_checkout_bill_snapshots',
    'room_checkout_receipts', 'room_operation_audit', 'room_shifts',
    'room_stay_rate_adjustments'
  ];
  target record;
begin
  for target in
    select distinct seq.oid::regclass as sequence_name
    from pg_class seq
    join pg_namespace seq_ns on seq_ns.oid = seq.relnamespace
    join pg_depend dep on dep.objid = seq.oid and dep.deptype in ('a', 'i')
    join pg_class tbl on tbl.oid = dep.refobjid
    join pg_namespace tbl_ns on tbl_ns.oid = tbl.relnamespace
    where seq_ns.nspname = 'public'
      and seq.relkind = 'S'
      and tbl_ns.nspname = 'public'
      and tbl.relname = any(insert_tables)
  loop
    execute format('grant usage on sequence %s to app_tenant_runtime', target.sequence_name);
  end loop;
end;
$task3d_sequences$;

-- Close inherited execution for application-owned routines. Extension member
-- routines are not rewritten here because changing extension ACLs blindly can
-- break managed Supabase internals. The TASK3-D diagnostic inventories those
-- separately before any extension-specific decision is made.
alter default privileges for role postgres in schema public
  revoke execute on routines from public, anon, authenticated, app_tenant_runtime;
alter default privileges for role postgres in schema public
  grant execute on routines to service_role;

do $task3d_functions$
declare
  reviewed_rpcs constant text[] := array[
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
  ];
  missing_rpcs text[];
  target record;
begin
  select array_agg(name order by name)
    into missing_rpcs
  from unnest(reviewed_rpcs) as name
  where not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = name
  );

  if missing_rpcs is not null then
    raise exception 'TASK3D_REQUIRED_RPCS_MISSING %', missing_rpcs;
  end if;

  for target in
    select p.oid::regprocedure as function_name, p.proname
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
  loop
    execute format(
      'revoke execute on function %s from public, anon, authenticated, app_tenant_runtime',
      target.function_name
    );
    execute format('grant execute on function %s to service_role', target.function_name);

    if target.proname = any(reviewed_rpcs) then
      execute format(
        'grant execute on function %s to app_tenant_runtime',
        target.function_name
      );
    end if;
  end loop;
end;
$task3d_functions$;

-- Guard against accidental role assignment at this preparation-only checkpoint.
do $task3d_final_guard$
declare
  runtime_role pg_roles%rowtype;
begin
  select * into runtime_role
  from pg_roles
  where rolname = 'app_tenant_runtime';

  if runtime_role.oid is null then
    raise exception 'TASK3D_RUNTIME_ROLE_NOT_CREATED';
  end if;

  if runtime_role.rolcanlogin
     or runtime_role.rolinherit
     or runtime_role.rolbypassrls then
    raise exception
      'TASK3D_RUNTIME_ROLE_FINAL_ATTRIBUTES_UNSAFE login=% inherit=% bypassrls=%',
      runtime_role.rolcanlogin,
      runtime_role.rolinherit,
      runtime_role.rolbypassrls;
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
    raise exception 'TASK3D_RUNTIME_ROLE_HAS_UNEXPECTED_MEMBERSHIP';
  end if;

  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relowner = runtime_role.oid
  ) or exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proowner = runtime_role.oid
  ) then
    raise exception 'TASK3D_RUNTIME_ROLE_OWNS_APPLICATION_OBJECT';
  end if;
end;
$task3d_final_guard$;

commit;

-- Rollback/disable note:
-- Do not drop this role or delete financial evidence. Before TASK3-E activation
-- it has no login/member and cannot affect the application. After activation,
-- remove a runtime login's membership to fail closed; preserve this audited role
-- and its grant history for investigation.
