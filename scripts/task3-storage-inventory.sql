-- TASK3-F preflight: authoritative read-only storage inventory.
-- Run in the Supabase SQL Editor as the project database administrator.
-- This script performs no DDL/DML and does not return object names, URLs,
-- filenames, owner identifiers, or customer data.

with
bucket as (
  select
    b.id::text as id,
    b.public,
    b.file_size_limit,
    coalesce(to_jsonb(b.allowed_mime_types), 'null'::jsonb) as allowed_mime_types
  from storage.buckets b
  where b.id = 'hotel-assets'
),
object_stats as (
  select
    count(*)::bigint as total_objects,
    count(*) filter (where o.owner_id is null)::bigint as owner_id_null,
    count(*) filter (
      where o.name ~ '^tenants/[0-9a-fA-F-]{36}/properties/[0-9]+/'
    )::bigint as canonical_paths,
    count(*) filter (
      where split_part(o.name, '/', 1) = 'platform'
    )::bigint as platform_paths,
    count(*) filter (
      where split_part(o.name, '/', 1) = 'shared'
    )::bigint as shared_paths,
    count(*) filter (
      where exists (
        select 1
        from public.hotels h
        where h.slug = split_part(o.name, '/', 1)
      )
    )::bigint as legacy_hotel_slug_paths,
    count(*) filter (
      where not (
        o.name ~ '^tenants/[0-9a-fA-F-]{36}/properties/[0-9]+/'
        or split_part(o.name, '/', 1) in ('platform', 'shared')
        or exists (
          select 1
          from public.hotels h
          where h.slug = split_part(o.name, '/', 1)
        )
      )
    )::bigint as unknown_prefix_paths
  from storage.objects o
  where o.bucket_id = 'hotel-assets'
),
canonical_parts as (
  select
    o.id,
    (regexp_match(
      o.name,
      '^tenants/([0-9a-fA-F-]{36})/properties/([0-9]+)/'
    ))[1]::uuid as tenant_id,
    (regexp_match(
      o.name,
      '^tenants/([0-9a-fA-F-]{36})/properties/([0-9]+)/'
    ))[2]::bigint as property_id
  from storage.objects o
  where o.bucket_id = 'hotel-assets'
    and o.name ~ '^tenants/[0-9a-fA-F-]{36}/properties/[0-9]+/'
),
canonical_stats as (
  select
    count(*) filter (where h.id is null)::bigint as ownership_mismatches
  from canonical_parts p
  left join public.hotels h
    on h.id = p.property_id
   and h.tenant_id = p.tenant_id
),
policy_stats as (
  select
    count(*)::bigint as policy_count,
    count(*) filter (
      where policyname like 'task3f_%'
    )::bigint as task3f_policy_count,
    count(*) filter (
      where cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
        and roles && array['public', 'anon', 'authenticated']::name[]
    )::bigint as direct_client_mutation_policy_count
  from pg_policies
  where schemaname = 'storage'
    and tablename = 'objects'
),
grant_stats as (
  select
    count(*) filter (
      where grantee in ('PUBLIC', 'anon', 'authenticated')
        and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    )::bigint as direct_client_mutation_grants,
    count(*) filter (
      where grantee = 'app_tenant_runtime'
    )::bigint as runtime_role_grants
  from information_schema.role_table_grants
  where table_schema = 'storage'
    and table_name = 'objects'
),
rls_state as (
  select
    c.relrowsecurity,
    c.relforcerowsecurity
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'storage'
    and c.relname = 'objects'
    and c.relkind in ('r', 'p')
),
inventory as (
  select
    'database_name'::text as check_name,
    current_database()::text as actual,
    'INFO'::text as result,
    'Connected database'::text as details
  union all
  select
    'postgres_version',
    current_setting('server_version'),
    'INFO',
    'Server version'
  union all
  select
    'hotel_assets_bucket_present',
    count(*)::text,
    case when count(*) = 1 then 'PASS' else 'FAIL' end,
    'Expected exactly one hotel-assets bucket'
  from bucket
  union all
  select
    'hotel_assets_bucket_public',
    coalesce((select public::text from bucket), 'missing'),
    'INFO',
    'Public delivery is compatibility-sensitive; Task 3F must not change it blindly'
  union all
  select
    'hotel_assets_file_size_limit',
    coalesce((select file_size_limit::text from bucket), 'NULL'),
    'INFO',
    'Bucket-level limit; backend routes also enforce route-specific limits'
  union all
  select
    'hotel_assets_allowed_mime_types',
    coalesce((select allowed_mime_types::text from bucket), 'NULL'),
    'INFO',
    'Bucket-level MIME allowlist'
  union all
  select
    'storage_objects_rls_enabled',
    coalesce((select relrowsecurity::text from rls_state), 'missing'),
    case
      when (select relrowsecurity from rls_state) is true then 'PASS'
      else 'FAIL'
    end,
    'storage.objects must retain RLS'
  union all
  select
    'storage_objects_force_rls',
    coalesce((select relforcerowsecurity::text from rls_state), 'missing'),
    'INFO',
    'Catalog evidence only; Supabase owns storage internals'
  union all
  select
    'storage_objects_policy_count',
    policy_count::text,
    'INFO',
    'All policies on storage.objects'
  from policy_stats
  union all
  select
    'task3f_policy_count',
    task3f_policy_count::text,
    case when task3f_policy_count = 0 then 'PASS' else 'REVIEW' end,
    'Preflight expects no partially installed Task 3F policy set'
  from policy_stats
  union all
  select
    'direct_client_mutation_policy_count',
    direct_client_mutation_policy_count::text,
    case
      when direct_client_mutation_policy_count = 0 then 'PASS'
      else 'REVIEW'
    end,
    'Mutation policies involving public/anon/authenticated require review'
  from policy_stats
  union all
  select
    'direct_client_mutation_grants',
    direct_client_mutation_grants::text,
    'INFO',
    'Grants alone do not bypass RLS; captured for authoritative review'
  from grant_stats
  union all
  select
    'app_tenant_runtime_storage_grants',
    runtime_role_grants::text,
    case when runtime_role_grants = 0 then 'PASS' else 'REVIEW' end,
    'Task 3E runtime role should not directly modify Supabase storage internals'
  from grant_stats
  union all
  select
    'hotel_assets_total_objects',
    total_objects::text,
    'INFO',
    'Aggregate count only; no object names returned'
  from object_stats
  union all
  select
    'hotel_assets_owner_id_null',
    owner_id_null::text,
    'INFO',
    'Service-role uploads commonly have no end-user owner'
  from object_stats
  union all
  select
    'canonical_tenant_property_paths',
    canonical_paths::text,
    'INFO',
    'Target shape: tenants/<tenant-uuid>/properties/<property-id>/...'
  from object_stats
  union all
  select
    'legacy_hotel_slug_paths',
    legacy_hotel_slug_paths::text,
    'INFO',
    'Legacy paths remain readable and are not renamed by Task 3F'
  from object_stats
  union all
  select
    'platform_paths',
    platform_paths::text,
    'INFO',
    'Explicit platform-owned prefix'
  from object_stats
  union all
  select
    'shared_paths',
    shared_paths::text,
    'INFO',
    'Legacy platform/shared prefix'
  from object_stats
  union all
  select
    'unknown_prefix_paths',
    unknown_prefix_paths::text,
    case when unknown_prefix_paths = 0 then 'PASS' else 'BLOCKER' end,
    'Unknown prefixes must be mapped before mutation enforcement'
  from object_stats
  union all
  select
    'canonical_path_ownership_mismatches',
    ownership_mismatches::text,
    case when ownership_mismatches = 0 then 'PASS' else 'BLOCKER' end,
    'Canonical tenant/property path pairs must match public.hotels'
  from canonical_stats
)
select check_name, actual, result, details
from inventory
order by check_name;

-- Policy definitions contain no customer data and are required to design
-- the exact Task 3F migration. Return this second result set as well.
select
  policyname,
  permissive,
  cmd,
  roles::text as roles,
  coalesce(qual, '') as using_expression,
  coalesce(with_check, '') as with_check_expression
from pg_policies
where schemaname = 'storage'
  and tablename = 'objects'
order by policyname;
