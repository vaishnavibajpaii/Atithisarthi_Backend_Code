-- TASK6-B live acceptance compensated-cleanup verification (READ ONLY).
-- Synthetic booking IDs: 19 and 21. Payment evidence must remain preserved.
-- Returns no guest PII or provider/transaction identifiers.

set statement_timeout = '30s';
set lock_timeout = '5s';
set search_path = pg_catalog, public;

with target as (
  select b.id, b.booking_status, b.payment_status, b.advance_paid,
    b.balance_amount, b.total_amount, b.check_in_date, b.check_out_date,
    b.request_fingerprint
  from public.room_bookings b
  where b.id = any(array[19, 21]::bigint[])
    and b.guest_name = 'Task Six Synthetic Guest'
    and b.notes like 'TASK6 synthetic %'
), paid as (
  select p.booking_id, round(sum(p.amount), 2) as amount, count(*) as row_count
  from public.room_booking_payments p
  where p.booking_id = any(array[19, 21]::bigint[])
    and p.payment_status = 'paid'
  group by p.booking_id
), refunded as (
  select r.booking_id, round(sum(r.amount), 2) as amount, count(*) as row_count
  from public.room_booking_refunds r
  where r.booking_id = any(array[19, 21]::bigint[])
    and r.status = 'completed'
  group by r.booking_id
), ledger as (
  select t.id,
    coalesce(p.amount, 0) as paid_amount,
    coalesce(r.amount, 0) as refunded_amount,
    coalesce(p.row_count, 0) as payment_rows,
    coalesce(r.row_count, 0) as refund_rows
  from target t
  left join paid p on p.booking_id = t.id
  left join refunded r on r.booking_id = t.id
), checks as (
  select 'synthetic_bookings_present'::text check_name, '2'::text expected,
    count(*)::text actual from target
  union all select 'synthetic_bookings_cancelled', '2', count(*)::text
    from target where booking_status = 'cancelled'
  union all select 'synthetic_blocking_bookings', '0', count(*)::text
    from target where booking_status in ('pending', 'confirmed', 'checked_in')
  union all select 'synthetic_booking_status_refunded', '2', count(*)::text
    from target where payment_status = 'refunded'
  union all select 'synthetic_financial_balance_restored', '2', count(*)::text
    from target where round(advance_paid, 2) = 0
      and round(balance_amount, 2) = round(total_amount, 2)
  union all select 'synthetic_payment_rows_preserved', '2',
    coalesce(sum(payment_rows), 0)::text from ledger
  union all select 'synthetic_completed_refund_rows', '2',
    coalesce(sum(refund_rows), 0)::text from ledger
  union all select 'synthetic_net_ledger_zero', '2', count(*)::text
    from ledger where paid_amount > 0
      and round(paid_amount - refunded_amount, 2) = 0
  union all select 'synthetic_checkout_receipts', '0', count(*)::text
    from public.room_checkout_receipts r where r.booking_id = any(array[19, 21]::bigint[])
  union all select 'synthetic_valid_digests', '2', count(*)::text
    from target where request_fingerprint ~ '^[a-f0-9]{64}$'
  union all select 'synthetic_date_ranges_valid', '2', count(*)::text
    from target where check_out_date > check_in_date
)
select check_name, expected, actual,
  case when actual = expected then 'PASS' else 'FAIL' end as result
from checks
order by check_name;
