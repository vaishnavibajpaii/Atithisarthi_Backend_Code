-- Task 3 / TASK3-B: deterministic tenant/property ownership backfill.
-- Authorized pre-production database only. Run manually in Supabase SQL Editor.
--
-- Approved decision: all 10 current properties are separate tenants and each
-- property_slug is its tenant_key. This script is one PL/pgSQL DO statement:
-- it creates no helper schema/table/procedure, and any error rolls back every
-- business-data write performed by this statement.

do $task3b$
declare
  v_property_map constant jsonb := '[
    {"property_id":1,"property_slug":"hotel-sai-raj","tenant_key":"hotel-sai-raj","tenant_display_name":"hotel-sai-raj"},
    {"property_id":2,"property_slug":"the-food-garden","tenant_key":"the-food-garden","tenant_display_name":"the-food-garden"},
    {"property_id":3,"property_slug":"hotel-celebration","tenant_key":"hotel-celebration","tenant_display_name":"hotel-celebration"},
    {"property_id":4,"property_slug":"hotel-siyaram","tenant_key":"hotel-siyaram","tenant_display_name":"hotel-siyaram"},
    {"property_id":5,"property_slug":"hotel-golden-leaf","tenant_key":"hotel-golden-leaf","tenant_display_name":"hotel-golden-leaf"},
    {"property_id":6,"property_slug":"coffee-club-ujjain","tenant_key":"coffee-club-ujjain","tenant_display_name":"coffee-club-ujjain"},
    {"property_id":7,"property_slug":"hotel-skyroof","tenant_key":"hotel-skyroof","tenant_display_name":"hotel-skyroof"},
    {"property_id":8,"property_slug":"snacky-hut","tenant_key":"snacky-hut","tenant_display_name":"snacky-hut"},
    {"property_id":9,"property_slug":"meridian-restaurant-ujjain","tenant_key":"meridian-restaurant-ujjain","tenant_display_name":"meridian-restaurant-ujjain"},
    {"property_id":10,"property_slug":"gapshap-cafe-ujjain","tenant_key":"gapshap-cafe-ujjain","tenant_display_name":"gapshap-cafe-ujjain"}
  ]'::jsonb;
  v_inquiry_map constant jsonb := '[
    {"inquiry_id":1,"expected_created_at":"2026-04-05 10:58:14.69488+00","expected_hotel_name":"Hotel Sai Raj","property_slug":"hotel-sai-raj"},
    {"inquiry_id":2,"expected_created_at":"2026-04-05 10:59:03.479938+00","expected_hotel_name":"Hotel Sai Raj","property_slug":"hotel-sai-raj"},
    {"inquiry_id":3,"expected_created_at":"2026-04-05 11:07:34.123265+00","expected_hotel_name":"Hotel Sai Raj","property_slug":"hotel-sai-raj"}
  ]'::jsonb;
  v_order_map constant jsonb := '[
    {"order_id":"1","expected_created_at":"2026-04-05 10:55:58.248082+00","expected_hotel_name":"Hotel Sai Raj","property_slug":"hotel-sai-raj"},
    {"order_id":"2","expected_created_at":"2026-04-05 12:45:14.566029+00","expected_hotel_name":"Hotel Sai Raj","property_slug":"hotel-sai-raj"},
    {"order_id":"24","expected_created_at":"2026-04-10 07:33:08.482016+00","expected_hotel_name":"Hotel Sai Raj","property_slug":"hotel-sai-raj"}
  ]'::jsonb;
  target_table text;
  target record;
  issue_count bigint;
begin
  perform set_config('lock_timeout', '10s', true);
  perform set_config('statement_timeout', '5min', true);

  execute 'lock table public.tenants, public.hotels in share row exclusive mode';
  foreach target_table in array array[
    'contact_submissions', 'food_order_bill_audit',
    'food_order_bill_formats', 'food_order_bill_snapshots', 'gallery_items',
    'guest_stays', 'hotel_feature_setting_audit', 'hotel_feature_settings',
    'hotel_floors', 'hotel_guest_profiles', 'hotel_notification_settings',
    'hotel_ordering_settings', 'hotel_ordering_settings_audit',
    'hotel_payment_route_settings', 'hotel_popup_notifications',
    'hotel_profiles', 'hotel_room_advance_policies', 'hotel_room_amenities',
    'hotel_room_tax_settings', 'hotel_staff_access', 'inquiries',
    'kds_settings', 'kds_status_history', 'kitchen_stations',
    'login_page_branding', 'login_page_branding_audit', 'menu_categories',
    'menu_category_audit', 'menu_combo_items', 'menu_combo_settings',
    'menu_items', 'notification_card_acknowledgements', 'notification_events',
    'order_rounds', 'order_support_requests', 'orders', 'payment_intents',
    'qr_customer_sessions', 'qr_event_outbox', 'qr_idempotency_records',
    'qr_order_submissions', 'qr_security_events',
    'qr_staff_idempotency_records', 'reservations',
    'restaurant_table_qr_tokens', 'restaurant_tables',
    'room_booking_payments', 'room_booking_refunds', 'room_bookings',
    'room_checkout_bill_audit', 'room_checkout_bill_formats',
    'room_checkout_bill_snapshots', 'room_checkout_receipts',
    'room_housekeeping_tasks', 'room_images', 'room_maintenance',
    'room_negotiated_rate_approvals', 'room_operation_audit',
    'room_rate_plans', 'room_shifts', 'room_stay_rate_adjustments',
    'room_tax_rules', 'room_types', 'rooms', 'testimonials',
    'payment_attempts', 'payment_webhook_events', 'payment_webhook_inbox'
  ]
  loop
    execute format('lock table public.%I in share row exclusive mode', target_table);
  end loop;

  if jsonb_array_length(v_property_map) <> 10 then
    raise exception 'TASK3B_APPROVED_MAPPING_COUNT_MISMATCH';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_property_map) as m(
      property_id bigint, property_slug text, tenant_key text,
      tenant_display_name text
    )
    left join public.hotels h
      on h.id = m.property_id and h.slug = m.property_slug
    where h.id is null
  ) then
    raise exception 'TASK3B_APPROVED_PROPERTY_NOT_FOUND_OR_SLUG_CHANGED';
  end if;

  if exists (
    select 1
    from public.hotels h
    left join jsonb_to_recordset(v_property_map) as m(
      property_id bigint, property_slug text, tenant_key text,
      tenant_display_name text
    ) on m.property_id = h.id and m.property_slug = h.slug
    where m.property_id is null
  ) then
    raise exception 'TASK3B_UNAPPROVED_PROPERTY_PRESENT';
  end if;

  if exists (
    select 1
    from public.tenants t
    left join jsonb_to_recordset(v_property_map) as m(
      property_id bigint, property_slug text, tenant_key text,
      tenant_display_name text
    ) on m.tenant_key = t.tenant_key
    where m.tenant_key is null
  ) then
    raise exception 'TASK3B_UNAPPROVED_TENANT_PRESENT';
  end if;

  if jsonb_array_length(v_inquiry_map) <> 3 then
    raise exception 'TASK3B_APPROVED_INQUIRY_MAPPING_COUNT_MISMATCH';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_inquiry_map) as m(
      inquiry_id bigint, expected_created_at timestamptz,
      expected_hotel_name text, property_slug text
    )
    left join public.inquiries i
      on i.id = m.inquiry_id
     and i.created_at = m.expected_created_at
     and lower(btrim(i.hotel_name)) = lower(m.expected_hotel_name)
     and (nullif(btrim(i.hotel_slug), '') is null
       or i.hotel_slug = m.property_slug)
    where i.id is null
  ) then
    raise exception 'TASK3B_APPROVED_INQUIRY_NOT_FOUND_OR_CHANGED';
  end if;

  if exists (
    select 1
    from public.inquiries i
    left join jsonb_to_recordset(v_inquiry_map) as m(
      inquiry_id bigint, expected_created_at timestamptz,
      expected_hotel_name text, property_slug text
    ) on m.inquiry_id = i.id
    where nullif(btrim(i.hotel_slug), '') is null and m.inquiry_id is null
  ) then
    raise exception 'TASK3B_UNAPPROVED_BLANK_INQUIRY_PRESENT';
  end if;

  if exists (
    select 1 from public.inquiries i
    where i.id = 4
      and i.created_at = '2026-04-05 12:56:03.079129+00'::timestamptz
      and lower(btrim(i.hotel_name)) = lower('Hotel Green Palace')
  ) then
    raise exception 'TASK3B_REMOVED_GREEN_PALACE_INQUIRY_STILL_PRESENT';
  end if;

  if jsonb_array_length(v_order_map) <> 3 then
    raise exception 'TASK3B_APPROVED_ORDER_MAPPING_COUNT_MISMATCH';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_order_map) as m(
      order_id text, expected_created_at timestamptz,
      expected_hotel_name text, property_slug text
    )
    left join public.orders o
      on o.id::text = m.order_id
     and o.created_at = m.expected_created_at
     and lower(btrim(o.hotel_name)) = lower(m.expected_hotel_name)
     and (nullif(btrim(o.hotel_slug), '') is null
       or o.hotel_slug = m.property_slug)
    where o.id is null
  ) then
    raise exception 'TASK3B_APPROVED_ORDER_NOT_FOUND_OR_CHANGED';
  end if;

  if exists (
    select 1
    from public.orders o
    left join jsonb_to_recordset(v_order_map) as m(
      order_id text, expected_created_at timestamptz,
      expected_hotel_name text, property_slug text
    ) on m.order_id = o.id::text
    where nullif(btrim(o.hotel_slug), '') is null and m.order_id is null
  ) then
    raise exception 'TASK3B_UNAPPROVED_UNOWNED_ORDER_PRESENT';
  end if;

  insert into public.tenants (tenant_key, display_name)
  select tenant_key, tenant_display_name
  from jsonb_to_recordset(v_property_map) as m(
    property_id bigint, property_slug text, tenant_key text,
    tenant_display_name text
  )
  order by property_id
  on conflict (tenant_key) do nothing;

  if exists (
    select 1
    from jsonb_to_recordset(v_property_map) as m(
      property_id bigint, property_slug text, tenant_key text,
      tenant_display_name text
    )
    left join public.tenants t on t.tenant_key = m.tenant_key
    where t.id is null
  ) then
    raise exception 'TASK3B_TENANT_CREATION_INCOMPLETE';
  end if;

  if exists (
    select 1
    from public.hotels h
    join jsonb_to_recordset(v_property_map) as m(
      property_id bigint, property_slug text, tenant_key text,
      tenant_display_name text
    ) on m.property_id = h.id and m.property_slug = h.slug
    join public.tenants t on t.tenant_key = m.tenant_key
    where h.tenant_id is not null and h.tenant_id is distinct from t.id
  ) then
    raise exception 'TASK3B_CONFLICTING_EXISTING_HOTEL_TENANT';
  end if;

  -- Suppress user triggers only within this atomic statement so ownership-only
  -- updates cannot emit notifications or alter unrelated business/audit state.
  perform set_config('session_replication_role', 'replica', true);

  update public.hotels h
  set tenant_id = t.id
  from jsonb_to_recordset(v_property_map) as m(
    property_id bigint, property_slug text, tenant_key text,
    tenant_display_name text
  )
  join public.tenants t on t.tenant_key = m.tenant_key
  where h.id = m.property_id and h.slug = m.property_slug
    and h.tenant_id is distinct from t.id;

  update public.inquiries i
  set hotel_slug = m.property_slug
  from jsonb_to_recordset(v_inquiry_map) as m(
    inquiry_id bigint, expected_created_at timestamptz,
    expected_hotel_name text, property_slug text
  )
  where i.id = m.inquiry_id
    and i.created_at = m.expected_created_at
    and lower(btrim(i.hotel_name)) = lower(m.expected_hotel_name)
    and nullif(btrim(i.hotel_slug), '') is null;

  update public.orders o
  set hotel_slug = m.property_slug
  from jsonb_to_recordset(v_order_map) as m(
    order_id text, expected_created_at timestamptz,
    expected_hotel_name text, property_slug text
  )
  where o.id::text = m.order_id
    and o.created_at = m.expected_created_at
    and lower(btrim(o.hotel_name)) = lower(m.expected_hotel_name)
    and nullif(btrim(o.hotel_slug), '') is null;

  for target in
    select * from (values
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
    ) as v(table_name, allow_global_null)
  loop
    execute format(
      'select count(*) from public.%I where hotel_slug is not null and btrim(hotel_slug) = ''''',
      target.table_name
    ) into issue_count;
    if issue_count <> 0 then
      raise exception 'TASK3B_BLANK_HOTEL_SLUG table=% count=%', target.table_name, issue_count;
    end if;

    execute format(
      'select count(*) from public.%I r where r.hotel_slug is not null and not exists (select 1 from public.hotels h where h.slug = r.hotel_slug)',
      target.table_name
    ) into issue_count;
    if issue_count <> 0 then
      raise exception 'TASK3B_UNKNOWN_HOTEL_SLUG table=% count=%', target.table_name, issue_count;
    end if;

    if not target.allow_global_null then
      execute format(
        'select count(*) from public.%I where hotel_slug is null',
        target.table_name
      ) into issue_count;
      if issue_count <> 0 then
        raise exception 'TASK3B_UNOWNED_STRICT_ROW table=% count=%', target.table_name, issue_count;
      end if;
    else
      execute format(
        'select count(*) from public.%I where hotel_slug is null and (tenant_id is not null or property_id is not null)',
        target.table_name
      ) into issue_count;
      if issue_count <> 0 then
        raise exception 'TASK3B_GLOBAL_ROW_HAS_OWNERSHIP table=% count=%', target.table_name, issue_count;
      end if;
    end if;

    execute format(
      'select count(*) from public.%I r join public.hotels h on h.slug = r.hotel_slug where (r.tenant_id is not null and r.tenant_id is distinct from h.tenant_id) or (r.property_id is not null and r.property_id is distinct from h.id)',
      target.table_name
    ) into issue_count;
    if issue_count <> 0 then
      raise exception 'TASK3B_CONFLICTING_EXISTING_OWNERSHIP table=% count=%', target.table_name, issue_count;
    end if;

    execute format(
      'update public.%I r set tenant_id = h.tenant_id, property_id = h.id from public.hotels h where h.slug = r.hotel_slug and (r.tenant_id is distinct from h.tenant_id or r.property_id is distinct from h.id)',
      target.table_name
    );
  end loop;

  if exists (
    select 1 from public.login_page_branding_audit
    where (scope_type = 'hotel' and hotel_slug is null)
       or (scope_type = 'platform' and hotel_slug is not null)
  ) then
    raise exception 'TASK3B_BRANDING_AUDIT_SCOPE_CONFLICT';
  end if;

  if exists (
    select 1 from public.payment_attempts a
    left join public.payment_intents i on i.id = a.payment_intent_id
    where i.id is null or i.tenant_id is null or i.property_id is null
  ) then
    raise exception 'TASK3B_PAYMENT_ATTEMPT_PARENT_UNMAPPED';
  end if;

  if exists (
    select 1 from public.payment_attempts a
    join public.payment_intents i on i.id = a.payment_intent_id
    where (a.tenant_id is not null and a.tenant_id is distinct from i.tenant_id)
       or (a.property_id is not null and a.property_id is distinct from i.property_id)
  ) then
    raise exception 'TASK3B_PAYMENT_ATTEMPT_OWNERSHIP_CONFLICT';
  end if;

  update public.payment_attempts a
  set tenant_id = i.tenant_id, property_id = i.property_id
  from public.payment_intents i
  where i.id = a.payment_intent_id
    and (a.tenant_id is distinct from i.tenant_id
      or a.property_id is distinct from i.property_id);

  if exists (
    select 1 from public.payment_webhook_inbox w
    left join public.payment_intents i on i.id = w.payment_intent_id
    where w.payment_intent_id is not null
      and (i.id is null or i.tenant_id is null or i.property_id is null)
  ) then
    raise exception 'TASK3B_WEBHOOK_INBOX_PARENT_UNMAPPED';
  end if;

  if exists (
    select 1 from public.payment_webhook_inbox w
    join public.payment_intents i on i.id = w.payment_intent_id
    where (w.tenant_id is not null and w.tenant_id is distinct from i.tenant_id)
       or (w.property_id is not null and w.property_id is distinct from i.property_id)
  ) then
    raise exception 'TASK3B_WEBHOOK_INBOX_OWNERSHIP_CONFLICT';
  end if;

  if exists (
    select 1 from public.payment_webhook_inbox
    where payment_intent_id is null
      and (tenant_id is not null or property_id is not null)
  ) then
    raise exception 'TASK3B_UNLINKED_WEBHOOK_INBOX_HAS_OWNERSHIP';
  end if;

  if exists (
    select 1 from public.payment_webhook_events
    where tenant_id is not null or property_id is not null
  ) then
    raise exception 'TASK3B_LEGACY_WEBHOOK_EVENT_HAS_UNPROVEN_OWNERSHIP';
  end if;

  update public.payment_webhook_inbox w
  set tenant_id = i.tenant_id, property_id = i.property_id
  from public.payment_intents i
  where i.id = w.payment_intent_id
    and (w.tenant_id is distinct from i.tenant_id
      or w.property_id is distinct from i.property_id);

  perform set_config('session_replication_role', 'origin', true);

  if (select count(*) from public.tenants) <> 10 then
    raise exception 'TASK3B_FINAL_TENANT_COUNT_MISMATCH';
  end if;

  if exists (
    select 1
    from public.hotels h
    join jsonb_to_recordset(v_property_map) as m(
      property_id bigint, property_slug text, tenant_key text,
      tenant_display_name text
    ) on m.property_id = h.id and m.property_slug = h.slug
    join public.tenants t on t.tenant_key = m.tenant_key
    where h.tenant_id is distinct from t.id
  ) then
    raise exception 'TASK3B_FINAL_HOTEL_MAPPING_MISMATCH';
  end if;

  for target in
    select * from (values
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
    ) as v(table_name, allow_global_null)
  loop
    execute format(
      'select count(*) from public.%I r left join public.hotels h on h.slug = r.hotel_slug where (r.hotel_slug is not null and (h.id is null or r.tenant_id is distinct from h.tenant_id or r.property_id is distinct from h.id)) or (r.hotel_slug is null and (%s))',
      target.table_name,
      case when target.allow_global_null
        then '(r.tenant_id is not null or r.property_id is not null)'
        else 'true'
      end
    ) into issue_count;
    if issue_count <> 0 then
      raise exception 'TASK3B_FINAL_DIRECT_TABLE_OWNERSHIP_FAILURE table=% count=%', target.table_name, issue_count;
    end if;
  end loop;

  if exists (
    select 1 from public.payment_attempts a
    join public.payment_intents i on i.id = a.payment_intent_id
    where a.tenant_id is distinct from i.tenant_id
       or a.property_id is distinct from i.property_id
  ) then
    raise exception 'TASK3B_FINAL_PAYMENT_ATTEMPT_FAILURE';
  end if;

  if exists (
    select 1 from public.payment_webhook_inbox w
    join public.payment_intents i on i.id = w.payment_intent_id
    where w.tenant_id is distinct from i.tenant_id
       or w.property_id is distinct from i.property_id
  ) then
    raise exception 'TASK3B_FINAL_WEBHOOK_INBOX_FAILURE';
  end if;

  perform pg_notify('pgrst', 'reload schema');
end;
$task3b$;
