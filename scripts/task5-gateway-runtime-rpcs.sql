-- Task 5: restricted application RPC surface for per-property gateways.
-- USER-RUN CHECKPOINT: execute manually in Supabase SQL Editor.
-- Requires backend/scripts/task5-per-hotel-gateway.sql to have passed verification.
-- This migration never reads secret values into its output except from the two
-- point-of-use resolver functions and the bounded webhook authenticator.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '10min';
set local search_path = pg_catalog, public;

do $task5_rpc_preflight$
begin
  if to_regclass('public.payment_gateway_accounts') is null
     or to_regclass('public.payment_gateway_credentials') is null
     or to_regclass('public.payment_gateway_webhook_secrets') is null
     or to_regclass('public.property_payment_gateway_policies') is null then
    raise exception 'TASK5_GATEWAY_SCHEMA_REQUIRED';
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
      and rolcanlogin
      and not rolsuper
      and not rolcreatedb
      and not rolcreaterole
      and not rolinherit
      and not rolreplication
      and not rolbypassrls
  ) then
    raise exception 'TASK5_TENANT_RUNTIME_REQUIRED';
  end if;
end;
$task5_rpc_preflight$;

-- A webhook reference is a selector only. This policy lets the restricted
-- function owner locate exactly that account before it sets canonical tenant
-- context. No credential or webhook-secret table receives a selector policy.
create policy task5_webhook_ref_selector
on public.payment_gateway_accounts
as permissive for select
to app_payment_gateway_secret_owner
using (
  webhook_ref = nullif(current_setting('app.task5_webhook_ref', true), '')
);

create or replace function public.task5_get_property_gateway_policy_internal(
  p_tenant_id uuid,
  p_property_id bigint,
  p_provider text
)
returns table (resolution_mode text, mode text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $task5_policy_internal_fn$
begin
  if p_tenant_id is null or p_property_id is null or p_property_id <= 0
     or p_provider <> 'razorpay' then
    raise exception using errcode = '22023', message = 'TASK5_GATEWAY_SCOPE_INVALID';
  end if;
  perform set_config('app.tenant_id', p_tenant_id::text, true);
  perform set_config('app.property_id', p_property_id::text, true);
  return query
    select p.resolution_mode, p.mode
    from public.property_payment_gateway_policies p
    where p.tenant_id = p_tenant_id
      and p.property_id = p_property_id
      and p.provider = p_provider;
  if not found then
    return query select 'LEGACY_GLOBAL'::text, null::text;
  end if;
end;
$task5_policy_internal_fn$;

create or replace function public.task5_resolve_active_gateway_credential(
  p_provider text
)
returns table (
  gateway_account_id uuid,
  merchant_ref text,
  credential_ref text,
  mode text,
  key_id text,
  key_secret text
)
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $task5_resolve_active_fn$
declare
  v_tenant_id uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_property_id bigint := nullif(current_setting('app.property_id', true), '')::bigint;
begin
  if v_tenant_id is null or v_property_id is null or p_provider <> 'razorpay' then
    raise exception using errcode = '22023', message = 'TASK5_GATEWAY_SCOPE_INVALID';
  end if;
  return query
    select a.id, a.merchant_ref, c.credential_ref, a.mode, c.key_id,
      d.decrypted_secret
    from public.property_payment_gateway_policies p
    join public.payment_gateway_accounts a
      on a.tenant_id = p.tenant_id
     and a.property_id = p.property_id
     and a.provider = p.provider
     and a.mode = p.mode
     and a.status = 'ACTIVE'
    join public.payment_gateway_credentials c
      on c.account_id = a.id and c.status = 'ACTIVE'
    join vault.decrypted_secrets d on d.id = c.secret_vault_id
    where p.tenant_id = v_tenant_id
      and p.property_id = v_property_id
      and p.provider = p_provider
      and p.resolution_mode = 'PER_PROPERTY';
end;
$task5_resolve_active_fn$;

create or replace function public.task5_resolve_bound_gateway_credential(
  p_gateway_account_id uuid,
  p_merchant_ref text,
  p_credential_ref text
)
returns table (
  gateway_account_id uuid,
  merchant_ref text,
  credential_ref text,
  mode text,
  key_id text,
  key_secret text
)
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $task5_resolve_bound_fn$
declare
  v_tenant_id uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_property_id bigint := nullif(current_setting('app.property_id', true), '')::bigint;
begin
  if v_tenant_id is null or v_property_id is null or p_gateway_account_id is null
     or coalesce(btrim(p_merchant_ref), '') = ''
     or coalesce(btrim(p_credential_ref), '') = '' then
    raise exception using errcode = '22023', message = 'TASK5_BOUND_CREDENTIAL_SCOPE_INVALID';
  end if;
  return query
    select a.id, a.merchant_ref, c.credential_ref, a.mode, c.key_id,
      d.decrypted_secret
    from public.payment_gateway_accounts a
    join public.payment_gateway_credentials c
      on c.account_id = a.id and c.status in ('ACTIVE', 'HISTORICAL')
    join vault.decrypted_secrets d on d.id = c.secret_vault_id
    where a.id = p_gateway_account_id
      and a.tenant_id = v_tenant_id
      and a.property_id = v_property_id
      and a.provider = 'razorpay'
      and a.merchant_ref = p_merchant_ref
      and a.status in ('ACTIVE', 'DISABLED')
      and c.credential_ref = p_credential_ref;
end;
$task5_resolve_bound_fn$;

create or replace function public.task5_resolve_webhook_candidates_internal(
  p_webhook_ref text
)
returns table (
  tenant_id uuid,
  property_id bigint,
  gateway_account_id uuid,
  merchant_ref text,
  webhook_secret_ref text,
  webhook_secret text
)
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $task5_webhook_candidates_fn$
declare
  v_account public.payment_gateway_accounts%rowtype;
begin
  if p_webhook_ref !~ '^rwh_[a-f0-9]{32}$' then
    raise exception using errcode = '22023', message = 'TASK5_WEBHOOK_REF_INVALID';
  end if;
  perform set_config('app.task5_webhook_ref', p_webhook_ref, true);
  select * into v_account
  from public.payment_gateway_accounts a
  where a.webhook_ref = p_webhook_ref
    and a.provider = 'razorpay'
    and a.status in ('ACTIVE', 'DISABLED');
  if not found then return; end if;

  perform set_config('app.tenant_id', v_account.tenant_id::text, true);
  perform set_config('app.property_id', v_account.property_id::text, true);
  return query
    select v_account.tenant_id, v_account.property_id, v_account.id,
      v_account.merchant_ref, w.webhook_secret_ref, d.decrypted_secret
    from public.payment_gateway_webhook_secrets w
    join vault.decrypted_secrets d on d.id = w.secret_vault_id
    where w.account_id = v_account.id
      and w.status in ('ACTIVE', 'HISTORICAL')
    order by case w.status when 'ACTIVE' then 0 else 1 end, w.version desc;
end;
$task5_webhook_candidates_fn$;

create or replace function public.task5_get_property_gateway_status()
returns table (
  provider text,
  resolution_mode text,
  configured boolean,
  gateway_account_id uuid,
  mode text,
  account_status text,
  merchant_ref text,
  credential_ref text,
  key_id text,
  key_id_masked text,
  secret_configured boolean,
  webhook_ref text,
  webhook_configured boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $task5_gateway_status_fn$
declare
  v_tenant_id uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_property_id bigint := nullif(current_setting('app.property_id', true), '')::bigint;
begin
  if v_tenant_id is null or v_property_id is null then
    raise exception using errcode = '22023', message = 'TASK5_GATEWAY_SCOPE_INVALID';
  end if;
  return query
    select 'razorpay'::text,
      coalesce(p.resolution_mode, 'LEGACY_GLOBAL'),
      (a.id is not null), a.id, a.mode, a.status, a.merchant_ref, c.credential_ref,
      c.key_id,
      case when c.key_id is null then null
        else left(c.key_id, greatest(length(c.key_id) - 4, 0)) || '****' end,
      (c.id is not null), a.webhook_ref, (w.id is not null)
    from (select 1) seed
    left join public.property_payment_gateway_policies p
      on p.tenant_id = v_tenant_id and p.property_id = v_property_id
     and p.provider = 'razorpay'
    left join public.payment_gateway_accounts a
      on a.tenant_id = v_tenant_id and a.property_id = v_property_id
     and a.provider = 'razorpay' and a.mode = p.mode
     and a.status in ('ACTIVE', 'DISABLED', 'DRAFT')
    left join public.payment_gateway_credentials c
      on c.account_id = a.id and c.status = 'ACTIVE'
    left join public.payment_gateway_webhook_secrets w
      on w.account_id = a.id and w.status = 'ACTIVE'
    order by a.created_at desc nulls last
    limit 1;
end;
$task5_gateway_status_fn$;

create or replace function public.task5_configure_property_gateway(
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
set search_path = pg_catalog, public, vault
as $task5_configure_gateway_fn$
declare
  v_tenant_id uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_property_id bigint := nullif(current_setting('app.property_id', true), '')::bigint;
  v_account public.payment_gateway_accounts%rowtype;
  v_credential_id uuid := gen_random_uuid();
  v_webhook_id uuid := gen_random_uuid();
  v_api_vault_id uuid;
  v_webhook_vault_id uuid;
  v_has_existing_credential boolean := false;
  v_current_credential_ref text;
  v_action text;
begin
  if v_tenant_id is null or v_property_id is null or p_provider is null
     or p_provider <> 'razorpay' or p_mode is null
     or p_mode not in ('TEST', 'LIVE') then
    raise exception using errcode = '22023', message = 'TASK5_GATEWAY_CONFIGURATION_SCOPE_INVALID';
  end if;
  if p_mode = 'TEST' and p_key_id !~ '^rzp_test_[A-Za-z0-9]+$'
     or p_mode = 'LIVE' and p_key_id !~ '^rzp_live_[A-Za-z0-9]+$' then
    raise exception using errcode = '22023', message = 'TASK5_GATEWAY_KEY_MODE_MISMATCH';
  end if;
  if p_key_secret is null or p_webhook_secret is null
     or length(p_key_secret) < 8 or length(p_key_secret) > 500
     or length(p_webhook_secret) < 8 or length(p_webhook_secret) > 500
     or p_key_secret ~ '[[:cntrl:]]'
     or p_webhook_secret ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'TASK5_GATEWAY_SECRET_FORMAT_INVALID';
  end if;
  if coalesce(p_validation_code, '') !~ '^[A-Z0-9_]{1,80}$' then
    raise exception using errcode = '22023', message = 'TASK5_GATEWAY_VALIDATION_REQUIRED';
  end if;

  select * into v_account
  from public.payment_gateway_accounts a
  where a.tenant_id = v_tenant_id and a.property_id = v_property_id
    and a.provider = p_provider and a.mode = p_mode
    and a.status in ('ACTIVE', 'DISABLED', 'DRAFT')
  order by a.created_at desc
  limit 1 for update;

  if found then
    select exists (
      select 1 from public.payment_gateway_credentials c
      where c.account_id = v_account.id and c.status in ('ACTIVE', 'HISTORICAL')
    ) into v_has_existing_credential;
    select c.credential_ref into v_current_credential_ref
    from public.payment_gateway_credentials c
    where c.account_id = v_account.id and c.status = 'ACTIVE';
    if v_has_existing_credential and
       v_current_credential_ref is distinct from p_expected_credential_ref then
      raise exception using errcode = '40001', message = 'TASK5_GATEWAY_CREDENTIAL_CHANGED';
    end if;
    if v_has_existing_credential and not p_rotation_continuity_verified then
      raise exception using errcode = '23514', message = 'TASK5_ROTATION_CONTINUITY_REQUIRED';
    end if;
    v_action := case when v_has_existing_credential then 'ROTATE' else 'CONFIGURE' end;
  else
    insert into public.payment_gateway_accounts (
      id, tenant_id, property_id, provider, mode, merchant_ref, webhook_ref,
      created_by, updated_by
    ) values (
      gen_random_uuid(), v_tenant_id, v_property_id, p_provider, p_mode,
      'RZP_MERCHANT_' || repeat('0', 32), 'rwh_' || repeat('0', 32),
      left(coalesce(p_actor_ref, 'hotel_owner'), 200),
      left(coalesce(p_actor_ref, 'hotel_owner'), 200)
    ) returning * into v_account;
    v_action := 'CONFIGURE';
  end if;

  if v_has_existing_credential then
    update public.payment_gateway_credentials as c
      set status = 'HISTORICAL'
      where c.account_id = v_account.id and c.status = 'ACTIVE';
    update public.payment_gateway_webhook_secrets as w
      set status = 'HISTORICAL'
      where w.account_id = v_account.id and w.status = 'ACTIVE';
  end if;

  select vault.create_secret(
    p_key_secret,
    'task5-api-' || replace(v_credential_id::text, '-', ''),
    'Task 5 immutable Razorpay API credential'
  ) into v_api_vault_id;
  select vault.create_secret(
    p_webhook_secret,
    'task5-webhook-' || replace(v_webhook_id::text, '-', ''),
    'Task 5 immutable Razorpay webhook credential'
  ) into v_webhook_vault_id;

  insert into public.payment_gateway_credentials (
    id, tenant_id, property_id, account_id, credential_ref, version,
    key_id, secret_vault_id, created_by, validated_at, last_validation_code
  ) values (
    v_credential_id, v_tenant_id, v_property_id, v_account.id,
    'RZP_CRED_' || repeat('0', 32), 1, p_key_id, v_api_vault_id,
    left(coalesce(p_actor_ref, 'hotel_owner'), 200), now(), p_validation_code
  );
  update public.payment_gateway_credentials as c
    set status = 'ACTIVE'
    where c.id = v_credential_id;

  insert into public.payment_gateway_webhook_secrets (
    id, tenant_id, property_id, account_id, webhook_secret_ref, version,
    secret_vault_id, created_by
  ) values (
    v_webhook_id, v_tenant_id, v_property_id, v_account.id,
    'RZP_WEBHOOK_' || repeat('0', 32), 1, v_webhook_vault_id,
    left(coalesce(p_actor_ref, 'hotel_owner'), 200)
  );
  update public.payment_gateway_webhook_secrets as w
    set status = 'ACTIVE'
    where w.id = v_webhook_id;

  update public.payment_gateway_accounts as a
    set status = 'ACTIVE', updated_by = left(coalesce(p_actor_ref, 'hotel_owner'), 200)
    where a.id = v_account.id
    returning * into v_account;

  insert into public.property_payment_gateway_policies (
    tenant_id, property_id, provider, mode, resolution_mode, created_by, updated_by
  ) values (
    v_tenant_id, v_property_id, p_provider, p_mode, 'PER_PROPERTY',
    left(coalesce(p_actor_ref, 'hotel_owner'), 200),
    left(coalesce(p_actor_ref, 'hotel_owner'), 200)
  ) on conflict (tenant_id, property_id, provider) do update
    set mode = excluded.mode, resolution_mode = 'PER_PROPERTY',
      updated_by = excluded.updated_by;

  insert into public.payment_gateway_audit_events (
    tenant_id, property_id, account_id, credential_ref, webhook_secret_ref,
    action, outcome, actor_ref, reason_code
  )
  select v_tenant_id, v_property_id, v_account.id, c.credential_ref,
    w.webhook_secret_ref, v_action, 'SUCCESS',
    left(coalesce(p_actor_ref, 'hotel_owner'), 200), p_validation_code
  from public.payment_gateway_credentials c
  join public.payment_gateway_webhook_secrets w on w.id = v_webhook_id
  where c.id = v_credential_id;

  return query
    select v_account.id, v_account.merchant_ref, c.credential_ref,
      v_account.webhook_ref, v_account.mode, v_account.status
    from public.payment_gateway_credentials c
    where c.id = v_credential_id;
end;
$task5_configure_gateway_fn$;

create or replace function public.task5_set_property_gateway_enabled(
  p_enabled boolean,
  p_actor_ref text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $task5_set_enabled_fn$
declare
  v_tenant_id uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_property_id bigint := nullif(current_setting('app.property_id', true), '')::bigint;
  v_account public.payment_gateway_accounts%rowtype;
begin
  select a.* into v_account
  from public.property_payment_gateway_policies p
  join public.payment_gateway_accounts a
    on a.tenant_id = p.tenant_id and a.property_id = p.property_id
   and a.provider = p.provider and a.mode = p.mode
  where p.tenant_id = v_tenant_id and p.property_id = v_property_id
    and p.provider = 'razorpay' and p.resolution_mode = 'PER_PROPERTY'
  for update of a;
  if not found then
    raise exception using errcode = 'P0002', message = 'TASK5_PROPERTY_GATEWAY_NOT_FOUND';
  end if;
  update public.payment_gateway_accounts
    set status = case when p_enabled then 'ACTIVE' else 'DISABLED' end,
      updated_by = left(coalesce(p_actor_ref, 'hotel_owner'), 200)
    where id = v_account.id;
  insert into public.payment_gateway_audit_events (
    tenant_id, property_id, account_id, action, outcome, actor_ref, reason_code
  ) values (
    v_tenant_id, v_property_id, v_account.id,
    case when p_enabled then 'ENABLE' else 'DISABLE' end,
    'SUCCESS', left(coalesce(p_actor_ref, 'hotel_owner'), 200), null
  );
  return true;
end;
$task5_set_enabled_fn$;

-- Move the reviewed functions to the isolated Vault-capable NOLOGIN owner.
do $task5_rpc_owner$
declare
  target regprocedure;
begin
  execute format(
    'grant app_payment_gateway_secret_owner to %I with admin false, inherit false, set true granted by %I',
    current_user, current_user
  );
  grant create on schema public to app_payment_gateway_secret_owner;

  foreach target in array array[
    'public.task5_get_property_gateway_policy_internal(uuid,bigint,text)'::regprocedure,
    'public.task5_resolve_active_gateway_credential(text)'::regprocedure,
    'public.task5_resolve_bound_gateway_credential(uuid,text,text)'::regprocedure,
    'public.task5_resolve_webhook_candidates_internal(text)'::regprocedure,
    'public.task5_get_property_gateway_status()'::regprocedure,
    'public.task5_configure_property_gateway(text,text,text,text,text,text,text,boolean,text)'::regprocedure,
    'public.task5_set_property_gateway_enabled(boolean,text)'::regprocedure
  ] loop
    execute format('alter function %s owner to app_payment_gateway_secret_owner', target);
  end loop;

  revoke create on schema public from app_payment_gateway_secret_owner;
end;
$task5_rpc_owner$;

set local role app_payment_gateway_secret_owner;

revoke all on function public.task5_get_property_gateway_policy_internal(uuid,bigint,text)
  from public, anon, authenticated, app_tenant_runtime, app_tenant_rpc_owner;
revoke all on function public.task5_resolve_active_gateway_credential(text)
  from public, anon, authenticated, service_role, app_tenant_rpc_owner;
revoke all on function public.task5_resolve_bound_gateway_credential(uuid,text,text)
  from public, anon, authenticated, service_role, app_tenant_rpc_owner;
revoke all on function public.task5_resolve_webhook_candidates_internal(text)
  from public, anon, authenticated, app_tenant_runtime, app_tenant_rpc_owner;
revoke all on function public.task5_get_property_gateway_status()
  from public, anon, authenticated, service_role, app_tenant_rpc_owner;
revoke all on function public.task5_configure_property_gateway(text,text,text,text,text,text,text,boolean,text)
  from public, anon, authenticated, service_role, app_tenant_rpc_owner;
revoke all on function public.task5_set_property_gateway_enabled(boolean,text)
  from public, anon, authenticated, service_role, app_tenant_rpc_owner;

grant execute on function public.task5_get_property_gateway_policy_internal(uuid,bigint,text)
  to service_role;
grant execute on function public.task5_resolve_webhook_candidates_internal(text)
  to service_role;
grant execute on function public.task5_resolve_active_gateway_credential(text),
  public.task5_resolve_bound_gateway_credential(uuid,text,text),
  public.task5_get_property_gateway_status(),
  public.task5_configure_property_gateway(text,text,text,text,text,text,text,boolean,text),
  public.task5_set_property_gateway_enabled(boolean,text)
  to app_tenant_runtime;
reset role;

do $task5_rpc_membership_cleanup$
begin
  execute format(
    'revoke app_payment_gateway_secret_owner from %I granted by %I restrict',
    current_user, current_user
  );
end;
$task5_rpc_membership_cleanup$;

do $task5_rpc_guard$
declare
  unsafe_count bigint;
begin
  select count(*) into unsafe_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles r on r.oid = p.proowner
  where n.nspname = 'public'
    and p.proname in (
      'task5_get_property_gateway_policy_internal',
      'task5_resolve_active_gateway_credential',
      'task5_resolve_bound_gateway_credential',
      'task5_resolve_webhook_candidates_internal',
      'task5_get_property_gateway_status',
      'task5_configure_property_gateway',
      'task5_set_property_gateway_enabled'
    )
    and (not p.prosecdef or r.rolname <> 'app_payment_gateway_secret_owner'
      or r.rolsuper or r.rolbypassrls
      or not (p.proconfig @> array['search_path=pg_catalog, public']
        or p.proconfig @> array['search_path=pg_catalog, public, vault']));
  if unsafe_count <> 0 then
    raise exception 'TASK5_GATEWAY_RPC_OWNER_GUARD_FAILED count=%', unsafe_count;
  end if;

  if has_function_privilege('anon', 'public.task5_resolve_active_gateway_credential(text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.task5_resolve_active_gateway_credential(text)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.task5_resolve_active_gateway_credential(text)', 'EXECUTE')
     or has_function_privilege('app_tenant_runtime', 'public.task5_resolve_webhook_candidates_internal(text)', 'EXECUTE') then
    raise exception 'TASK5_GATEWAY_SECRET_RPC_GRANT_GUARD_FAILED';
  end if;
end;
$task5_rpc_guard$;

notify pgrst, 'reload schema';
commit;
