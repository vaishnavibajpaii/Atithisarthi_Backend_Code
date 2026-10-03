-- Task 3 / TASK3-B order blocker diagnostic (READ ONLY).
-- Investigates orders with NULL or blank hotel_slug without returning customer
-- PII, order items, notification payloads, provider identifiers, or secrets.

with unowned_orders as (
  select
    o.id,
    o.created_at,
    o.status,
    case
      when o.hotel_slug is null then 'NULL'
      else 'BLANK'
    end as hotel_slug_state,
    nullif(btrim(o.hotel_name), '') as recorded_hotel_name,
    nullif(btrim(o.order_type), '') as order_type,
    nullif(btrim(o.order_source), '') as order_source,
    nullif(btrim(o.payment_method), '') as payment_method,
    nullif(btrim(o.payment_status), '') as payment_status,
    nullif(btrim(o.gateway_status), '') as gateway_status,
    o.restaurant_table_id,
    o.room_id,
    o.room_booking_id,
    o.created_by_staff_id,
    nullif(btrim(o.parent_order_id), '') as parent_order_id,
    nullif(btrim(o.order_group_id), '') as order_group_id,
    nullif(btrim(o.gateway_order_id), '') as gateway_order_id
  from public.orders o
  where nullif(btrim(o.hotel_slug), '') is null
),
notification_candidates as (
  select distinct
    o.id as order_id,
    h.slug as candidate_slug,
    'notification_event'::text as evidence_source
  from unowned_orders o
  join public.notification_events n
    on n.source_type = 'order'
   and n.source_id = o.id::text
  join public.hotels h on h.slug = n.hotel_slug
),
intent_business_order_candidates as (
  select distinct
    o.id as order_id,
    h.slug as candidate_slug,
    'payment_intent_business_order'::text as evidence_source
  from unowned_orders o
  join public.payment_intents p on p.business_order_id = o.id::text
  join public.hotels h on h.slug = p.hotel_slug
),
intent_gateway_order_candidates as (
  select distinct
    o.id as order_id,
    h.slug as candidate_slug,
    'payment_intent_provider_order'::text as evidence_source
  from unowned_orders o
  join public.payment_intents p
    on p.provider_order_id = o.gateway_order_id
   and o.gateway_order_id is not null
  join public.hotels h on h.slug = p.hotel_slug
),
restaurant_table_candidates as (
  select distinct
    o.id as order_id,
    h.slug as candidate_slug,
    'restaurant_table'::text as evidence_source
  from unowned_orders o
  join public.restaurant_tables t on t.id = o.restaurant_table_id
  join public.hotels h on h.slug = t.hotel_slug
),
room_candidates as (
  select distinct
    o.id as order_id,
    h.slug as candidate_slug,
    'room'::text as evidence_source
  from unowned_orders o
  join public.rooms r on r.id = o.room_id
  join public.hotels h on h.slug = r.hotel_slug
),
room_booking_candidates as (
  select distinct
    o.id as order_id,
    h.slug as candidate_slug,
    'room_booking'::text as evidence_source
  from unowned_orders o
  join public.room_bookings b on b.id = o.room_booking_id
  join public.hotels h on h.slug = b.hotel_slug
),
staff_candidates as (
  select distinct
    o.id as order_id,
    h.slug as candidate_slug,
    'creating_staff_access'::text as evidence_source
  from unowned_orders o
  join public.hotel_staff_access s on s.id = o.created_by_staff_id
  join public.hotels h on h.slug = s.hotel_slug
),
parent_order_candidates as (
  select distinct
    o.id as order_id,
    h.slug as candidate_slug,
    'parent_order'::text as evidence_source
  from unowned_orders o
  join public.orders parent on parent.id::text = o.parent_order_id
  join public.hotels h on h.slug = parent.hotel_slug
),
order_group_candidates as (
  select distinct
    o.id as order_id,
    h.slug as candidate_slug,
    'order_group_peer'::text as evidence_source
  from unowned_orders o
  join public.orders peer
    on peer.order_group_id = o.order_group_id
   and peer.id is distinct from o.id
   and o.order_group_id is not null
  join public.hotels h on h.slug = peer.hotel_slug
),
profile_name_candidates as (
  select distinct
    o.id as order_id,
    h.slug as candidate_slug,
    'exact_profile_hotel_name'::text as evidence_source
  from unowned_orders o
  join public.hotel_profiles p
    on lower(btrim(p.hotel_name)) = lower(o.recorded_hotel_name)
  join public.hotels h on h.slug = p.hotel_slug
  where o.recorded_hotel_name is not null
    and lower(o.recorded_hotel_name) <> 'unknown hotel'
),
slug_literal_candidates as (
  select distinct
    o.id as order_id,
    h.slug as candidate_slug,
    'exact_slug_literal'::text as evidence_source
  from unowned_orders o
  join public.hotels h
    on lower(o.recorded_hotel_name) = lower(h.slug)
    or lower(o.recorded_hotel_name) = replace(lower(h.slug), '-', ' ')
  where o.recorded_hotel_name is not null
    and lower(o.recorded_hotel_name) <> 'unknown hotel'
),
candidate_evidence as (
  select * from notification_candidates
  union all select * from intent_business_order_candidates
  union all select * from intent_gateway_order_candidates
  union all select * from restaurant_table_candidates
  union all select * from room_candidates
  union all select * from room_booking_candidates
  union all select * from staff_candidates
  union all select * from parent_order_candidates
  union all select * from order_group_candidates
  union all select * from profile_name_candidates
  union all select * from slug_literal_candidates
),
candidate_summary as (
  select
    order_id,
    count(distinct candidate_slug) as candidate_count,
    min(candidate_slug) filter (
      where candidate_slug is not null
    ) as single_candidate_slug,
    string_agg(
      distinct candidate_slug || ':' || evidence_source,
      ', ' order by candidate_slug || ':' || evidence_source
    ) as safe_evidence
  from candidate_evidence
  group by order_id
),
runtime_state as (
  select
    (select count(*) from public.tenants) as tenant_count,
    (select count(*) from public.hotels where tenant_id is not null)
      as assigned_hotel_count
)
select
  o.id::text as order_id,
  o.created_at,
  o.status,
  o.hotel_slug_state,
  coalesce(o.recorded_hotel_name, '[MISSING]') as recorded_hotel_name,
  coalesce(o.order_type, '') as order_type,
  coalesce(o.order_source, '') as order_source,
  coalesce(o.payment_method, '') as payment_method,
  coalesce(o.payment_status, '') as payment_status,
  coalesce(o.gateway_status, '') as gateway_status,
  coalesce(c.candidate_count, 0) as candidate_count,
  case
    when c.candidate_count = 1 then c.single_candidate_slug
    else null
  end as deterministic_candidate_slug,
  coalesce(c.safe_evidence, '') as safe_evidence,
  case
    when c.candidate_count = 1 then 'DETERMINISTIC_CANDIDATE_REVIEW_REQUIRED'
    when c.candidate_count > 1 then 'AMBIGUOUS_USER_DECISION_REQUIRED'
    else 'NO_DATABASE_EVIDENCE_USER_DECISION_REQUIRED'
  end as resolution_status,
  r.tenant_count as post_failure_tenant_count,
  r.assigned_hotel_count as post_failure_assigned_hotel_count
from unowned_orders o
cross join runtime_state r
left join candidate_summary c on c.order_id = o.id
order by o.id;
