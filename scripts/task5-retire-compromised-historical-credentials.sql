-- Task 5: retire one compromised historical Razorpay TEST credential pair.
--
-- Run only after:
--   1. the property has successfully rotated to a new ACTIVE API credential and
--      ACTIVE webhook secret;
--   2. Razorpay checkout and webhook delivery have passed with the new versions;
--   3. the previous provider API key has been revoked in Razorpay.
--
-- This script never reads or returns secret material. It preserves the immutable
-- credential rows, Vault references, PaymentIntent bindings, and audit evidence.
-- It deliberately stops unless there is exactly one ACTIVE and one HISTORICAL
-- API credential plus exactly one ACTIVE and one HISTORICAL webhook version.

begin;

do $task5_retire_compromised$
declare
  -- REQUIRED: replace this sentinel with the canonical property slug.
  v_hotel_slug text := '__REPLACE_WITH_CANONICAL_HOTEL_SLUG__';
  v_tenant_id uuid;
  v_property_id bigint;
  v_account_id uuid;
  v_account_count bigint;
  v_active_api_count bigint;
  v_historical_api_count bigint;
  v_active_webhook_count bigint;
  v_historical_webhook_count bigint;
  v_retired_api_count bigint;
  v_retired_webhook_count bigint;
begin
  if v_hotel_slug = '__REPLACE_WITH_CANONICAL_HOTEL_SLUG__'
     or nullif(btrim(v_hotel_slug), '') is null then
    raise exception using errcode = '22023',
      message = 'TASK5_CANONICAL_HOTEL_SLUG_REQUIRED';
  end if;
  perform set_config('app.task5_retire_hotel_slug', v_hotel_slug, true);

  select h.tenant_id, h.id
    into strict v_tenant_id, v_property_id
  from public.hotels h
  where h.slug = v_hotel_slug
    and h.tenant_id is not null;

  select count(*), (array_agg(a.id order by a.created_at desc))[1]
    into v_account_count, v_account_id
  from public.property_payment_gateway_policies p
  join public.payment_gateway_accounts a
    on a.tenant_id = p.tenant_id
   and a.property_id = p.property_id
   and a.provider = p.provider
   and a.mode = p.mode
  where p.tenant_id = v_tenant_id
    and p.property_id = v_property_id
    and p.provider = 'razorpay'
    and p.mode = 'TEST'
    and p.resolution_mode = 'PER_PROPERTY'
    and a.status = 'ACTIVE';

  if v_account_count <> 1 or v_account_id is null then
    raise exception using errcode = '23514',
      message = 'TASK5_SINGLE_ACTIVE_TEST_ACCOUNT_REQUIRED';
  end if;

  select
    count(*) filter (where c.status = 'ACTIVE'),
    count(*) filter (where c.status = 'HISTORICAL')
    into v_active_api_count, v_historical_api_count
  from public.payment_gateway_credentials c
  where c.tenant_id = v_tenant_id
    and c.property_id = v_property_id
    and c.account_id = v_account_id;

  select
    count(*) filter (where w.status = 'ACTIVE'),
    count(*) filter (where w.status = 'HISTORICAL')
    into v_active_webhook_count, v_historical_webhook_count
  from public.payment_gateway_webhook_secrets w
  where w.tenant_id = v_tenant_id
    and w.property_id = v_property_id
    and w.account_id = v_account_id;

  if v_active_api_count <> 1 or v_historical_api_count <> 1
     or v_active_webhook_count <> 1 or v_historical_webhook_count <> 1 then
    raise exception using errcode = '23514',
      message = 'TASK5_SINGLE_ROTATION_PAIR_REQUIRED';
  end if;

  with retired as (
    update public.payment_gateway_credentials c
       set status = 'RETIRED'
     where c.tenant_id = v_tenant_id
       and c.property_id = v_property_id
       and c.account_id = v_account_id
       and c.status = 'HISTORICAL'
    returning c.credential_ref
  )
  insert into public.payment_gateway_audit_events (
    tenant_id, property_id, account_id, credential_ref,
    action, outcome, actor_ref, reason_code
  )
  select v_tenant_id, v_property_id, v_account_id, r.credential_ref,
    'RETIRE', 'SUCCESS', 'task5_security_response',
    'COMPROMISED_SECRET_EXPOSURE'
  from retired r;
  get diagnostics v_retired_api_count = row_count;

  with retired as (
    update public.payment_gateway_webhook_secrets w
       set status = 'RETIRED'
     where w.tenant_id = v_tenant_id
       and w.property_id = v_property_id
       and w.account_id = v_account_id
       and w.status = 'HISTORICAL'
    returning w.webhook_secret_ref
  )
  insert into public.payment_gateway_audit_events (
    tenant_id, property_id, account_id, webhook_secret_ref,
    action, outcome, actor_ref, reason_code
  )
  select v_tenant_id, v_property_id, v_account_id, r.webhook_secret_ref,
    'RETIRE', 'SUCCESS', 'task5_security_response',
    'COMPROMISED_SECRET_EXPOSURE'
  from retired r;
  get diagnostics v_retired_webhook_count = row_count;

  if v_retired_api_count <> 1 or v_retired_webhook_count <> 1 then
    raise exception using errcode = '23514',
      message = 'TASK5_COMPROMISED_PAIR_RETIREMENT_INCOMPLETE';
  end if;

  if exists (
    select 1
    from public.payment_gateway_credentials c
    where c.account_id = v_account_id and c.status = 'HISTORICAL'
  ) or exists (
    select 1
    from public.payment_gateway_webhook_secrets w
    where w.account_id = v_account_id and w.status = 'HISTORICAL'
  ) then
    raise exception using errcode = '23514',
      message = 'TASK5_HISTORICAL_SECRET_STILL_RUNTIME_ELIGIBLE';
  end if;
end;
$task5_retire_compromised$;

-- Safe metadata-only result. No IDs, key material, Vault handles, payloads, or PII.
select
  case
    when count(*) filter (where c.status = 'ACTIVE') = 1
     and count(*) filter (where c.status = 'HISTORICAL') = 0
     and count(*) filter (where c.status = 'RETIRED') >= 1
    then 'PASS' else 'FAIL'
  end as api_credential_retirement,
  case
    when (
      select count(*)
      from public.payment_gateway_webhook_secrets w
      where w.account_id = c.account_id and w.status = 'ACTIVE'
    ) = 1
     and (
      select count(*)
      from public.payment_gateway_webhook_secrets w
      where w.account_id = c.account_id and w.status = 'HISTORICAL'
    ) = 0
     and (
      select count(*)
      from public.payment_gateway_webhook_secrets w
      where w.account_id = c.account_id and w.status = 'RETIRED'
    ) >= 1
    then 'PASS' else 'FAIL'
  end as webhook_secret_retirement,
  count(*) filter (where c.status = 'ACTIVE') as active_api_versions,
  count(*) filter (where c.status = 'RETIRED') as retired_api_versions
from public.payment_gateway_credentials c
join public.payment_gateway_accounts a on a.id = c.account_id
join public.hotels h
  on h.tenant_id = a.tenant_id and h.id = a.property_id
where h.slug = current_setting('app.task5_retire_hotel_slug', true)
  and a.provider = 'razorpay'
  and a.mode = 'TEST'
  and a.status = 'ACTIVE'
group by c.account_id;

commit;
