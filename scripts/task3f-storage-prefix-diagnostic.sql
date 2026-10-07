-- TASK3-F blocker diagnostic for unknown hotel-assets prefixes.
-- READ ONLY. Returns aggregate folder classifications only.
-- It does not return object names, filenames, URLs, owner IDs, or customer data.

with
known_hotel_slugs as (
  select slug as hotel_slug, 'hotels'::text as source
  from public.hotels
  union
  select hotel_slug, 'room_images'
  from public.room_images
  where nullif(hotel_slug, '') is not null
  union
  select hotel_slug, 'food_order_bill_formats'
  from public.food_order_bill_formats
  where nullif(hotel_slug, '') is not null
  union
  select hotel_slug, 'room_checkout_bill_formats'
  from public.room_checkout_bill_formats
  where nullif(hotel_slug, '') is not null
  union
  select hotel_slug, 'menu_categories'
  from public.menu_categories
  where nullif(hotel_slug, '') is not null
  union
  select hotel_slug, 'gallery_items'
  from public.gallery_items
  where nullif(hotel_slug, '') is not null
  union
  select hotel_slug, 'hotel_popup_notifications'
  from public.hotel_popup_notifications
  where nullif(hotel_slug, '') is not null
  union
  select hotel_slug, 'login_page_branding'
  from public.login_page_branding
  where scope_type = 'hotel'
    and nullif(hotel_slug, '') is not null
),
path_references as (
  select storage_path as object_name, 'room_images'::text as source
  from public.room_images
  where nullif(storage_path, '') is not null
  union all
  select logo_storage_path, 'food_order_bill_formats'
  from public.food_order_bill_formats
  where nullif(logo_storage_path, '') is not null
  union all
  select logo_storage_path, 'room_checkout_bill_formats'
  from public.room_checkout_bill_formats
  where nullif(logo_storage_path, '') is not null
  union all
  select image_storage_path, 'menu_categories'
  from public.menu_categories
  where nullif(image_storage_path, '') is not null
  union all
  select storage_path, 'gallery_items'
  from public.gallery_items
  where nullif(storage_path, '') is not null
  union all
  select storage_path, 'hotel_popup_notifications'
  from public.hotel_popup_notifications
  where nullif(storage_path, '') is not null
),
unknown_objects as (
  select
    o.id,
    o.name,
    split_part(o.name, '/', 1) as first_segment,
    split_part(o.name, '/', 2) as second_segment
  from storage.objects o
  where o.bucket_id = 'hotel-assets'
    and not (
      o.name ~ '^tenants/[0-9a-fA-F-]{36}/properties/[0-9]+/'
      or split_part(o.name, '/', 1) in ('platform', 'shared')
      or exists (
        select 1
        from public.hotels h
        where h.slug = split_part(o.name, '/', 1)
      )
    )
),
classified as (
  select
    u.id,
    u.first_segment,
    u.second_segment,
    exists (
      select 1
      from known_hotel_slugs k
      where k.hotel_slug = u.first_segment
    ) as appears_as_legacy_hotel_slug,
    exists (
      select 1
      from path_references r
      where r.object_name = u.name
    ) as has_exact_database_reference
  from unknown_objects u
),
grouped as (
  select
    case
      when first_segment ~ '^[a-z0-9][a-z0-9_-]{0,119}$'
        then first_segment
      else 'redacted-' || md5(first_segment)
    end as safe_first_segment,
    case
      when second_segment ~ '^[a-z0-9][a-z0-9_-]{0,119}$'
        then second_segment
      when second_segment = ''
        then '[none]'
      else 'redacted-' || md5(second_segment)
    end as safe_second_segment,
    count(*)::bigint as object_count,
    count(*) filter (
      where has_exact_database_reference
    )::bigint as database_referenced_objects,
    bool_or(appears_as_legacy_hotel_slug) as appears_as_legacy_hotel_slug,
    case
      when bool_or(appears_as_legacy_hotel_slug)
        then 'LEGACY_HOTEL_SLUG_REVIEW'
      when count(*) filter (where has_exact_database_reference) > 0
        then 'REFERENCED_NONCANONICAL_REVIEW'
      else 'UNMAPPED_PREFIX_REVIEW'
    end as classification
  from classified
  group by first_segment, second_segment
),
summary as (
  select
    count(*)::bigint as unknown_object_count,
    count(distinct first_segment)::bigint as unknown_prefix_count,
    count(*) filter (
      where has_exact_database_reference
    )::bigint as database_referenced_object_count,
    count(*) filter (
      where not has_exact_database_reference
    )::bigint as unreferenced_object_count,
    count(distinct first_segment) filter (
      where first_segment !~ '^[a-z0-9][a-z0-9_-]{0,119}$'
    )::bigint as redacted_prefix_count
  from classified
)
select
  'PREFIX'::text as row_type,
  safe_first_segment,
  safe_second_segment,
  object_count,
  database_referenced_objects,
  appears_as_legacy_hotel_slug,
  classification,
  null::bigint as unknown_prefix_count,
  null::bigint as unreferenced_object_count,
  null::bigint as redacted_prefix_count
from grouped
union all
select
  'SUMMARY',
  '[all unknown prefixes]',
  '[all resource folders]',
  unknown_object_count,
  database_referenced_object_count,
  null::boolean,
  'SUMMARY',
  unknown_prefix_count,
  unreferenced_object_count,
  redacted_prefix_count
from summary
order by row_type, safe_first_segment, safe_second_segment;
