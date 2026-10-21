-- TASK6-D data-consistency diagnostic, stage 2 of 2.
-- Read-only aggregate inspection. No identifiers or guest PII are returned.

begin transaction read only;

with checks(check_name, expected, actual, result) as (
  select 'duplicate_receipts_per_booking', '0', coalesce(sum(group_count - 1), 0)::text,
    case when coalesce(sum(group_count - 1), 0) = 0 then 'PASS' else 'FAIL' end
  from (
    select count(*)::bigint as group_count
    from public.room_checkout_receipts
    group by hotel_slug, booking_id
    having count(*) > 1
  ) duplicate_groups

  union all

  select 'duplicate_receipt_idempotency_keys', '0', coalesce(sum(group_count - 1), 0)::text,
    case when coalesce(sum(group_count - 1), 0) = 0 then 'PASS' else 'FAIL' end
  from (
    select count(*)::bigint as group_count
    from public.room_checkout_receipts
    group by hotel_slug, idempotency_key
    having count(*) > 1
  ) duplicate_groups

  union all

  select 'receipt_invalid_amount_or_array_shape', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.room_checkout_receipts
  where amount is null or room_amount is null or food_amount is null
     or amount < 0 or room_amount < 0 or food_amount < 0
     or round(amount, 2) is distinct from round(room_amount + food_amount, 2)
     or jsonb_typeof(settled_order_ids) is distinct from 'array'
     or jsonb_typeof(allocations_json) is distinct from 'array'

  union all

  select 'receipt_allocation_total_mismatch', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.room_checkout_receipts receipt
  where round(receipt.food_amount, 2) is distinct from round(coalesce((
    select sum(coalesce(public.task6_safe_numeric(allocation.value ->> 'amount'), 0))
    from jsonb_array_elements(
      case when jsonb_typeof(receipt.allocations_json) = 'array'
        then receipt.allocations_json else '[]'::jsonb end
    ) allocation(value)
  ), 0), 2)

  union all

  select 'receipt_scope_or_booking_mismatch', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.room_checkout_receipts receipt
  left join public.room_bookings booking on booking.id = receipt.booking_id
  where booking.id is null
     or booking.hotel_slug is distinct from receipt.hotel_slug
     or booking.tenant_id is distinct from receipt.tenant_id
     or booking.property_id is distinct from receipt.property_id

  union all

  select 'paid_receipt_booking_state_mismatch', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.room_checkout_receipts receipt
  join public.room_bookings booking
    on booking.id = receipt.booking_id and booking.hotel_slug = receipt.hotel_slug
  where receipt.payment_status = 'paid'
    and (
      booking.booking_status <> 'checked_out'
      or booking.payment_status <> 'paid'
      or round(coalesce(booking.balance_amount, 0), 2) <> 0
      or booking.checked_out_at is null
    )

  union all

  select 'invalid_receipt_request_fingerprints', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.room_checkout_receipts
  where request_fingerprint is not null
    and request_fingerprint !~ '^[0-9a-f]{64}$'

  union all

  select 'legacy_receipts_without_request_digest', 'informational', count(*)::text, 'INFO'
  from public.room_checkout_receipts
  where request_fingerprint is null

  union all

  select 'receipts_missing_final_snapshot', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.room_checkout_receipts receipt
  where not exists (
    select 1
    from public.room_checkout_bill_snapshots snapshot
    where snapshot.hotel_slug = receipt.hotel_slug
      and snapshot.booking_id = receipt.booking_id
      and snapshot.checkout_receipt_id = receipt.id
  )

  union all

  select 'checked_out_bookings_without_receipt', 'informational', count(*)::text, 'INFO'
  from public.room_bookings booking
  where booking.booking_status = 'checked_out'
    and not exists (
      select 1 from public.room_checkout_receipts receipt
      where receipt.hotel_slug = booking.hotel_slug
        and receipt.booking_id = booking.id
    )

  union all

  select 'checked_out_financial_state_mismatch', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.room_bookings
  where booking_status = 'checked_out'
    and (
      checked_out_at is null
      or payment_status <> 'paid'
      or round(coalesce(balance_amount, 0), 2) <> 0
    )

  union all

  select 'snapshot_source_scope_mismatch', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.room_checkout_bill_snapshots snapshot
  left join public.room_bookings booking on booking.id = snapshot.booking_id
  left join public.room_checkout_receipts receipt on receipt.id = snapshot.checkout_receipt_id
  where booking.id is null
     or booking.hotel_slug is distinct from snapshot.hotel_slug
     or booking.tenant_id is distinct from snapshot.tenant_id
     or booking.property_id is distinct from snapshot.property_id
     or snapshot.checkout_receipt_id is null
     or receipt.id is null
     or receipt.hotel_slug is distinct from snapshot.hotel_slug
     or receipt.booking_id is distinct from snapshot.booking_id
     or receipt.tenant_id is distinct from snapshot.tenant_id
     or receipt.property_id is distinct from snapshot.property_id

  union all

  -- The finalizer assigns the receipt-ID invoice number after the receipt
  -- insert; the immutable row column is canonical and the bill reader overlays it.
  select 'invalid_final_snapshot_shape', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.room_checkout_bill_snapshots
  where jsonb_typeof(snapshot_json) is distinct from 'object'
     or payload_hash !~ '^[0-9a-f]{64}$'
     or coalesce(lower(snapshot_json ->> 'provisional'), 'true') <> 'false'
     or coalesce(snapshot_json ->> 'documentType', '') <> 'guest_folio'
     or nullif(btrim(coalesce(snapshot_json ->> 'folioNumber', '')), '') is null
     or nullif(btrim(coalesce(invoice_number, '')), '') is null
     or jsonb_typeof(snapshot_json -> 'totals') is distinct from 'object'
     or jsonb_typeof(snapshot_json -> 'lines') is distinct from 'array'

  union all

  select 'duplicate_snapshot_folio_numbers', '0', coalesce(sum(group_count - 1), 0)::text,
    case when coalesce(sum(group_count - 1), 0) = 0 then 'PASS' else 'FAIL' end
  from (
    select count(*)::bigint as group_count
    from public.room_checkout_bill_snapshots
    group by hotel_slug, folio_number
    having count(*) > 1
  ) duplicate_groups

  union all

  select 'duplicate_snapshot_invoice_numbers', '0', coalesce(sum(group_count - 1), 0)::text,
    case when coalesce(sum(group_count - 1), 0) = 0 then 'PASS' else 'FAIL' end
  from (
    select count(*)::bigint as group_count
    from public.room_checkout_bill_snapshots
    where invoice_number is not null
    group by hotel_slug, invoice_number
    having count(*) > 1
  ) duplicate_groups

  union all

  select 'settled_order_ids_reused_across_receipts', '0', coalesce(sum(group_count - 1), 0)::text,
    case when coalesce(sum(group_count - 1), 0) = 0 then 'PASS' else 'FAIL' end
  from (
    select receipt.hotel_slug, settled.order_id, count(*)::bigint as group_count
    from public.room_checkout_receipts receipt
    cross join lateral jsonb_array_elements_text(
      case when jsonb_typeof(receipt.settled_order_ids) = 'array'
        then receipt.settled_order_ids else '[]'::jsonb end
    ) settled(order_id)
    group by receipt.hotel_slug, settled.order_id
    having count(*) > 1
  ) duplicate_groups

  union all

  select 'settled_receipt_orders_not_paid_and_billed', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.room_checkout_receipts receipt
  cross join lateral jsonb_array_elements_text(
    case when jsonb_typeof(receipt.settled_order_ids) = 'array'
      then receipt.settled_order_ids else '[]'::jsonb end
  ) settled(order_id)
  left join public.orders source_order
    on source_order.id::text = settled.order_id
   and source_order.hotel_slug = receipt.hotel_slug
  where source_order.id is null
     or source_order.room_booking_id is distinct from receipt.booking_id
     or source_order.tenant_id is distinct from receipt.tenant_id
     or source_order.property_id is distinct from receipt.property_id
     or source_order.room_service_charge_to_room is distinct from true
     or lower(coalesce(source_order.payment_status, '')) <> 'paid'
     or lower(coalesce(source_order.billing_status, '')) <> 'billed'

  union all

  select 'versioned_checkout_orders_with_invalid_snapshot', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.orders source_order
  where source_order.room_service_charge_to_room is true
    and source_order.financial_snapshot_version is not null
    and not public.task6_order_snapshot_valid(source_order.items, source_order.totals)

  union all

  select 'active_checkout_orders_with_legacy_snapshot', 'informational', count(*)::text, 'INFO'
  from public.orders source_order
  join public.room_bookings booking
    on booking.id = source_order.room_booking_id
   and booking.hotel_slug = source_order.hotel_slug
  where source_order.room_service_charge_to_room is true
    and booking.booking_status = 'checked_in'
    and lower(coalesce(source_order.status, 'new')) not in ('cancelled', 'payment_failed')
    and lower(coalesce(source_order.payment_status, 'unpaid')) not in ('paid', 'refunded')
    and source_order.financial_snapshot_version is null

  union all

  select 'positive_room_allocation_without_matching_payment', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.room_checkout_receipts receipt
  where receipt.room_amount > 0
    and not exists (
      select 1
      from public.room_booking_payments payment
      where payment.hotel_slug = receipt.hotel_slug
        and payment.booking_id = receipt.booking_id
        and payment.payment_status = 'paid'
        and round(payment.amount, 2) = round(receipt.room_amount, 2)
        and payment.paid_at = receipt.paid_at
    )

  union all

  select 'receipt_guest_stay_not_closed', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.room_checkout_receipts receipt
  where not exists (
    select 1 from public.guest_stays stay
    where stay.hotel_slug = receipt.hotel_slug
      and stay.booking_id = receipt.booking_id
      and stay.stay_status = 'checked_out'
      and stay.checked_out_at is not null
  )

  union all

  select 'receipt_missing_housekeeping_turnover', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.room_checkout_receipts receipt
  join public.room_bookings booking
    on booking.id = receipt.booking_id and booking.hotel_slug = receipt.hotel_slug
  where not exists (
    select 1 from public.room_housekeeping_tasks task
    where task.hotel_slug = receipt.hotel_slug
      and task.booking_id = receipt.booking_id
      and task.room_id = booking.room_id
  )

  union all

  select 'checkout_receipt_count', 'informational', count(*)::text, 'INFO'
  from public.room_checkout_receipts

  union all

  select 'final_checkout_snapshot_count', 'informational', count(*)::text, 'INFO'
  from public.room_checkout_bill_snapshots

  union all

  select 'booking_status_values', 'informational',
    coalesce((
      select jsonb_object_agg(status_value, row_count order by status_value)::text
      from (
        select coalesce(nullif(lower(btrim(booking_status)), ''), '<empty>') status_value,
               count(*) row_count
        from public.room_bookings
        group by 1
      ) status_counts
    ), '{}'::jsonb::text),
    'INFO'

  union all

  select 'receipt_payment_status_values', 'informational',
    coalesce((
      select jsonb_object_agg(status_value, row_count order by status_value)::text
      from (
        select coalesce(nullif(lower(btrim(payment_status)), ''), '<empty>') status_value,
               count(*) row_count
        from public.room_checkout_receipts
        group by 1
      ) status_counts
    ), '{}'::jsonb::text),
    'INFO'
)
select check_name, expected, actual, result
from checks
order by check_name;

rollback;
