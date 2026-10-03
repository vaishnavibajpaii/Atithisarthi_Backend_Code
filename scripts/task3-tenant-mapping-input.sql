-- Task 3 / TASK3-B mapping input (READ ONLY).
-- Run manually in the authorized pre-production Supabase SQL Editor.
--
-- This query returns public property identifiers only. It does not inspect
-- guests, staff, orders, payments, or other customer data, and it makes no
-- database changes.
--
-- The user must explicitly assign each property to a tenant. Reuse the same
-- approved_tenant_key for hotels that belong to the same organization. Use a
-- different key when they are independent tenants. Do not infer grouping from
-- similar names or slugs.

select
  h.id as property_id,
  h.slug as property_slug,
  h.tenant_id as existing_tenant_id,
  ''::text as approved_tenant_key,
  ''::text as approved_tenant_display_name,
  'USER_INPUT_REQUIRED'::text as mapping_status
from public.hotels h
order by h.id;
