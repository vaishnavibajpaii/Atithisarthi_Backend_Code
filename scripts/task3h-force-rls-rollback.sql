-- EMERGENCY ROLLBACK ONLY. Do not run during normal Task 3H activation.
-- Preserves RLS, policies, columns, constraints, grants, and all data.
begin;
set local lock_timeout='10s';
set local statement_timeout='5min';
do $task3h_no_force$
declare
  target_tables constant text[]:=array[
    'hotels','gallery_items','hotel_popup_notifications','login_page_branding','menu_categories','menu_combo_items','menu_combo_settings','menu_items','notification_events','room_booking_payments','room_bookings','room_images','testimonials','contact_submissions','food_order_bill_formats','food_order_bill_snapshots','guest_stays','hotel_feature_settings','hotel_floors','hotel_guest_profiles','hotel_notification_settings','hotel_ordering_settings','hotel_payment_route_settings','hotel_profiles','hotel_room_advance_policies','hotel_room_amenities','hotel_room_tax_settings','hotel_staff_access','inquiries','kds_settings','kitchen_stations','notification_card_acknowledgements','order_rounds','order_support_requests','orders','payment_intents','qr_customer_sessions','qr_event_outbox','qr_idempotency_records','qr_order_submissions','qr_staff_idempotency_records','reservations','restaurant_table_qr_tokens','restaurant_tables','room_checkout_bill_formats','room_checkout_bill_snapshots','room_housekeeping_tasks','room_maintenance','room_negotiated_rate_approvals','room_rate_plans','room_tax_rules','room_types','rooms','food_order_bill_audit','hotel_feature_setting_audit','hotel_ordering_settings_audit','kds_status_history','login_page_branding_audit','menu_category_audit','payment_attempts','payment_webhook_inbox','qr_security_events','room_booking_refunds','room_checkout_bill_audit','room_checkout_receipts','room_operation_audit','room_shifts','room_stay_rate_adjustments'
  ]::text[];
  table_name text;
begin
  if cardinality(target_tables)<>68 then raise exception 'TASK3H_ROLLBACK_MANIFEST_INVALID'; end if;
  foreach table_name in array target_tables loop execute format('alter table public.%I no force row level security',table_name); end loop;
end;
$task3h_no_force$;
commit;
