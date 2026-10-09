-- Task 3G room-image path compatibility read-only verification.

with target_function as (
  select p.* from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='protect_room_image_scope'
),
checks as (
  select 'protect_function_single'::text check_name,'1'::text expected,
    (select count(*)::text from target_function) actual
  union all
  select 'protect_function_security_invoker','true',
    coalesce((select (not prosecdef)::text from target_function),'false')
  union all
  select 'protect_function_search_path_safe','true',
    coalesce((select exists(
      select 1 from unnest(coalesce(proconfig,array[]::text[])) setting
      where setting='search_path=pg_catalog, public'
    )::text from target_function),'false')
  union all
  select 'canonical_path_guard_present','true',
    coalesce((select (
      pg_get_functiondef(oid) like '%tenants/%'
      and pg_get_functiondef(oid) like '%/properties/%'
      and pg_get_functiondef(oid) like '%/room-images/%'
    )::text from target_function),'false')
  union all
  select 'legacy_path_compatibility_present','true',
    coalesce((select (
      pg_get_functiondef(oid) like '%v_legacy_prefix%'
    )::text from target_function),'false')
  union all
  select 'runtime_direct_trigger_execute','false',
    coalesce((select has_function_privilege(
      'app_tenant_runtime',oid,'EXECUTE'
    )::text from target_function),'true')
  union all
  select 'protect_trigger_present','1',
    (select count(*)::text from pg_trigger
      where tgrelid='public.room_images'::regclass
        and tgname='trg_protect_room_image_scope' and not tgisinternal)
  union all
  select 'room_image_path_mismatches','0',
    (select count(*)::text from public.room_images
      where tenant_id is null or property_id is null or hotel_slug is null
        or position('..' in storage_path)>0
        or (
          storage_path not like hotel_slug || '/room-images/%'
          and storage_path not like
            'tenants/' || tenant_id::text || '/properties/' || property_id::text || '/room-images/%'
        ))
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
  case when expected=actual then 'PASS' else 'FAIL' end result
from checks order by check_name;
