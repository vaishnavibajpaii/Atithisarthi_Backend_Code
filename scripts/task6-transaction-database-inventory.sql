-- Task 6 transactional-correctness database inventory.
-- READ ONLY: this file contains one SELECT statement. It creates, alters,
-- updates, deletes, grants, revokes, or executes application routines nowhere.
-- Run the entire file in the Supabase SQL Editor for the authorized TEST
-- environment and return the complete result grid (CSV preferred).
--
-- DATA MINIMIZATION:
--   * No guest/customer/staff names, phones, emails, addresses, notes, ID proof,
--     tokens, secrets, gateway payloads, JSON request context, or free text is read.
--   * Data-quality checks return aggregate counts only, never business row data.
--   * Function bodies are intentionally excluded. Routine identity, owner,
--     security mode, volatility, configuration, and grants are included.
--
-- INTERPRETATION:
--   * A zero count means no issue was observed by that check at execution time.
--   * A nonzero "candidate" check requires review; it is not an instruction to
--     auto-fix or delete legacy financial data.
--   * Catalog evidence here is authoritative for the database where it is run.
--   * tenants and legacy payment_webhook_events are intentionally outside the
--     exact Task 3H 68-table FORCE RLS manifest; both must still have RLS and
--     restricted grants. SECURITY INVOKER routines are assessed by invoker
--     privileges, not merely by the owning role's BYPASSRLS attribute.

with
target_relation_names(relation_name) as (
  values
    ('tenants'), ('hotels'), ('hotel_profiles'), ('hotel_feature_settings'),
    ('rooms'), ('room_types'), ('room_rate_plans'), ('room_bookings'),
    ('room_booking_payments'), ('room_booking_refunds'), ('room_maintenance'),
    ('room_housekeeping_tasks'), ('guest_stays'), ('room_shifts'),
    ('room_operation_audit'), ('room_checkout_receipts'),
    ('room_checkout_bill_formats'), ('room_checkout_bill_snapshots'), ('room_checkout_bill_audit'),
    ('hotel_room_tax_settings'), ('room_tax_rules'),
    ('hotel_room_advance_policies'),
    ('room_stay_rate_adjustments'), ('room_negotiated_rate_approvals'),
    ('menu_items'), ('menu_combo_items'), ('orders'), ('order_rounds'),
    ('restaurant_tables'), ('restaurant_table_qr_tokens'), ('qr_customer_sessions'),
    ('qr_order_submissions'),
    ('qr_idempotency_records'), ('qr_staff_idempotency_records'),
    ('qr_event_outbox'), ('qr_security_events'), ('notification_events'),
    ('kds_status_history'), ('food_order_bill_formats'), ('food_order_bill_snapshots'),
    ('food_order_bill_audit'), ('order_support_requests'),
    ('payment_intents'), ('payment_attempts'),
    ('payment_webhook_inbox'), ('payment_webhook_events')
),
target_relations as (
  select
    c.oid as relation_oid,
    n.nspname as schema_name,
    c.relname as relation_name,
    c.relkind,
    c.relowner,
    c.relrowsecurity,
    c.relforcerowsecurity,
    c.relpersistence
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join target_relation_names t on t.relation_name = c.relname
  where n.nspname = 'public'
    and c.relkind in ('r', 'p', 'v', 'm')
),
relevant_routines as (
  select
    p.oid as routine_oid,
    n.nspname as routine_schema,
    p.proname as routine_name,
    p.proowner,
    p.prosecdef,
    p.provolatile,
    p.proparallel,
    p.prokind,
    p.proconfig,
    pg_get_function_identity_arguments(p.oid) as identity_arguments,
    pg_get_function_result(p.oid) as result_type
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and (
      p.proname in (
        'create_room_booking_with_advance',
        'record_room_booking_payment',
        'record_room_booking_refund',
        'shift_room_booking',
        'extend_room_booking',
        'settle_room_combined_checkout',
        'validate_room_service_booking_link',
        'room_checkout_order_total',
        'create_staff_table_order_if_available',
        'get_staff_active_table_order',
        'enforce_one_active_root_dine_in_order',
        'sync_dine_in_order_terminal_lifecycle',
        'add_staff_items_to_active_order',
        'submit_secure_qr_table_order',
        'edit_secure_qr_submission',
        'correct_secure_qr_submission_staff',
        'merge_qr_order_totals',
        'replace_qr_order_totals',
        'protect_food_order_bill_snapshot',
        'protect_room_checkout_bill_snapshot',
        'finalize_captured_payment',
        'claim_payment_intent_provider_creation',
        'attach_payment_intent_provider_order',
        'claim_payment_webhook',
        'complete_payment_webhook'
      )
      or p.proname ~* '(booking|checkout|order|bill|invoice|folio|kds|payment|idempoten)'
    )
),
booking_status_counts as (
  select booking_status as status_value, count(*)::bigint as row_count
  from public.room_bookings
  group by booking_status
),
booking_payment_status_counts as (
  select payment_status as status_value, count(*)::bigint as row_count
  from public.room_bookings
  group by payment_status
),
order_status_counts as (
  select coalesce(status, '[NULL]') as status_value, count(*)::bigint as row_count
  from public.orders
  group by status
),
order_kitchen_status_counts as (
  select coalesce(kitchen_status, '[NULL]') as status_value, count(*)::bigint as row_count
  from public.orders
  group by kitchen_status
),
order_payment_status_counts as (
  select coalesce(payment_status, '[NULL]') as status_value, count(*)::bigint as row_count
  from public.orders
  group by payment_status
),
order_billing_status_counts as (
  select coalesce(billing_status, '[NULL]') as status_value, count(*)::bigint as row_count
  from public.orders
  group by billing_status
),
payment_intent_status_counts as (
  select coalesce(status, '[NULL]') as status_value, count(*)::bigint as row_count
  from public.payment_intents
  group by status
),
logical_order_duplicate_groups as (
  select count(*)::bigint as duplicate_groups,
         coalesce(sum(group_count - 1), 0)::bigint as excess_rows
  from (
    select count(*)::bigint as group_count
    from public.orders
    group by
      hotel_slug,
      coalesce(order_type, ''),
      coalesce(table_number, ''),
      coalesce(parent_order_id::text, ''),
      to_jsonb(items),
      to_jsonb(totals),
      date_trunc('second', created_at)
    having count(*) > 1
  ) grouped
),
anomaly_counts as (
  select
    'invalid_booking_date_ranges'::text as check_name,
    'P0'::text as severity,
    count(*)::bigint as affected_count,
    jsonb_build_object('rule', 'check_out_date must be greater than check_in_date') as details
  from public.room_bookings
  where check_in_date is null or check_out_date is null or check_out_date <= check_in_date

  union all

  select
    'overlapping_active_booking_pairs', 'P0', count(*)::bigint,
    jsonb_build_object(
      'blocking_statuses', jsonb_build_array('pending','confirmed','checked_in'),
      'range_semantics', '[check_in_date, check_out_date)',
      'expectation', '0 pairs'
    )
  from public.room_bookings a
  join public.room_bookings b
    on b.room_id = a.room_id
   and b.id > a.id
   and b.check_in_date < a.check_out_date
   and b.check_out_date > a.check_in_date
  where a.booking_status in ('pending','confirmed','checked_in')
    and b.booking_status in ('pending','confirmed','checked_in')

  union all

  select
    'active_booking_room_scope_mismatch', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'booking room, hotel_slug, tenant_id, and property_id must match')
  from public.room_bookings b
  left join public.rooms r on r.id = b.room_id
  where r.id is null
     or r.hotel_slug is distinct from b.hotel_slug
     or r.tenant_id is distinct from b.tenant_id
     or r.property_id is distinct from b.property_id

  union all

  select
    'booking_negative_or_null_financials', 'P0', count(*)::bigint,
    jsonb_build_object('columns', jsonb_build_array(
      'room_price','tax_amount','discount_amount','total_amount','advance_paid','balance_amount'
    ))
  from public.room_bookings
  where room_price is null or tax_amount is null or discount_amount is null
     or total_amount is null or advance_paid is null or balance_amount is null
     or room_price < 0 or tax_amount < 0 or discount_amount < 0
     or total_amount < 0 or advance_paid < 0 or balance_amount < 0

  union all

  select
    'booking_total_equation_mismatch', 'P1', count(*)::bigint,
    jsonb_build_object('rule', 'total_amount = room_price + tax_amount - discount_amount at 2 decimals')
  from public.room_bookings
  where round(total_amount, 2) is distinct from
        round(greatest(0, room_price + tax_amount - discount_amount), 2)

  union all

  select
    'booking_balance_equation_mismatch', 'P1', count(*)::bigint,
    jsonb_build_object('rule', 'balance_amount = max(0, total_amount - advance_paid) at 2 decimals')
  from public.room_bookings
  where round(balance_amount, 2) is distinct from
        round(greatest(0, total_amount - advance_paid), 2)

  union all

  select
    'booking_payment_status_mismatch', 'P1', count(*)::bigint,
    jsonb_build_object('rule', 'unpaid/partial/paid must agree with advance and balance')
  from public.room_bookings
  where (payment_status = 'unpaid' and advance_paid > 0)
     or (payment_status = 'partial' and (advance_paid <= 0 or balance_amount <= 0))
     or (payment_status = 'paid' and balance_amount > 0)

  union all

  select
    'booking_lifecycle_timestamp_mismatch', 'P1', count(*)::bigint,
    jsonb_build_object('rule', 'terminal/check-in state must have its matching timestamp')
  from public.room_bookings
  where (booking_status = 'checked_in' and checked_in_at is null)
     or (booking_status = 'checked_out' and checked_out_at is null)
     or (booking_status = 'cancelled' and cancelled_at is null)

  union all

  select
    'duplicate_booking_idempotency_keys', 'P0', coalesce(sum(group_count - 1), 0)::bigint,
    jsonb_build_object('scope', '(hotel_slug, idempotency_key)', 'expectation', '0 excess rows')
  from (
    select count(*)::bigint as group_count
    from public.room_bookings
    where idempotency_key is not null
    group by hotel_slug, idempotency_key
    having count(*) > 1
  ) duplicate_keys

  union all

  select
    'maintenance_invalid_ranges', 'P1', count(*)::bigint,
    jsonb_build_object('rule', 'end_at is null or end_at > start_at')
  from public.room_maintenance
  where start_at is null or (end_at is not null and end_at <= start_at)

  union all

  select
    'maintenance_active_booking_overlap_pairs', 'P1', count(*)::bigint,
    jsonb_build_object('meaning', 'candidate operational conflicts; review rather than auto-fix')
  from public.room_maintenance m
  join public.room_bookings b
    on b.room_id = m.room_id
   and b.hotel_slug = m.hotel_slug
   and b.check_in_date::timestamptz < coalesce(m.end_at, 'infinity'::timestamptz)
   and b.check_out_date::timestamptz > m.start_at
  where m.status in ('open','in_progress')
    and b.booking_status in ('pending','confirmed','checked_in')

  union all

  select
    'orphan_or_cross_scope_booking_payments', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'payment must reference a same-owner booking')
  from public.room_booking_payments p
  left join public.room_bookings b on b.id = p.booking_id
  where b.id is null
     or b.hotel_slug is distinct from p.hotel_slug
     or b.tenant_id is distinct from p.tenant_id
     or b.property_id is distinct from p.property_id

  union all

  select
    'booking_payment_negative_or_null_amounts', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'payment amount must be positive and non-null')
  from public.room_booking_payments
  where amount is null or amount <= 0

  union all

  select
    'paid_booking_payment_missing_identifiers_candidate', 'P1', count(*)::bigint,
    jsonb_build_object(
      'rule', 'paid ledger row has no receipt, transaction, or provider reference',
      'note', 'legacy cash rows may require explicit review'
    )
  from public.room_booking_payments
  where payment_status = 'paid'
    and nullif(btrim(coalesce(receipt_reference, '')), '') is null
    and nullif(btrim(coalesce(transaction_id, '')), '') is null
    and nullif(btrim(coalesce(provider_reference, '')), '') is null

  union all

  select
    'duplicate_booking_payment_idempotency_keys', 'P0', coalesce(sum(group_count - 1), 0)::bigint,
    jsonb_build_object('scope', '(hotel_slug, idempotency_key)', 'expectation', '0 excess rows')
  from (
    select count(*)::bigint as group_count
    from public.room_booking_payments
    where idempotency_key is not null
    group by hotel_slug, idempotency_key
    having count(*) > 1
  ) duplicate_keys

  union all

  select
    'orphan_or_cross_scope_booking_refunds', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'refund must reference a same-owner booking')
  from public.room_booking_refunds r
  left join public.room_bookings b on b.id = r.booking_id
  where b.id is null
     or b.hotel_slug is distinct from r.hotel_slug
     or b.tenant_id is distinct from r.tenant_id
     or b.property_id is distinct from r.property_id

  union all

  select
    'booking_refund_negative_or_null_amounts', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'refund amount must be positive and non-null')
  from public.room_booking_refunds
  where amount is null or amount <= 0

  union all

  select
    'guest_stay_booking_or_room_scope_mismatch', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'stay, booking, and room must share canonical ownership')
  from public.guest_stays s
  left join public.room_bookings b on b.id = s.booking_id
  left join public.rooms r on r.id = s.room_id
  where b.id is null or r.id is null
     or b.hotel_slug is distinct from s.hotel_slug
     or r.hotel_slug is distinct from s.hotel_slug
     or b.tenant_id is distinct from s.tenant_id
     or b.property_id is distinct from s.property_id
     or r.tenant_id is distinct from s.tenant_id
     or r.property_id is distinct from s.property_id

  union all

  select
    'housekeeping_booking_or_room_scope_mismatch', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'housekeeping task and optional booking must belong to the task room/property')
  from public.room_housekeeping_tasks h
  left join public.rooms r on r.id = h.room_id
  left join public.room_bookings b on b.id = h.booking_id
  where r.id is null
     or r.hotel_slug is distinct from h.hotel_slug
     or r.tenant_id is distinct from h.tenant_id
     or r.property_id is distinct from h.property_id
     or (h.booking_id is not null and (
       b.id is null
       or b.hotel_slug is distinct from h.hotel_slug
       or b.room_id is distinct from h.room_id
       or b.tenant_id is distinct from h.tenant_id
       or b.property_id is distinct from h.property_id
     ))

  union all

  select
    'room_shift_scope_mismatch', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'shift booking/from-room/to-room must share canonical ownership')
  from public.room_shifts s
  left join public.room_bookings b on b.id = s.booking_id
  left join public.rooms from_room on from_room.id = s.from_room_id
  left join public.rooms to_room on to_room.id = s.to_room_id
  where b.id is null or from_room.id is null or to_room.id is null
     or b.hotel_slug is distinct from s.hotel_slug
     or from_room.hotel_slug is distinct from s.hotel_slug
     or to_room.hotel_slug is distinct from s.hotel_slug
     or b.tenant_id is distinct from s.tenant_id
     or b.property_id is distinct from s.property_id
     or from_room.tenant_id is distinct from s.tenant_id
     or from_room.property_id is distinct from s.property_id
     or to_room.tenant_id is distinct from s.tenant_id
     or to_room.property_id is distinct from s.property_id

  union all

  select
    'order_missing_or_negative_total', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'stored authoritative total must be numeric and non-negative')
  from public.orders o
  cross join lateral (
    select coalesce(
      to_jsonb(o.totals)->>'gpayFinalTotal',
      to_jsonb(o.totals)->>'final',
      to_jsonb(o.totals)->>'total',
      to_jsonb(o.totals)->>'normalTotal'
    ) as total_text
  ) t
  where t.total_text is null
     or t.total_text !~ '^-?[0-9]+([.][0-9]+)?$'
     or (case when t.total_text ~ '^-?[0-9]+([.][0-9]+)?$' then t.total_text::numeric end) < 0

  union all

  select
    'order_item_invalid_quantity_or_price', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'every item quantity must be positive and snapshot price non-negative')
  from public.orders o
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(to_jsonb(o.items)) = 'array' then to_jsonb(o.items) else '[]'::jsonb end
  ) item
  where coalesce(item->>'qty', '') !~ '^[0-9]+([.][0-9]+)?$'
     or coalesce(item->>'price', '') !~ '^-?[0-9]+([.][0-9]+)?$'
     or (case when coalesce(item->>'qty', '') ~ '^[0-9]+([.][0-9]+)?$' then (item->>'qty')::numeric end) <= 0
     or (case when coalesce(item->>'price', '') ~ '^-?[0-9]+([.][0-9]+)?$' then (item->>'price')::numeric end) < 0

  union all

  select
    'logical_order_duplicate_candidates', 'P0', excess_rows,
    jsonb_build_object(
      'duplicate_groups', duplicate_groups,
      'basis', 'same property/type/table/parent/items/totals within the same second',
      'note', 'candidate retry duplicates; review, do not auto-delete'
    )
  from logical_order_duplicate_groups

  union all

  select
    'order_room_service_scope_mismatch', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'room-service order booking/room/property ownership must match')
  from public.orders o
  left join public.room_bookings b on b.id = o.room_booking_id
  left join public.rooms r on r.id = o.room_id
  where o.room_booking_id is not null
    and (
      b.id is null or r.id is null
      or b.hotel_slug is distinct from o.hotel_slug
      or r.hotel_slug is distinct from o.hotel_slug
      or b.room_id is distinct from o.room_id
      or b.tenant_id is distinct from o.tenant_id
      or b.property_id is distinct from o.property_id
      or r.tenant_id is distinct from o.tenant_id
      or r.property_id is distinct from o.property_id
    )

  union all

  select
    'order_parent_scope_mismatch', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'add-on child order must reference a same-owner parent order')
  from public.orders child
  left join public.orders parent on parent.id::text = child.parent_order_id::text
  where child.parent_order_id is not null
    and (
      parent.id is null
      or parent.hotel_slug is distinct from child.hotel_slug
      or parent.tenant_id is distinct from child.tenant_id
      or parent.property_id is distinct from child.property_id
    )

  union all

  select
    'order_restaurant_table_scope_mismatch', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'order restaurant table must share canonical ownership')
  from public.orders o
  left join public.restaurant_tables t on t.id = o.restaurant_table_id
  where o.restaurant_table_id is not null
    and (
      t.id is null
      or t.hotel_slug is distinct from o.hotel_slug
      or t.tenant_id is distinct from o.tenant_id
      or t.property_id is distinct from o.property_id
    )

  union all

  select
    'duplicate_order_bill_numbers', 'P0', coalesce(sum(group_count - 1), 0)::bigint,
    jsonb_build_object('scope', '(hotel_slug, bill_number)', 'expectation', '0 excess rows')
  from (
    select count(*)::bigint as group_count
    from public.orders
    where nullif(btrim(coalesce(bill_number, '')), '') is not null
    group by hotel_slug, bill_number
    having count(*) > 1
  ) duplicate_bills

  union all

  select
    'duplicate_order_gateway_order_ids', 'P0', coalesce(sum(group_count - 1), 0)::bigint,
    jsonb_build_object('scope', '(payment_gateway, gateway_order_id)', 'expectation', '0 excess rows')
  from (
    select count(*)::bigint as group_count
    from public.orders
    where nullif(btrim(coalesce(gateway_order_id, '')), '') is not null
    group by payment_gateway, gateway_order_id
    having count(*) > 1
  ) duplicate_gateway_orders

  union all

  select
    'duplicate_order_gateway_payment_ids', 'P0', coalesce(sum(group_count - 1), 0)::bigint,
    jsonb_build_object('scope', '(payment_gateway, gateway_payment_id)', 'expectation', '0 excess rows')
  from (
    select count(*)::bigint as group_count
    from public.orders
    where nullif(btrim(coalesce(gateway_payment_id, '')), '') is not null
    group by payment_gateway, gateway_payment_id
    having count(*) > 1
  ) duplicate_gateway_payments

  union all

  select
    'order_billing_status_inconsistency', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'billed requires bill_number+billed_at; not_billed must not retain them')
  from public.orders
  where (lower(coalesce(billing_status, '')) = 'billed'
         and (nullif(btrim(coalesce(bill_number, '')), '') is null or billed_at is null))
     or (lower(coalesce(billing_status, 'not_billed')) = 'not_billed'
         and (nullif(btrim(coalesce(bill_number, '')), '') is not null or billed_at is not null))

  union all

  select
    'order_payment_status_inconsistency', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'paid requires paid_at; non-paid must not carry verified provider evidence inconsistently')
  from public.orders
  where (lower(coalesce(payment_status, '')) = 'paid' and paid_at is null)
     or (lower(coalesce(payment_status, '')) <> 'paid'
         and gateway_status = 'paid')

  union all

  select
    'paid_online_order_missing_gateway_identifiers_candidate', 'P1', count(*)::bigint,
    jsonb_build_object('note', 'manual cash/card/UPI rows require business review; Task 2 rows should be bound')
  from public.orders
  where lower(coalesce(payment_status, '')) = 'paid'
    and lower(coalesce(payment_method, '')) ~ '(razorpay|online|secure)'
    and (
      nullif(btrim(coalesce(gateway_order_id, '')), '') is null
      or nullif(btrim(coalesce(gateway_payment_id, '')), '') is null
    )

  union all

  select
    'billed_order_missing_final_snapshot', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'every billed source order should have one immutable food bill snapshot')
  from public.orders o
  where lower(coalesce(o.billing_status, '')) = 'billed'
    and not exists (
      select 1 from public.food_order_bill_snapshots s
      where s.hotel_slug = o.hotel_slug and s.order_id = o.id::text
    )

  union all

  select
    'orphan_or_cross_scope_order_rounds', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'order round must reference a same-hotel order')
  from public.order_rounds r
  left join public.orders o on o.id::text = r.order_id
  where o.id is null or o.hotel_slug is distinct from r.hotel_slug

  union all

  select
    'duplicate_order_round_sequences', 'P0', coalesce(sum(group_count - 1), 0)::bigint,
    jsonb_build_object('scope', '(hotel_slug, order_id, sequence_number)')
  from (
    select count(*)::bigint as group_count
    from public.order_rounds
    group by hotel_slug, order_id, sequence_number
    having count(*) > 1
  ) duplicate_rounds

  union all

  select
    'duplicate_order_round_idempotency_keys', 'P0', coalesce(sum(group_count - 1), 0)::bigint,
    jsonb_build_object('scope', '(hotel_slug, order_id, idempotency_key)')
  from (
    select count(*)::bigint as group_count
    from public.order_rounds
    group by hotel_slug, order_id, idempotency_key
    having count(*) > 1
  ) duplicate_round_keys

  union all

  select
    'duplicate_qr_idempotency_keys', 'P0', coalesce(sum(group_count - 1), 0)::bigint,
    jsonb_build_object('scope', '(qr_session_id, action_scope, idempotency_key_hash)')
  from (
    select count(*)::bigint as group_count
    from public.qr_idempotency_records
    group by qr_session_id, action_scope, idempotency_key_hash
    having count(*) > 1
  ) duplicate_qr_keys

  union all

  select
    'duplicate_qr_outbox_deduplication_keys', 'P0', coalesce(sum(group_count - 1), 0)::bigint,
    jsonb_build_object('scope', 'deduplication_key')
  from (
    select count(*)::bigint as group_count
    from public.qr_event_outbox
    group by deduplication_key
    having count(*) > 1
  ) duplicate_outbox_keys

  union all

  select
    'qr_submission_scope_mismatch', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'QR submission session/table/order must share hotel and canonical ownership')
  from public.qr_order_submissions q
  left join public.orders o on o.id::text = q.order_id
  left join public.restaurant_tables t on t.id = q.restaurant_table_id
  left join public.qr_customer_sessions s on s.id = q.qr_session_id
  where o.id is null or t.id is null or s.id is null
     or o.hotel_slug is distinct from q.hotel_slug
     or t.hotel_slug is distinct from q.hotel_slug
     or s.hotel_slug is distinct from q.hotel_slug
     or o.tenant_id is distinct from q.tenant_id
     or o.property_id is distinct from q.property_id
     or t.tenant_id is distinct from q.tenant_id
     or t.property_id is distinct from q.property_id
     or s.tenant_id is distinct from q.tenant_id
     or s.property_id is distinct from q.property_id

  union all

  select
    'checkout_receipt_negative_or_inconsistent_amounts', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'amount, room_amount, food_amount non-negative and amount = room + food')
  from public.room_checkout_receipts
  where amount is null or room_amount is null or food_amount is null
     or amount < 0 or room_amount < 0 or food_amount < 0
     or round(amount, 2) is distinct from round(room_amount + food_amount, 2)

  union all

  select
    'duplicate_checkout_receipts_per_booking', 'P0', coalesce(sum(group_count - 1), 0)::bigint,
    jsonb_build_object('scope', '(hotel_slug, booking_id)', 'expectation', 'one final checkout')
  from (
    select count(*)::bigint as group_count
    from public.room_checkout_receipts
    group by hotel_slug, booking_id
    having count(*) > 1
  ) duplicate_checkouts

  union all

  select
    'duplicate_checkout_idempotency_keys', 'P0', coalesce(sum(group_count - 1), 0)::bigint,
    jsonb_build_object('scope', '(hotel_slug, idempotency_key)')
  from (
    select count(*)::bigint as group_count
    from public.room_checkout_receipts
    group by hotel_slug, idempotency_key
    having count(*) > 1
  ) duplicate_checkout_keys

  union all

  select
    'checkout_receipt_booking_scope_mismatch', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'receipt must reference a same-owner booking')
  from public.room_checkout_receipts r
  left join public.room_bookings b on b.id = r.booking_id
  where b.id is null
     or b.hotel_slug is distinct from r.hotel_slug
     or b.tenant_id is distinct from r.tenant_id
     or b.property_id is distinct from r.property_id

  union all

  select
    'checkout_receipt_booking_state_mismatch', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'paid checkout receipt requires checked_out+paid booking with zero balance')
  from public.room_checkout_receipts r
  join public.room_bookings b on b.id = r.booking_id and b.hotel_slug = r.hotel_slug
  where r.payment_status = 'paid'
    and (b.booking_status <> 'checked_out' or b.payment_status <> 'paid' or b.balance_amount <> 0)

  union all

  select
    'finalized_checkout_missing_bill_snapshot', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'each checkout receipt should have one immutable room checkout bill snapshot')
  from public.room_checkout_receipts r
  where not exists (
    select 1 from public.room_checkout_bill_snapshots s
    where s.hotel_slug = r.hotel_slug
      and s.booking_id = r.booking_id
      and s.checkout_receipt_id = r.id
  )

  union all

  select
    'checked_out_booking_without_checkout_receipt_candidate', 'P1', count(*)::bigint,
    jsonb_build_object('note', 'legacy/simple-status checkouts may exist; review, do not auto-migrate')
  from public.room_bookings b
  where b.booking_status = 'checked_out'
    and not exists (
      select 1 from public.room_checkout_receipts r
      where r.hotel_slug = b.hotel_slug and r.booking_id = b.id
    )

  union all

  select
    'duplicate_food_snapshot_invoice_numbers', 'P0', coalesce(sum(group_count - 1), 0)::bigint,
    jsonb_build_object('scope', '(hotel_slug, invoice_number)')
  from (
    select count(*)::bigint as group_count
    from public.food_order_bill_snapshots
    where invoice_number is not null
    group by hotel_slug, invoice_number
    having count(*) > 1
  ) duplicate_invoices

  union all

  select
    'duplicate_room_snapshot_invoice_numbers', 'P0', coalesce(sum(group_count - 1), 0)::bigint,
    jsonb_build_object('scope', '(hotel_slug, invoice_number)')
  from (
    select count(*)::bigint as group_count
    from public.room_checkout_bill_snapshots
    where invoice_number is not null
    group by hotel_slug, invoice_number
    having count(*) > 1
  ) duplicate_invoices

  union all

  select
    'food_snapshot_source_scope_mismatch', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'food snapshot must reference same-hotel source order')
  from public.food_order_bill_snapshots s
  left join public.orders o on o.id::text = s.order_id
  where o.id is null or o.hotel_slug is distinct from s.hotel_slug

  union all

  select
    'room_snapshot_source_scope_mismatch', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'room snapshot must reference same-hotel booking/receipt')
  from public.room_checkout_bill_snapshots s
  left join public.room_bookings b on b.id = s.booking_id
  left join public.room_checkout_receipts r on r.id = s.checkout_receipt_id
  where b.id is null
     or b.hotel_slug is distinct from s.hotel_slug
     or (s.checkout_receipt_id is not null and (
       r.id is null or r.hotel_slug is distinct from s.hotel_slug or r.booking_id is distinct from s.booking_id
     ))

  union all

  select
    'paid_payment_intent_missing_provider_identity', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'PAID intent requires provider order, payment id, and paid_at')
  from public.payment_intents
  where status = 'PAID'
    and (
      nullif(btrim(coalesce(provider_order_id, '')), '') is null
      or nullif(btrim(coalesce(provider_payment_id, '')), '') is null
      or paid_at is null
    )

  union all

  select
    'duplicate_payment_intent_idempotency_keys', 'P0', coalesce(sum(group_count - 1), 0)::bigint,
    jsonb_build_object('scope', '(hotel_slug, operation, idempotency_key)')
  from (
    select count(*)::bigint as group_count
    from public.payment_intents
    group by hotel_slug, operation, idempotency_key
    having count(*) > 1
  ) duplicate_intent_keys

  union all

  select
    'duplicate_payment_intent_provider_order_ids', 'P0', coalesce(sum(group_count - 1), 0)::bigint,
    jsonb_build_object('scope', '(provider, merchant_ref, provider_order_id)')
  from (
    select count(*)::bigint as group_count
    from public.payment_intents
    where provider_order_id is not null
    group by provider, merchant_ref, provider_order_id
    having count(*) > 1
  ) duplicate_provider_orders

  union all

  select
    'duplicate_payment_intent_provider_payment_ids', 'P0', coalesce(sum(group_count - 1), 0)::bigint,
    jsonb_build_object('scope', '(provider, merchant_ref, provider_payment_id)')
  from (
    select count(*)::bigint as group_count
    from public.payment_intents
    where provider_payment_id is not null
    group by provider, merchant_ref, provider_payment_id
    having count(*) > 1
  ) duplicate_provider_payments

  union all

  select
    'payment_intent_business_order_scope_mismatch', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'bound business order must belong to the payment intent property')
  from public.payment_intents i
  left join public.orders o on o.id::text = i.business_order_id
  where i.business_order_id is not null
    and (
      o.id is null
      or o.hotel_slug is distinct from i.hotel_slug
      or o.tenant_id is distinct from i.tenant_id
      or o.property_id is distinct from i.property_id
    )

  union all

  select
    'payment_attempt_orphan_intent', 'P0', count(*)::bigint,
    jsonb_build_object('rule', 'every payment attempt must reference an existing intent')
  from public.payment_attempts a
  left join public.payment_intents i on i.id = a.payment_intent_id
  where i.id is null
),
inventory as (
  select
    '00_inventory_context'::text as section,
    'database'::text as object_type,
    current_database()::text as object_identity,
    'INFO'::text as severity,
    jsonb_build_object(
      'database_name', current_database(),
      'current_user', current_user,
      'session_user', session_user,
      'postgres_version', current_setting('server_version'),
      'transaction_read_only', current_setting('transaction_read_only'),
      'observed_at_utc', timezone('utc', statement_timestamp()),
      'script_date', '2026-10-15',
      'pii_returned', false
    ) as details

  union all

  select
    '01_required_relation_presence',
    'relation_presence',
    format('public.%I', names.relation_name),
    case when rel.relation_oid is null then 'P0' else 'INFO' end,
    jsonb_build_object('present', rel.relation_oid is not null)
  from target_relation_names names
  left join target_relations rel on rel.relation_name = names.relation_name

  union all

  select
    '02_relation_security',
    case r.relkind when 'r' then 'table' when 'p' then 'partitioned_table'
      when 'v' then 'view' when 'm' then 'materialized_view' else r.relkind::text end,
    format('%I.%I', r.schema_name, r.relation_name),
    case
      when r.relkind in ('r','p') and not r.relrowsecurity then 'P0'
      when r.relkind in ('r','p') and not r.relforcerowsecurity
       and r.relation_name not in ('tenants', 'payment_webhook_events') then 'P0'
      else 'INFO'
    end,
    jsonb_build_object(
      'owner', pg_get_userbyid(r.relowner),
      'rls_enabled', r.relrowsecurity,
      'force_rls', r.relforcerowsecurity,
      'persistence', r.relpersistence,
      'estimated_live_rows', coalesce(stats.n_live_tup, 0)::bigint
    )
  from target_relations r
  left join pg_stat_user_tables stats on stats.relid = r.relation_oid

  union all

  select
    '03_columns',
    'column',
    format('%I.%I.%I', cols.table_schema, cols.table_name, cols.column_name),
    'INFO',
    jsonb_build_object(
      'ordinal_position', cols.ordinal_position,
      'data_type', cols.data_type,
      'udt_name', cols.udt_name,
      'nullable', cols.is_nullable,
      'safe_default', case
        when cols.column_name ~* '(secret|credential|key|token|password|payload|context|metadata|notes|email|phone|name|address|proof)'
          then '[suppressed]'
        else coalesce(cols.column_default, '')
      end,
      'identity', cols.is_identity,
      'generated', cols.is_generated,
      'category', case
        when cols.column_name in ('tenant_id','property_id','hotel_slug','room_id','booking_id','order_id') then 'ownership_or_relation'
        when cols.column_name ~* '(price|amount|subtotal|total|tax|gst|discount|charge|currency)' then 'financial'
        when cols.column_name ~* '(status|state|active|final|paid|billed)' then 'lifecycle'
        when cols.column_name ~* '(idempot|digest|fingerprint|version)' then 'concurrency_or_idempotency'
        when cols.column_name ~* '(invoice|bill|folio|receipt|transaction|provider_order|provider_payment)' then 'financial_identity'
        else 'other'
      end
    )
  from information_schema.columns cols
  join target_relations r
    on r.schema_name = cols.table_schema and r.relation_name = cols.table_name

  union all

  select
    '04_constraints',
    case con.contype when 'p' then 'primary_key' when 'f' then 'foreign_key'
      when 'u' then 'unique' when 'c' then 'check' when 'x' then 'exclusion'
      when 'n' then 'not_null' else con.contype::text end,
    format('%I.%I.%I', r.schema_name, r.relation_name, con.conname),
    case when not con.convalidated then 'P0' else 'INFO' end,
    jsonb_build_object(
      'definition', pg_get_constraintdef(con.oid, true),
      'validated', con.convalidated,
      'deferrable', con.condeferrable,
      'initially_deferred', con.condeferred,
      'referenced_relation', case when con.confrelid = 0 then null else con.confrelid::regclass::text end
    )
  from target_relations r
  join pg_constraint con on con.conrelid = r.relation_oid

  union all

  select
    '05_indexes',
    'index',
    format('%I.%I', idx.schemaname, idx.indexname),
    case when indis.indisvalid is false or indis.indisready is false then 'P0' else 'INFO' end,
    jsonb_build_object(
      'relation', format('%I.%I', idx.schemaname, idx.tablename),
      'definition', idx.indexdef,
      'unique', indis.indisunique,
      'valid', indis.indisvalid,
      'ready', indis.indisready
    )
  from pg_indexes idx
  join target_relations r on r.schema_name = idx.schemaname and r.relation_name = idx.tablename
  join pg_class index_class on index_class.relname = idx.indexname
  join pg_namespace index_ns on index_ns.oid = index_class.relnamespace and index_ns.nspname = idx.schemaname
  join pg_index indis on indis.indexrelid = index_class.oid

  union all

  select
    '06_triggers',
    'trigger',
    format('%I.%I.%I', r.schema_name, r.relation_name, trg.tgname),
    case when trg.tgenabled = 'D' then 'P0' else 'INFO' end,
    jsonb_build_object(
      'enabled_code', trg.tgenabled,
      'definition', pg_get_triggerdef(trg.oid, true),
      'function', trg.tgfoid::regprocedure::text
    )
  from target_relations r
  join pg_trigger trg on trg.tgrelid = r.relation_oid
  where not trg.tgisinternal

  union all

  select
    '07_rls_policies',
    'policy',
    format('%I.%I.%I', pol.schemaname, pol.tablename, pol.policyname),
    'INFO',
    jsonb_build_object(
      'permissive', pol.permissive,
      'roles', to_jsonb(pol.roles),
      'command', pol.cmd,
      'using_expression', pol.qual,
      'check_expression', pol.with_check
    )
  from pg_policies pol
  join target_relations r on r.schema_name = pol.schemaname and r.relation_name = pol.tablename

  union all

  select
    '07b_table_grants',
    'table_grant',
    format('%I.%I->%I', grants.table_schema, grants.table_name, grants.grantee),
    case
      when grants.grantee in ('PUBLIC','anon','authenticated')
       and grants.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER','REFERENCES')
      then 'P0'
      else 'INFO'
    end,
    jsonb_build_object(
      'grantor', grants.grantor,
      'grantee', grants.grantee,
      'privilege', grants.privilege_type,
      'grantable', grants.is_grantable
    )
  from information_schema.table_privileges grants
  join target_relations r
    on r.schema_name = grants.table_schema
   and r.relation_name = grants.table_name

  union all

  select
    '08_routines',
    case rr.prokind when 'p' then 'procedure' else 'function' end,
    format('%I.%I(%s)', rr.routine_schema, rr.routine_name, rr.identity_arguments),
    case
      when rr.prosecdef
       and owner_role.rolbypassrls
       and (
         has_function_privilege('anon', rr.routine_oid, 'EXECUTE')
         or has_function_privilege('authenticated', rr.routine_oid, 'EXECUTE')
         or has_function_privilege('app_tenant_runtime', rr.routine_oid, 'EXECUTE')
       ) then 'P0'
      when rr.prosecdef
       and not (
         'search_path=public, pg_temp' = any(coalesce(rr.proconfig, array[]::text[]))
         or 'search_path=pg_catalog, public' = any(coalesce(rr.proconfig, array[]::text[]))
         or 'search_path=public' = any(coalesce(rr.proconfig, array[]::text[]))
       ) then 'P0'
      else 'INFO'
    end,
    jsonb_build_object(
      'owner', pg_get_userbyid(rr.proowner),
      'owner_superuser', owner_role.rolsuper,
      'owner_bypassrls', owner_role.rolbypassrls,
      'security_definer', rr.prosecdef,
      'anon_execute', has_function_privilege('anon', rr.routine_oid, 'EXECUTE'),
      'authenticated_execute', has_function_privilege('authenticated', rr.routine_oid, 'EXECUTE'),
      'tenant_runtime_execute', has_function_privilege('app_tenant_runtime', rr.routine_oid, 'EXECUTE'),
      'volatility', rr.provolatile,
      'parallel', rr.proparallel,
      'configuration', coalesce(to_jsonb(rr.proconfig), '[]'::jsonb),
      'result_type', rr.result_type,
      'body_included', false
    )
  from relevant_routines rr
  join pg_roles owner_role on owner_role.oid = rr.proowner

  union all

  select
    '09_routine_grants',
    'routine_grant',
    format('%I.%I.%s->%I', grants.routine_schema, grants.routine_name, grants.specific_name, grants.grantee),
    case when grants.grantee in ('PUBLIC','anon','authenticated') and grants.privilege_type = 'EXECUTE'
      then 'P0' else 'INFO' end,
    jsonb_build_object(
      'grantor', grants.grantor,
      'grantee', grants.grantee,
      'privilege', grants.privilege_type,
      'grantable', grants.is_grantable
    )
  from information_schema.routine_privileges grants
  join relevant_routines rr
    on rr.routine_schema = grants.routine_schema
   and rr.routine_name = grants.routine_name

  union all

  select
    '10_status_distribution',
    'aggregate',
    'public.room_bookings.booking_status',
    'INFO',
    jsonb_build_object('counts', coalesce(jsonb_object_agg(status_value, row_count), '{}'::jsonb))
  from booking_status_counts

  union all

  select '10_status_distribution', 'aggregate', 'public.room_bookings.payment_status', 'INFO',
    jsonb_build_object('counts', coalesce(jsonb_object_agg(status_value, row_count), '{}'::jsonb))
  from booking_payment_status_counts

  union all

  select '10_status_distribution', 'aggregate', 'public.orders.status', 'INFO',
    jsonb_build_object('counts', coalesce(jsonb_object_agg(status_value, row_count), '{}'::jsonb))
  from order_status_counts

  union all

  select '10_status_distribution', 'aggregate', 'public.orders.kitchen_status', 'INFO',
    jsonb_build_object('counts', coalesce(jsonb_object_agg(status_value, row_count), '{}'::jsonb))
  from order_kitchen_status_counts

  union all

  select '10_status_distribution', 'aggregate', 'public.orders.payment_status', 'INFO',
    jsonb_build_object('counts', coalesce(jsonb_object_agg(status_value, row_count), '{}'::jsonb))
  from order_payment_status_counts

  union all

  select '10_status_distribution', 'aggregate', 'public.orders.billing_status', 'INFO',
    jsonb_build_object('counts', coalesce(jsonb_object_agg(status_value, row_count), '{}'::jsonb))
  from order_billing_status_counts

  union all

  select '10_status_distribution', 'aggregate', 'public.payment_intents.status', 'INFO',
    jsonb_build_object('counts', coalesce(jsonb_object_agg(status_value, row_count), '{}'::jsonb))
  from payment_intent_status_counts

  union all

  select
    '11_data_integrity_checks',
    'aggregate_check',
    checks.check_name,
    case when checks.affected_count > 0 then checks.severity else 'PASS' end,
    checks.details || jsonb_build_object('affected_count', checks.affected_count)
  from anomaly_counts checks

  union all

  select
    '12_required_transactional_controls',
    'control_presence',
    controls.control_name,
    case when controls.present then 'INFO' else controls.missing_severity end,
    jsonb_build_object('present', controls.present, 'expected_kind', controls.expected_kind)
  from (
    select
      expected.control_name,
      expected.expected_kind,
      expected.missing_severity,
      case expected.expected_kind
        when 'constraint' then exists (
          select 1 from pg_constraint c where c.conname = expected.control_name
        )
        when 'index' then exists (
          select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'i' and c.relname = expected.control_name
        )
        when 'trigger' then exists (
          select 1 from pg_trigger t where not t.tgisinternal and t.tgname = expected.control_name and t.tgenabled <> 'D'
        )
        when 'function' then exists (
          select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = expected.control_name
        )
        when 'extension' then exists (
          select 1 from pg_extension e where e.extname = expected.control_name
        )
        else false
      end as present
    from (values
      ('btree_gist','extension','P0'),
      ('room_bookings_no_active_overlap','constraint','P0'),
      ('room_bookings_scope_idempotency_unique','index','P0'),
      ('orders_validate_room_service_booking_link','trigger','P0'),
      ('food_order_bill_snapshots_protect','trigger','P0'),
      ('room_checkout_bill_snapshots_protect','trigger','P0'),
      ('create_room_booking_with_advance','function','P1'),
      ('record_room_booking_payment','function','P1'),
      ('record_room_booking_refund','function','P1'),
      ('shift_room_booking','function','P1'),
      ('extend_room_booking','function','P1'),
      ('settle_room_combined_checkout','function','P0'),
      ('create_staff_table_order_if_available','function','P0'),
      ('add_staff_items_to_active_order','function','P0'),
      ('submit_secure_qr_table_order','function','P0'),
      ('finalize_captured_payment','function','P0')
    ) expected(control_name, expected_kind, missing_severity)
  ) controls
)
select section, object_type, object_identity, severity, details
from inventory
order by section, severity desc, object_type, object_identity;
