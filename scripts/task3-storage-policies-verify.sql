-- Task 3F read-only catalog verifier.
-- Expected result: every row whose result is not INFO must be PASS.

with expected_policies(policyname, cmd, expected_qual, expected_check) as (
  values
    ('task3f_direct_insert_deny', 'INSERT', null::text, 'false'),
    ('task3f_direct_update_deny', 'UPDATE', 'false', 'false'),
    ('task3f_direct_delete_deny', 'DELETE', 'false', null::text)
),
policy_checks as (
  select
    e.policyname,
    case when count(p.*) = 1
      and bool_and(p.permissive = 'RESTRICTIVE')
      and bool_and(p.cmd = e.cmd)
      and bool_and(p.roles @> array['anon'::name, 'authenticated'::name])
      and bool_and(p.roles <@ array['anon'::name, 'authenticated'::name])
      and bool_and(p.qual is not distinct from e.expected_qual)
      and bool_and(p.with_check is not distinct from e.expected_check)
    then 1 else 0 end as valid
  from expected_policies e
  left join pg_policies p
    on p.schemaname = 'storage'
   and p.tablename = 'objects'
   and p.policyname = e.policyname
  group by e.policyname, e.cmd, e.expected_qual, e.expected_check
),
storage_relation as (
  select c.relrowsecurity, c.relforcerowsecurity
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'storage' and c.relname = 'objects'
),
hotel_slugs as (
  select array_agg(lower(slug)) as slugs
  from public.hotels
  where slug is not null and btrim(slug) <> ''
),
object_inventory as (
  select
    count(*) filter (where o.bucket_id = 'hotel-assets') as total_objects,
    count(*) filter (
      where o.bucket_id = 'hotel-assets'
        and split_part(o.name, '/', 1) <> 'tenants'
        and split_part(o.name, '/', 1) not in ('platform', 'shared')
        and not (split_part(o.name, '/', 1) = any(coalesce(h.slugs, array[]::text[])))
    ) as preserved_unmapped_objects
  from storage.objects o
  cross join hotel_slugs h
),
canonical_objects as (
  select
    o.name,
    split_part(o.name, '/', 2) as tenant_text,
    split_part(o.name, '/', 4) as property_text
  from storage.objects o
  where o.bucket_id = 'hotel-assets'
    and split_part(o.name, '/', 1) = 'tenants'
    and split_part(o.name, '/', 3) = 'properties'
    and split_part(o.name, '/', 2) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and split_part(o.name, '/', 4) ~ '^[1-9][0-9]*$'
),
checks(check_name, expected, actual, result) as (
  select 'hotel_assets_bucket_present', '1', count(*)::text,
    case when count(*) = 1 then 'PASS' else 'FAIL' end
  from storage.buckets where id = 'hotel-assets'

  union all
  select 'hotel_assets_public_compatibility', 'true', coalesce(bool_and(public)::text, 'NULL'),
    case when count(*) = 1 and bool_and(public) then 'PASS' else 'FAIL' end
  from storage.buckets where id = 'hotel-assets'

  union all
  select 'storage_objects_rls_enabled', 'true', coalesce(bool_and(relrowsecurity)::text, 'NULL'),
    case when count(*) = 1 and bool_and(relrowsecurity) then 'PASS' else 'FAIL' end
  from storage_relation

  union all
  select 'storage_objects_force_rls_unchanged', 'false', coalesce(bool_or(relforcerowsecurity)::text, 'NULL'),
    case when count(*) = 1 and not bool_or(relforcerowsecurity) then 'PASS' else 'FAIL' end
  from storage_relation

  union all
  select 'task3f_policy_count', '3', count(*)::text,
    case when count(*) = 3 then 'PASS' else 'FAIL' end
  from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
    and policyname like 'task3f_%'

  union all
  select 'task3f_policy_definitions', '3', coalesce(sum(valid), 0)::text,
    case when coalesce(sum(valid), 0) = 3 then 'PASS' else 'FAIL' end
  from policy_checks

  union all
  select 'unexpected_direct_mutation_policies', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from pg_policies p
  where p.schemaname = 'storage' and p.tablename = 'objects'
    and p.cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
    and p.roles && array['public'::name, 'anon'::name, 'authenticated'::name]
    and p.policyname not in (
      'task3f_direct_insert_deny',
      'task3f_direct_update_deny',
      'task3f_direct_delete_deny'
    )

  union all
  select 'app_tenant_runtime_storage_privileges', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from information_schema.role_table_grants
  where grantee = 'app_tenant_runtime' and table_schema = 'storage'

  union all
  select 'service_role_bypass_path_preserved', 'true', coalesce(bool_and(rolbypassrls)::text, 'NULL'),
    case when count(*) = 1 and bool_and(rolbypassrls) then 'PASS' else 'FAIL' end
  from pg_roles
  where rolname = 'service_role'

  union all
  select 'canonical_path_ownership_mismatches', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from canonical_objects c
  left join public.hotels h
    on h.id = c.property_text::bigint
   and h.tenant_id = c.tenant_text::uuid
  where h.id is null

  union all
  select 'storage_object_count_not_below_preflight', '>=174', total_objects::text,
    case when total_objects >= 174 then 'PASS' else 'FAIL' end
  from object_inventory

  union all
  select 'unmapped_objects_preserved', '>=32', preserved_unmapped_objects::text,
    case when preserved_unmapped_objects >= 32 then 'PASS' else 'FAIL' end
  from object_inventory

  union all
  select 'database_name', 'postgres', current_database(), 'INFO'

  union all
  select 'postgres_version', '17.6 baseline', current_setting('server_version'), 'INFO'
)
select check_name, expected, actual, result
from checks
order by check_name;

