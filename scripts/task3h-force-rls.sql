-- Task 3H final FORCE RLS activation for the exact reviewed 68-table manifest.
-- Data-preserving and transactional. Does not change policies, grants, or rows.
begin;
set local lock_timeout='10s';
set local statement_timeout='5min';
set local search_path=pg_catalog,public;
do $task3h_force_rls$
declare
  target_tables constant text[]:=array[
    'hotels','gallery_items','hotel_popup_notifications','login_page_branding','menu_categories','menu_combo_items','menu_combo_settings','menu_items','notification_events','room_booking_payments','room_bookings','room_images','testimonials','contact_submissions','food_order_bill_formats','food_order_bill_snapshots','guest_stays','hotel_feature_settings','hotel_floors','hotel_guest_profiles','hotel_notification_settings','hotel_ordering_settings','hotel_payment_route_settings','hotel_profiles','hotel_room_advance_policies','hotel_room_amenities','hotel_room_tax_settings','hotel_staff_access','inquiries','kds_settings','kitchen_stations','notification_card_acknowledgements','order_rounds','order_support_requests','orders','payment_intents','qr_customer_sessions','qr_event_outbox','qr_idempotency_records','qr_order_submissions','qr_staff_idempotency_records','reservations','restaurant_table_qr_tokens','restaurant_tables','room_checkout_bill_formats','room_checkout_bill_snapshots','room_housekeeping_tasks','room_maintenance','room_negotiated_rate_approvals','room_rate_plans','room_tax_rules','room_types','rooms','food_order_bill_audit','hotel_feature_setting_audit','hotel_ordering_settings_audit','kds_status_history','login_page_branding_audit','menu_category_audit','payment_attempts','payment_webhook_inbox','qr_security_events','room_booking_refunds','room_checkout_bill_audit','room_checkout_receipts','room_operation_audit','room_shifts','room_stay_rate_adjustments'
  ]::text[];
  table_name text;
  bad_count bigint;
begin
  if cardinality(target_tables)<>68 or cardinality(array(select distinct unnest(target_tables)))<>68 then raise exception 'TASK3H_TARGET_MANIFEST_INVALID'; end if;
  select count(*) into bad_count from unnest(target_tables) t(name) where to_regclass(format('public.%I',t.name)) is null;
  if bad_count<>0 then raise exception 'TASK3H_TARGET_TABLES_MISSING count=%',bad_count; end if;
  select count(*) into bad_count from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any(target_tables) and c.relkind in ('r','p') and not c.relrowsecurity;
  if bad_count<>0 then raise exception 'TASK3H_RLS_DISABLED count=%',bad_count; end if;
  select count(*) into bad_count from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any(target_tables) and (select oid from pg_roles where rolname='app_tenant_runtime')=any(p.polroles) and (select oid from pg_roles where rolname='app_tenant_rpc_owner')=any(p.polroles);
  if bad_count<>199 then raise exception 'TASK3H_POLICY_MANIFEST_DRIFT count=%',bad_count; end if;
  select count(*) into bad_count from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any(target_tables) and c.relforcerowsecurity;
  if bad_count<>0 then raise exception 'TASK3H_FORCE_RLS_ALREADY_OR_PARTIALLY_ENABLED count=%',bad_count; end if;
  if not exists(select 1 from pg_roles where rolname='app_tenant_runtime' and rolcanlogin and not rolsuper and not rolbypassrls)
     or not exists(select 1 from pg_roles where rolname='app_tenant_rpc_owner' and not rolcanlogin and not rolsuper and not rolbypassrls)
     or not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls) then
    raise exception 'TASK3H_ROLE_SAFETY_GUARD_FAILED';
  end if;
  foreach table_name in array target_tables loop
    execute format('alter table public.%I force row level security',table_name);
  end loop;
  select count(*) into bad_count from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any(target_tables) and c.relkind in ('r','p') and c.relforcerowsecurity;
  if bad_count<>68 then raise exception 'TASK3H_FORCE_RLS_FINAL_GUARD_FAILED count=%',bad_count; end if;
end;
$task3h_force_rls$;
commit;
