-- Task 3 / TASK3-E3 read-only candidate identity inventory.
-- Run manually in the authorized pre-production Supabase SQL Editor.
-- This query performs no writes and returns no guest/payment PII.

select
  h.tenant_id::text as tenant_id,
  h.id::text as property_id,
  h.slug as property_slug
from public.hotels h
where h.tenant_id is not null
  and nullif(btrim(h.slug), '') is not null
order by h.id;
