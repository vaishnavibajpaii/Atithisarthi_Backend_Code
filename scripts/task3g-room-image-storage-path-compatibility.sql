-- Task 3G additive compatibility upgrade for room-image metadata paths.
-- Preserves legacy paths and permits canonical Task 3F tenant/property paths.
-- Does not rename/delete objects, change storage visibility, or enable FORCE RLS.

begin;
set local lock_timeout='10s';
set local statement_timeout='2min';
set local search_path=pg_catalog,public;

do $task3g_room_image_preflight$
declare bad_count bigint;
begin
  if to_regclass('public.room_images') is null then
    raise exception 'TASK3G_ROOM_IMAGES_TABLE_MISSING';
  end if;
  select count(*) into bad_count
  from public.room_images
  where tenant_id is null or property_id is null or hotel_slug is null
    or position('..' in storage_path)>0
    or (
      storage_path not like hotel_slug || '/room-images/%'
      and storage_path not like
        'tenants/' || tenant_id::text || '/properties/' || property_id::text || '/room-images/%'
    );
  if bad_count<>0 then
    raise exception 'TASK3G_ROOM_IMAGE_PATH_PREFLIGHT_FAILED count=%',bad_count;
  end if;
end;
$task3g_room_image_preflight$;

create or replace function public.protect_room_image_scope()
returns trigger
language plpgsql
security invoker
set search_path=pg_catalog,public
as $task3g_room_image_scope$
declare
  v_owner_slug text;
  v_owner_tenant uuid;
  v_owner_property bigint;
  v_target text;
  v_legacy_prefix text;
  v_canonical_prefix text;
begin
  if new.room_id is not null then
    select hotel_slug,tenant_id,property_id
      into v_owner_slug,v_owner_tenant,v_owner_property
    from public.rooms where id=new.room_id;
    v_target:='room:'||new.room_id;
  else
    select hotel_slug,tenant_id,property_id
      into v_owner_slug,v_owner_tenant,v_owner_property
    from public.room_types where id=new.room_type_id;
    v_target:='room-type:'||new.room_type_id;
  end if;

  if v_owner_slug is null or v_owner_tenant is null or v_owner_property is null then
    raise exception using errcode='P0001',message='ROOM_IMAGE_OWNER_NOT_VISIBLE';
  end if;
  if new.hotel_slug<>v_owner_slug
     or new.tenant_id is distinct from v_owner_tenant
     or new.property_id is distinct from v_owner_property then
    raise exception using errcode='P0001',message='ROOM_IMAGE_HOTEL_SCOPE_MISMATCH';
  end if;

  v_legacy_prefix:=v_owner_slug||'/room-images/';
  v_canonical_prefix:=
    'tenants/'||v_owner_tenant::text||'/properties/'||
    v_owner_property::text||'/room-images/';
  if position('..' in new.storage_path)>0
     or not (
       new.storage_path like v_legacy_prefix||'%'
       or new.storage_path like v_canonical_prefix||'%'
     ) then
    raise exception using errcode='P0001',message='ROOM_IMAGE_STORAGE_SCOPE_MISMATCH';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('room-image:'||v_owner_slug||':'||v_target,0)
  );
  if new.is_primary then
    update public.room_images set is_primary=false,updated_at=now()
      where hotel_slug=v_owner_slug
        and id<>coalesce(new.id,0)
        and room_id is not distinct from new.room_id
        and room_type_id is not distinct from new.room_type_id
        and is_primary;
  end if;
  new.updated_at:=now();
  return new;
end;
$task3g_room_image_scope$;

revoke all on function public.protect_room_image_scope()
  from public,anon,authenticated,app_tenant_runtime,app_tenant_rpc_owner;
grant execute on function public.protect_room_image_scope() to service_role;

do $task3g_room_image_guard$
declare bad_count bigint;
begin
  select count(*) into bad_count
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='protect_room_image_scope'
    and (
      p.prosecdef
      or not exists (
        select 1 from unnest(coalesce(p.proconfig,array[]::text[])) setting
        where setting='search_path=pg_catalog, public'
      )
      or has_function_privilege('app_tenant_runtime',p.oid,'EXECUTE')
    );
  if bad_count<>0 then
    raise exception 'TASK3G_ROOM_IMAGE_FUNCTION_GUARD_FAILED';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgrelid='public.room_images'::regclass
      and tgname='trg_protect_room_image_scope' and not tgisinternal
  ) then
    raise exception 'TASK3G_ROOM_IMAGE_TRIGGER_MISSING';
  end if;
end;
$task3g_room_image_guard$;

commit;
