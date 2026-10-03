-- Task 3 / TASK3-C: canonical ownership and selected composite parent FKs.
-- Authorized pre-production database only. Run manually in Supabase SQL Editor.
--
-- Preconditions:
--   * TASK3-A and TASK3-B completed successfully;
--   * backend/scripts/task3-backfill-verify.sql reports 83/83 PASS.
--
-- This checkpoint does not install the restricted runtime role or RLS policies.
-- It keeps hotel_slug for compatibility, derives canonical ownership for legacy
-- writes, and rejects any supplied ownership that conflicts with hotels.slug.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '10min';

-- Fail closed if ownership has drifted since the approved TASK3-B verification.
do $task3c_preflight$
declare
  target record;
  issue_count bigint;
begin
  if exists (
    select 1
    from public.hotels h
    left join public.tenants t on t.id = h.tenant_id
    where h.tenant_id is null or t.id is null
  ) then
    raise exception 'TASK3C_HOTEL_TENANT_PREFLIGHT_FAILED';
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
      'select count(*) from public.%I r left join public.hotels h on h.slug = r.hotel_slug where '
      || case when target.allow_global_null then
        '(r.hotel_slug is null and (r.tenant_id is not null or r.property_id is not null)) '
        || 'or (r.hotel_slug is not null and (h.id is null or r.tenant_id is distinct from h.tenant_id or r.property_id is distinct from h.id))'
      else
        'r.hotel_slug is null or h.id is null or r.tenant_id is null or r.property_id is null '
        || 'or r.tenant_id is distinct from h.tenant_id or r.property_id is distinct from h.id'
      end,
      target.table_name
    ) into issue_count;

    if issue_count <> 0 then
      raise exception 'TASK3C_OWNER_PREFLIGHT_FAILED table=% count=%',
        target.table_name, issue_count;
    end if;
  end loop;

  if exists (
    select 1 from public.payment_attempts a
    left join public.payment_intents i on i.id = a.payment_intent_id
    where i.id is null or a.tenant_id is null or a.property_id is null
       or a.tenant_id is distinct from i.tenant_id
       or a.property_id is distinct from i.property_id
  ) then
    raise exception 'TASK3C_PAYMENT_ATTEMPT_PREFLIGHT_FAILED';
  end if;

  if exists (
    select 1 from public.payment_webhook_inbox w
    left join public.payment_intents i on i.id = w.payment_intent_id
    where (w.payment_intent_id is null and
           (w.tenant_id is not null or w.property_id is not null))
       or (w.payment_intent_id is not null and
           (i.id is null or w.tenant_id is null or w.property_id is null
            or w.tenant_id is distinct from i.tenant_id
            or w.property_id is distinct from i.property_id))
  ) then
    raise exception 'TASK3C_WEBHOOK_INBOX_PREFLIGHT_FAILED';
  end if;
end;
$task3c_preflight$;

alter table public.hotels validate constraint hotels_tenant_id_fkey_task3;
alter table public.hotels alter column tenant_id set not null;

create unique index if not exists hotels_tenant_id_id_uidx
  on public.hotels (tenant_id, id);

-- Compatibility bridge for existing application writes. This is integrity
-- mapping only, not authorization: later RLS still compares the resulting IDs
-- with trusted transaction-local request context.
create or replace function public.task3c_apply_canonical_owner()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $task3c_owner_fn$
declare
  expected_tenant uuid;
  expected_property bigint;
  strict_scope boolean := coalesce(tg_argv[0], 'true')::boolean;
  normalized_slug text := nullif(btrim(new.hotel_slug), '');
begin
  if normalized_slug is null then
    if strict_scope then
      raise exception using errcode = '23514',
        message = format('TASK3C_PROPERTY_SCOPE_REQUIRED table=%s', tg_table_name);
    end if;
    if new.tenant_id is not null or new.property_id is not null then
      raise exception using errcode = '23514',
        message = format('TASK3C_GLOBAL_OWNER_CONFLICT table=%s', tg_table_name);
    end if;
    new.hotel_slug := null;
    return new;
  end if;

  select h.tenant_id, h.id
    into expected_tenant, expected_property
  from public.hotels h
  where h.slug = normalized_slug;

  if not found or expected_tenant is null then
    raise exception using errcode = '23503',
      message = format('TASK3C_UNKNOWN_PROPERTY table=%s', tg_table_name);
  end if;

  if new.tenant_id is not null and new.tenant_id is distinct from expected_tenant then
    raise exception using errcode = '23514',
      message = format('TASK3C_TENANT_CONFLICT table=%s', tg_table_name);
  end if;
  if new.property_id is not null and new.property_id is distinct from expected_property then
    raise exception using errcode = '23514',
      message = format('TASK3C_PROPERTY_CONFLICT table=%s', tg_table_name);
  end if;

  new.hotel_slug := normalized_slug;
  new.tenant_id := expected_tenant;
  new.property_id := expected_property;
  return new;
end;
$task3c_owner_fn$;

revoke all on function public.task3c_apply_canonical_owner() from public, anon, authenticated;

do $task3c_direct_constraints$
declare
  target record;
  constraint_name text;
  pair_constraint_name text;
  trigger_name text;
  index_name text;
begin
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
    constraint_name := 'task3c_owner_fk_' || substr(md5(target.table_name), 1, 12);
    pair_constraint_name := 'task3c_owner_pair_ck_' || substr(md5(target.table_name), 1, 12);
    trigger_name := 'task3c_owner_trg_' || substr(md5(target.table_name), 1, 12);
    index_name := 'task3c_owner_idx_' || substr(md5(target.table_name), 1, 12);

    execute format(
      'create index if not exists %I on public.%I (tenant_id, property_id)',
      index_name, target.table_name
    );

    if not exists (
      select 1 from pg_constraint
      where conrelid = format('public.%I', target.table_name)::regclass
        and conname = constraint_name
    ) then
      execute format(
        'alter table public.%I add constraint %I foreign key (tenant_id, property_id) references public.hotels(tenant_id, id) on update restrict on delete restrict not valid',
        target.table_name, constraint_name
      );
    end if;
    execute format(
      'alter table public.%I validate constraint %I',
      target.table_name, constraint_name
    );

    if not exists (
      select 1 from pg_constraint
      where conrelid = format('public.%I', target.table_name)::regclass
        and conname = pair_constraint_name
    ) then
      execute format(
        'alter table public.%I add constraint %I check ((tenant_id is null) = (property_id is null)) not valid',
        target.table_name, pair_constraint_name
      );
    end if;
    execute format(
      'alter table public.%I validate constraint %I',
      target.table_name, pair_constraint_name
    );

    execute format('drop trigger if exists %I on public.%I', trigger_name, target.table_name);
    execute format(
      'create trigger %I before insert or update of hotel_slug, tenant_id, property_id on public.%I for each row execute function public.task3c_apply_canonical_owner(%L)',
      trigger_name, target.table_name, (not target.allow_global_null)::text
    );

    if not target.allow_global_null then
      execute format('alter table public.%I alter column tenant_id set not null', target.table_name);
      execute format('alter table public.%I alter column property_id set not null', target.table_name);
    end if;
  end loop;
end;
$task3c_direct_constraints$;

-- Payment attempts and linked webhook inbox rows inherit ownership only from
-- the authoritative internal PaymentIntent, never from provider payload data.
create or replace function public.task3c_inherit_payment_owner()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $task3c_payment_owner_fn$
declare
  expected_tenant uuid;
  expected_property bigint;
  intent_required boolean := coalesce(tg_argv[0], 'false')::boolean;
begin
  if new.payment_intent_id is null then
    if intent_required then
      raise exception using errcode = '23514', message = 'TASK3C_PAYMENT_INTENT_REQUIRED';
    end if;
    if new.tenant_id is not null or new.property_id is not null then
      raise exception using errcode = '23514', message = 'TASK3C_UNLINKED_WEBHOOK_OWNER_CONFLICT';
    end if;
    return new;
  end if;

  select i.tenant_id, i.property_id
    into expected_tenant, expected_property
  from public.payment_intents i
  where i.id = new.payment_intent_id;

  if not found or expected_tenant is null or expected_property is null then
    raise exception using errcode = '23503', message = 'TASK3C_PAYMENT_INTENT_OWNER_MISSING';
  end if;
  if new.tenant_id is not null and new.tenant_id is distinct from expected_tenant then
    raise exception using errcode = '23514', message = 'TASK3C_PAYMENT_TENANT_CONFLICT';
  end if;
  if new.property_id is not null and new.property_id is distinct from expected_property then
    raise exception using errcode = '23514', message = 'TASK3C_PAYMENT_PROPERTY_CONFLICT';
  end if;

  new.tenant_id := expected_tenant;
  new.property_id := expected_property;
  return new;
end;
$task3c_payment_owner_fn$;

revoke all on function public.task3c_inherit_payment_owner() from public, anon, authenticated;

create unique index if not exists task3c_payment_intent_owner_id_uidx
  on public.payment_intents (tenant_id, property_id, id);

do $task3c_payment_constraints$
declare
  constraint_name text;
begin
  constraint_name := 'task3c_payment_attempt_intent_owner_fk';
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.payment_attempts'::regclass and conname = constraint_name
  ) then
    alter table public.payment_attempts
      add constraint task3c_payment_attempt_intent_owner_fk
      foreign key (tenant_id, property_id, payment_intent_id)
      references public.payment_intents(tenant_id, property_id, id)
      on update restrict on delete restrict not valid;
  end if;
  alter table public.payment_attempts
    validate constraint task3c_payment_attempt_intent_owner_fk;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.payment_webhook_inbox'::regclass
      and conname = 'task3c_webhook_intent_owner_fk'
  ) then
    alter table public.payment_webhook_inbox
      add constraint task3c_webhook_intent_owner_fk
      foreign key (tenant_id, property_id, payment_intent_id)
      references public.payment_intents(tenant_id, property_id, id)
      on update restrict on delete restrict not valid;
  end if;
  alter table public.payment_webhook_inbox
    validate constraint task3c_webhook_intent_owner_fk;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.payment_webhook_inbox'::regclass
      and conname = 'task3c_webhook_owner_link_ck'
  ) then
    alter table public.payment_webhook_inbox
      add constraint task3c_webhook_owner_link_ck check (
        (payment_intent_id is null and tenant_id is null and property_id is null)
        or
        (payment_intent_id is not null and tenant_id is not null and property_id is not null)
      ) not valid;
  end if;
  alter table public.payment_webhook_inbox
    validate constraint task3c_webhook_owner_link_ck;
end;
$task3c_payment_constraints$;

drop trigger if exists task3c_payment_attempt_owner_trg on public.payment_attempts;
create trigger task3c_payment_attempt_owner_trg
before insert or update of payment_intent_id, tenant_id, property_id
on public.payment_attempts for each row
execute function public.task3c_inherit_payment_owner('true');

drop trigger if exists task3c_webhook_inbox_owner_trg on public.payment_webhook_inbox;
create trigger task3c_webhook_inbox_owner_trg
before insert or update of payment_intent_id, tenant_id, property_id
on public.payment_webhook_inbox for each row
execute function public.task3c_inherit_payment_owner('false');

alter table public.payment_attempts alter column tenant_id set not null;
alter table public.payment_attempts alter column property_id set not null;

-- Legacy payment_webhook_events has no authoritative PaymentIntent link. Keep
-- its evidence rows explicitly unowned instead of fabricating tenant ownership.
do $task3c_legacy_webhook$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.payment_webhook_events'::regclass
      and conname = 'task3c_legacy_webhook_unowned_ck'
  ) then
    alter table public.payment_webhook_events
      add constraint task3c_legacy_webhook_unowned_ck
      check (tenant_id is null and property_id is null) not valid;
  end if;
  alter table public.payment_webhook_events
    validate constraint task3c_legacy_webhook_unowned_ck;
end;
$task3c_legacy_webhook$;

-- Selected high-value relationships with proven deployed types. Existing
-- single-column FKs remain in place; these composite FKs add owner agreement.
do $task3c_parent_constraints$
declare
  rel record;
  parent_index_name text;
  constraint_name text;
begin
  for rel in
    select * from (values
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
    ) as v(child_table, child_column, parent_table)
  loop
    parent_index_name := 'task3c_parent_uidx_' || substr(md5(rel.parent_table), 1, 12);
    constraint_name := 'task3c_parent_fk_' ||
      substr(md5(rel.child_table || ':' || rel.child_column || ':' || rel.parent_table), 1, 12);

    execute format(
      'create unique index if not exists %I on public.%I (tenant_id, property_id, id)',
      parent_index_name, rel.parent_table
    );

    if not exists (
      select 1 from pg_constraint
      where conrelid = format('public.%I', rel.child_table)::regclass
        and conname = constraint_name
    ) then
      execute format(
        'alter table public.%I add constraint %I foreign key (tenant_id, property_id, %I) references public.%I(tenant_id, property_id, id) on update restrict on delete no action not valid',
        rel.child_table, constraint_name, rel.child_column, rel.parent_table
      );
    end if;
    execute format(
      'alter table public.%I validate constraint %I',
      rel.child_table, constraint_name
    );
  end loop;
end;
$task3c_parent_constraints$;

notify pgrst, 'reload schema';

commit;
