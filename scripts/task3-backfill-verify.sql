-- Task 3 / TASK3-B read-only backfill verification.
-- Run only after task3-tenant-isolation-backfill.sql succeeds.
-- Returns counts and statuses only; it does not return customer PII.
-- Expected: every row reports PASS.

with table_specs(table_name, allow_global_null) as (
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
approved_inquiries(
  inquiry_id, expected_created_at, expected_hotel_name, property_slug
) as (
  values
    (1::bigint, '2026-04-05 10:58:14.69488+00'::timestamptz,
      'Hotel Sai Raj'::text, 'hotel-sai-raj'::text),
    (2::bigint, '2026-04-05 10:59:03.479938+00'::timestamptz,
      'Hotel Sai Raj'::text, 'hotel-sai-raj'::text),
    (3::bigint, '2026-04-05 11:07:34.123265+00'::timestamptz,
      'Hotel Sai Raj'::text, 'hotel-sai-raj'::text)
),
approved_orders(
  order_id, expected_created_at, expected_hotel_name, property_slug
) as (
  values
    ('1'::text, '2026-04-05 10:55:58.248082+00'::timestamptz,
      'Hotel Sai Raj'::text, 'hotel-sai-raj'::text),
    ('2'::text, '2026-04-05 12:45:14.566029+00'::timestamptz,
      'Hotel Sai Raj'::text, 'hotel-sai-raj'::text),
    ('24'::text, '2026-04-10 07:33:08.482016+00'::timestamptz,
      'Hotel Sai Raj'::text, 'hotel-sai-raj'::text)
),
table_xml as (
  select
    s.table_name,
    query_to_xml(
      format(
        'select count(*)::bigint as issue_count from public.%I r left join public.hotels h on h.slug = r.hotel_slug where (r.hotel_slug is not null and (btrim(r.hotel_slug) = '''' or h.id is null or r.tenant_id is distinct from h.tenant_id or r.property_id is distinct from h.id)) or (r.hotel_slug is null and (%s))',
        s.table_name,
        case
          when s.allow_global_null
            then '(r.tenant_id is not null or r.property_id is not null)'
          else 'true'
        end
      ),
      true,
      false,
      ''
    ) as result_xml
  from table_specs s
),
table_issues as (
  select
    table_name,
    (((xpath('/table/row/issue_count/text()', result_xml))[1])::text)::bigint
      as issue_count
  from table_xml
),
public_tables as (
  select c.oid, c.relrowsecurity, c.relforcerowsecurity
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
),
checks as (
  select 'approved_tenant_count'::text as check_name,
    '10'::text as expected,
    count(*)::text as actual
  from public.tenants

  union all
  select 'approved_property_count', '10', count(*)::text
  from public.hotels

  union all
  select 'hotel_tenant_mapping_mismatch', '0', count(*)::text
  from public.hotels h
  left join public.tenants t on t.id = h.tenant_id
  where t.id is null or t.tenant_key is distinct from h.slug

  union all
  select 'tenant_property_cardinality_mismatch', '0', count(*)::text
  from (
    select t.id
    from public.tenants t
    left join public.hotels h on h.tenant_id = t.id
    group by t.id
    having count(h.id) <> 1
       or min(h.slug) is distinct from min(t.tenant_key)
  ) mismatches

  union all
  select 'direct_table_total_ownership_issues', '0',
    coalesce(sum(issue_count), 0)::text
  from table_issues

  union all
  select 'approved_legacy_inquiry_mapping_mismatch', '0', count(*)::text
  from approved_inquiries a
  left join public.inquiries i on i.id = a.inquiry_id
  left join public.hotels h on h.slug = a.property_slug
  where i.id is null
     or i.created_at is distinct from a.expected_created_at
     or lower(btrim(i.hotel_name)) is distinct from lower(a.expected_hotel_name)
     or i.hotel_slug is distinct from a.property_slug
     or i.tenant_id is distinct from h.tenant_id
     or i.property_id is distinct from h.id

  union all
  select 'removed_green_palace_inquiry_present', '0', count(*)::text
  from public.inquiries i
  where i.id = 4
    and i.created_at = '2026-04-05 12:56:03.079129+00'::timestamptz
    and lower(btrim(i.hotel_name)) = lower('Hotel Green Palace')

  union all
  select 'approved_legacy_order_mapping_mismatch', '0', count(*)::text
  from approved_orders a
  left join public.orders o on o.id::text = a.order_id
  left join public.hotels h on h.slug = a.property_slug
  where o.id is null
     or o.created_at is distinct from a.expected_created_at
     or lower(btrim(o.hotel_name)) is distinct from lower(a.expected_hotel_name)
     or o.hotel_slug is distinct from a.property_slug
     or o.tenant_id is distinct from h.tenant_id
     or o.property_id is distinct from h.id

  union all
  select 'table:' || table_name || ':ownership_issues', '0', issue_count::text
  from table_issues

  union all
  select 'branding_audit_scope_conflicts', '0', count(*)::text
  from public.login_page_branding_audit
  where (scope_type = 'hotel' and hotel_slug is null)
     or (scope_type = 'platform' and hotel_slug is not null)

  union all
  select 'payment_attempt_ownership_issues', '0', count(*)::text
  from public.payment_attempts a
  left join public.payment_intents i on i.id = a.payment_intent_id
  where i.id is null
     or i.tenant_id is null
     or i.property_id is null
     or a.tenant_id is distinct from i.tenant_id
     or a.property_id is distinct from i.property_id

  union all
  select 'linked_webhook_inbox_ownership_issues', '0', count(*)::text
  from public.payment_webhook_inbox w
  left join public.payment_intents i on i.id = w.payment_intent_id
  where w.payment_intent_id is not null
    and (
      i.id is null
      or i.tenant_id is null
      or i.property_id is null
      or w.tenant_id is distinct from i.tenant_id
      or w.property_id is distinct from i.property_id
    )

  union all
  select 'unlinked_webhook_inbox_with_ownership', '0', count(*)::text
  from public.payment_webhook_inbox
  where payment_intent_id is null
    and (tenant_id is not null or property_id is not null)

  union all
  select 'legacy_webhook_events_with_unproven_ownership', '0', count(*)::text
  from public.payment_webhook_events
  where tenant_id is not null or property_id is not null

  union all
  select 'all_public_tables_rls_enabled', '0',
    count(*) filter (where not relrowsecurity)::text
  from public_tables

  union all
  select 'force_rls_not_prematurely_enabled', '0',
    count(*) filter (where relforcerowsecurity)::text
  from public_tables

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
  select 'rls_policies_not_yet_installed', '0', count(*)::text
  from pg_policies
  where schemaname in ('public', 'storage')

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
