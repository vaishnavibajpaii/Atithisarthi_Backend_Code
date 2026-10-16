-- TASK6-B live-probe failure diagnostic (READ ONLY).
-- Run in the Supabase SQL Editor after a live verifier returned HTTP 500.
-- It returns no guest name, phone, email, address, company, GSTIN, or notes.

set statement_timeout = '30s';
set lock_timeout = '5s';
set search_path = pg_catalog, public;

select
  b.id::text as booking_id,
  b.room_id::text as room_id,
  b.booking_status,
  b.payment_status,
  b.check_in_date,
  b.check_out_date,
  (b.request_fingerprint ~ '^[a-f0-9]{64}$') as digest_present,
  b.created_at
from public.room_bookings b
where b.guest_name = 'Task Six Synthetic Guest'
  and b.notes like 'TASK6 synthetic %'
  and b.check_in_date >= date '2027-10-20'
  and b.check_out_date <= date '2027-10-23'
order by b.created_at, b.id;
