-- Task 5: staged rollout controls for per-property gateways.
-- USER-RUN CHECKPOINT: execute manually in Supabase SQL Editor.
-- Requires task5-gateway-runtime-rpcs.sql to have passed verification.
--
-- Saving or rotating credentials must not silently change payment routing.
-- This additive migration keeps configuration and explicit cutover separate.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '10min';
set local search_path = pg_catalog, public;

do $task5_rollout_preflight$
begin
  if to_regprocedure(
    'public.task5_configure_property_gateway(text,text,text,text,text,text,text,boolean,text)'
  ) is null
     or to_regclass('public.property_payment_gateway_policies') is null
     or to_regclass('public.payment_gateway_accounts') is null then
    raise exception 'TASK5_RUNTIME_RPC_MIGRATION_REQUIRED';
  end if;
  if not exists (
    select 1 from pg_roles
    where rolname = 'app_payment_gateway_secret_owner'
      and not rolcanlogin and not rolsuper and not rolbypassrls
  ) then
    raise exception 'TASK5_SECRET_OWNER_REQUIRED';
  end if;
  if not exists (
    select 1 from pg_roles
    where rolname = 'app_tenant_runtime'
      and rolcanlogin and not rolsuper and not rolcreatedb
      and not rolcreaterole and not rolinherit
      and not rolreplication and not rolbypassrls
  ) then
    raise exception 'TASK5_TENANT_RUNTIME_REQUIRED';
  end if;
end;
$task5_rollout_preflight$;

-- The underlying reviewed function continues to perform the Vault writes and
-- immutable version rotation. This wrapper restores the pre-existing routing
-- decision in the same transaction, so configuration alone never cuts over.
create or replace function public.task5_configure_property_gateway_staged(
  p_provider text,
  p_mode text,
  p_key_id text,
  p_key_secret text,
  p_webhook_secret text,
  p_actor_ref text,
  p_validation_code text,
  p_rotation_continuity_verified boolean default false,
  p_expected_credential_ref text default null
)
returns table (
  gateway_account_id uuid,
  merchant_ref text,
  credential_ref text,
  webhook_ref text,
  mode text,
  status text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $task5_configure_gateway_staged_fn$
declare
  v_tenant_id uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_property_id bigint := nullif(current_setting('app.property_id', true), '')::bigint;
  v_prior_resolution_mode text;
begin
  if v_tenant_id is null or v_property_id is null or p_provider <> 'razorpay' then
    raise exception using errcode = '22023', message = 'TASK5_GATEWAY_CONFIGURATION_SCOPE_INVALID';
  end if;

  select p.resolution_mode into v_prior_resolution_mode
  from public.property_payment_gateway_policies p
  where p.tenant_id = v_tenant_id
    and p.property_id = v_property_id
    and p.provider = p_provider
  for update;
  v_prior_resolution_mode := coalesce(v_prior_resolution_mode, 'LEGACY_GLOBAL');

  return query
    select configured.gateway_account_id, configured.merchant_ref,
      configured.credential_ref, configured.webhook_ref,
      configured.mode, configured.status
    from public.task5_configure_property_gateway(
      p_provider, p_mode, p_key_id, p_key_secret, p_webhook_secret,
      p_actor_ref, p_validation_code, p_rotation_continuity_verified,
      p_expected_credential_ref
    ) configured;

  update public.property_payment_gateway_policies p
    set resolution_mode = v_prior_resolution_mode,
      updated_by = left(coalesce(p_actor_ref, 'hotel_owner'), 200)
    where p.tenant_id = v_tenant_id
      and p.property_id = v_property_id
      and p.provider = p_provider;
end;
$task5_configure_gateway_staged_fn$;

-- Explicit, reversible pilot switch. PER_PROPERTY still fails closed in the
-- application whenever its feature flag is disabled or resolution fails.
create or replace function public.task5_set_property_gateway_resolution(
  p_resolution_mode text,
  p_actor_ref text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $task5_set_gateway_resolution_fn$
declare
  v_tenant_id uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_property_id bigint := nullif(current_setting('app.property_id', true), '')::bigint;
  v_policy public.property_payment_gateway_policies%rowtype;
  v_account_id uuid;
begin
  if v_tenant_id is null or v_property_id is null
     or p_resolution_mode not in ('LEGACY_GLOBAL', 'PER_PROPERTY') then
    raise exception using errcode = '22023', message = 'TASK5_GATEWAY_RESOLUTION_INVALID';
  end if;

  select p.* into v_policy
  from public.property_payment_gateway_policies p
  where p.tenant_id = v_tenant_id
    and p.property_id = v_property_id
    and p.provider = 'razorpay'
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'TASK5_PROPERTY_GATEWAY_NOT_FOUND';
  end if;

  select a.id into v_account_id
  from public.payment_gateway_accounts a
  where a.tenant_id = v_tenant_id
    and a.property_id = v_property_id
    and a.provider = 'razorpay'
    and a.mode = v_policy.mode
    and a.status in ('ACTIVE', 'DISABLED')
  order by a.created_at desc
  limit 1;

  if p_resolution_mode = 'PER_PROPERTY' and v_account_id is null then
    raise exception using errcode = '23514', message = 'TASK5_PER_PROPERTY_GATEWAY_NOT_READY';
  end if;

  update public.property_payment_gateway_policies p
    set resolution_mode = p_resolution_mode,
      updated_by = left(coalesce(p_actor_ref, 'hotel_owner'), 200)
    where p.tenant_id = v_tenant_id
      and p.property_id = v_property_id
      and p.provider = 'razorpay';

  insert into public.payment_gateway_audit_events (
    tenant_id, property_id, account_id, action, outcome, actor_ref, reason_code
  ) values (
    v_tenant_id, v_property_id, v_account_id,
    case when p_resolution_mode = 'PER_PROPERTY' then 'ENABLE' else 'DISABLE' end,
    'SUCCESS', left(coalesce(p_actor_ref, 'hotel_owner'), 200),
    case when p_resolution_mode = 'PER_PROPERTY'
      then 'PER_PROPERTY_CUTOVER' else 'LEGACY_GLOBAL_ROLLBACK' end
  );

  return true;
end;
$task5_set_gateway_resolution_fn$;

do $task5_rollout_owner$
declare
  target regprocedure;
begin
  execute format(
    'grant app_payment_gateway_secret_owner to %I with admin false, inherit false, set true granted by %I',
    current_user, current_user
  );
  grant create on schema public to app_payment_gateway_secret_owner;

  foreach target in array array[
    'public.task5_configure_property_gateway_staged(text,text,text,text,text,text,text,boolean,text)'::regprocedure,
    'public.task5_set_property_gateway_resolution(text,text)'::regprocedure
  ] loop
    execute format('alter function %s owner to app_payment_gateway_secret_owner', target);
  end loop;

  revoke create on schema public from app_payment_gateway_secret_owner;
end;
$task5_rollout_owner$;

set local role app_payment_gateway_secret_owner;
-- The original Vault writer is now internal to the staged wrapper. Revoke as
-- its restricted owner; the migration runner deliberately has no standing
-- membership in this role outside this transaction.
revoke all on function public.task5_configure_property_gateway(
  text,text,text,text,text,text,text,boolean,text
) from public, anon, authenticated, app_tenant_runtime, app_tenant_rpc_owner, service_role;
revoke all on function public.task5_configure_property_gateway_staged(
  text,text,text,text,text,text,text,boolean,text
) from public, anon, authenticated, service_role, app_tenant_rpc_owner;
revoke all on function public.task5_set_property_gateway_resolution(text,text)
  from public, anon, authenticated, service_role, app_tenant_rpc_owner;
grant execute on function public.task5_configure_property_gateway_staged(
  text,text,text,text,text,text,text,boolean,text
) to app_tenant_runtime;
grant execute on function public.task5_set_property_gateway_resolution(text,text)
  to app_tenant_runtime;
reset role;

do $task5_rollout_membership_cleanup$
begin
  execute format(
    'revoke app_payment_gateway_secret_owner from %I granted by %I restrict',
    current_user, current_user
  );
end;
$task5_rollout_membership_cleanup$;

commit;
