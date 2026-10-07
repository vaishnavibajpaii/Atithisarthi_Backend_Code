-- Task 3F: additive Supabase Storage mutation lockdown.
-- MANUAL EXECUTION ONLY. Run in the approved Supabase SQL editor with stop-on-error.
-- This script does not move, rename, update, or delete any storage object.

begin;

do $$
declare
  v_bucket_count integer;
  v_bucket_public boolean;
  v_rls_enabled boolean;
  v_unexpected_policies integer;
begin
  select count(*), bool_and(public)
    into v_bucket_count, v_bucket_public
  from storage.buckets
  where id = 'hotel-assets';

  if v_bucket_count <> 1 then
    raise exception 'TASK3F_HOTEL_ASSETS_BUCKET_COUNT expected=1 actual=%', v_bucket_count;
  end if;
  if v_bucket_public is distinct from true then
    raise exception 'TASK3F_PUBLIC_DELIVERY_COMPATIBILITY_CHANGED';
  end if;

  select c.relrowsecurity
    into v_rls_enabled
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'storage' and c.relname = 'objects';

  if v_rls_enabled is distinct from true then
    raise exception 'TASK3F_STORAGE_OBJECTS_RLS_DISABLED';
  end if;

  select count(*)
    into v_unexpected_policies
  from pg_policies p
  where p.schemaname = 'storage'
    and p.tablename = 'objects'
    and p.cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
    and p.roles && array['public'::name, 'anon'::name, 'authenticated'::name]
    and p.policyname not in (
      'task3f_direct_insert_deny',
      'task3f_direct_update_deny',
      'task3f_direct_delete_deny'
    );

  if v_unexpected_policies <> 0 then
    raise exception 'TASK3F_UNEXPECTED_DIRECT_MUTATION_POLICIES count=%', v_unexpected_policies;
  end if;
end
$$;

drop policy if exists task3f_direct_insert_deny on storage.objects;
drop policy if exists task3f_direct_update_deny on storage.objects;
drop policy if exists task3f_direct_delete_deny on storage.objects;

create policy task3f_direct_insert_deny
on storage.objects
as restrictive
for insert
to anon, authenticated
with check (false);

create policy task3f_direct_update_deny
on storage.objects
as restrictive
for update
to anon, authenticated
using (false)
with check (false);

create policy task3f_direct_delete_deny
on storage.objects
as restrictive
for delete
to anon, authenticated
using (false);

commit;

-- Non-destructive rollback (manual, only if this release must be reverted):
--   drop policy if exists task3f_direct_insert_deny on storage.objects;
--   drop policy if exists task3f_direct_update_deny on storage.objects;
--   drop policy if exists task3f_direct_delete_deny on storage.objects;
-- Rollback removes only Task 3F policy definitions. It never removes objects.

