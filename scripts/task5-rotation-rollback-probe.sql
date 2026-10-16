-- Task 5: rollback-only probe of the exact staged credential-rotation path.
--
-- This probe uses fixed non-provider dummy values, never reads decrypted Vault
-- material, never returns credential references, and rolls back every write.
-- It temporarily grants SET-role membership to the SQL runner in the same
-- transaction so the call executes through app_tenant_runtime exactly as the
-- backend does. The membership and all attempted Vault/configuration writes are
-- removed by the final ROLLBACK.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '2min';
set local search_path = pg_catalog, public;

do $task5_rotation_probe_prepare$
declare
  v_tenant_id uuid;
  v_property_id bigint;
  v_expected_credential_ref text;
begin
  select h.tenant_id, h.id
    into strict v_tenant_id, v_property_id
  from public.hotels h
  where h.slug = 'hotel-sai-raj'
    and h.tenant_id is not null;

  select c.credential_ref
    into strict v_expected_credential_ref
  from public.property_payment_gateway_policies p
  join public.payment_gateway_accounts a
    on a.tenant_id = p.tenant_id
   and a.property_id = p.property_id
   and a.provider = p.provider
   and a.mode = p.mode
  join public.payment_gateway_credentials c
    on c.account_id = a.id and c.status = 'ACTIVE'
  where p.tenant_id = v_tenant_id
    and p.property_id = v_property_id
    and p.provider = 'razorpay'
    and p.mode = 'TEST'
    and p.resolution_mode = 'PER_PROPERTY'
    and a.status = 'ACTIVE';

  perform set_config('app.tenant_id', v_tenant_id::text, true);
  perform set_config('app.property_id', v_property_id::text, true);
  perform set_config(
    'app.task5_rotation_probe_expected_credential_ref',
    v_expected_credential_ref,
    true
  );
  perform set_config('app.task5_rotation_probe_result', 'NOT_RUN', true);
  perform set_config('app.task5_rotation_probe_sqlstate', '', true);
  perform set_config('app.task5_rotation_probe_constraint', '', true);
  perform set_config('app.task5_rotation_probe_message', '', true);
end;
$task5_rotation_probe_prepare$;

do $task5_rotation_probe_membership$
begin
  execute format(
    'grant app_tenant_runtime to %I with admin false, inherit false, set true granted by %I',
    current_user,
    current_user
  );
end;
$task5_rotation_probe_membership$;

set local role app_tenant_runtime;

do $task5_rotation_probe_execute$
declare
  v_message text;
  v_sqlstate text;
  v_constraint text;
  v_safe_message text := 'UNMAPPED_FAILURE';
begin
  perform *
  from public.task5_configure_property_gateway_staged(
    'razorpay',
    'TEST',
    'rzp_test_Task5RotationProbeOnly',
    'task5-dummy-api-secret-never-use',
    'task5-dummy-webhook-secret-never-use',
    'task5_rotation_rollback_probe',
    'TEST_CONNECTION_OK',
    true,
    current_setting('app.task5_rotation_probe_expected_credential_ref', true)
  );

  -- Exercise deferred readiness checks inside the rollback-only transaction.
  execute 'set constraints all immediate';

  perform set_config(
    'app.task5_rotation_probe_result',
    'DATABASE_ROTATION_PATH_SUCCESS_ROLLED_BACK',
    true
  );
exception when others then
  get stacked diagnostics
    v_message = message_text,
    v_sqlstate = returned_sqlstate,
    v_constraint = constraint_name;

  if v_message ~ '^TASK5_[A-Z0-9_]+$' then
    v_safe_message := v_message;
  elsif v_message ~ '^permission denied for (function|table|relation|sequence|schema) [a-zA-Z0-9_]+$' then
    v_safe_message := v_message;
  elsif v_message ~ '^column reference "[a-zA-Z0-9_]+" is ambiguous$' then
    v_safe_message := v_message;
  elsif v_message ~ '^record "[a-zA-Z0-9_]+" is not assigned yet$' then
    v_safe_message := v_message;
  elsif v_sqlstate = '23505' and coalesce(v_constraint, '') ~ '^[a-zA-Z0-9_]+$' then
    v_safe_message := 'UNIQUE_CONSTRAINT_VIOLATION';
  end if;

  perform set_config('app.task5_rotation_probe_result', 'DATABASE_ROTATION_PATH_FAILED', true);
  perform set_config('app.task5_rotation_probe_sqlstate', coalesce(v_sqlstate, ''), true);
  perform set_config(
    'app.task5_rotation_probe_constraint',
    case when coalesce(v_constraint, '') ~ '^[a-zA-Z0-9_]+$'
      then v_constraint else '' end,
    true
  );
  perform set_config('app.task5_rotation_probe_message', v_safe_message, true);
end;
$task5_rotation_probe_execute$;

reset role;

select
  current_setting('app.task5_rotation_probe_result', true) as probe_result,
  nullif(current_setting('app.task5_rotation_probe_sqlstate', true), '') as sqlstate,
  nullif(current_setting('app.task5_rotation_probe_constraint', true), '') as constraint_name,
  nullif(current_setting('app.task5_rotation_probe_message', true), '') as safe_message;

do $task5_rotation_probe_membership_cleanup$
begin
  execute format(
    'revoke app_tenant_runtime from %I granted by %I restrict',
    current_user,
    current_user
  );
end;
$task5_rotation_probe_membership_cleanup$;

rollback;
