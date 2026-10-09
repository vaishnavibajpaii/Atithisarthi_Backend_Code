-- Task 3G room-image storage-path compatibility preflight.
-- Read only: returns aggregate/catalog evidence and no object names or PII.

with
room_image_stats as (
  select
    count(*)::bigint as total_rows,
    count(*) filter (
      where storage_path like hotel_slug || '/room-images/%'
        and position('..' in storage_path)=0
    )::bigint as legacy_rows,
    count(*) filter (
      where storage_path like
        'tenants/' || tenant_id::text || '/properties/' || property_id::text || '/room-images/%'
        and position('..' in storage_path)=0
    )::bigint as canonical_rows,
    count(*) filter (
      where position('..' in storage_path)>0
        or (
          storage_path not like hotel_slug || '/room-images/%'
          and storage_path not like
            'tenants/' || tenant_id::text || '/properties/' || property_id::text || '/room-images/%'
        )
    )::bigint as incompatible_rows,
    count(*) filter (
      where tenant_id is null or property_id is null or hotel_slug is null
    )::bigint as incomplete_ownership_rows
  from public.room_images
),
checks as (
  select 'room_images_table_present'::text check_name,'1'::text expected,
    (select count(*)::text from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname='room_images' and c.relkind in ('r','p')) actual
  union all
  select 'protect_function_present','1',
    (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='protect_room_image_scope'
        and p.prokind='f')
  union all
  select 'protect_trigger_present','1',
    (select count(*)::text from pg_trigger t
      where t.tgrelid='public.room_images'::regclass
        and t.tgname='trg_protect_room_image_scope' and not t.tgisinternal)
  union all
  select 'protect_function_security_invoker','true',
    coalesce((select (not p.prosecdef)::text from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='protect_room_image_scope'
      order by p.oid limit 1),'false')
  union all
  select 'runtime_direct_trigger_execute','false',
    coalesce((select has_function_privilege('app_tenant_runtime',p.oid,'EXECUTE')::text
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='protect_room_image_scope'
      order by p.oid limit 1),'true')
  union all
  select 'incomplete_room_image_ownership','0',
    (select incomplete_ownership_rows::text from room_image_stats)
  union all
  select 'incompatible_room_image_paths','0',
    (select incompatible_rows::text from room_image_stats)
  union all
  select 'runtime_policy_count_preserved','199',
    (select count(*)::text from pg_policy p
      join pg_class c on c.oid=p.polrelid
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public'
        and (select oid from pg_roles where rolname='app_tenant_runtime')=any(p.polroles))
  union all
  select 'force_rls_not_yet_enabled','0',
    (select count(*)::text from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p') and c.relforcerowsecurity)
)
select check_name,expected,actual,
  case when actual=expected then 'PASS' else 'FAIL' end result
from checks
union all
select 'room_image_total_rows','INFO',total_rows::text,'INFO' from room_image_stats
union all
select 'room_image_legacy_rows','INFO',legacy_rows::text,'INFO' from room_image_stats
union all
select 'room_image_canonical_rows','INFO',canonical_rows::text,'INFO' from room_image_stats
order by check_name;
