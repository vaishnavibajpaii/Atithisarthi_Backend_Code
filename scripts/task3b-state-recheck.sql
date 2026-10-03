-- Task 3 / TASK3-B state recheck (READ ONLY, always returns one row).
-- No customer PII is selected.

select
  current_database() as database_name,
  current_user as database_user,
  now() as checked_at,
  (select count(*) from public.tenants) as tenant_count,
  (select count(*) from public.hotels) as hotel_count,
  (
    select count(*) from public.hotels
    where tenant_id is not null
  ) as assigned_hotel_count,
  (
    select count(*) from public.inquiries
    where hotel_slug is null
  ) as inquiries_null_hotel_slug,
  (
    select count(*) from public.inquiries
    where hotel_slug is not null and btrim(hotel_slug) = ''
  ) as inquiries_blank_hotel_slug,
  (
    select count(*) from public.inquiries
    where tenant_id is not null or property_id is not null
  ) as inquiries_with_any_canonical_ownership,
  (
    select count(*) from public.inquiries i
    left join public.hotels h on h.slug = i.hotel_slug
    where i.hotel_slug is not null and h.id is null
  ) as inquiries_unknown_hotel_slug,
  (
    select count(*) from public.inquiries i
    join public.hotels h on h.slug = i.hotel_slug
    where i.tenant_id is distinct from h.tenant_id
       or i.property_id is distinct from h.id
  ) as inquiries_ownership_mismatch;
