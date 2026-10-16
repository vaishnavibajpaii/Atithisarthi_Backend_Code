-- Task 5: read-only deployed-function diagnostic for credential rotation.
-- Returns only function metadata and boolean source-shape checks. It never
-- reads or returns key material, Vault data, credential references, or PII.

with target_function as (
  select
    p.oid,
    p.prosecdef,
    r.rolname as owner_name,
    pg_get_functiondef(p.oid) as definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles r on r.oid = p.proowner
  where n.nspname = 'public'
    and p.proname = 'task5_configure_property_gateway'
    and pg_get_function_identity_arguments(p.oid) =
      'p_provider text, p_mode text, p_key_id text, p_key_secret text, p_webhook_secret text, p_actor_ref text, p_validation_code text, p_rotation_continuity_verified boolean, p_expected_credential_ref text'
),
allocator_functions as (
  select
    bool_or(
      p.proname = 'task5_guard_gateway_credential'
      and pg_get_functiondef(p.oid) like '%max(version)%'
      and pg_get_functiondef(p.oid) like '%new.version%'
    ) as api_allocator_present,
    bool_or(
      p.proname = 'task5_guard_gateway_webhook_secret'
      and pg_get_functiondef(p.oid) like '%max(version)%'
      and pg_get_functiondef(p.oid) like '%new.version%'
    ) as webhook_allocator_present
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'task5_guard_gateway_credential',
      'task5_guard_gateway_webhook_secret'
    )
),
target_account as (
  select a.id
  from public.hotels h
  join public.property_payment_gateway_policies p
    on p.tenant_id = h.tenant_id
   and p.property_id = h.id
   and p.provider = 'razorpay'
   and p.mode = 'TEST'
   and p.resolution_mode = 'PER_PROPERTY'
  join public.payment_gateway_accounts a
    on a.tenant_id = p.tenant_id
   and a.property_id = p.property_id
   and a.provider = p.provider
   and a.mode = p.mode
   and a.status = 'ACTIVE'
  where h.slug = 'hotel-sai-raj'
),
version_state as (
  select
    (select count(*) from target_account) as matching_accounts,
    (
      select count(*)
      from public.payment_gateway_credentials c
      join target_account a on a.id = c.account_id
    ) as api_versions,
    (
      select coalesce(max(c.version), 0)
      from public.payment_gateway_credentials c
      join target_account a on a.id = c.account_id
    ) as maximum_api_version,
    (
      select count(*)
      from public.payment_gateway_webhook_secrets w
      join target_account a on a.id = w.account_id
    ) as webhook_versions,
    (
      select coalesce(max(w.version), 0)
      from public.payment_gateway_webhook_secrets w
      join target_account a on a.id = w.account_id
    ) as maximum_webhook_version
)
select
  case when count(f.oid) = 1 then 'PASS' else 'FAIL' end as function_present,
  case
    when count(*) filter (
      where f.prosecdef and f.owner_name = 'app_payment_gateway_secret_owner'
    ) = 1 then 'PASS' else 'FAIL'
  end as restricted_security_definer,
  case
    when bool_and(alloc.api_allocator_present) then 'PASS' else 'FAIL'
  end as api_rotation_version_allocator,
  case
    when bool_and(alloc.webhook_allocator_present) then 'PASS' else 'FAIL'
  end as webhook_rotation_version_allocator,
  v.matching_accounts,
  v.api_versions,
  v.maximum_api_version,
  v.webhook_versions,
  v.maximum_webhook_version,
  case
    when count(f.oid) = 1
     and v.matching_accounts = 1
     and v.api_versions = 1
     and v.webhook_versions = 1
     and bool_and(alloc.api_allocator_present)
     and bool_and(alloc.webhook_allocator_present)
    then 'VERSION_ALLOCATION_DELEGATED_TO_GUARDS'
    else 'REVIEW_REQUIRED'
  end as diagnosis
from version_state v
left join target_function f on true
cross join allocator_functions alloc
group by
  v.matching_accounts,
  v.api_versions,
  v.maximum_api_version,
  v.webhook_versions,
  v.maximum_webhook_version,
  alloc.api_allocator_present,
  alloc.webhook_allocator_present;
