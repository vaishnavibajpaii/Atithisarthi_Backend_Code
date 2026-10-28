-- TASK 6-F: READ-ONLY QR-to-staff-table visibility diagnostic.
-- Run manually in Supabase SQL Editor against the same TEST database used by
-- the TEST backend. This script never inserts, updates, or deletes data.
-- It intentionally excludes guest details and monetary values.

begin;
set local transaction read only;

with recent_qr_submissions as (
  select
    submission.public_reference,
    submission.order_id,
    submission.hotel_slug,
    submission.restaurant_table_id,
    submission.round_sequence,
    submission.status as submission_status,
    submission.created_at as submission_created_at
  from public.qr_order_submissions submission
  where submission.hotel_slug = 'hotel-sai-raj'
    and submission.created_at >= now() - interval '24 hours'
  order by submission.created_at desc
  limit 20
),
recent_qr_roots as (
  select
    submission.public_reference,
    submission.order_id,
    submission.restaurant_table_id as submission_table_id,
    submission.round_sequence,
    submission.submission_status,
    submission.submission_created_at,
    orders.id as root_order_id,
    orders.order_type,
    orders.order_source,
    orders.parent_order_id,
    orders.table_number,
    orders.restaurant_table_id as order_table_id,
    orders.status as order_status,
    orders.kitchen_status,
    orders.payment_status,
    orders.billing_status,
    orders.created_at as order_created_at,
    tables.table_code,
    tables.is_active as table_is_active,
    tables.operational_status as table_operational_status
  from recent_qr_submissions submission
  left join public.orders orders
    on orders.id::text = submission.order_id
   and orders.hotel_slug = submission.hotel_slug
  left join public.restaurant_tables tables
    on tables.id = orders.restaurant_table_id
   and tables.hotel_slug = orders.hotel_slug
)
select
  'recent_qr_root_order_visibility' as section,
  public_reference,
  order_id as submission_order_id,
  root_order_id,
  submission_table_id,
  order_table_id,
  table_code,
  table_number,
  round_sequence,
  submission_status,
  order_source,
  order_type,
  parent_order_id is null as is_root_order,
  order_status,
  kitchen_status,
  payment_status,
  billing_status,
  table_is_active,
  table_operational_status,
  public.is_dine_in_order_open(
    order_status,
    kitchen_status,
    payment_status,
    billing_status
  ) as active_table_guard_includes_order,
  (
    lower(coalesce(order_status, '')) in ('new', 'confirmed', 'preparing')
    and table_number is not null
    and parent_order_id is null
    and lower(coalesce(order_type, '')) = 'dine-in'
  ) as staff_table_activity_endpoint_includes_order,
  submission_created_at,
  order_created_at
from recent_qr_roots
order by submission_created_at desc;

select
  'active_table_floor_for_t01' as section,
  tables.id as table_id,
  tables.table_code,
  tables.is_active,
  tables.operational_status,
  orders.id as active_order_id,
  orders.order_source,
  orders.status as order_status,
  orders.kitchen_status,
  orders.payment_status,
  orders.billing_status,
  orders.created_at as order_created_at
from public.restaurant_tables tables
left join lateral (
  select candidate.*
  from public.orders candidate
  where candidate.hotel_slug = tables.hotel_slug
    and candidate.order_type = 'dine-in'
    and candidate.parent_order_id is null
    and (
      candidate.restaurant_table_id = tables.id
      or lower(coalesce(candidate.table_number, '')) = lower(tables.table_code)
    )
    and public.is_dine_in_order_open(
      candidate.status,
      candidate.kitchen_status,
      candidate.payment_status,
      candidate.billing_status
    )
  order by candidate.created_at desc, candidate.id desc
  limit 1
) orders on true
where tables.hotel_slug = 'hotel-sai-raj'
  and tables.table_code = 'T01';

commit;
