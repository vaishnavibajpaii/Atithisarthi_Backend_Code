-- Task 5 gateway runtime permission probe (ROLLBACK ONLY; DUMMY VALUES).
--
-- This diagnostic exercises the same PostgreSQL configuration/status path as
-- the backend under app_tenant_runtime. It uses dummy TEST-shaped values, does
-- not read Vault secrets or payment data, catches the failure, emits only a
-- sanitized object-level result, and rolls back the outer transaction.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '2min';
set local search_path = pg_catalog, public;

-- Choose a canonical property without exposing its identifiers. Prefer a
-- property with no gateway account; if every property is configured, carry
-- the current non-secret credential reference to exercise rotation safely.
with target as (
  select h.tenant_id, h.id as property_id,
    current_credential.credential_ref
  from public.hotels h
  left join lateral (
    select c.credential_ref
    from public.payment_gateway_accounts a
    join public.payment_gateway_credentials c
      on c.account_id = a.id and c.status = 'ACTIVE'
    where a.tenant_id = h.tenant_id
      and a.property_id = h.id
      and a.provider = 'razorpay'
      and a.mode = 'TEST'
      and a.status in ('ACTIVE', 'DISABLED', 'DRAFT')
    order by c.created_at desc
    limit 1
  ) current_credential on true
  order by (current_credential.credential_ref is not null), h.id
  limit 1
)
select
  set_config('app.tenant_id', target.tenant_id::text, true),
  set_config('app.property_id', target.property_id::text, true),
  set_config(
    'app.task5_probe_expected_credential_ref',
    coalesce(target.credential_ref, ''),
    true
  )
from target;

do $task5_probe_scope_guard$
begin
  if nullif(current_setting('app.tenant_id', true), '') is null
     or nullif(current_setting('app.property_id', true), '') is null then
    raise exception 'TASK5_PROBE_CANONICAL_PROPERTY_REQUIRED';
  end if;
end;
$task5_probe_scope_guard$;

-- Acquire SET-only membership inside this transaction so the probe can mirror
-- the deployed runtime identity. The membership is explicitly revoked below
-- and is also protected by the final outer rollback.
do $task5_probe_runtime_membership$
begin
  execute format(
    'grant app_tenant_runtime to %I with admin false, inherit false, set true granted by %I',
    current_user,
    current_user
  );
end;
$task5_probe_runtime_membership$;

set local role app_tenant_runtime;

do $task5_runtime_permission_probe$
declare
  v_message text;
  v_sqlstate text;
  v_safe_result text;
  v_expected_credential_ref text := nullif(
    current_setting('app.task5_probe_expected_credential_ref', true), ''
  );
begin
  perform *
  from public.task5_configure_property_gateway_staged(
    'razorpay',
    'TEST',
    'rzp_test_Task5PermissionProbeOnly',
    'task5-dummy-api-secret-never-use',
    'task5-dummy-webhook-secret-never-use',
    'task5_permission_probe',
    'TEST_CONNECTION_OK',
    v_expected_credential_ref is not null,
    v_expected_credential_ref
  );

  perform * from public.task5_get_property_gateway_status();

  -- Railway commits after the RPC returns. Force the initially deferred
  -- readiness trigger now so this rollback-only probe covers that commit-time
  -- authorization boundary too.
  execute 'set constraints all immediate';

  v_safe_result := 'UNEXPECTED_SUCCESS_ROLLED_BACK';
  perform set_config('app.task5_probe_result', v_safe_result, true);
exception when others then
  get stacked diagnostics
    v_message = message_text,
    v_sqlstate = returned_sqlstate;

  if v_sqlstate = '42501'
     and v_message ~ '^permission denied for (function|table|relation|sequence|schema) [a-zA-Z0-9_]+$' then
    v_safe_result := 'SQLSTATE_42501: ' || v_message;
  elsif v_message ~ '^TASK5_[A-Z0-9_]+$' then
    v_safe_result := v_message;
  elsif v_sqlstate = '42501' then
    v_safe_result := 'SQLSTATE_42501: UNMAPPED_PERMISSION_TARGET';
  else
    v_safe_result := 'SQLSTATE_' || coalesce(v_sqlstate, 'UNKNOWN') ||
      ': NON_PERMISSION_FAILURE';
  end if;

  perform set_config('app.task5_probe_result', v_safe_result, true);
end;
$task5_runtime_permission_probe$;

reset role;

select current_setting('app.task5_probe_result', true) as task5_permission_probe;

do $task5_probe_runtime_membership_cleanup$
begin
  execute format(
    'revoke app_tenant_runtime from %I granted by %I restrict',
    current_user,
    current_user
  );
end;
$task5_probe_runtime_membership_cleanup$;

rollback;
