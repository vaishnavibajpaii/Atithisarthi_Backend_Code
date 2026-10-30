-- Task 7C follow-up verification. READ ONLY; no object/customer/secret content.
-- Run manually after the reviewed TEST bucket settings step, not as a migration.
begin transaction isolation level repeatable read read only;
set local statement_timeout = '10s';
set local lock_timeout = '2s';

with expected_policy(name, command, using_expression, check_expression) as (
  values ('task3f_direct_insert_deny', 'INSERT', null::text, 'false'),
         ('task3f_direct_update_deny', 'UPDATE', 'false', 'false'),
         ('task3f_direct_delete_deny', 'DELETE', 'false', null::text)
), policy_validity as (
  select e.name, count(p.*) = 1 and bool_and(
    p.cmd = e.command and p.permissive = 'RESTRICTIVE'
    and p.roles @> array['anon'::name,'authenticated'::name]
    and p.roles <@ array['anon'::name,'authenticated'::name]
    and cardinality(p.roles) = 2
    and p.qual is not distinct from e.using_expression
    and p.with_check is not distinct from e.check_expression
  ) as valid
  from expected_policy e left join pg_policies p
    on p.schemaname = 'storage' and p.tablename = 'objects' and p.policyname = e.name
  group by e.name
), bucket as (
  select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'hotel-assets'
), checks(name, ok) as (
  select 'bucket_present', count(*) = 1 from bucket
  union all
  select 'public_asset_delivery_preserved', count(*) = 1 and bool_and(public) from bucket
  union all
  -- Keep legitimate 8 MiB room images working. Accept either UI MB convention
  -- for a 10 MB cap; do not tighten every route to the generic 5 MiB limit.
  select 'bucket_size_compatible_with_8_mib_room_upload', count(*) = 1
    and bool_and(coalesce(file_size_limit between 8388608 and 10485760, false)) from bucket
  union all
  select 'bucket_four_image_mime_types', count(*) = 1 and bool_and(coalesce(
    allowed_mime_types @> array['image/jpeg','image/png','image/webp','image/avif']::text[]
    and allowed_mime_types <@ array['image/jpeg','image/png','image/webp','image/avif']::text[]
    and cardinality(allowed_mime_types) = 4, false)) from bucket
  union all
  select 'storage_bucket_objects_rls_on', count(*) = 2 and bool_and(c.relrowsecurity)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'storage' and c.relname in ('buckets','objects') and c.relkind in ('r','p')
  union all
  select 'reviewed_direct_mutation_deny_policies',
    coalesce((select count(*) = 3 and bool_and(valid) from policy_validity), false)
    and (select count(*) = 3 from pg_policies where schemaname = 'storage' and tablename = 'objects')
), inventory(section, object_identity, details) as (
  select 'context'::text, 'execution'::text,
    jsonb_build_object('script','TASK7C_STORAGE_CONTROLS_VERIFY_V1', 'captured_at',current_timestamp,
      'server_version',current_setting('server_version'), 'transaction_read_only',current_setting('transaction_read_only'))
  union all
  select 'bucket', id, jsonb_build_object('public',public,'file_size_limit',file_size_limit,'allowed_mime_types',allowed_mime_types) from bucket
  union all
  select 'check', name, jsonb_build_object('result',case when coalesce(ok,false) then 'PASS' else 'FAIL' end) from checks
  union all
  select 'storage_relation', format('%I.%I',n.nspname,c.relname),
    jsonb_build_object('owner',pg_get_userbyid(c.relowner),'rls_enabled',c.relrowsecurity,'force_rls',c.relforcerowsecurity)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'storage' and c.relkind in ('r','p')
  union all
  select 'storage_policy', format('%I.%I.%I',p.schemaname,p.tablename,p.policyname),
    jsonb_build_object('command',p.cmd,'roles',p.roles,'permissive',p.permissive,
      'using_md5',md5(p.qual),'check_md5',md5(p.with_check))
  from pg_policies p where p.schemaname = 'storage'
)
select section, object_identity, details from inventory order by section, object_identity;

commit;
