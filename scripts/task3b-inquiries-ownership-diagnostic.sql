-- Task 3 / TASK3-B blocker diagnostic (READ ONLY).
-- Investigates inquiries with NULL or blank hotel_slug without returning guest PII.
-- No guest name, phone, event details, requirements, or notification payload
-- is selected.

with unowned_inquiries as (
  select
    i.id,
    i.created_at,
    i.status,
    case
      when i.hotel_slug is null then 'NULL'
      else 'BLANK'
    end as hotel_slug_state,
    nullif(btrim(i.hotel_name), '') as recorded_hotel_name
  from public.inquiries i
  where nullif(btrim(i.hotel_slug), '') is null
),
event_candidates as (
  select distinct
    i.id as inquiry_id,
    h.slug as candidate_slug,
    'notification_event'::text as evidence_source
  from unowned_inquiries i
  join public.notification_events n
    on n.source_type = 'inquiry'
   and n.source_id = i.id::text
  join public.hotels h on h.slug = n.hotel_slug
),
profile_name_candidates as (
  select distinct
    i.id as inquiry_id,
    h.slug as candidate_slug,
    'exact_profile_hotel_name'::text as evidence_source
  from unowned_inquiries i
  join public.hotel_profiles p
    on lower(btrim(p.hotel_name)) = lower(i.recorded_hotel_name)
  join public.hotels h on h.slug = p.hotel_slug
  where i.recorded_hotel_name is not null
    and lower(i.recorded_hotel_name) <> 'unknown hotel'
),
slug_literal_candidates as (
  select distinct
    i.id as inquiry_id,
    h.slug as candidate_slug,
    'exact_slug_literal'::text as evidence_source
  from unowned_inquiries i
  join public.hotels h
    on lower(i.recorded_hotel_name) = lower(h.slug)
    or lower(i.recorded_hotel_name) = replace(lower(h.slug), '-', ' ')
  where i.recorded_hotel_name is not null
    and lower(i.recorded_hotel_name) <> 'unknown hotel'
),
candidate_evidence as (
  select * from event_candidates
  union all
  select * from profile_name_candidates
  union all
  select * from slug_literal_candidates
),
candidate_summary as (
  select
    inquiry_id,
    count(distinct candidate_slug) as candidate_count,
    min(candidate_slug) filter (
      where candidate_slug is not null
    ) as single_candidate_slug,
    string_agg(
      distinct candidate_slug || ':' || evidence_source,
      ', ' order by candidate_slug || ':' || evidence_source
    ) as safe_evidence
  from candidate_evidence
  group by inquiry_id
),
runtime_state as (
  select
    (select count(*) from public.tenants) as tenant_count,
    (select count(*) from public.hotels where tenant_id is not null)
      as assigned_hotel_count
)
select
  i.id::text as inquiry_id,
  i.created_at,
  i.status,
  i.hotel_slug_state,
  coalesce(i.recorded_hotel_name, '[MISSING]') as recorded_hotel_name,
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
from unowned_inquiries i
cross join runtime_state r
left join candidate_summary c on c.inquiry_id = i.id
order by i.id;
