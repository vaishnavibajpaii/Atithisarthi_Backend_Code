-- TASK6-B synthetic booking payment diagnostic (READ ONLY).
-- Targets only TEST booking IDs 19 and 21 and returns no guest PII,
-- transaction/provider values, idempotency keys, notes, reasons, or actor IDs.

set statement_timeout = '30s';
set lock_timeout = '5s';
set search_path = pg_catalog, public;

with booking_events as (
  select
    'booking'::text as section,
    b.id::text as booking_id,
    b.created_at as event_time,
    'created_snapshot'::text as event_kind,
    b.total_amount::text as amount,
    b.booking_status as status,
    b.payment_status as financial_status,
    null::text as method_or_type,
    null::text as actor_role,
    jsonb_build_object(
      'advancePaid', b.advance_paid,
      'balanceAmount', b.balance_amount,
      'cancelledAt', b.cancelled_at,
      'updatedAt', b.updated_at,
      'digestPresent', b.request_fingerprint ~ '^[a-f0-9]{64}$'
    ) as evidence
  from public.room_bookings b
  where b.id = any(array[19, 21]::bigint[])
    and b.guest_name = 'Task Six Synthetic Guest'
    and b.notes like 'TASK6 synthetic %'
), payment_events as (
  select
    'payment'::text as section,
    p.booking_id::text as booking_id,
    coalesce(p.paid_at, p.created_at) as event_time,
    ('payment_row_' || p.id::text)::text as event_kind,
    p.amount::text as amount,
    p.payment_status as status,
    null::text as financial_status,
    concat_ws('/', p.payment_method, p.payment_type) as method_or_type,
    nullif(p.received_role, '') as actor_role,
    jsonb_build_object(
      'createdAt', p.created_at,
      'updatedAt', p.updated_at,
      'hasIdempotencyKey', nullif(btrim(coalesce(p.idempotency_key, '')), '') is not null,
      'hasTransactionId', nullif(btrim(coalesce(p.transaction_id, '')), '') is not null,
      'hasProviderReference', nullif(btrim(coalesce(p.provider_reference, '')), '') is not null,
      'hasReceiptReference', nullif(btrim(coalesce(p.receipt_reference, '')), '') is not null
    ) as evidence
  from public.room_booking_payments p
  where p.booking_id = any(array[19, 21]::bigint[])
), audit_events as (
  select
    'audit'::text as section,
    a.target_id as booking_id,
    a.created_at as event_time,
    a.action as event_kind,
    coalesce(a.new_value->>'amount', '') as amount,
    null::text as status,
    coalesce(a.new_value->>'paymentStatus', '') as financial_status,
    null::text as method_or_type,
    nullif(a.actor_role, '') as actor_role,
    jsonb_build_object(
      'paymentIdPresent', nullif(a.new_value->>'paymentId', '') is not null,
      'balanceAmount', a.new_value->>'balanceAmount',
      'paymentLineCount', a.new_value->>'paymentLineCount'
    ) as evidence
  from public.room_operation_audit a
  where a.target_type = 'room_booking'
    and a.target_id in ('19', '21')
), refund_events as (
  select
    'refund'::text as section,
    r.booking_id::text as booking_id,
    r.created_at as event_time,
    ('refund_row_' || r.id::text)::text as event_kind,
    r.amount::text as amount,
    r.status,
    null::text as financial_status,
    r.payment_method as method_or_type,
    null::text as actor_role,
    jsonb_build_object(
      'hasIdempotencyKey', nullif(btrim(coalesce(r.idempotency_key, '')), '') is not null,
      'hasTransactionId', nullif(btrim(coalesce(r.transaction_id, '')), '') is not null
    ) as evidence
  from public.room_booking_refunds r
  where r.booking_id = any(array[19, 21]::bigint[])
), all_events as (
  select * from booking_events
  union all select * from payment_events
  union all select * from audit_events
  union all select * from refund_events
)
select * from all_events
order by booking_id::bigint, event_time, section, event_kind;
