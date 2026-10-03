-- Task 3 / TASK3-C read-only verification.
-- Run only after task3-tenant-isolation-constraints.sql succeeds.
-- Returns catalog/count evidence only; no customer PII is selected.
-- Expected: every row reports PASS.

with direct_specs(table_name, allow_global_null) as (
  values
    ('contact_submissions', false), ('food_order_bill_audit', false),
    ('food_order_bill_formats', false), ('food_order_bill_snapshots', false),
    ('gallery_items', false), ('guest_stays', false),
    ('hotel_feature_setting_audit', false), ('hotel_feature_settings', false),
    ('hotel_floors', false), ('hotel_guest_profiles', false),
    ('hotel_notification_settings', false), ('hotel_ordering_settings', false),
    ('hotel_ordering_settings_audit', false),
    ('hotel_payment_route_settings', false), ('hotel_popup_notifications', false),
    ('hotel_profiles', false), ('hotel_room_advance_policies', false),
    ('hotel_room_amenities', false), ('hotel_room_tax_settings', false),
    ('hotel_staff_access', false), ('inquiries', false),
    ('kds_settings', false), ('kds_status_history', false),
    ('kitchen_stations', false), ('login_page_branding', true),
    ('login_page_branding_audit', true), ('menu_categories', false),
    ('menu_category_audit', false), ('menu_combo_items', false),
    ('menu_combo_settings', false), ('menu_items', false),
    ('notification_card_acknowledgements', false), ('notification_events', false),
    ('order_rounds', false), ('order_support_requests', false),
    ('orders', false), ('payment_intents', false),
    ('qr_customer_sessions', false), ('qr_event_outbox', false),
    ('qr_idempotency_records', false), ('qr_order_submissions', false),
    ('qr_security_events', true), ('qr_staff_idempotency_records', false),
    ('reservations', false), ('restaurant_table_qr_tokens', false),
    ('restaurant_tables', false), ('room_booking_payments', false),
    ('room_booking_refunds', false), ('room_bookings', false),
    ('room_checkout_bill_audit', false), ('room_checkout_bill_formats', false),
    ('room_checkout_bill_snapshots', false), ('room_checkout_receipts', false),
    ('room_housekeeping_tasks', false), ('room_images', false),
    ('room_maintenance', false), ('room_negotiated_rate_approvals', false),
    ('room_operation_audit', false), ('room_rate_plans', false),
    ('room_shifts', false), ('room_stay_rate_adjustments', false),
    ('room_tax_rules', false), ('room_types', false), ('rooms', false),
    ('testimonials', false)
),
relation_specs(child_table, child_column, parent_table) as (
  values
    ('rooms', 'room_type_id', 'room_types'),
    ('rooms', 'floor_id', 'hotel_floors'),
    ('room_rate_plans', 'room_type_id', 'room_types'),
    ('room_rate_plans', 'room_id', 'rooms'),
    ('room_bookings', 'room_id', 'rooms'),
    ('room_bookings', 'rate_plan_id', 'room_rate_plans'),
    ('room_bookings', 'previous_room_id', 'rooms'),
    ('room_bookings', 'tax_rule_id', 'room_tax_rules'),
    ('guest_stays', 'booking_id', 'room_bookings'),
    ('guest_stays', 'guest_profile_id', 'hotel_guest_profiles'),
    ('guest_stays', 'room_id', 'rooms'),
    ('room_housekeeping_tasks', 'room_id', 'rooms'),
    ('room_housekeeping_tasks', 'booking_id', 'room_bookings'),
    ('room_maintenance', 'room_id', 'rooms'),
    ('room_shifts', 'booking_id', 'room_bookings'),
    ('room_shifts', 'stay_id', 'guest_stays'),
    ('room_shifts', 'from_room_id', 'rooms'),
    ('room_shifts', 'to_room_id', 'rooms'),
    ('room_negotiated_rate_approvals', 'booking_id', 'room_bookings'),
    ('room_stay_rate_adjustments', 'booking_id', 'room_bookings'),
    ('room_booking_payments', 'booking_id', 'room_bookings'),
    ('room_booking_refunds', 'booking_id', 'room_bookings'),
    ('room_checkout_receipts', 'booking_id', 'room_bookings'),
    ('room_checkout_bill_snapshots', 'booking_id', 'room_bookings'),
    ('room_checkout_bill_snapshots', 'checkout_receipt_id', 'room_checkout_receipts'),
    ('room_images', 'room_id', 'rooms'),
    ('room_images', 'room_type_id', 'room_types'),
    ('orders', 'room_id', 'rooms'),
    ('orders', 'room_booking_id', 'room_bookings'),
    ('orders', 'restaurant_table_id', 'restaurant_tables'),
    ('restaurant_table_qr_tokens', 'restaurant_table_id', 'restaurant_tables'),
    ('qr_customer_sessions', 'restaurant_table_id', 'restaurant_tables'),
    ('qr_customer_sessions', 'qr_token_id', 'restaurant_table_qr_tokens'),
    ('qr_order_submissions', 'restaurant_table_id', 'restaurant_tables'),
    ('qr_order_submissions', 'qr_session_id', 'qr_customer_sessions'),
    ('qr_idempotency_records', 'qr_session_id', 'qr_customer_sessions'),
    ('room_checkout_bill_audit', 'snapshot_id', 'room_checkout_bill_snapshots'),
    ('food_order_bill_audit', 'snapshot_id', 'food_order_bill_snapshots'),
    ('login_page_branding_audit', 'branding_id', 'login_page_branding')
),
public_tables as (
  select c.oid, c.relrowsecurity, c.relforcerowsecurity
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
),
checks(check_name, expected, actual) as (
  select 'approved_tenant_count', '10', count(*)::text
  from public.tenants

  union all
  select 'assigned_property_count', '10', count(*)::text
  from public.hotels where tenant_id is not null

  union all
  select 'hotel_tenant_orphans', '0', count(*)::text
  from public.hotels h
  left join public.tenants t on t.id = h.tenant_id
  where h.tenant_id is null or t.id is null

  union all
  select 'hotels_tenant_fk_validated', 'true', coalesce(bool_and(c.convalidated), false)::text
  from pg_constraint c
  where c.conrelid = 'public.hotels'::regclass
    and c.conname = 'hotels_tenant_id_fkey_task3'
    and c.contype = 'f'

  union all
  select 'hotels_tenant_not_null', 'true', a.attnotnull::text
  from pg_attribute a
  where a.attrelid = 'public.hotels'::regclass
    and a.attname = 'tenant_id' and not a.attisdropped

  union all
  select 'direct_owner_fk_missing_or_unvalidated', '0', count(*)::text
  from direct_specs s
  where not exists (
    select 1 from pg_constraint c
    where c.conrelid = format('public.%I', s.table_name)::regclass
      and c.conname = 'task3c_owner_fk_' || substr(md5(s.table_name), 1, 12)
      and c.contype = 'f' and c.convalidated
      and c.confrelid = 'public.hotels'::regclass
  )

  union all
  select 'direct_owner_pair_check_missing_or_unvalidated', '0', count(*)::text
  from direct_specs s
  where not exists (
    select 1 from pg_constraint c
    where c.conrelid = format('public.%I', s.table_name)::regclass
      and c.conname = 'task3c_owner_pair_ck_' || substr(md5(s.table_name), 1, 12)
      and c.contype = 'c' and c.convalidated
  )

  union all
  select 'strict_owner_columns_still_nullable', '0', count(*)::text
  from direct_specs s
  cross join (values ('tenant_id'), ('property_id')) as col(column_name)
  left join pg_attribute a
    on a.attrelid = format('public.%I', s.table_name)::regclass
   and a.attname = col.column_name and not a.attisdropped
  where not s.allow_global_null and coalesce(a.attnotnull, false) = false

  union all
  select 'canonical_owner_trigger_missing_or_disabled', '0', count(*)::text
  from direct_specs s
  where not exists (
    select 1 from pg_trigger t
    where t.tgrelid = format('public.%I', s.table_name)::regclass
      and t.tgname = 'task3c_owner_trg_' || substr(md5(s.table_name), 1, 12)
      and not t.tgisinternal and t.tgenabled <> 'D'
  )

  union all
  select 'selected_parent_fk_missing_or_unvalidated', '0', count(*)::text
  from relation_specs r
  where not exists (
    select 1 from pg_constraint c
    where c.conrelid = format('public.%I', r.child_table)::regclass
      and c.conname = 'task3c_parent_fk_' ||
        substr(md5(r.child_table || ':' || r.child_column || ':' || r.parent_table), 1, 12)
      and c.contype = 'f' and c.convalidated
      and c.confrelid = format('public.%I', r.parent_table)::regclass
  )

  union all
  select 'payment_attempt_owner_issues', '0', count(*)::text
  from public.payment_attempts a
  left join public.payment_intents i on i.id = a.payment_intent_id
  where i.id is null or a.tenant_id is null or a.property_id is null
     or a.tenant_id is distinct from i.tenant_id
     or a.property_id is distinct from i.property_id

  union all
  select 'webhook_inbox_owner_issues', '0', count(*)::text
  from public.payment_webhook_inbox w
  left join public.payment_intents i on i.id = w.payment_intent_id
  where (w.payment_intent_id is null and
         (w.tenant_id is not null or w.property_id is not null))
     or (w.payment_intent_id is not null and
         (i.id is null or w.tenant_id is null or w.property_id is null
          or w.tenant_id is distinct from i.tenant_id
          or w.property_id is distinct from i.property_id))

  union all
  select 'legacy_webhook_events_with_unproven_ownership', '0', count(*)::text
  from public.payment_webhook_events
  where tenant_id is not null or property_id is not null

  union all
  select 'payment_owner_constraints_validated', '3', count(*)::text
  from pg_constraint c
  where c.convalidated and (
       (c.conrelid = 'public.payment_attempts'::regclass
        and c.conname = 'task3c_payment_attempt_intent_owner_fk')
    or (c.conrelid = 'public.payment_webhook_inbox'::regclass
        and c.conname in ('task3c_webhook_intent_owner_fk', 'task3c_webhook_owner_link_ck'))
  )

  union all
  select 'payment_owner_triggers_enabled', '2', count(*)::text
  from pg_trigger t
  where not t.tgisinternal and t.tgenabled <> 'D' and (
       (t.tgrelid = 'public.payment_attempts'::regclass
        and t.tgname = 'task3c_payment_attempt_owner_trg')
    or (t.tgrelid = 'public.payment_webhook_inbox'::regclass
        and t.tgname = 'task3c_webhook_inbox_owner_trg')
  )

  union all
  select 'owner_trigger_functions_not_publicly_executable', 'true', (
    not has_function_privilege('anon', 'public.task3c_apply_canonical_owner()', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.task3c_apply_canonical_owner()', 'EXECUTE')
    and not has_function_privilege('anon', 'public.task3c_inherit_payment_owner()', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.task3c_inherit_payment_owner()', 'EXECUTE')
  )::text

  union all
  select 'all_public_tables_rls_enabled', '0',
    count(*) filter (where not relrowsecurity)::text
  from public_tables

  union all
  select 'force_rls_not_prematurely_enabled', '0',
    count(*) filter (where relforcerowsecurity)::text
  from public_tables

  union all
  select 'rls_policies_not_yet_installed', '0', count(*)::text
  from pg_policies where schemaname in ('public', 'storage')

  union all
  select 'anon_authenticated_effective_table_privileges', '0', count(*)::text
  from public_tables t
  cross join (values ('anon'), ('authenticated')) as r(role_name)
  cross join (values
    ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
    ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')
  ) as p(privilege_name)
  where has_table_privilege(r.role_name, t.oid, p.privilege_name)

  union all
  select 'service_role_payment_rpc_preserved', 'true', (
    has_function_privilege(
      'service_role',
      'public.finalize_captured_payment(uuid,text,text,text,text,bigint,text,text,text,text)',
      'EXECUTE'
    ) and
    has_function_privilege(
      'service_role',
      'public.claim_payment_webhook(text,integer,integer)',
      'EXECUTE'
    )
  )::text
)
select
  check_name,
  expected,
  actual,
  case when actual = expected then 'PASS' else 'FAIL' end as result
from checks
order by check_name;
