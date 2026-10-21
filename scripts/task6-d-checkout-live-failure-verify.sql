-- TASK 6-D-C live failure inspection for synthetic booking 25.
-- Read-only, TEST database only. Returns no guest names/contact details and makes no writes.
-- It checks whether the failed checkout request left any durable evidence.

begin transaction read only;

with evidence(section, details) as (
  select
    'booking',
    jsonb_build_object(
      'rows', count(*),
      'booking_status', max(booking_status),
      'payment_status', max(payment_status),
      'balance_amount', max(balance_amount),
      'checked_out_at_present', coalesce(bool_or(checked_out_at is not null), false)
    )
  from public.room_bookings
  where id = 25

  union all

  select
    'checkout_receipts',
    jsonb_build_object(
      'rows_for_booking', count(*),
      'rows_for_failed_key', count(*) filter (
        where idempotency_key = 'task6-checkout-adb041d7-83ca-4a9e-a0fc-b03a75a5426b'
      ),
      'payment_statuses', coalesce(
        jsonb_agg(distinct payment_status) filter (where payment_status is not null),
        '[]'::jsonb
      ),
      'paid_amount_total', coalesce(sum(amount) filter (where payment_status = 'paid'), 0)
    )
  from public.room_checkout_receipts
  where booking_id = 25

  union all

  select
    'room_payment_for_failed_run',
    jsonb_build_object(
      'rows', count(*),
      'paid_rows', count(*) filter (where payment_status = 'paid'),
      'amount_total', coalesce(sum(amount), 0)
    )
  from public.room_booking_payments
  where booking_id = 25
    and transaction_id = 'TASK6TEST-adb041d7-83ca-4a9e-a0fc-b03a75a5426b'

  union all

  select
    'final_bill_snapshots',
    jsonb_build_object(
      'rows_for_booking', count(*),
      'rows_linked_to_failed_receipt', count(*) filter (
        where checkout_receipt_id in (
          select id from public.room_checkout_receipts
          where booking_id = 25
            and idempotency_key = 'task6-checkout-adb041d7-83ca-4a9e-a0fc-b03a75a5426b'
        )
      ),
      'final_shape_rows', count(*) filter (
        where jsonb_typeof(snapshot_json) = 'object'
          and coalesce(lower(snapshot_json ->> 'provisional'), 'true') = 'false'
      )
    )
  from public.room_checkout_bill_snapshots
  where booking_id = 25

  union all

  select
    'checkout_audit',
    jsonb_build_object(
      'bill_issued_rows_for_booking', count(*),
      'rows_linked_to_failed_receipt', count(*) filter (
        where details_json ->> 'checkoutReceiptId' in (
          select id::text from public.room_checkout_receipts
          where booking_id = 25
            and idempotency_key = 'task6-checkout-adb041d7-83ca-4a9e-a0fc-b03a75a5426b'
        )
      )
    )
  from public.room_checkout_bill_audit
  where booking_id = 25
    and action = 'bill_issued'

  union all

  select
    'linked_room_orders',
    jsonb_build_object(
      'rows', count(*),
      'paid_rows', count(*) filter (where lower(coalesce(payment_status, '')) = 'paid'),
      'billed_rows', count(*) filter (where lower(coalesce(billing_status, '')) = 'billed')
    )
  from public.orders
  where room_booking_id = 25
    and room_service_charge_to_room is true
    and lower(coalesce(status, 'new')) not in ('cancelled', 'payment_failed')

  union all

  select
    'guest_stay',
    jsonb_build_object(
      'checked_out_rows', count(*) filter (
        where stay_status = 'checked_out' and checked_out_at is not null
      )
    )
  from public.guest_stays
  where booking_id = 25

  union all

  select
    'housekeeping_turnover',
    jsonb_build_object('rows', count(*))
  from public.room_housekeeping_tasks
  where booking_id = 25
)
select section, details
from evidence
order by section;

rollback;
