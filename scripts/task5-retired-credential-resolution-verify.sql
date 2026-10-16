-- Task 5: verify runtime resolution after early credential retirement.
--
-- This script never returns secrets, key IDs, Vault handles, account IDs,
-- credential references, PaymentIntent IDs, payloads, or PII. It invokes the
-- bound resolver internally and returns row counts only. Temporary role
-- membership and transaction-local context are removed by the final ROLLBACK.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '2min';
set local search_path = pg_catalog, public;

do $task5_retired_resolution_prepare$
declare
  v_tenant_id uuid;
  v_property_id bigint;
  v_retired_account_id uuid;
  v_retired_merchant_ref text;
  v_retired_credential_ref text;
  v_active_account_id uuid;
  v_active_merchant_ref text;
  v_active_credential_ref text;
begin
  select i.tenant_id, i.property_id, i.gateway_account_id,
    i.merchant_ref, i.credential_ref
    into strict v_tenant_id, v_property_id, v_retired_account_id,
      v_retired_merchant_ref, v_retired_credential_ref
  from public.payment_intents i
  join public.hotels h
    on h.tenant_id = i.tenant_id and h.id = i.property_id
  join public.payment_gateway_credentials c
    on c.account_id = i.gateway_account_id
   and c.credential_ref = i.credential_ref
   and c.status = 'RETIRED'
  where h.slug = 'hotel-sai-raj'
    and i.provider = 'razorpay'
  order by i.created_at desc
  limit 1;

  select i.gateway_account_id, i.merchant_ref, i.credential_ref
    into strict v_active_account_id, v_active_merchant_ref, v_active_credential_ref
  from public.payment_intents i
  join public.payment_gateway_credentials c
    on c.account_id = i.gateway_account_id
   and c.credential_ref = i.credential_ref
   and c.status = 'ACTIVE'
  where i.tenant_id = v_tenant_id
    and i.property_id = v_property_id
    and i.provider = 'razorpay'
  order by i.created_at desc
  limit 1;

  perform set_config('app.tenant_id', v_tenant_id::text, true);
  perform set_config('app.property_id', v_property_id::text, true);
  perform set_config('app.task5_retired_account_id', v_retired_account_id::text, true);
  perform set_config('app.task5_retired_merchant_ref', v_retired_merchant_ref, true);
  perform set_config('app.task5_retired_credential_ref', v_retired_credential_ref, true);
  perform set_config('app.task5_active_account_id', v_active_account_id::text, true);
  perform set_config('app.task5_active_merchant_ref', v_active_merchant_ref, true);
  perform set_config('app.task5_active_credential_ref', v_active_credential_ref, true);
end;
$task5_retired_resolution_prepare$;

do $task5_retired_resolution_membership$
begin
  execute format(
    'grant app_tenant_runtime to %I with admin false, inherit false, set true granted by %I',
    current_user,
    current_user
  );
end;
$task5_retired_resolution_membership$;

set local role app_tenant_runtime;

do $task5_retired_resolution_execute$
declare
  v_retired_rows bigint;
  v_active_rows bigint;
begin
  select count(*) into v_retired_rows
  from public.task5_resolve_bound_gateway_credential(
    current_setting('app.task5_retired_account_id', true)::uuid,
    current_setting('app.task5_retired_merchant_ref', true),
    current_setting('app.task5_retired_credential_ref', true)
  );

  select count(*) into v_active_rows
  from public.task5_resolve_bound_gateway_credential(
    current_setting('app.task5_active_account_id', true)::uuid,
    current_setting('app.task5_active_merchant_ref', true),
    current_setting('app.task5_active_credential_ref', true)
  );

  perform set_config('app.task5_retired_resolution_rows', v_retired_rows::text, true);
  perform set_config('app.task5_active_resolution_rows', v_active_rows::text, true);
end;
$task5_retired_resolution_execute$;

reset role;

select
  case
    when current_setting('app.task5_retired_resolution_rows', true)::bigint = 0
    then 'PASS' else 'FAIL'
  end as retired_binding_denied,
  case
    when current_setting('app.task5_active_resolution_rows', true)::bigint = 1
    then 'PASS' else 'FAIL'
  end as active_binding_resolves,
  current_setting('app.task5_retired_resolution_rows', true)::bigint
    as retired_resolution_rows,
  current_setting('app.task5_active_resolution_rows', true)::bigint
    as active_resolution_rows;

do $task5_retired_resolution_membership_cleanup$
begin
  execute format(
    'revoke app_tenant_runtime from %I granted by %I restrict',
    current_user,
    current_user
  );
end;
$task5_retired_resolution_membership_cleanup$;

rollback;
