-- Task 4: additive application-session security schema and restricted RPC surface.
-- APPROVED DESIGN ONLY. Run manually in Supabase SQL Editor.
-- This migration does not alter Task 3 tenant ownership, disable RLS, migrate
-- existing principals, or invalidate existing legacy JWTs.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '10min';
set local search_path = pg_catalog, public;

do $task4_prerequisites$
declare
  unsafe_count bigint;
begin
  if not exists (
    select 1 from pg_roles where rolname = 'app_tenant_runtime'
  ) then
    raise exception 'TASK4_APP_TENANT_RUNTIME_MISSING';
  end if;

  select count(*) into unsafe_count
  from pg_roles
  where rolname = 'app_tenant_runtime'
    and (
      not rolcanlogin or rolsuper or rolcreatedb or rolcreaterole
      or rolreplication or rolbypassrls
    );
  if unsafe_count <> 0 then
    raise exception 'TASK4_APP_TENANT_RUNTIME_UNSAFE';
  end if;

  select count(*) into unsafe_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('hotel_staff_access', 'hotels')
    and c.relkind in ('r', 'p')
    and c.relrowsecurity
    and c.relforcerowsecurity;
  if unsafe_count <> 2 then
    raise exception 'TASK4_TASK3_FORCE_RLS_PREREQUISITE_FAILED count=%',
      unsafe_count;
  end if;

  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in (
        'auth_sessions',
        'auth_refresh_token_history',
        'auth_security_events'
      )
  ) then
    raise exception 'TASK4_SESSION_OBJECTS_ALREADY_EXIST';
  end if;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like 'task4_%auth%'
  ) then
    raise exception 'TASK4_AUTH_ROUTINES_ALREADY_EXIST';
  end if;
end;
$task4_prerequisites$;

do $task4_role$
declare
  target pg_roles%rowtype;
  effective_memberships bigint;
begin
  select * into target
  from pg_roles
  where rolname = 'app_auth_rpc_owner';

  if target.oid is null then
    create role app_auth_rpc_owner
      nologin nosuperuser nocreatedb nocreaterole noinherit
      noreplication nobypassrls;
    select * into target
    from pg_roles
    where rolname = 'app_auth_rpc_owner';
  end if;

  if target.rolcanlogin or target.rolsuper or target.rolcreatedb
     or target.rolcreaterole or target.rolinherit or target.rolreplication
     or target.rolbypassrls then
    raise exception 'TASK4_AUTH_RPC_OWNER_ATTRIBUTES_UNSAFE';
  end if;

  select count(*) into effective_memberships
  from pg_auth_members m
  where m.roleid = target.oid
    and (m.inherit_option or m.set_option);
  if effective_memberships <> 0 then
    raise exception
      'TASK4_AUTH_RPC_OWNER_EFFECTIVE_MEMBERSHIP count=%',
      effective_memberships;
  end if;
end;
$task4_role$;

revoke create on schema public from app_auth_rpc_owner;
grant usage on schema public to app_auth_rpc_owner;

do $task4_membership$
begin
  execute format(
    'grant app_auth_rpc_owner to %I with admin false, inherit false, set true granted by %I',
    current_user,
    current_user
  );
end;
$task4_membership$;

grant create on schema public to app_auth_rpc_owner;

create table public.auth_sessions (
  id uuid primary key,
  principal_type text not null,
  admin_user_id bigint,
  staff_access_id bigint,
  tenant_id uuid,
  property_id bigint,
  role_snapshot text,
  kds_role_snapshot text,
  refresh_family_id uuid not null,
  refresh_token_hash bytea not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  latest_access_expires_at timestamptz not null,
  refresh_expires_at timestamptz not null,
  revoked_at timestamptz,
  revoke_reason text,
  user_agent_hash bytea,
  version bigint not null default 1,
  constraint auth_sessions_principal_type_ck check (
    principal_type in ('platform_admin', 'hotel_staff')
  ),
  constraint auth_sessions_principal_shape_ck check (
    (
      principal_type = 'platform_admin'
      and admin_user_id is not null
      and staff_access_id is null
      and tenant_id is null
      and property_id is null
      and role_snapshot is null
      and kds_role_snapshot is null
    )
    or
    (
      principal_type = 'hotel_staff'
      and admin_user_id is null
      and staff_access_id is not null
      and tenant_id is not null
      and property_id is not null
      and role_snapshot is not null
      and role_snapshot in ('owner', 'staff')
      and kds_role_snapshot is not null
      and kds_role_snapshot in ('general', 'kitchen', 'expo', 'manager')
    )
  ),
  constraint auth_sessions_refresh_hash_ck check (
    octet_length(refresh_token_hash) = 32
  ),
  constraint auth_sessions_user_agent_hash_ck check (
    user_agent_hash is null or octet_length(user_agent_hash) = 32
  ),
  constraint auth_sessions_expiry_ck check (
    latest_access_expires_at > created_at
    and refresh_expires_at > latest_access_expires_at
  ),
  constraint auth_sessions_revocation_shape_ck check (
    (revoked_at is null and revoke_reason is null)
    or
    (revoked_at is not null and revoke_reason is not null)
  ),
  constraint auth_sessions_revoke_reason_ck check (
    revoke_reason is null
    or revoke_reason in (
      'logout', 'logout_all', 'refresh_replay', 'principal_inactive',
      'credential_changed', 'role_changed', 'kds_role_changed',
      'tenant_context_changed', 'account_deleted', 'admin_revoke',
      'security_change'
    )
  ),
  constraint auth_sessions_version_ck check (version > 0),
  constraint auth_sessions_admin_fk foreign key (admin_user_id)
    references public.admin_users(id) on update restrict on delete cascade,
  constraint auth_sessions_staff_fk foreign key (staff_access_id)
    references public.hotel_staff_access(id) on update restrict on delete cascade,
  constraint auth_sessions_property_fk foreign key (tenant_id, property_id)
    references public.hotels(tenant_id, id)
    on update restrict on delete restrict
);

create unique index auth_sessions_refresh_token_hash_uidx
  on public.auth_sessions (refresh_token_hash);
create index auth_sessions_refresh_family_idx
  on public.auth_sessions (refresh_family_id);
create index auth_sessions_admin_active_idx
  on public.auth_sessions (admin_user_id, refresh_expires_at)
  where revoked_at is null and admin_user_id is not null;
create index auth_sessions_staff_active_idx
  on public.auth_sessions (staff_access_id, refresh_expires_at)
  where revoked_at is null and staff_access_id is not null;
create index auth_sessions_tenant_property_idx
  on public.auth_sessions (tenant_id, property_id)
  where tenant_id is not null and property_id is not null;

create table public.auth_refresh_token_history (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  refresh_family_id uuid not null,
  token_hash bytea not null,
  used_at timestamptz not null default now(),
  expires_at timestamptz not null,
  replay_detected_at timestamptz,
  constraint auth_refresh_history_hash_ck check (
    octet_length(token_hash) = 32
  ),
  constraint auth_refresh_history_expiry_ck check (expires_at > used_at),
  constraint auth_refresh_history_session_fk foreign key (session_id)
    references public.auth_sessions(id) on update restrict on delete cascade
);

create unique index auth_refresh_history_token_hash_uidx
  on public.auth_refresh_token_history (token_hash);
create index auth_refresh_history_family_used_idx
  on public.auth_refresh_token_history (refresh_family_id, used_at desc);
create index auth_refresh_history_expiry_idx
  on public.auth_refresh_token_history (expires_at);

create table public.auth_security_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  outcome text not null,
  principal_type text,
  principal_id bigint,
  session_id uuid,
  tenant_id uuid,
  property_id bigint,
  request_id text,
  safe_context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint auth_security_events_type_ck check (
    event_type in (
      'login_success', 'login_failure', 'refresh_success', 'refresh_replay',
      'logout', 'session_revoke', 'role_change', 'staff_disable',
      'credential_change', 'account_delete', 'privileged_denied'
    )
  ),
  constraint auth_security_events_outcome_ck check (
    outcome in ('success', 'failure', 'denied')
  ),
  constraint auth_security_events_principal_type_ck check (
    principal_type is null
    or principal_type in ('platform_admin', 'hotel_staff')
  ),
  constraint auth_security_events_principal_id_ck check (
    principal_id is null or principal_id > 0
  ),
  constraint auth_security_events_tenant_shape_ck check (
    (tenant_id is null and property_id is null)
    or
    (tenant_id is not null and property_id is not null)
  ),
  constraint auth_security_events_request_id_ck check (
    request_id is null or length(request_id) between 1 and 160
  ),
  constraint auth_security_events_context_ck check (
    jsonb_typeof(safe_context) = 'object'
    and octet_length(safe_context::text) <= 4096
  )
);

create index auth_security_events_created_idx
  on public.auth_security_events (created_at desc);
create index auth_security_events_principal_idx
  on public.auth_security_events (
    principal_type, principal_id, created_at desc
  )
  where principal_id is not null;
create index auth_security_events_session_idx
  on public.auth_security_events (session_id, created_at desc)
  where session_id is not null;
create index auth_security_events_tenant_property_idx
  on public.auth_security_events (tenant_id, property_id, created_at desc)
  where tenant_id is not null and property_id is not null;

alter table public.auth_sessions enable row level security;
alter table public.auth_sessions force row level security;
alter table public.auth_refresh_token_history enable row level security;
alter table public.auth_refresh_token_history force row level security;
alter table public.auth_security_events enable row level security;
alter table public.auth_security_events force row level security;

revoke all privileges on table
  public.auth_sessions,
  public.auth_refresh_token_history,
  public.auth_security_events
from public, anon, authenticated, service_role, app_tenant_runtime,
  app_tenant_rpc_owner, app_auth_rpc_owner;

grant select, insert, update on public.auth_sessions
  to app_auth_rpc_owner;
grant select, insert, update on public.auth_refresh_token_history
  to app_auth_rpc_owner;
grant insert on public.auth_security_events
  to app_auth_rpc_owner;

create policy task4_auth_owner_select on public.auth_sessions
  for select to app_auth_rpc_owner using (true);
create policy task4_auth_owner_insert on public.auth_sessions
  for insert to app_auth_rpc_owner with check (true);
create policy task4_auth_owner_update on public.auth_sessions
  for update to app_auth_rpc_owner using (true) with check (true);

create policy task4_auth_owner_select on public.auth_refresh_token_history
  for select to app_auth_rpc_owner using (true);
create policy task4_auth_owner_insert on public.auth_refresh_token_history
  for insert to app_auth_rpc_owner with check (true);
create policy task4_auth_owner_update on public.auth_refresh_token_history
  for update to app_auth_rpc_owner using (true) with check (true);

create policy task4_auth_owner_insert on public.auth_security_events
  for insert to app_auth_rpc_owner with check (true);

-- Role-specific policies do not modify or broaden any existing Task 3 policy.
grant select (id, email, password_hash, full_name, is_active)
  on public.admin_users to app_auth_rpc_owner;
grant select (
  id, hotel_slug, display_name, role, pin_hash, is_active,
  kds_role, tenant_id, property_id
)
  on public.hotel_staff_access to app_auth_rpc_owner;
grant select (id, tenant_id, slug, is_active)
  on public.hotels to app_auth_rpc_owner;
grant select (id, status)
  on public.tenants to app_auth_rpc_owner;

create policy task4_auth_principal_read on public.admin_users
  for select to app_auth_rpc_owner using (true);
create policy task4_auth_principal_read on public.hotel_staff_access
  for select to app_auth_rpc_owner using (true);
create policy task4_auth_principal_read on public.hotels
  for select to app_auth_rpc_owner using (true);
create policy task4_auth_principal_read on public.tenants
  for select to app_auth_rpc_owner using (true);

create function public.task4_resolve_auth_principal(
  p_principal_type text,
  p_principal_id bigint
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $task4$
declare
  resolved jsonb;
begin
  if p_principal_id is null or p_principal_id <= 0 then
    return null;
  end if;

  if p_principal_type = 'platform_admin' then
    select jsonb_build_object(
      'principal_type', 'platform_admin',
      'principal_id', admin_user.id,
      'email', admin_user.email,
      'full_name', coalesce(admin_user.full_name, '')
    )
    into resolved
    from public.admin_users as admin_user
    where admin_user.id = p_principal_id
      and admin_user.is_active is true;
    return resolved;
  end if;

  if p_principal_type = 'hotel_staff' then
    select jsonb_build_object(
      'principal_type', 'hotel_staff',
      'principal_id', staff_user.id,
      'display_name', staff_user.display_name,
      'role', staff_user.role,
      'kds_role', staff_user.kds_role,
      'hotel_slug', hotel.slug,
      'tenant_id', staff_user.tenant_id,
      'property_id', staff_user.property_id
    )
    into resolved
    from public.hotel_staff_access as staff_user
    join public.hotels as hotel
      on hotel.tenant_id = staff_user.tenant_id
     and hotel.id = staff_user.property_id
     and hotel.slug = staff_user.hotel_slug
    join public.tenants as tenant
      on tenant.id = staff_user.tenant_id
    where staff_user.id = p_principal_id
      and staff_user.is_active is true
      and hotel.is_active is true
      and tenant.status = 'active';
    return resolved;
  end if;

  return null;
end;
$task4$;

create function public.task4_validate_auth_session(
  p_session_id uuid,
  p_principal_type text,
  p_principal_id bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $task4$
declare
  session_row public.auth_sessions%rowtype;
  principal jsonb;
  principal_tenant_id uuid;
  principal_property_id bigint;
  principal_role text;
  principal_kds_role text;
  revoke_code text;
begin
  if p_principal_type not in ('platform_admin', 'hotel_staff')
     or p_principal_id is null
     or p_principal_id <= 0 then
    return jsonb_build_object('status', 'unknown');
  end if;

  select *
  into session_row
  from public.auth_sessions
  where id = p_session_id;

  if not found
     or session_row.principal_type <> p_principal_type
     or (
       p_principal_type = 'platform_admin'
       and session_row.admin_user_id is distinct from p_principal_id
     )
     or (
       p_principal_type = 'hotel_staff'
       and session_row.staff_access_id is distinct from p_principal_id
     ) then
    return jsonb_build_object('status', 'unknown');
  end if;

  if session_row.revoked_at is not null then
    return jsonb_build_object('status', 'revoked');
  end if;
  if session_row.refresh_expires_at <= now() then
    return jsonb_build_object('status', 'expired');
  end if;

  principal := public.task4_resolve_auth_principal(
    p_principal_type,
    p_principal_id
  );

  if principal is null then
    revoke_code := 'principal_inactive';
  elsif p_principal_type = 'hotel_staff' then
    principal_tenant_id := (principal ->> 'tenant_id')::uuid;
    principal_property_id := (principal ->> 'property_id')::bigint;
    principal_role := principal ->> 'role';
    principal_kds_role := principal ->> 'kds_role';

    if session_row.tenant_id is distinct from principal_tenant_id
       or session_row.property_id is distinct from principal_property_id then
      revoke_code := 'tenant_context_changed';
    elsif session_row.role_snapshot is distinct from principal_role then
      revoke_code := 'role_changed';
    elsif session_row.kds_role_snapshot is distinct from principal_kds_role then
      revoke_code := 'kds_role_changed';
    end if;
  end if;

  if revoke_code is not null then
    update public.auth_sessions
    set revoked_at = now(),
        revoke_reason = revoke_code,
        version = version + 1
    where id = session_row.id
      and revoked_at is null;

    perform public.task4_record_auth_security_event(
      case
        when revoke_code in ('role_changed', 'kds_role_changed')
          then 'role_change'
        when revoke_code = 'principal_inactive'
          and p_principal_type = 'hotel_staff'
          then 'staff_disable'
        else 'session_revoke'
      end,
      'success',
      p_principal_type,
      p_principal_id,
      session_row.id,
      session_row.tenant_id,
      session_row.property_id,
      null,
      jsonb_build_object('reason', revoke_code)
    );

    return jsonb_build_object('status', 'revoked');
  end if;

  if session_row.last_seen_at < now() - interval '5 minutes' then
    update public.auth_sessions
    set last_seen_at = now()
    where id = session_row.id;
  end if;

  return jsonb_build_object(
    'status', 'active',
    'session_id', session_row.id,
    'refresh_family_id', session_row.refresh_family_id,
    'version', session_row.version,
    'refresh_expires_at', session_row.refresh_expires_at
  ) || principal;
end;
$task4$;

create function public.task4_rotate_auth_refresh(
  p_session_id uuid,
  p_principal_type text,
  p_principal_id bigint,
  p_presented_token_hash bytea,
  p_next_token_hash bytea,
  p_next_access_expires_at timestamptz,
  p_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $task4$
declare
  session_row public.auth_sessions%rowtype;
  validation jsonb;
  replayed boolean;
begin
  if p_presented_token_hash is null
     or octet_length(p_presented_token_hash) <> 32
     or p_next_token_hash is null
     or octet_length(p_next_token_hash) <> 32
     or p_presented_token_hash = p_next_token_hash then
    raise exception 'TASK4_REFRESH_HASH_INVALID';
  end if;

  validation := public.task4_validate_auth_session(
    p_session_id,
    p_principal_type,
    p_principal_id
  );
  if validation ->> 'status' <> 'active' then
    return validation;
  end if;

  select *
  into session_row
  from public.auth_sessions
  where id = p_session_id
  for update;

  if p_next_access_expires_at <= now()
     or p_next_access_expires_at > now() + interval '20 minutes'
     or p_next_access_expires_at >= session_row.refresh_expires_at then
    raise exception 'TASK4_REFRESH_ACCESS_EXPIRY_INVALID';
  end if;

  if exists (
    select 1
    from public.auth_refresh_token_history
    where token_hash = p_next_token_hash
  ) then
    raise exception 'TASK4_REFRESH_HASH_COLLISION';
  end if;

  if session_row.refresh_token_hash <> p_presented_token_hash then
    select exists (
      select 1
      from public.auth_refresh_token_history as history
      where history.session_id = session_row.id
        and history.refresh_family_id = session_row.refresh_family_id
        and history.token_hash = p_presented_token_hash
        and history.expires_at > now()
    )
    into replayed;

    if replayed then
      update public.auth_refresh_token_history
      set replay_detected_at = coalesce(replay_detected_at, now())
      where session_id = session_row.id
        and refresh_family_id = session_row.refresh_family_id
        and token_hash = p_presented_token_hash;

      update public.auth_sessions
      set revoked_at = coalesce(revoked_at, now()),
          revoke_reason = coalesce(revoke_reason, 'refresh_replay'),
          version = version + case when revoked_at is null then 1 else 0 end
      where refresh_family_id = session_row.refresh_family_id;

      perform public.task4_record_auth_security_event(
        'refresh_replay',
        'denied',
        session_row.principal_type,
        coalesce(session_row.admin_user_id, session_row.staff_access_id),
        session_row.id,
        session_row.tenant_id,
        session_row.property_id,
        p_request_id,
        '{}'::jsonb
      );

      return jsonb_build_object('status', 'refresh_replay');
    end if;

    return jsonb_build_object('status', 'invalid');
  end if;

  insert into public.auth_refresh_token_history (
    session_id, refresh_family_id, token_hash, expires_at
  )
  values (
    session_row.id,
    session_row.refresh_family_id,
    session_row.refresh_token_hash,
    session_row.refresh_expires_at
  );

  update public.auth_sessions
  set refresh_token_hash = p_next_token_hash,
      latest_access_expires_at = p_next_access_expires_at,
      last_seen_at = now(),
      version = version + 1
  where id = session_row.id;

  perform public.task4_record_auth_security_event(
    'refresh_success',
    'success',
    session_row.principal_type,
    coalesce(session_row.admin_user_id, session_row.staff_access_id),
    session_row.id,
    session_row.tenant_id,
    session_row.property_id,
    p_request_id,
    '{}'::jsonb
  );

  return (validation - 'version') || jsonb_build_object(
    'status', 'rotated',
    'version', session_row.version + 1,
    'latest_access_expires_at', p_next_access_expires_at
  );
end;
$task4$;

create function public.task4_revoke_auth_session(
  p_session_id uuid,
  p_principal_type text,
  p_principal_id bigint,
  p_reason text default 'logout',
  p_request_id text default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $task4$
declare
  session_row public.auth_sessions%rowtype;
  normalized_reason text := lower(btrim(coalesce(p_reason, '')));
begin
  if normalized_reason not in (
    'logout',
    'admin_revoke',
    'security_change'
  ) then
    raise exception 'TASK4_SESSION_REVOKE_REASON_INVALID';
  end if;

  select *
  into session_row
  from public.auth_sessions
  where id = p_session_id
    and principal_type = p_principal_type
    and (
      (p_principal_type = 'platform_admin' and admin_user_id = p_principal_id)
      or
      (p_principal_type = 'hotel_staff' and staff_access_id = p_principal_id)
    )
  for update;

  if not found then
    return false;
  end if;

  if session_row.revoked_at is null then
    update public.auth_sessions
    set revoked_at = now(),
        revoke_reason = normalized_reason,
        version = version + 1
    where id = session_row.id;

    perform public.task4_record_auth_security_event(
      case when normalized_reason = 'logout'
        then 'logout' else 'session_revoke' end,
      'success',
      session_row.principal_type,
      coalesce(session_row.admin_user_id, session_row.staff_access_id),
      session_row.id,
      session_row.tenant_id,
      session_row.property_id,
      p_request_id,
      jsonb_build_object('reason', normalized_reason)
    );
  end if;

  return true;
end;
$task4$;

create function public.task4_revoke_principal_sessions(
  p_principal_type text,
  p_principal_id bigint,
  p_reason text,
  p_request_id text default null
)
returns bigint
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $task4$
declare
  normalized_reason text := lower(btrim(coalesce(p_reason, '')));
  revoked_count bigint;
  event_name text;
begin
  if p_principal_type not in ('platform_admin', 'hotel_staff')
     or p_principal_id is null
     or p_principal_id <= 0 then
    raise exception 'TASK4_PRINCIPAL_REVOKE_IDENTITY_INVALID';
  end if;

  if normalized_reason not in (
    'logout_all', 'principal_inactive', 'credential_changed',
    'role_changed', 'kds_role_changed', 'tenant_context_changed',
    'account_deleted', 'admin_revoke', 'security_change'
  ) then
    raise exception 'TASK4_PRINCIPAL_REVOKE_REASON_INVALID';
  end if;

  update public.auth_sessions
  set revoked_at = now(),
      revoke_reason = normalized_reason,
      version = version + 1
  where principal_type = p_principal_type
    and revoked_at is null
    and (
      (p_principal_type = 'platform_admin' and admin_user_id = p_principal_id)
      or
      (p_principal_type = 'hotel_staff' and staff_access_id = p_principal_id)
    );
  get diagnostics revoked_count = row_count;

  if revoked_count > 0 then
    event_name := case
      when normalized_reason in ('role_changed', 'kds_role_changed')
        then 'role_change'
      when normalized_reason = 'principal_inactive'
        and p_principal_type = 'hotel_staff'
        then 'staff_disable'
      when normalized_reason = 'credential_changed'
        then 'credential_change'
      when normalized_reason = 'account_deleted'
        then 'account_delete'
      else 'session_revoke'
    end;

    perform public.task4_record_auth_security_event(
      event_name,
      'success',
      p_principal_type,
      p_principal_id,
      null,
      null,
      null,
      p_request_id,
      jsonb_build_object(
        'reason', normalized_reason,
        'session_count', revoked_count
      )
    );
  end if;

  return revoked_count;
end;
$task4$;


create function public.task4_get_admin_login_principal(
  p_email text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $task4$
declare
  normalized_email text := lower(btrim(coalesce(p_email, '')));
  result jsonb;
begin
  if length(normalized_email) < 3 or length(normalized_email) > 320 then
    return null;
  end if;

  select jsonb_build_object(
    'principal_id', admin_user.id,
    'email', admin_user.email,
    'full_name', coalesce(admin_user.full_name, ''),
    'password_hash', admin_user.password_hash
  )
  into result
  from public.admin_users as admin_user
  where admin_user.email = normalized_email
    and admin_user.is_active is true
  limit 1;

  return result;
end;
$task4$;

create function public.task4_get_staff_login_candidates(
  p_hotel_slug text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $task4$
declare
  normalized_slug text := lower(btrim(coalesce(p_hotel_slug, '')));
  result jsonb;
begin
  if normalized_slug !~ '^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$' then
    return '[]'::jsonb;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'principal_id', staff_user.id,
        'hotel_slug', hotel.slug,
        'display_name', staff_user.display_name,
        'role', staff_user.role,
        'kds_role', staff_user.kds_role,
        'tenant_id', staff_user.tenant_id,
        'property_id', staff_user.property_id,
        'pin_hash', staff_user.pin_hash
      )
      order by staff_user.id
    ),
    '[]'::jsonb
  )
  into result
  from public.hotel_staff_access as staff_user
  join public.hotels as hotel
    on hotel.tenant_id = staff_user.tenant_id
   and hotel.id = staff_user.property_id
   and hotel.slug = staff_user.hotel_slug
  join public.tenants as tenant
    on tenant.id = staff_user.tenant_id
  where staff_user.hotel_slug = normalized_slug
    and staff_user.is_active is true
    and hotel.is_active is true
    and tenant.status = 'active';

  return result;
end;
$task4$;

create function public.task4_record_auth_security_event(
  p_event_type text,
  p_outcome text,
  p_principal_type text default null,
  p_principal_id bigint default null,
  p_session_id uuid default null,
  p_tenant_id uuid default null,
  p_property_id bigint default null,
  p_request_id text default null,
  p_safe_context jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $task4$
declare
  event_id uuid := gen_random_uuid();
  normalized_event text := lower(btrim(coalesce(p_event_type, '')));
  normalized_outcome text := lower(btrim(coalesce(p_outcome, '')));
  normalized_request_id text := nullif(btrim(coalesce(p_request_id, '')), '');
  normalized_context jsonb := coalesce(p_safe_context, '{}'::jsonb);
begin
  if normalized_event not in (
    'login_success', 'login_failure', 'refresh_success', 'refresh_replay',
    'logout', 'session_revoke', 'role_change', 'staff_disable',
    'credential_change', 'account_delete', 'privileged_denied'
  ) then
    raise exception 'TASK4_AUTH_EVENT_TYPE_INVALID';
  end if;

  if normalized_outcome not in ('success', 'failure', 'denied') then
    raise exception 'TASK4_AUTH_EVENT_OUTCOME_INVALID';
  end if;

  if p_principal_type is not null
     and p_principal_type not in ('platform_admin', 'hotel_staff') then
    raise exception 'TASK4_AUTH_EVENT_PRINCIPAL_TYPE_INVALID';
  end if;
  if p_principal_id is not null and p_principal_id <= 0 then
    raise exception 'TASK4_AUTH_EVENT_PRINCIPAL_ID_INVALID';
  end if;
  if (p_tenant_id is null) <> (p_property_id is null) then
    raise exception 'TASK4_AUTH_EVENT_TENANT_SHAPE_INVALID';
  end if;
  if normalized_request_id is not null
     and length(normalized_request_id) > 160 then
    raise exception 'TASK4_AUTH_EVENT_REQUEST_ID_INVALID';
  end if;
  if jsonb_typeof(normalized_context) <> 'object'
     or octet_length(normalized_context::text) > 4096 then
    raise exception 'TASK4_AUTH_EVENT_CONTEXT_INVALID';
  end if;
  if normalized_context::text ~*
    '"[^"]*(password|pin|token|authorization|cookie|secret|email|phone)[^"]*"[[:space:]]*:'
  then
    raise exception 'TASK4_AUTH_EVENT_CONTEXT_FORBIDDEN_KEY';
  end if;

  insert into public.auth_security_events (
    id, event_type, outcome, principal_type, principal_id, session_id,
    tenant_id, property_id, request_id, safe_context
  )
  values (
    event_id, normalized_event, normalized_outcome, p_principal_type,
    p_principal_id, p_session_id, p_tenant_id, p_property_id,
    normalized_request_id, normalized_context
  );

  return event_id;
end;
$task4$;

create function public.task4_create_auth_session(
  p_session_id uuid,
  p_principal_type text,
  p_principal_id bigint,
  p_refresh_family_id uuid,
  p_refresh_token_hash bytea,
  p_access_expires_at timestamptz,
  p_refresh_expires_at timestamptz,
  p_user_agent_hash bytea default null,
  p_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $task4$
declare
  principal jsonb;
  principal_tenant_id uuid;
  principal_property_id bigint;
  principal_role text;
  principal_kds_role text;
begin
  if p_session_id is null or p_refresh_family_id is null then
    raise exception 'TASK4_SESSION_IDENTIFIERS_REQUIRED';
  end if;
  if p_principal_type not in ('platform_admin', 'hotel_staff')
     or p_principal_id is null
     or p_principal_id <= 0 then
    raise exception 'TASK4_SESSION_PRINCIPAL_INVALID';
  end if;
  if p_refresh_token_hash is null
     or octet_length(p_refresh_token_hash) <> 32 then
    raise exception 'TASK4_SESSION_REFRESH_HASH_INVALID';
  end if;
  if p_user_agent_hash is not null
     and octet_length(p_user_agent_hash) <> 32 then
    raise exception 'TASK4_SESSION_USER_AGENT_HASH_INVALID';
  end if;
  if p_access_expires_at <= now()
     or p_access_expires_at > now() + interval '20 minutes' then
    raise exception 'TASK4_SESSION_ACCESS_EXPIRY_INVALID';
  end if;
  if p_refresh_expires_at <= p_access_expires_at
     or p_refresh_expires_at > now() + interval '8 days' then
    raise exception 'TASK4_SESSION_REFRESH_EXPIRY_INVALID';
  end if;
  if exists (
    select 1
    from public.auth_refresh_token_history
    where token_hash = p_refresh_token_hash
  ) then
    raise exception 'TASK4_SESSION_REFRESH_HASH_COLLISION';
  end if;

  principal := public.task4_resolve_auth_principal(
    p_principal_type,
    p_principal_id
  );
  if principal is null then
    raise exception 'TASK4_SESSION_PRINCIPAL_INACTIVE';
  end if;

  if p_principal_type = 'hotel_staff' then
    principal_tenant_id := (principal ->> 'tenant_id')::uuid;
    principal_property_id := (principal ->> 'property_id')::bigint;
    principal_role := principal ->> 'role';
    principal_kds_role := principal ->> 'kds_role';
  end if;

  insert into public.auth_sessions (
    id, principal_type, admin_user_id, staff_access_id, tenant_id,
    property_id, role_snapshot, kds_role_snapshot, refresh_family_id,
    refresh_token_hash, latest_access_expires_at, refresh_expires_at,
    user_agent_hash
  )
  values (
    p_session_id,
    p_principal_type,
    case when p_principal_type = 'platform_admin'
      then p_principal_id else null end,
    case when p_principal_type = 'hotel_staff'
      then p_principal_id else null end,
    principal_tenant_id,
    principal_property_id,
    principal_role,
    principal_kds_role,
    p_refresh_family_id,
    p_refresh_token_hash,
    p_access_expires_at,
    p_refresh_expires_at,
    p_user_agent_hash
  );

  perform public.task4_record_auth_security_event(
    'login_success', 'success', p_principal_type, p_principal_id,
    p_session_id, principal_tenant_id, principal_property_id,
    p_request_id, '{}'::jsonb
  );

  return jsonb_build_object(
    'status', 'created',
    'session_id', p_session_id,
    'refresh_family_id', p_refresh_family_id,
    'version', 1
  ) || principal;
end;
$task4$;

-- Remove default PUBLIC execute grants before ownership transfer.
revoke all privileges on function public.task4_resolve_auth_principal(text,bigint)
  from public, anon, authenticated, service_role, app_tenant_runtime,
    app_tenant_rpc_owner;
revoke all privileges on function public.task4_get_admin_login_principal(text)
  from public, anon, authenticated, service_role, app_tenant_runtime,
    app_tenant_rpc_owner;
revoke all privileges on function public.task4_get_staff_login_candidates(text)
  from public, anon, authenticated, service_role, app_tenant_runtime,
    app_tenant_rpc_owner;
revoke all privileges on function public.task4_record_auth_security_event(
  text,text,text,bigint,uuid,uuid,bigint,text,jsonb
)
  from public, anon, authenticated, service_role, app_tenant_runtime,
    app_tenant_rpc_owner;
revoke all privileges on function public.task4_create_auth_session(
  uuid,text,bigint,uuid,bytea,timestamptz,timestamptz,bytea,text
)
  from public, anon, authenticated, service_role, app_tenant_runtime,
    app_tenant_rpc_owner;
revoke all privileges on function public.task4_validate_auth_session(
  uuid,text,bigint
)
  from public, anon, authenticated, service_role, app_tenant_runtime,
    app_tenant_rpc_owner;
revoke all privileges on function public.task4_rotate_auth_refresh(
  uuid,text,bigint,bytea,bytea,timestamptz,text
)
  from public, anon, authenticated, service_role, app_tenant_runtime,
    app_tenant_rpc_owner;
revoke all privileges on function public.task4_revoke_auth_session(
  uuid,text,bigint,text,text
)
  from public, anon, authenticated, service_role, app_tenant_runtime,
    app_tenant_rpc_owner;
revoke all privileges on function public.task4_revoke_principal_sessions(
  text,bigint,text,text
)
  from public, anon, authenticated, service_role, app_tenant_runtime,
    app_tenant_rpc_owner;

alter function public.task4_resolve_auth_principal(text,bigint)
  owner to app_auth_rpc_owner;
alter function public.task4_get_admin_login_principal(text)
  owner to app_auth_rpc_owner;
alter function public.task4_get_staff_login_candidates(text)
  owner to app_auth_rpc_owner;
alter function public.task4_record_auth_security_event(
  text,text,text,bigint,uuid,uuid,bigint,text,jsonb
)
  owner to app_auth_rpc_owner;
alter function public.task4_create_auth_session(
  uuid,text,bigint,uuid,bytea,timestamptz,timestamptz,bytea,text
)
  owner to app_auth_rpc_owner;
alter function public.task4_validate_auth_session(uuid,text,bigint)
  owner to app_auth_rpc_owner;
alter function public.task4_rotate_auth_refresh(
  uuid,text,bigint,bytea,bytea,timestamptz,text
)
  owner to app_auth_rpc_owner;
alter function public.task4_revoke_auth_session(
  uuid,text,bigint,text,text
)
  owner to app_auth_rpc_owner;
alter function public.task4_revoke_principal_sessions(
  text,bigint,text,text
)
  owner to app_auth_rpc_owner;

set local role app_auth_rpc_owner;

grant execute on function public.task4_get_admin_login_principal(text)
  to app_tenant_runtime;
grant execute on function public.task4_get_staff_login_candidates(text)
  to app_tenant_runtime;
grant execute on function public.task4_record_auth_security_event(
  text,text,text,bigint,uuid,uuid,bigint,text,jsonb
)
  to app_tenant_runtime;
grant execute on function public.task4_create_auth_session(
  uuid,text,bigint,uuid,bytea,timestamptz,timestamptz,bytea,text
)
  to app_tenant_runtime;
grant execute on function public.task4_validate_auth_session(
  uuid,text,bigint
)
  to app_tenant_runtime;
grant execute on function public.task4_rotate_auth_refresh(
  uuid,text,bigint,bytea,bytea,timestamptz,text
)
  to app_tenant_runtime;
grant execute on function public.task4_revoke_auth_session(
  uuid,text,bigint,text,text
)
  to app_tenant_runtime;
grant execute on function public.task4_revoke_principal_sessions(
  text,bigint,text,text
)
  to app_tenant_runtime;

reset role;

revoke create on schema public from app_auth_rpc_owner;

do $task4_membership_cleanup$
begin
  execute format(
    'revoke app_auth_rpc_owner from %I granted by %I restrict',
    current_user,
    current_user
  );
end;
$task4_membership_cleanup$;

do $task4_guard$
declare
  bad_count bigint;
  runtime_policy_count bigint;
begin
  select count(*) into bad_count
  from pg_roles
  where rolname = 'app_auth_rpc_owner'
    and (
      rolcanlogin or rolsuper or rolcreatedb or rolcreaterole
      or rolinherit or rolreplication or rolbypassrls
    );
  if bad_count <> 0 then
    raise exception 'TASK4_AUTH_RPC_OWNER_UNSAFE';
  end if;

  select count(*) into bad_count
  from pg_auth_members m
  where m.roleid = (
    select oid from pg_roles where rolname = 'app_auth_rpc_owner'
  )
    and (m.inherit_option or m.set_option);
  if bad_count <> 0 then
    raise exception 'TASK4_AUTH_RPC_OWNER_MEMBERSHIP_UNSAFE count=%',
      bad_count;
  end if;

  select count(*) into bad_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in (
      'auth_sessions',
      'auth_refresh_token_history',
      'auth_security_events'
    )
    and c.relkind in ('r', 'p')
    and (not c.relrowsecurity or not c.relforcerowsecurity);
  if bad_count <> 0 then
    raise exception 'TASK4_AUTH_TABLE_RLS_UNSAFE count=%', bad_count;
  end if;

  select count(*) into bad_count
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in (
      'auth_sessions',
      'auth_refresh_token_history',
      'auth_security_events'
    )
    and grantee in (
      'PUBLIC',
      'anon',
      'authenticated',
      'service_role',
      'app_tenant_runtime',
      'app_tenant_rpc_owner'
    );
  if bad_count <> 0 then
    raise exception 'TASK4_AUTH_TABLE_DIRECT_GRANT_UNSAFE count=%',
      bad_count;
  end if;

  select count(*) into bad_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles owner_role on owner_role.oid = p.proowner
  where n.nspname = 'public'
    and p.proname in (
      'task4_get_admin_login_principal',
      'task4_get_staff_login_candidates',
      'task4_record_auth_security_event',
      'task4_create_auth_session',
      'task4_validate_auth_session',
      'task4_rotate_auth_refresh',
      'task4_revoke_auth_session',
      'task4_revoke_principal_sessions'
    )
    and (
      owner_role.rolname <> 'app_auth_rpc_owner'
      or owner_role.rolbypassrls
      or not p.prosecdef
    );
  if bad_count <> 0 then
    raise exception 'TASK4_AUTH_RPC_DEFINITION_UNSAFE count=%', bad_count;
  end if;

  select count(*) into bad_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral aclexplode(
    coalesce(p.proacl, acldefault('f', p.proowner))
  ) acl
  left join pg_roles granted_role on granted_role.oid = acl.grantee
  where n.nspname = 'public'
    and p.proname in (
      'task4_resolve_auth_principal',
      'task4_get_admin_login_principal',
      'task4_get_staff_login_candidates',
      'task4_record_auth_security_event',
      'task4_create_auth_session',
      'task4_validate_auth_session',
      'task4_rotate_auth_refresh',
      'task4_revoke_auth_session',
      'task4_revoke_principal_sessions'
    )
    and acl.privilege_type = 'EXECUTE'
    and (
      acl.grantee = 0
      or granted_role.rolname in (
        'anon',
        'authenticated',
        'service_role',
        'app_tenant_rpc_owner'
      )
    );
  if bad_count <> 0 then
    raise exception 'TASK4_AUTH_RPC_EXECUTE_GRANT_UNSAFE count=%',
      bad_count;
  end if;

  select count(*) into runtime_policy_count
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and (
      select oid from pg_roles where rolname = 'app_tenant_runtime'
    ) = any(p.polroles);
  if runtime_policy_count <> 199 then
    raise exception
      'TASK4_TASK3_RUNTIME_POLICY_COUNT_CHANGED expected=199 actual=%',
      runtime_policy_count;
  end if;
end;
$task4_guard$;

commit;

-- Rollback is intentionally not automated. These objects are dormant until
-- Task 4 feature flags are enabled. If deployment is abandoned before use,
-- review retained audit/session evidence before removing any object.


