-- Task 5: repair credential rotation's PL/pgSQL status-column ambiguity.
-- USER-RUN CHECKPOINT: execute manually in Supabase SQL Editor.
--
-- This CREATE OR REPLACE keeps the existing signature, restricted owner,
-- SECURITY DEFINER boundary, Vault design, grants, triggers, data, and payment
-- bindings. The only behavioral change is qualifying UPDATE target columns so
-- they cannot conflict with the RETURNS TABLE output variable named status.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '5min';
set local search_path = pg_catalog, public, vault;

do $task5_rotation_fix_preflight$
begin
  if to_regprocedure(
    'public.task5_configure_property_gateway(text,text,text,text,text,text,text,boolean,text)'
  ) is null then
    raise exception 'TASK5_ROTATION_WRITER_REQUIRED';
  end if;
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_roles r on r.oid = p.proowner
    where n.nspname = 'public'
      and p.proname = 'task5_configure_property_gateway'
      and p.prosecdef
      and r.rolname = 'app_payment_gateway_secret_owner'
      and not r.rolsuper
      and not r.rolbypassrls
  ) then
    raise exception 'TASK5_ROTATION_WRITER_OWNER_INVALID';
  end if;
end;
$task5_rotation_fix_preflight$;

do $task5_rotation_fix_membership$
begin
  execute format(
    'grant app_payment_gateway_secret_owner to %I with admin false, inherit false, set true granted by %I',
    current_user,
    current_user
  );
end;
$task5_rotation_fix_membership$;

grant create on schema public to app_payment_gateway_secret_owner;
set local role app_payment_gateway_secret_owner;

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

reset role;
revoke create on schema public from app_payment_gateway_secret_owner;

do $task5_rotation_fix_verify$
declare
  v_definition text;
begin
  select pg_get_functiondef(p.oid)
    into strict v_definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles r on r.oid = p.proowner
  where n.nspname = 'public'
    and p.proname = 'task5_configure_property_gateway'
    and p.prosecdef
    and r.rolname = 'app_payment_gateway_secret_owner';

  if v_definition not like '%update public.payment_gateway_credentials as c%'
     or v_definition not like '%c.status = ''ACTIVE''%'
     or v_definition not like '%update public.payment_gateway_webhook_secrets as w%'
     or v_definition not like '%w.status = ''ACTIVE''%' then
    raise exception 'TASK5_ROTATION_STATUS_QUALIFICATION_FAILED';
  end if;
  if has_function_privilege(
    'app_tenant_runtime',
    'public.task5_configure_property_gateway(text,text,text,text,text,text,text,boolean,text)',
    'EXECUTE'
  ) then
    raise exception 'TASK5_INTERNAL_WRITER_RUNTIME_EXECUTE_FORBIDDEN';
  end if;
  if not has_function_privilege(
    'app_tenant_runtime',
    'public.task5_configure_property_gateway_staged(text,text,text,text,text,text,text,boolean,text)',
    'EXECUTE'
  ) then
    raise exception 'TASK5_STAGED_WRITER_RUNTIME_EXECUTE_REQUIRED';
  end if;
end;
$task5_rotation_fix_verify$;

select
  case when exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_roles r on r.oid = p.proowner
    where n.nspname = 'public'
      and p.proname = 'task5_configure_property_gateway'
      and p.prosecdef
      and r.rolname = 'app_payment_gateway_secret_owner'
  ) then 'PASS' else 'FAIL' end as restricted_owner_preserved,
  case when not has_function_privilege(
    'app_tenant_runtime',
    'public.task5_configure_property_gateway(text,text,text,text,text,text,text,boolean,text)',
    'EXECUTE'
  ) then 'PASS' else 'FAIL' end as internal_writer_still_denied,
  case when has_function_privilege(
    'app_tenant_runtime',
    'public.task5_configure_property_gateway_staged(text,text,text,text,text,text,text,boolean,text)',
    'EXECUTE'
  ) then 'PASS' else 'FAIL' end as staged_writer_still_allowed,
  'PASS'::text as status_ambiguity_fixed;

do $task5_rotation_fix_membership_cleanup$
begin
  execute format(
    'revoke app_payment_gateway_secret_owner from %I granted by %I restrict',
    current_user,
    current_user
  );
end;
$task5_rotation_fix_membership_cleanup$;

commit;
