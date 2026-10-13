-- Task 5: additive per-hotel Razorpay gateway ownership and credential-version schema.
-- USER-RUN CHECKPOINT: execute manually in Supabase SQL Editor only after review.
--
-- This migration is intentionally schema-only:
--   * it creates no gateway configuration rows;
--   * it stores no secret values;
--   * it does not alter historical merchant_ref or credential_ref values;
--   * it does not switch any property away from the legacy-global path; and
--   * it does not grant hotel/runtime roles direct access to gateway metadata or Vault.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '10min';
set local search_path = pg_catalog, public;

do $task5_preflight$
declare
  target_name text;
  target_role pg_roles%rowtype;
begin
  if not exists (
    select 1 from pg_extension where extname = 'supabase_vault'
  ) or to_regnamespace('vault') is null
     or to_regclass('vault.decrypted_secrets') is null then
    raise exception 'TASK5_SUPABASE_VAULT_REQUIRED';
  end if;

  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'vault'
      and p.proname = 'create_secret'
      and p.prosecdef
  ) then
    raise exception 'TASK5_SECURITY_DEFINER_VAULT_CREATE_SECRET_REQUIRED';
  end if;

  foreach target_name in array array[
    'hotels', 'payment_intents', 'payment_attempts', 'payment_webhook_inbox'
  ] loop
    if to_regclass(format('public.%I', target_name)) is null then
      raise exception 'TASK5_REQUIRED_TABLE_MISSING table=%', target_name;
    end if;
  end loop;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.hotels'::regclass
      and contype in ('p', 'u')
      and pg_get_constraintdef(oid) = 'UNIQUE (tenant_id, id)'
  ) and not exists (
    select 1
    from pg_index i
    where i.indrelid = 'public.hotels'::regclass
      and i.indisunique
      and pg_get_indexdef(i.indexrelid) like '%(tenant_id, id)%'
  ) then
    raise exception 'TASK5_CANONICAL_HOTEL_OWNER_KEY_MISSING';
  end if;

  foreach target_name in array array[
    'property_payment_gateway_policies',
    'payment_gateway_accounts',
    'payment_gateway_credentials',
    'payment_gateway_webhook_secrets',
    'payment_gateway_audit_events'
  ] loop
    if to_regclass(format('public.%I', target_name)) is not null then
      raise exception 'TASK5_SCHEMA_ALREADY_OR_PARTIALLY_PRESENT table=%', target_name;
    end if;
  end loop;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name in ('payment_intents', 'payment_attempts', 'payment_webhook_inbox')
      and column_name in ('gateway_account_id', 'webhook_secret_ref')
  ) or exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'payment_attempts'
      and column_name = 'credential_ref'
  ) then
    raise exception 'TASK5_EXISTING_PAYMENT_BINDING_COLUMNS_DETECTED';
  end if;

  foreach target_name in array array[
    'app_tenant_runtime', 'app_tenant_rpc_owner', 'service_role', 'anon', 'authenticated'
  ] loop
    select * into target_role from pg_roles where rolname = target_name;
    if target_role.oid is null then
      raise exception 'TASK5_REQUIRED_ROLE_MISSING role=%', target_name;
    end if;
  end loop;

  if exists (
    select 1 from pg_roles
    where rolname in ('app_tenant_runtime', 'app_tenant_rpc_owner')
      and (rolsuper or rolbypassrls)
  ) then
    raise exception 'TASK5_TENANT_ROLE_BYPASS_RLS_UNSAFE';
  end if;

  -- Fail closed rather than inheriting an already-broad Vault posture. These
  -- checks include privileges inherited from PUBLIC.
  foreach target_name in array array['anon', 'authenticated', 'app_tenant_runtime'] loop
    if has_schema_privilege(target_name, 'vault', 'USAGE')
       or has_table_privilege(target_name, 'vault.decrypted_secrets', 'SELECT') then
      raise exception 'TASK5_EXISTING_VAULT_ACCESS_UNSAFE role=%', target_name;
    end if;
  end loop;

  if exists (
    select 1
    from public.payment_intents
    where tenant_id is null or property_id is null
       or coalesce(btrim(merchant_ref), '') = ''
       or coalesce(btrim(credential_ref), '') = ''
  ) then
    raise exception 'TASK5_PAYMENT_INTENT_BINDING_PREFLIGHT_FAILED';
  end if;

  if exists (
    select 1
    from public.payment_attempts a
    join public.payment_intents i on i.id = a.payment_intent_id
    where a.tenant_id is distinct from i.tenant_id
       or a.property_id is distinct from i.property_id
       or a.provider is distinct from i.provider
       or a.merchant_ref is distinct from i.merchant_ref
  ) then
    raise exception 'TASK5_PAYMENT_ATTEMPT_BINDING_PREFLIGHT_FAILED';
  end if;
end;
$task5_preflight$;

do $task5_secret_owner_role$
declare
  target pg_roles%rowtype;
begin
  select * into target
  from pg_roles
  where rolname = 'app_payment_gateway_secret_owner';

  if target.oid is null then
    create role app_payment_gateway_secret_owner
      nologin nosuperuser nocreatedb nocreaterole noinherit
      noreplication nobypassrls;

    select * into target
    from pg_roles
    where rolname = 'app_payment_gateway_secret_owner';
  end if;

  if target.rolcanlogin or target.rolsuper or target.rolcreatedb
     or target.rolcreaterole or target.rolinherit or target.rolreplication
     or target.rolbypassrls then
    raise exception 'TASK5_SECRET_OWNER_ROLE_UNSAFE';
  end if;
end;
$task5_secret_owner_role$;

revoke create on schema public from app_payment_gateway_secret_owner;
grant usage on schema public to app_payment_gateway_secret_owner;

do $task5_vault_access_grants$
begin
  if not has_schema_privilege(
    'app_payment_gateway_secret_owner', 'vault', 'USAGE'
  ) then
    if not has_schema_privilege(current_user, 'vault', 'USAGE WITH GRANT OPTION') then
      raise exception 'TASK5_VAULT_SCHEMA_GRANT_OPTION_REQUIRED';
    end if;
    grant usage on schema vault to app_payment_gateway_secret_owner;
  end if;

  if not has_table_privilege(
    'app_payment_gateway_secret_owner', 'vault.decrypted_secrets', 'SELECT'
  ) then
    if not has_table_privilege(
      current_user, 'vault.decrypted_secrets', 'SELECT WITH GRANT OPTION'
    ) then
      raise exception 'TASK5_VAULT_VIEW_GRANT_OPTION_REQUIRED';
    end if;
    grant select on table vault.decrypted_secrets
      to app_payment_gateway_secret_owner;
  end if;
end;
$task5_vault_access_grants$;

do $task5_vault_create_grant$
declare
  target record;
  granted_count integer := 0;
begin
  for target in
    select p.oid, p.oid::regprocedure as routine_name
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'vault'
      and p.proname = 'create_secret'
      and p.prosecdef
  loop
    if not has_function_privilege(
      'app_payment_gateway_secret_owner', target.oid, 'EXECUTE'
    ) then
      if not has_function_privilege(
        current_user, target.oid, 'EXECUTE WITH GRANT OPTION'
      ) then
        continue;
      end if;
      execute format(
        'grant execute on function %s to app_payment_gateway_secret_owner',
        target.routine_name
      );
    end if;

    if has_function_privilege(
      'app_payment_gateway_secret_owner', target.oid, 'EXECUTE'
    ) then
      granted_count := granted_count + 1;
    end if;
  end loop;

  if granted_count = 0 then
    raise exception 'TASK5_VAULT_CREATE_SECRET_GRANT_FAILED';
  end if;
end;
$task5_vault_create_grant$;

-- vault.decrypted_secrets is intentionally used only by the isolated NOLOGIN
-- secret owner. Supabase Vault's view invokes one provider-managed internal
-- decrypt helper as the querying role, so grant only that exact view dependency
-- to the same restricted owner. Do not alter provider-managed ACLs.
do $task5_vault_decrypt_dependency_grant$
declare
  target record;
  dependency_count integer := 0;
begin
  for target in
    select distinct p.oid, p.oid::regprocedure as routine_name
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_depend dep on dep.refobjid = p.oid
    join pg_rewrite rw on rw.oid = dep.objid
    where n.nspname = 'vault'
      and p.proname = '_crypto_aead_det_decrypt'
      and rw.ev_class = 'vault.decrypted_secrets'::regclass
  loop
    dependency_count := dependency_count + 1;

    if not has_function_privilege(
      'app_payment_gateway_secret_owner', target.oid, 'EXECUTE'
    ) then
      if not has_function_privilege(
        current_user, target.oid, 'EXECUTE WITH GRANT OPTION'
      ) then
        raise exception 'TASK5_VAULT_DECRYPT_GRANT_OPTION_REQUIRED';
      end if;
      execute format(
        'grant execute on function %s to app_payment_gateway_secret_owner',
        target.routine_name
      );
    end if;
  end loop;

  if dependency_count <> 1 then
    raise exception 'TASK5_VAULT_DECRYPT_DEPENDENCY_UNEXPECTED count=%',
      dependency_count;
  end if;
end;
$task5_vault_decrypt_dependency_grant$;

create table public.property_payment_gateway_policies (
  tenant_id uuid not null,
  property_id bigint not null,
  provider text not null,
  mode text not null,
  resolution_mode text not null default 'LEGACY_GLOBAL',
  created_by text not null default current_user,
  updated_by text not null default current_user,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, property_id, provider),
  constraint task5_gateway_policy_hotel_fk
    foreign key (tenant_id, property_id)
    references public.hotels(tenant_id, id)
    on update restrict on delete restrict,
  constraint task5_gateway_policy_provider_ck
    check (provider = 'razorpay'),
  constraint task5_gateway_policy_mode_ck
    check (mode in ('TEST', 'LIVE')),
  constraint task5_gateway_policy_resolution_ck
    check (resolution_mode in ('LEGACY_GLOBAL', 'PER_PROPERTY'))
);

create table public.payment_gateway_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  property_id bigint not null,
  provider text not null,
  mode text not null,
  merchant_ref text not null,
  webhook_ref text not null,
  status text not null default 'DRAFT',
  created_by text not null default current_user,
  updated_by text not null default current_user,
  activated_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint task5_gateway_account_hotel_fk
    foreign key (tenant_id, property_id)
    references public.hotels(tenant_id, id)
    on update restrict on delete restrict,
  constraint task5_gateway_account_provider_ck
    check (provider = 'razorpay'),
  constraint task5_gateway_account_mode_ck
    check (mode in ('TEST', 'LIVE')),
  constraint task5_gateway_account_status_ck
    check (status in ('DRAFT', 'ACTIVE', 'DISABLED')),
  constraint task5_gateway_account_merchant_ref_ck
    check (merchant_ref ~ '^RZP_MERCHANT_[a-f0-9]{32}$'),
  constraint task5_gateway_account_webhook_ref_ck
    check (webhook_ref ~ '^rwh_[a-f0-9]{32}$'),
  constraint task5_gateway_account_disabled_at_ck
    check ((status = 'DISABLED') = (disabled_at is not null))
);

alter table public.payment_gateway_accounts
  add constraint task5_gateway_account_owner_id_uq
  unique (tenant_id, property_id, id),
  add constraint task5_gateway_account_owner_merchant_uq
  unique (tenant_id, property_id, id, provider, merchant_ref),
  add constraint task5_gateway_account_provider_merchant_uq
  unique (id, provider, merchant_ref),
  add constraint task5_gateway_account_merchant_ref_uq
  unique (merchant_ref),
  add constraint task5_gateway_account_webhook_ref_uq
  unique (webhook_ref);

create unique index task5_gateway_one_active_per_mode_uidx
  on public.payment_gateway_accounts (tenant_id, property_id, provider, mode)
  where status = 'ACTIVE';

create index task5_gateway_account_owner_idx
  on public.payment_gateway_accounts (tenant_id, property_id, provider, mode, status);

create table public.payment_gateway_credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  property_id bigint not null,
  account_id uuid not null,
  credential_ref text not null,
  version bigint not null,
  key_id text not null,
  secret_vault_id uuid not null,
  status text not null default 'PENDING',
  created_by text not null default current_user,
  validated_at timestamptz,
  last_validation_code text,
  activated_at timestamptz,
  superseded_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint task5_gateway_credential_account_fk
    foreign key (tenant_id, property_id, account_id)
    references public.payment_gateway_accounts(tenant_id, property_id, id)
    on update restrict on delete restrict,
  constraint task5_gateway_credential_status_ck
    check (status in ('PENDING', 'ACTIVE', 'HISTORICAL', 'INVALID', 'RETIRED')),
  constraint task5_gateway_credential_ref_ck
    check (credential_ref ~ '^RZP_CRED_[a-f0-9]{32}$'),
  constraint task5_gateway_credential_version_ck
    check (version > 0),
  constraint task5_gateway_credential_key_id_ck
    check (key_id ~ '^rzp_(test|live)_[A-Za-z0-9]+$'),
  constraint task5_gateway_validation_code_ck
    check (
      last_validation_code is null
      or last_validation_code ~ '^[A-Z0-9_]{1,80}$'
    ),
  constraint task5_gateway_credential_lifecycle_ck
    check (
      (status = 'ACTIVE' and activated_at is not null and retired_at is null)
      or (status = 'HISTORICAL' and activated_at is not null and superseded_at is not null and retired_at is null)
      or (status = 'RETIRED' and retired_at is not null)
      or (status in ('PENDING', 'INVALID') and retired_at is null)
    )
);

alter table public.payment_gateway_credentials
  add constraint task5_gateway_credential_account_version_uq
  unique (account_id, version),
  add constraint task5_gateway_credential_account_ref_uq
  unique (account_id, credential_ref),
  add constraint task5_gateway_credential_owner_ref_uq
  unique (tenant_id, property_id, account_id, credential_ref),
  add constraint task5_gateway_credential_vault_uq
  unique (secret_vault_id);

create unique index task5_gateway_one_active_credential_uidx
  on public.payment_gateway_credentials (account_id)
  where status = 'ACTIVE';

create index task5_gateway_credential_resolution_idx
  on public.payment_gateway_credentials (tenant_id, property_id, credential_ref, status);

create table public.payment_gateway_webhook_secrets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  property_id bigint not null,
  account_id uuid not null,
  webhook_secret_ref text not null,
  version bigint not null,
  secret_vault_id uuid not null,
  status text not null default 'PENDING',
  created_by text not null default current_user,
  activated_at timestamptz,
  superseded_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint task5_gateway_webhook_account_fk
    foreign key (tenant_id, property_id, account_id)
    references public.payment_gateway_accounts(tenant_id, property_id, id)
    on update restrict on delete restrict,
  constraint task5_gateway_webhook_status_ck
    check (status in ('PENDING', 'ACTIVE', 'HISTORICAL', 'INVALID', 'RETIRED')),
  constraint task5_gateway_webhook_ref_ck
    check (webhook_secret_ref ~ '^RZP_WEBHOOK_[a-f0-9]{32}$'),
  constraint task5_gateway_webhook_version_ck
    check (version > 0),
  constraint task5_gateway_webhook_lifecycle_ck
    check (
      (status = 'ACTIVE' and activated_at is not null and retired_at is null)
      or (status = 'HISTORICAL' and activated_at is not null and superseded_at is not null and retired_at is null)
      or (status = 'RETIRED' and retired_at is not null)
      or (status in ('PENDING', 'INVALID') and retired_at is null)
    )
);

alter table public.payment_gateway_webhook_secrets
  add constraint task5_gateway_webhook_account_version_uq
  unique (account_id, version),
  add constraint task5_gateway_webhook_account_ref_uq
  unique (account_id, webhook_secret_ref),
  add constraint task5_gateway_webhook_vault_uq
  unique (secret_vault_id);

create unique index task5_gateway_one_active_webhook_uidx
  on public.payment_gateway_webhook_secrets (account_id)
  where status = 'ACTIVE';

create index task5_gateway_webhook_resolution_idx
  on public.payment_gateway_webhook_secrets (tenant_id, property_id, account_id, status);

create table public.payment_gateway_audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  property_id bigint not null,
  account_id uuid,
  credential_ref text,
  webhook_secret_ref text,
  action text not null,
  outcome text not null,
  actor_ref text not null default current_user,
  reason_code text,
  created_at timestamptz not null default now(),
  constraint task5_gateway_audit_hotel_fk
    foreign key (tenant_id, property_id)
    references public.hotels(tenant_id, id)
    on update restrict on delete restrict,
  constraint task5_gateway_audit_account_fk
    foreign key (tenant_id, property_id, account_id)
    references public.payment_gateway_accounts(tenant_id, property_id, id)
    on update restrict on delete restrict,
  constraint task5_gateway_audit_credential_fk
    foreign key (account_id, credential_ref)
    references public.payment_gateway_credentials(account_id, credential_ref)
    on update restrict on delete restrict,
  constraint task5_gateway_audit_webhook_fk
    foreign key (account_id, webhook_secret_ref)
    references public.payment_gateway_webhook_secrets(account_id, webhook_secret_ref)
    on update restrict on delete restrict,
  constraint task5_gateway_audit_ref_owner_ck
    check (
      (credential_ref is null or account_id is not null)
      and (webhook_secret_ref is null or account_id is not null)
    ),
  constraint task5_gateway_audit_action_ck
    check (action in (
      'CONFIGURE', 'VALIDATE', 'ACTIVATE', 'ROTATE',
      'DISABLE', 'ENABLE', 'RETIRE', 'TEST_CONNECTION',
      'RESOLUTION_DENIED'
    )),
  constraint task5_gateway_audit_outcome_ck
    check (outcome in ('SUCCESS', 'DENIED', 'FAILED')),
  constraint task5_gateway_audit_reason_ck
    check (reason_code is null or reason_code ~ '^[A-Z0-9_]{1,80}$')
);

create index task5_gateway_audit_owner_created_idx
  on public.payment_gateway_audit_events (tenant_id, property_id, created_at desc);

create or replace function public.task5_guard_gateway_policy()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $task5_guard_gateway_policy_fn$
begin
  if tg_op = 'UPDATE' and (
    new.tenant_id is distinct from old.tenant_id
    or new.property_id is distinct from old.property_id
    or new.provider is distinct from old.provider
    or new.created_at is distinct from old.created_at
    or new.created_by is distinct from old.created_by
  ) then
    raise exception using errcode = '23514', message = 'TASK5_GATEWAY_POLICY_IDENTITY_IMMUTABLE';
  end if;

  if new.resolution_mode = 'PER_PROPERTY' and not exists (
    select 1
    from public.payment_gateway_accounts a
    join public.payment_gateway_credentials c
      on c.account_id = a.id and c.status = 'ACTIVE'
    join public.payment_gateway_webhook_secrets w
      on w.account_id = a.id and w.status = 'ACTIVE'
    where a.tenant_id = new.tenant_id
      and a.property_id = new.property_id
      and a.provider = new.provider
      and a.mode = new.mode
      and a.status = 'ACTIVE'
  ) then
    raise exception using errcode = '23514', message = 'TASK5_PER_PROPERTY_GATEWAY_NOT_READY';
  end if;

  new.updated_at := now();
  return new;
end;
$task5_guard_gateway_policy_fn$;

create or replace function public.task5_guard_gateway_account()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $task5_guard_gateway_account_fn$
begin
  if tg_op = 'INSERT' then
    new.merchant_ref := 'RZP_MERCHANT_' || replace(new.id::text, '-', '');
    new.webhook_ref := 'rwh_' || replace(new.id::text, '-', '');
    new.status := 'DRAFT';
    new.activated_at := null;
    new.disabled_at := null;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.property_id is distinct from old.property_id
     or new.provider is distinct from old.provider
     or new.mode is distinct from old.mode
     or new.merchant_ref is distinct from old.merchant_ref
     or new.webhook_ref is distinct from old.webhook_ref
     or new.created_at is distinct from old.created_at
     or new.created_by is distinct from old.created_by then
    raise exception using errcode = '23514', message = 'TASK5_GATEWAY_ACCOUNT_IDENTITY_IMMUTABLE';
  end if;

  if old.status = 'DRAFT' and new.status not in ('DRAFT', 'ACTIVE', 'DISABLED')
     or old.status = 'ACTIVE' and new.status not in ('ACTIVE', 'DISABLED')
     or old.status = 'DISABLED' and new.status not in ('DISABLED', 'ACTIVE') then
    raise exception using errcode = '23514', message = 'TASK5_GATEWAY_ACCOUNT_STATUS_TRANSITION_INVALID';
  end if;

  if new.status = 'ACTIVE' then
    if not exists (
      select 1 from public.payment_gateway_credentials
      where account_id = new.id and status = 'ACTIVE'
    ) or not exists (
      select 1 from public.payment_gateway_webhook_secrets
      where account_id = new.id and status = 'ACTIVE'
    ) then
      raise exception using errcode = '23514', message = 'TASK5_GATEWAY_ACCOUNT_NOT_READY';
    end if;
    new.activated_at := coalesce(old.activated_at, now());
    new.disabled_at := null;
  elsif new.status = 'DISABLED' then
    new.disabled_at := coalesce(old.disabled_at, now());
  else
    new.activated_at := null;
    new.disabled_at := null;
  end if;

  new.updated_at := now();
  return new;
end;
$task5_guard_gateway_account_fn$;

create or replace function public.task5_guard_gateway_credential()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $task5_guard_gateway_credential_fn$
declare
  account_row public.payment_gateway_accounts%rowtype;
begin
  select * into account_row
  from public.payment_gateway_accounts
  where id = new.account_id
  for update;

  if not found then
    raise exception using errcode = '23503', message = 'TASK5_GATEWAY_ACCOUNT_NOT_FOUND';
  end if;

  if tg_op = 'INSERT' then
    new.tenant_id := account_row.tenant_id;
    new.property_id := account_row.property_id;
    new.credential_ref := 'RZP_CRED_' || replace(new.id::text, '-', '');
    select coalesce(max(version), 0) + 1 into new.version
    from public.payment_gateway_credentials
    where account_id = new.account_id;
    new.status := 'PENDING';
    new.activated_at := null;
    new.superseded_at := null;
    new.retired_at := null;
    new.created_at := now();
    new.updated_at := now();
  else
    if new.id is distinct from old.id
       or new.tenant_id is distinct from old.tenant_id
       or new.property_id is distinct from old.property_id
       or new.account_id is distinct from old.account_id
       or new.credential_ref is distinct from old.credential_ref
       or new.version is distinct from old.version
       or new.key_id is distinct from old.key_id
       or new.secret_vault_id is distinct from old.secret_vault_id
       or new.created_at is distinct from old.created_at
       or new.created_by is distinct from old.created_by then
      raise exception using errcode = '23514', message = 'TASK5_GATEWAY_CREDENTIAL_IMMUTABLE';
    end if;

    if old.status = 'PENDING' and new.status not in ('PENDING', 'ACTIVE', 'INVALID', 'RETIRED')
       or old.status = 'ACTIVE' and new.status not in ('ACTIVE', 'HISTORICAL', 'INVALID', 'RETIRED')
       or old.status = 'HISTORICAL' and new.status not in ('HISTORICAL', 'INVALID', 'RETIRED')
       or old.status = 'INVALID' and new.status not in ('INVALID', 'RETIRED')
       or old.status = 'RETIRED' and new.status <> 'RETIRED' then
      raise exception using errcode = '23514', message = 'TASK5_GATEWAY_CREDENTIAL_STATUS_TRANSITION_INVALID';
    end if;
  end if;

  if account_row.mode = 'TEST' and new.key_id !~ '^rzp_test_[A-Za-z0-9]+$' then
    raise exception using errcode = '23514', message = 'TASK5_GATEWAY_CREDENTIAL_MODE_MISMATCH';
  end if;
  if account_row.mode = 'LIVE' and new.key_id !~ '^rzp_live_[A-Za-z0-9]+$' then
    raise exception using errcode = '23514', message = 'TASK5_GATEWAY_CREDENTIAL_MODE_MISMATCH';
  end if;

  if new.status = 'ACTIVE' then
    if new.validated_at is null then
      raise exception using errcode = '23514', message = 'TASK5_GATEWAY_CREDENTIAL_NOT_VALIDATED';
    end if;
    new.activated_at := coalesce(old.activated_at, now());
    new.superseded_at := null;
    new.retired_at := null;
  elsif new.status = 'HISTORICAL' then
    new.superseded_at := coalesce(old.superseded_at, now());
    new.retired_at := null;
  elsif new.status = 'RETIRED' then
    new.retired_at := coalesce(old.retired_at, now());
  end if;

  new.updated_at := now();
  return new;
end;
$task5_guard_gateway_credential_fn$;

create or replace function public.task5_guard_gateway_webhook_secret()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $task5_guard_gateway_webhook_fn$
declare
  account_row public.payment_gateway_accounts%rowtype;
begin
  select * into account_row
  from public.payment_gateway_accounts
  where id = new.account_id
  for update;

  if not found then
    raise exception using errcode = '23503', message = 'TASK5_GATEWAY_ACCOUNT_NOT_FOUND';
  end if;

  if tg_op = 'INSERT' then
    new.tenant_id := account_row.tenant_id;
    new.property_id := account_row.property_id;
    new.webhook_secret_ref := 'RZP_WEBHOOK_' || replace(new.id::text, '-', '');
    select coalesce(max(version), 0) + 1 into new.version
    from public.payment_gateway_webhook_secrets
    where account_id = new.account_id;
    new.status := 'PENDING';
    new.activated_at := null;
    new.superseded_at := null;
    new.retired_at := null;
    new.created_at := now();
    new.updated_at := now();
  else
    if new.id is distinct from old.id
       or new.tenant_id is distinct from old.tenant_id
       or new.property_id is distinct from old.property_id
       or new.account_id is distinct from old.account_id
       or new.webhook_secret_ref is distinct from old.webhook_secret_ref
       or new.version is distinct from old.version
       or new.secret_vault_id is distinct from old.secret_vault_id
       or new.created_at is distinct from old.created_at
       or new.created_by is distinct from old.created_by then
      raise exception using errcode = '23514', message = 'TASK5_GATEWAY_WEBHOOK_SECRET_IMMUTABLE';
    end if;

    if old.status = 'PENDING' and new.status not in ('PENDING', 'ACTIVE', 'INVALID', 'RETIRED')
       or old.status = 'ACTIVE' and new.status not in ('ACTIVE', 'HISTORICAL', 'INVALID', 'RETIRED')
       or old.status = 'HISTORICAL' and new.status not in ('HISTORICAL', 'INVALID', 'RETIRED')
       or old.status = 'INVALID' and new.status not in ('INVALID', 'RETIRED')
       or old.status = 'RETIRED' and new.status <> 'RETIRED' then
      raise exception using errcode = '23514', message = 'TASK5_GATEWAY_WEBHOOK_STATUS_TRANSITION_INVALID';
    end if;
  end if;

  if new.status = 'ACTIVE' then
    new.activated_at := coalesce(old.activated_at, now());
    new.superseded_at := null;
    new.retired_at := null;
  elsif new.status = 'HISTORICAL' then
    new.superseded_at := coalesce(old.superseded_at, now());
    new.retired_at := null;
  elsif new.status = 'RETIRED' then
    new.retired_at := coalesce(old.retired_at, now());
  end if;

  new.updated_at := now();
  return new;
end;
$task5_guard_gateway_webhook_fn$;

create or replace function public.task5_forbid_gateway_delete()
returns trigger
language plpgsql
set search_path = pg_catalog
as $task5_forbid_gateway_delete_fn$
begin
  raise exception using errcode = '23514',
    message = format('TASK5_GATEWAY_DELETE_FORBIDDEN table=%s', tg_table_name);
end;
$task5_forbid_gateway_delete_fn$;

create or replace function public.task5_forbid_audit_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $task5_forbid_audit_mutation_fn$
begin
  raise exception using errcode = '23514', message = 'TASK5_GATEWAY_AUDIT_IMMUTABLE';
end;
$task5_forbid_audit_mutation_fn$;

create or replace function public.task5_assert_active_account_ready()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $task5_assert_active_account_ready_fn$
declare
  affected_account_id uuid;
  active_credential_count integer;
  active_webhook_count integer;
begin
  if tg_table_name = 'payment_gateway_accounts' then
    affected_account_id := case when tg_op = 'DELETE' then old.id else new.id end;
  else
    affected_account_id := case
      when tg_op = 'DELETE' then old.account_id
      else new.account_id
    end;
  end if;

  if not exists (
    select 1
    from public.payment_gateway_accounts
    where id = affected_account_id and status = 'ACTIVE'
  ) then
    return null;
  end if;

  select count(*) into active_credential_count
  from public.payment_gateway_credentials
  where account_id = affected_account_id and status = 'ACTIVE';

  select count(*) into active_webhook_count
  from public.payment_gateway_webhook_secrets
  where account_id = affected_account_id and status = 'ACTIVE';

  if active_credential_count <> 1 or active_webhook_count <> 1 then
    raise exception using errcode = '23514',
      message = 'TASK5_ACTIVE_GATEWAY_ACCOUNT_NOT_READY';
  end if;

  return null;
end;
$task5_assert_active_account_ready_fn$;

create trigger task5_gateway_policy_guard_trg
before insert or update on public.property_payment_gateway_policies
for each row execute function public.task5_guard_gateway_policy();

create trigger task5_gateway_account_guard_trg
before insert or update on public.payment_gateway_accounts
for each row execute function public.task5_guard_gateway_account();

create trigger task5_gateway_credential_guard_trg
before insert or update on public.payment_gateway_credentials
for each row execute function public.task5_guard_gateway_credential();

create trigger task5_gateway_webhook_guard_trg
before insert or update on public.payment_gateway_webhook_secrets
for each row execute function public.task5_guard_gateway_webhook_secret();

create trigger task5_gateway_policy_no_delete_trg
before delete on public.property_payment_gateway_policies
for each row execute function public.task5_forbid_gateway_delete();
create trigger task5_gateway_account_no_delete_trg
before delete on public.payment_gateway_accounts
for each row execute function public.task5_forbid_gateway_delete();
create trigger task5_gateway_credential_no_delete_trg
before delete on public.payment_gateway_credentials
for each row execute function public.task5_forbid_gateway_delete();
create trigger task5_gateway_webhook_no_delete_trg
before delete on public.payment_gateway_webhook_secrets
for each row execute function public.task5_forbid_gateway_delete();
create trigger task5_gateway_audit_immutable_trg
before update or delete on public.payment_gateway_audit_events
for each row execute function public.task5_forbid_audit_mutation();

create constraint trigger task5_gateway_account_ready_constraint_trg
after insert or update or delete on public.payment_gateway_accounts
deferrable initially deferred
for each row execute function public.task5_assert_active_account_ready();

create constraint trigger task5_gateway_credential_ready_constraint_trg
after insert or update or delete on public.payment_gateway_credentials
deferrable initially deferred
for each row execute function public.task5_assert_active_account_ready();

create constraint trigger task5_gateway_webhook_ready_constraint_trg
after insert or update or delete on public.payment_gateway_webhook_secrets
deferrable initially deferred
for each row execute function public.task5_assert_active_account_ready();

alter table public.payment_intents
  add column gateway_account_id uuid;

alter table public.payment_intents
  add constraint task5_payment_intent_account_fk
    foreign key (tenant_id, property_id, gateway_account_id, provider, merchant_ref)
    references public.payment_gateway_accounts(tenant_id, property_id, id, provider, merchant_ref)
    on update restrict on delete restrict,
  add constraint task5_payment_intent_credential_fk
    foreign key (tenant_id, property_id, gateway_account_id, credential_ref)
    references public.payment_gateway_credentials(tenant_id, property_id, account_id, credential_ref)
    on update restrict on delete restrict,
  add constraint task5_payment_intent_gateway_binding_ck
    check (
      gateway_account_id is not null
      or (provider = 'razorpay' and merchant_ref = 'LEGACY_PLATFORM_RAZORPAY')
    );

create unique index task5_payment_intent_evidence_binding_uidx
  on public.payment_intents (
    tenant_id, property_id, id, provider, merchant_ref, credential_ref
  );

create or replace function public.task5_guard_payment_intent_gateway_binding()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $task5_guard_intent_binding_fn$
declare
  binding_count integer;
begin
  if tg_op = 'UPDATE' then
    if new.gateway_account_id is distinct from old.gateway_account_id
       or new.provider is distinct from old.provider
       or new.merchant_ref is distinct from old.merchant_ref
       or new.credential_ref is distinct from old.credential_ref
       or new.tenant_id is distinct from old.tenant_id
       or new.property_id is distinct from old.property_id then
      raise exception using errcode = '23514', message = 'TASK5_PAYMENT_INTENT_GATEWAY_BINDING_IMMUTABLE';
    end if;
    return new;
  end if;

  if new.gateway_account_id is null then
    if new.provider <> 'razorpay' or new.merchant_ref <> 'LEGACY_PLATFORM_RAZORPAY' then
      raise exception using errcode = '23514', message = 'TASK5_UNREGISTERED_GATEWAY_BINDING_DENIED';
    end if;
    return new;
  end if;

  select count(*) into binding_count
  from public.payment_gateway_accounts a
  join public.payment_gateway_credentials c
    on c.account_id = a.id
  where a.id = new.gateway_account_id
    and a.tenant_id = new.tenant_id
    and a.property_id = new.property_id
    and a.provider = new.provider
    and a.merchant_ref = new.merchant_ref
    and a.status = 'ACTIVE'
    and c.credential_ref = new.credential_ref
    and c.status = 'ACTIVE';

  if binding_count <> 1 then
    raise exception using errcode = '23514', message = 'TASK5_PAYMENT_INTENT_GATEWAY_BINDING_INVALID';
  end if;

  return new;
end;
$task5_guard_intent_binding_fn$;

create trigger task5_payment_intent_gateway_binding_trg
before insert or update of gateway_account_id, provider, merchant_ref, credential_ref, tenant_id, property_id
on public.payment_intents
for each row execute function public.task5_guard_payment_intent_gateway_binding();

alter table public.payment_attempts
  add column credential_ref text;

update public.payment_attempts a
set credential_ref = i.credential_ref
from public.payment_intents i
where i.id = a.payment_intent_id;

alter table public.payment_attempts
  alter column credential_ref set not null,
  add constraint task5_payment_attempt_intent_binding_fk
    foreign key (
      tenant_id, property_id, payment_intent_id,
      provider, merchant_ref, credential_ref
    ) references public.payment_intents(
      tenant_id, property_id, id,
      provider, merchant_ref, credential_ref
    ) on update restrict on delete restrict;

create or replace function public.task5_inherit_payment_attempt_credential()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $task5_inherit_attempt_credential_fn$
declare
  expected_ref text;
begin
  select credential_ref into expected_ref
  from public.payment_intents
  where id = new.payment_intent_id;

  if not found then
    raise exception using errcode = '23503', message = 'TASK5_PAYMENT_INTENT_NOT_FOUND';
  end if;

  if new.credential_ref is not null and new.credential_ref <> expected_ref then
    raise exception using errcode = '23514', message = 'TASK5_PAYMENT_ATTEMPT_CREDENTIAL_MISMATCH';
  end if;

  new.credential_ref := expected_ref;
  return new;
end;
$task5_inherit_attempt_credential_fn$;

create trigger task5_payment_attempt_credential_trg
before insert or update of payment_intent_id, credential_ref
on public.payment_attempts
for each row execute function public.task5_inherit_payment_attempt_credential();

alter table public.payment_webhook_inbox
  add column gateway_account_id uuid,
  add column webhook_secret_ref text,
  add constraint task5_webhook_gateway_pair_ck
    check ((gateway_account_id is null) = (webhook_secret_ref is null)),
  add constraint task5_webhook_gateway_account_fk
    foreign key (gateway_account_id, provider, merchant_ref)
    references public.payment_gateway_accounts(id, provider, merchant_ref)
    on update restrict on delete restrict,
  add constraint task5_webhook_secret_binding_fk
    foreign key (gateway_account_id, webhook_secret_ref)
    references public.payment_gateway_webhook_secrets(account_id, webhook_secret_ref)
    on update restrict on delete restrict;

create index task5_webhook_gateway_binding_idx
  on public.payment_webhook_inbox (gateway_account_id, webhook_secret_ref, received_at)
  where gateway_account_id is not null;

create or replace function public.task5_guard_webhook_gateway_binding()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $task5_guard_webhook_binding_fn$
declare
  account_row public.payment_gateway_accounts%rowtype;
  intent_row public.payment_intents%rowtype;
  secret_status text;
begin
  if new.gateway_account_id is null then
    if new.webhook_secret_ref is not null then
      raise exception using errcode = '23514', message = 'TASK5_WEBHOOK_SECRET_WITHOUT_ACCOUNT';
    end if;
    return new;
  end if;

  select * into account_row
  from public.payment_gateway_accounts
  where id = new.gateway_account_id;

  if not found
     or account_row.provider <> new.provider
     or account_row.merchant_ref <> new.merchant_ref then
    raise exception using errcode = '23514', message = 'TASK5_WEBHOOK_MERCHANT_BINDING_MISMATCH';
  end if;

  select status into secret_status
  from public.payment_gateway_webhook_secrets
  where account_id = new.gateway_account_id
    and webhook_secret_ref = new.webhook_secret_ref;

  if not found then
    raise exception using errcode = '23514', message = 'TASK5_WEBHOOK_SECRET_BINDING_MISMATCH';
  end if;

  if tg_op = 'INSERT' and secret_status not in ('ACTIVE', 'HISTORICAL') then
    raise exception using errcode = '23514', message = 'TASK5_WEBHOOK_SECRET_NOT_ACCEPTABLE';
  end if;

  if new.payment_intent_id is not null then
    select * into intent_row
    from public.payment_intents
    where id = new.payment_intent_id;

    if not found
       or intent_row.tenant_id <> account_row.tenant_id
       or intent_row.property_id <> account_row.property_id
       or intent_row.provider <> account_row.provider
       or intent_row.merchant_ref <> account_row.merchant_ref
       or intent_row.gateway_account_id is distinct from account_row.id then
      raise exception using errcode = '23514', message = 'TASK5_WEBHOOK_PAYMENT_INTENT_BOUNDARY_MISMATCH';
    end if;
  end if;

  return new;
end;
$task5_guard_webhook_binding_fn$;

create trigger task5_webhook_gateway_binding_trg
before insert or update of gateway_account_id, webhook_secret_ref, payment_intent_id, provider, merchant_ref
on public.payment_webhook_inbox
for each row execute function public.task5_guard_webhook_gateway_binding();

-- These two trigger functions validate non-secret gateway bindings during
-- payment/inbox writes. They execute as the existing non-BYPASSRLS Task 3 RPC
-- owner so service-role callers do not need direct gateway-table grants.
do $task5_binding_function_owner$
begin
  revoke all on function public.task5_guard_payment_intent_gateway_binding()
    from public, anon, authenticated, app_tenant_runtime, service_role;
  revoke all on function public.task5_guard_webhook_gateway_binding()
    from public, anon, authenticated, app_tenant_runtime, service_role;

  execute format(
    'grant app_tenant_rpc_owner to %I with admin false, inherit false, set true granted by %I',
    current_user,
    current_user
  );
  grant create on schema public to app_tenant_rpc_owner;

  alter function public.task5_guard_payment_intent_gateway_binding()
    owner to app_tenant_rpc_owner;
  alter function public.task5_guard_webhook_gateway_binding()
    owner to app_tenant_rpc_owner;

  revoke create on schema public from app_tenant_rpc_owner;
  execute format(
    'revoke app_tenant_rpc_owner from %I granted by %I',
    current_user,
    current_user
  );
end;
$task5_binding_function_owner$;

do $task5_rls$
declare
  table_name text;
  mutable_tables constant text[] := array[
    'property_payment_gateway_policies',
    'payment_gateway_accounts',
    'payment_gateway_credentials',
    'payment_gateway_webhook_secrets'
  ];
  tenant_scope constant text := $scope$
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and property_id = nullif(current_setting('app.property_id', true), '')::bigint
  $scope$;
begin
  foreach table_name in array mutable_tables || array['payment_gateway_audit_events'] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('alter table public.%I force row level security', table_name);
    execute format(
      'create policy task5_tenant_select on public.%I as permissive for select to app_tenant_runtime, app_tenant_rpc_owner, app_payment_gateway_secret_owner using (%s)',
      table_name, tenant_scope
    );
    execute format(
      'create policy task5_tenant_insert on public.%I as permissive for insert to app_tenant_rpc_owner, app_payment_gateway_secret_owner with check (%s)',
      table_name, tenant_scope
    );

    if table_name = any(mutable_tables) then
      execute format(
        'create policy task5_tenant_update on public.%I as permissive for update to app_tenant_rpc_owner, app_payment_gateway_secret_owner using (%s) with check (%s)',
        table_name, tenant_scope, tenant_scope
      );
    end if;
  end loop;
end;
$task5_rls$;

revoke all on table
  public.property_payment_gateway_policies,
  public.payment_gateway_accounts,
  public.payment_gateway_credentials,
  public.payment_gateway_webhook_secrets,
  public.payment_gateway_audit_events
from public, anon, authenticated, app_tenant_runtime, app_tenant_rpc_owner,
  app_payment_gateway_secret_owner, service_role;

-- Only the isolated NOLOGIN function-owner role receives underlying metadata
-- access. app_tenant_runtime will later receive EXECUTE on reviewed safe RPCs,
-- never direct table or Vault access.
grant select, insert, update on table
  public.property_payment_gateway_policies,
  public.payment_gateway_accounts,
  public.payment_gateway_credentials,
  public.payment_gateway_webhook_secrets
to app_payment_gateway_secret_owner;

grant select, insert on table public.payment_gateway_audit_events
to app_payment_gateway_secret_owner;

grant select on table
  public.payment_gateway_accounts,
  public.payment_gateway_credentials,
  public.payment_gateway_webhook_secrets
to app_tenant_rpc_owner;

revoke all on function public.task5_guard_gateway_policy() from public, anon, authenticated;
revoke all on function public.task5_guard_gateway_account() from public, anon, authenticated;
revoke all on function public.task5_guard_gateway_credential() from public, anon, authenticated;
revoke all on function public.task5_guard_gateway_webhook_secret() from public, anon, authenticated;
revoke all on function public.task5_forbid_gateway_delete() from public, anon, authenticated;
revoke all on function public.task5_forbid_audit_mutation() from public, anon, authenticated;
revoke all on function public.task5_assert_active_account_ready() from public, anon, authenticated;
revoke all on function public.task5_inherit_payment_attempt_credential() from public, anon, authenticated;

-- PostgreSQL checks trigger-function EXECUTE for the role performing gateway
-- writes. Keep the trigger surface closed to application roles while allowing
-- only the isolated NOLOGIN gateway function owner to invoke the guards.
grant execute on function
  public.task5_guard_gateway_policy(),
  public.task5_guard_gateway_account(),
  public.task5_guard_gateway_credential(),
  public.task5_guard_gateway_webhook_secret(),
  public.task5_assert_active_account_ready()
to app_payment_gateway_secret_owner;

-- The readiness constraint is initially deferred, so PostgreSQL fires it at
-- COMMIT after the outer SECURITY DEFINER writer has returned. Isolate its
-- table reads behind the same NOLOGIN owner instead of granting the hotel
-- runtime any direct gateway-table access.
do $task5_deferred_trigger_owner$
begin
  execute format(
    'grant app_payment_gateway_secret_owner to %I with admin false, inherit false, set true granted by %I',
    current_user,
    current_user
  );
  grant create on schema public to app_payment_gateway_secret_owner;
  alter function public.task5_assert_active_account_ready()
    owner to app_payment_gateway_secret_owner;
  revoke create on schema public from app_payment_gateway_secret_owner;
  execute format(
    'revoke app_payment_gateway_secret_owner from %I granted by %I restrict',
    current_user,
    current_user
  );
end;
$task5_deferred_trigger_owner$;

comment on table public.property_payment_gateway_policies is
  'Task 5 server-controlled explicit legacy-global versus per-property gateway selection.';
comment on table public.payment_gateway_accounts is
  'Task 5 non-secret canonical property ownership and merchant identity metadata.';
comment on table public.payment_gateway_credentials is
  'Task 5 immutable Razorpay API credential versions. secret_vault_id is a Vault UUID, never secret plaintext.';
comment on table public.payment_gateway_webhook_secrets is
  'Task 5 immutable Razorpay webhook-secret versions. Secret material remains in Supabase Vault.';
comment on table public.payment_gateway_audit_events is
  'Task 5 append-only gateway administration audit without request bodies or secret values.';
comment on column public.payment_intents.gateway_account_id is
  'Task 5 immutable property gateway account binding. NULL is retained only for explicit legacy-global intents.';
comment on column public.payment_attempts.credential_ref is
  'Task 5 credential evidence inherited from the authoritative PaymentIntent.';
comment on column public.payment_webhook_inbox.gateway_account_id is
  'Task 5 account candidate authenticated by the matched webhook HMAC secret; not derived from payload tenant metadata.';
comment on column public.payment_webhook_inbox.webhook_secret_ref is
  'Task 5 non-secret immutable webhook secret version reference that authenticated intake.';

do $task5_final_guard$
declare
  bad_count bigint;
  table_name text;
begin
  select count(*) into bad_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in (
      'property_payment_gateway_policies',
      'payment_gateway_accounts',
      'payment_gateway_credentials',
      'payment_gateway_webhook_secrets',
      'payment_gateway_audit_events'
    )
    and c.relkind in ('r', 'p')
    and c.relrowsecurity
    and c.relforcerowsecurity;
  if bad_count <> 5 then
    raise exception 'TASK5_RLS_FORCE_RLS_FINAL_GUARD_FAILED count=%', bad_count;
  end if;

  if exists (
    select 1 from pg_roles
    where rolname = 'app_payment_gateway_secret_owner'
      and (rolcanlogin or rolsuper or rolcreatedb or rolcreaterole
        or rolinherit or rolreplication or rolbypassrls)
  ) or exists (
    select 1
    from pg_auth_members m
    where m.roleid = (
      select oid from pg_roles where rolname = 'app_payment_gateway_secret_owner'
    ) and (m.inherit_option or m.set_option)
  ) then
    raise exception 'TASK5_SECRET_OWNER_FINAL_GUARD_FAILED';
  end if;

  foreach table_name in array array[
    'property_payment_gateway_policies',
    'payment_gateway_accounts',
    'payment_gateway_credentials',
    'payment_gateway_webhook_secrets',
    'payment_gateway_audit_events'
  ] loop
    if has_table_privilege('anon', format('public.%I', table_name), 'SELECT')
       or has_table_privilege('authenticated', format('public.%I', table_name), 'SELECT')
       or has_table_privilege('app_tenant_runtime', format('public.%I', table_name), 'SELECT')
       or has_table_privilege('service_role', format('public.%I', table_name), 'SELECT') then
      raise exception 'TASK5_DIRECT_GATEWAY_TABLE_ACCESS_UNSAFE table=%', table_name;
    end if;
  end loop;

  if has_schema_privilege('anon', 'vault', 'USAGE')
     or has_schema_privilege('authenticated', 'vault', 'USAGE')
     or has_schema_privilege('app_tenant_runtime', 'vault', 'USAGE')
     or has_table_privilege('anon', 'vault.decrypted_secrets', 'SELECT')
     or has_table_privilege('authenticated', 'vault.decrypted_secrets', 'SELECT')
     or has_table_privilege('app_tenant_runtime', 'vault.decrypted_secrets', 'SELECT') then
    raise exception 'TASK5_VAULT_RUNTIME_ISOLATION_FINAL_GUARD_FAILED';
  end if;

  if not has_schema_privilege('app_payment_gateway_secret_owner', 'vault', 'USAGE')
     or not has_table_privilege(
       'app_payment_gateway_secret_owner', 'vault.decrypted_secrets', 'SELECT'
     ) then
    raise exception 'TASK5_SECRET_OWNER_VAULT_ACCESS_MISSING';
  end if;

  select count(*) into bad_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles r on r.oid = p.proowner
  where n.nspname = 'public'
    and p.proname in (
      'task5_guard_payment_intent_gateway_binding',
      'task5_guard_webhook_gateway_binding'
    )
    and p.prosecdef
    and r.rolname = 'app_tenant_rpc_owner'
    and p.proconfig @> array['search_path=pg_catalog, public'];
  if bad_count <> 2 then
    raise exception 'TASK5_BINDING_FUNCTION_OWNER_FINAL_GUARD_FAILED count=%', bad_count;
  end if;

  if exists (
    select 1 from public.payment_intents where gateway_account_id is not null
  ) or exists (
    select 1
    from public.payment_attempts a
    join public.payment_intents i on i.id = a.payment_intent_id
    where a.credential_ref is distinct from i.credential_ref
  ) or exists (
    select 1
    from public.payment_webhook_inbox
    where gateway_account_id is not null or webhook_secret_ref is not null
  ) then
    raise exception 'TASK5_HISTORICAL_PAYMENT_IMMUTABILITY_FINAL_GUARD_FAILED';
  end if;

  if exists (select 1 from public.property_payment_gateway_policies)
     or exists (select 1 from public.payment_gateway_accounts)
     or exists (select 1 from public.payment_gateway_credentials)
     or exists (select 1 from public.payment_gateway_webhook_secrets)
     or exists (select 1 from public.payment_gateway_audit_events) then
    raise exception 'TASK5_SCHEMA_ONLY_MIGRATION_CREATED_DATA';
  end if;
end;
$task5_final_guard$;

notify pgrst, 'reload schema';

commit;

-- No automatic rollback is supplied because gateway/account/version rows are
-- financial-security evidence once configuration begins. Before configuration,
-- rollback may drop only these empty Task 5 objects after an explicit review.
-- Never delete PaymentIntents, attempts, webhook inbox rows, or Vault secrets.
