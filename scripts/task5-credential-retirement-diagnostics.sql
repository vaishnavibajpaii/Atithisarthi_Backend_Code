-- Task 5: read-only diagnostic for compromised credential retirement.
-- Returns counts and lifecycle statuses only. It never reads or returns key IDs,
-- secret values, Vault handles, credential references, account IDs, payloads, or PII.

with target_property as (
  select h.tenant_id, h.id as property_id
  from public.hotels h
  where h.slug = 'hotel-sai-raj'
    and h.tenant_id is not null
),
target_accounts as (
  select a.id, a.tenant_id, a.property_id, a.status, a.mode,
    p.resolution_mode
  from target_property t
  join public.property_payment_gateway_policies p
    on p.tenant_id = t.tenant_id
   and p.property_id = t.property_id
   and p.provider = 'razorpay'
  join public.payment_gateway_accounts a
    on a.tenant_id = p.tenant_id
   and a.property_id = p.property_id
   and a.provider = p.provider
   and a.mode = p.mode
  where a.mode = 'TEST'
),
account_summary as (
  select
    count(*) as matching_accounts,
    count(*) filter (
      where status = 'ACTIVE' and resolution_mode = 'PER_PROPERTY'
    ) as active_per_property_accounts
  from target_accounts
),
credential_summary as (
  select
    count(c.id) as total_api_versions,
    count(*) filter (where c.status = 'PENDING') as pending_api_versions,
    count(*) filter (where c.status = 'ACTIVE') as active_api_versions,
    count(*) filter (where c.status = 'HISTORICAL') as historical_api_versions,
    count(*) filter (where c.status = 'INVALID') as invalid_api_versions,
    count(*) filter (where c.status = 'RETIRED') as retired_api_versions,
    min(c.version) as minimum_api_version,
    max(c.version) as maximum_api_version
  from target_accounts a
  left join public.payment_gateway_credentials c on c.account_id = a.id
),
webhook_summary as (
  select
    count(w.id) as total_webhook_versions,
    count(*) filter (where w.status = 'PENDING') as pending_webhook_versions,
    count(*) filter (where w.status = 'ACTIVE') as active_webhook_versions,
    count(*) filter (where w.status = 'HISTORICAL') as historical_webhook_versions,
    count(*) filter (where w.status = 'INVALID') as invalid_webhook_versions,
    count(*) filter (where w.status = 'RETIRED') as retired_webhook_versions,
    min(w.version) as minimum_webhook_version,
    max(w.version) as maximum_webhook_version
  from target_accounts a
  left join public.payment_gateway_webhook_secrets w on w.account_id = a.id
),
intent_summary as (
  select
    count(*) as byog_payment_intents,
    count(*) filter (where c.status = 'ACTIVE') as intents_bound_to_active_api,
    count(*) filter (where c.status = 'HISTORICAL') as intents_bound_to_historical_api,
    count(*) filter (where c.status = 'RETIRED') as intents_bound_to_retired_api,
    count(*) filter (where c.id is null) as intents_with_missing_api_binding
  from target_accounts a
  join public.payment_intents i
    on i.gateway_account_id = a.id
   and i.tenant_id = a.tenant_id
   and i.property_id = a.property_id
  left join public.payment_gateway_credentials c
    on c.account_id = i.gateway_account_id
   and c.credential_ref = i.credential_ref
),
audit_summary as (
  select
    count(*) filter (where e.action = 'CONFIGURE' and e.outcome = 'SUCCESS')
      as successful_configurations,
    count(*) filter (where e.action = 'ROTATE' and e.outcome = 'SUCCESS')
      as successful_rotations,
    count(*) filter (where e.action = 'RETIRE' and e.outcome = 'SUCCESS')
      as successful_retirements
  from target_accounts a
  left join public.payment_gateway_audit_events e on e.account_id = a.id
)
select
  case
    when (select count(*) from target_property) = 1 then 'PASS' else 'FAIL'
  end as canonical_property,
  a.matching_accounts,
  a.active_per_property_accounts,
  c.total_api_versions,
  c.pending_api_versions,
  c.active_api_versions,
  c.historical_api_versions,
  c.invalid_api_versions,
  c.retired_api_versions,
  c.minimum_api_version,
  c.maximum_api_version,
  w.total_webhook_versions,
  w.pending_webhook_versions,
  w.active_webhook_versions,
  w.historical_webhook_versions,
  w.invalid_webhook_versions,
  w.retired_webhook_versions,
  w.minimum_webhook_version,
  w.maximum_webhook_version,
  i.byog_payment_intents,
  i.intents_bound_to_active_api,
  i.intents_bound_to_historical_api,
  i.intents_bound_to_retired_api,
  i.intents_with_missing_api_binding,
  e.successful_configurations,
  e.successful_rotations,
  e.successful_retirements
from account_summary a
cross join credential_summary c
cross join webhook_summary w
cross join intent_summary i
cross join audit_summary e;
