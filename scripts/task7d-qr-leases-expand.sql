-- Task 7D QR delivery leasing expansion. MANUAL REVIEW/APPLICATION ONLY.
-- Disabled by default. Adds private state; never replays old events or changes
-- payment RPCs, financial triggers, business rows or existing tenant grants.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';
do $preflight$
begin
  if current_user <> 'postgres' then raise exception 'TASK7D_OPERATOR_REQUIRED'; end if;
  if not exists(select 1 from pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then
    raise exception 'TASK7D_DEFINER_FORCE_RLS_CAPABILITY_REQUIRED';
  end if;
  if to_regclass('public.task7d_qr_delivery_state') is not null
    or to_regclass('public.task7d_qr_worker_control') is not null
    or to_regclass('public.task7d_qr_delivery_attempts') is not null then
    raise exception 'TASK7D_ALREADY_PRESENT_REVIEW_VERIFY_INSTEAD';
  end if;
  if not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='qr_event_outbox' and c.relrowsecurity and c.relforcerowsecurity)
    or not exists(select 1 from pg_roles where rolname='service_role') then
    raise exception 'TASK7D_SOURCE_OR_ROLE_PRECONDITION_FAILED';
  end if;
end $preflight$;

create table public.task7d_qr_worker_control (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false,
  min_event_id bigint check(min_event_id > 0),
  activated_at timestamptz,
  schema_version integer not null default 1 check(schema_version=1)
);
insert into public.task7d_qr_worker_control(singleton) values(true);

create table public.task7d_qr_delivery_state (
  event_id bigint primary key references public.qr_event_outbox(id),
  tenant_id uuid not null,
  property_id bigint not null,
  status text not null default 'READY' check(status in ('READY','PROCESSING','SUCCEEDED','DEAD_LETTER')),
  attempt_count integer not null default 0 check(attempt_count between 0 and 12),
  claim_version bigint not null default 0 check(claim_version >= 0),
  lease_owner uuid,
  lease_until timestamptz,
  heartbeat_at timestamptz,
  available_at timestamptz not null default now(),
  dead_lettered_at timestamptz,
  last_error_code text check(last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{0,95}$'),
  replay_count integer not null default 0 check(replay_count >= 0),
  updated_at timestamptz not null default now(),
  unique(event_id,tenant_id,property_id),
  foreign key(tenant_id,property_id) references public.hotels(tenant_id,id),
  check((status='PROCESSING' and lease_owner is not null and lease_until is not null)
    or (status<>'PROCESSING' and lease_owner is null and lease_until is null)),
  check((status='DEAD_LETTER')=(dead_lettered_at is not null))
);
create index task7d_qr_delivery_ready_idx on public.task7d_qr_delivery_state(available_at,event_id)
  where status in ('READY','PROCESSING');
create table public.task7d_qr_delivery_attempts (
  event_id bigint not null,
  claim_version bigint not null,
  tenant_id uuid not null,
  property_id bigint not null,
  lease_owner uuid not null,
  attempt_number integer not null check(attempt_number between 1 and 12),
  replay_number integer not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text not null default 'PROCESSING' check(outcome in ('PROCESSING','SUCCEEDED','RETRY','DEAD_LETTER','LEASE_EXPIRED')),
  error_code text check(error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{0,95}$'),
  primary key(event_id,claim_version),
  foreign key(event_id,tenant_id,property_id) references public.task7d_qr_delivery_state(event_id,tenant_id,property_id)
);
alter table public.task7d_qr_worker_control enable row level security;
alter table public.task7d_qr_worker_control force row level security;
alter table public.task7d_qr_delivery_state enable row level security;
alter table public.task7d_qr_delivery_state force row level security;
alter table public.task7d_qr_delivery_attempts enable row level security;
alter table public.task7d_qr_delivery_attempts force row level security;
revoke all on public.task7d_qr_worker_control,public.task7d_qr_delivery_state,public.task7d_qr_delivery_attempts
  from public,anon,authenticated,app_tenant_runtime,app_tenant_rpc_owner,service_role;

-- Operator-only cutover: preserve initial high-water mark across pause/resume.
-- All old QR senders must be quiesced before this is manually enabled.
create function public.task7d_configure_qr_delivery(p_enabled boolean)
returns jsonb language plpgsql set search_path=pg_catalog,public as $fn$
declare v_control public.task7d_qr_worker_control%rowtype; v_min bigint;
begin
  if current_user <> 'postgres' then raise exception 'TASK7D_OPERATOR_REQUIRED'; end if;
  select * into strict v_control from public.task7d_qr_worker_control where singleton for update;
  if exists(select 1 from public.task7d_qr_delivery_state where status='PROCESSING' and lease_until>clock_timestamp()) then
    raise exception 'TASK7D_ACTIVE_SENDERS_MUST_DRAIN';
  end if;
  if p_enabled and v_control.min_event_id is null then
    lock table public.qr_event_outbox in share row exclusive mode;
    select coalesce(max(id),0)+1 into v_min from public.qr_event_outbox;
  else v_min := v_control.min_event_id;
  end if;
  update public.task7d_qr_worker_control set enabled=p_enabled,min_event_id=v_min,
    activated_at=case when p_enabled then coalesce(activated_at,clock_timestamp()) else activated_at end where singleton;
  return jsonb_build_object('enabled',p_enabled,'min_event_id',v_min::text,'schema_version',1);
end $fn$;

create function public.task7d_qr_delivery_readiness()
returns jsonb language sql security definer set search_path=pg_catalog,public as $fn$
  select jsonb_build_object('schema_version',schema_version,'enabled',enabled,'min_event_id',min_event_id::text)
  from public.task7d_qr_worker_control where singleton
$fn$;

create function public.task7d_claim_qr_delivery(p_lease_owner uuid,p_lease_seconds integer default 60)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $fn$
declare s public.task7d_qr_delivery_state%rowtype; v_event public.qr_event_outbox%rowtype; v_floor bigint; v_now timestamptz:=clock_timestamp();
begin
  if p_lease_owner is null or p_lease_seconds is null or p_lease_seconds not between 30 and 300 then raise exception 'TASK7D_LEASE_ARGUMENT_INVALID'; end if;
  select min_event_id into v_floor from public.task7d_qr_worker_control where singleton and enabled for share;
  if v_floor is null then return null; end if;
  insert into public.task7d_qr_delivery_state(event_id,tenant_id,property_id,available_at)
    select q.id,q.tenant_id,q.property_id,q.next_attempt_at from public.qr_event_outbox q
    join public.hotels h on h.id=q.property_id and h.tenant_id=q.tenant_id and h.slug=q.hotel_slug
    join public.orders o on o.id::text=q.aggregate_id and o.tenant_id=q.tenant_id and o.property_id=q.property_id and o.hotel_slug=q.hotel_slug
    where q.id>=v_floor and q.published_at is null and q.aggregate_type='order'
      and not exists(select 1 from public.task7d_qr_delivery_state d where d.event_id=q.id)
    order by q.id limit 25 on conflict(event_id) do nothing;

  -- Expired last attempts become visible dead letters without a thirteenth send.
  with expired_candidates as (
    select event_id from public.task7d_qr_delivery_state
    where status='PROCESSING' and lease_until<=clock_timestamp() and attempt_count>=12
    order by event_id for update skip locked limit 25
  ), expired as (
    update public.task7d_qr_delivery_state d set status='DEAD_LETTER',dead_lettered_at=v_now,
      lease_owner=null,lease_until=null,last_error_code='QR_LEASE_EXPIRED_AT_MAX',updated_at=v_now
    from expired_candidates x where d.event_id=x.event_id returning d.event_id,d.claim_version,d.tenant_id,d.property_id
  ), audit as (
    update public.task7d_qr_delivery_attempts a set finished_at=v_now,outcome='DEAD_LETTER',error_code='QR_LEASE_EXPIRED_AT_MAX'
    from expired x where a.event_id=x.event_id and a.claim_version=x.claim_version returning a.event_id
  ) update public.qr_event_outbox q set next_attempt_at='9999-12-31 00:00:00+00',last_error='QR_LEASE_EXPIRED_AT_MAX'
    from expired x where q.id=x.event_id and q.tenant_id=x.tenant_id and q.property_id=x.property_id and q.published_at is null;

  select d.* into s from public.task7d_qr_delivery_state d join public.qr_event_outbox q on q.id=d.event_id
    join public.hotels h on h.id=d.property_id and h.tenant_id=d.tenant_id and h.slug=q.hotel_slug
    join public.orders o on o.id::text=q.aggregate_id and o.tenant_id=d.tenant_id and o.property_id=d.property_id and o.hotel_slug=q.hotel_slug
    where d.event_id>=v_floor and q.published_at is null and q.tenant_id=d.tenant_id and q.property_id=d.property_id
      and d.status in ('READY','PROCESSING') and d.attempt_count<12 and d.available_at<=v_now
      and (d.lease_until is null or d.lease_until<=clock_timestamp())
    order by d.available_at,d.event_id for update of d,q skip locked limit 1;
  if not found then return null; end if;
  v_now:=clock_timestamp();
  if s.status='PROCESSING' then
    update public.task7d_qr_delivery_attempts set finished_at=v_now,outcome='LEASE_EXPIRED',error_code='QR_LEASE_EXPIRED'
      where event_id=s.event_id and claim_version=s.claim_version;
  end if;
  update public.task7d_qr_delivery_state set status='PROCESSING',attempt_count=attempt_count+1,claim_version=claim_version+1,
    lease_owner=p_lease_owner,lease_until=v_now+make_interval(secs=>p_lease_seconds),heartbeat_at=v_now,last_error_code=null,updated_at=v_now
    where event_id=s.event_id returning * into s;
  insert into public.task7d_qr_delivery_attempts(event_id,claim_version,tenant_id,property_id,lease_owner,attempt_number,replay_number)
    values(s.event_id,s.claim_version,s.tenant_id,s.property_id,p_lease_owner,s.attempt_count,s.replay_count);
  update public.qr_event_outbox set attempt_count=least(attempt_count,2147483645)+1,
    next_attempt_at=s.lease_until,last_error=null where id=s.event_id and tenant_id=s.tenant_id and property_id=s.property_id and published_at is null returning * into v_event;
  return jsonb_build_object('event',to_jsonb(v_event)||jsonb_build_object('id',v_event.id::text,'property_id',v_event.property_id::text),
    'lease',jsonb_build_object('owner',p_lease_owner,'version',s.claim_version::text,'until',s.lease_until));
end $fn$;

create function public.task7d_renew_qr_delivery(p_event_id bigint,p_lease_owner uuid,p_claim_version bigint,p_lease_seconds integer default 60)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $fn$
declare s public.task7d_qr_delivery_state%rowtype;
begin
  if p_lease_seconds is null or p_lease_seconds not between 30 and 300 then return false; end if;
  select * into s from public.task7d_qr_delivery_state
    where event_id=p_event_id and lease_owner=p_lease_owner and claim_version=p_claim_version and status='PROCESSING' for update;
  if not found then return false; end if;
  perform 1 from public.qr_event_outbox where id=s.event_id and tenant_id=s.tenant_id and property_id=s.property_id and published_at is null for share;
  if not found or s.lease_until<=clock_timestamp() then return false; end if;
  update public.task7d_qr_delivery_state d set lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),heartbeat_at=clock_timestamp(),updated_at=clock_timestamp()
    where d.event_id=p_event_id and d.lease_owner=p_lease_owner and d.claim_version=p_claim_version
      and d.status='PROCESSING' and d.lease_until>clock_timestamp()
      and exists(select 1 from public.qr_event_outbox q where q.id=d.event_id and q.tenant_id=d.tenant_id and q.property_id=d.property_id and q.published_at is null);
  return found;
end $fn$;

create function public.task7d_complete_qr_delivery(p_event_id bigint,p_lease_owner uuid,p_claim_version bigint,p_success boolean,p_error_code text default null)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $fn$
declare s public.task7d_qr_delivery_state%rowtype; v_now timestamptz:=clock_timestamp(); v_code text; v_delay double precision;
begin
  if p_success is null then return false; end if;
  select * into s from public.task7d_qr_delivery_state where event_id=p_event_id and lease_owner=p_lease_owner
    and claim_version=p_claim_version and status='PROCESSING' and lease_until>v_now for update;
  if not found then return false; end if;
  v_now:=clock_timestamp();
  if s.lease_until<=v_now then return false; end if;
  perform 1 from public.qr_event_outbox q where q.id=s.event_id and q.tenant_id=s.tenant_id and q.property_id=s.property_id and q.published_at is null for update;
  if not found then return false; end if;
  v_now:=clock_timestamp();
  if s.lease_until<=v_now then return false; end if;
  v_code:=case when p_error_code ~ '^[A-Z][A-Z0-9_]{0,95}$' then p_error_code else 'QR_DELIVERY_ERROR' end;
  v_delay:=greatest(5,least(300,5*power(2,least(6,s.attempt_count-1))*(0.8+random()*0.4)));
  update public.task7d_qr_delivery_state set status=case when p_success then 'SUCCEEDED' when s.attempt_count>=12 then 'DEAD_LETTER' else 'READY' end,
    lease_owner=null,lease_until=null,dead_lettered_at=case when not p_success and s.attempt_count>=12 then v_now else null end,
    available_at=case when p_success then v_now else v_now+make_interval(secs=>v_delay) end,
    last_error_code=case when p_success then null else v_code end,updated_at=v_now where event_id=s.event_id;
  update public.task7d_qr_delivery_attempts set finished_at=v_now,
    outcome=case when p_success then 'SUCCEEDED' when s.attempt_count>=12 then 'DEAD_LETTER' else 'RETRY' end,
    error_code=case when p_success then null else v_code end where event_id=s.event_id and claim_version=s.claim_version;
  update public.qr_event_outbox set published_at=case when p_success then v_now else published_at end,
    next_attempt_at=case when p_success then v_now when s.attempt_count>=12 then '9999-12-31 00:00:00+00'::timestamptz else v_now+make_interval(secs=>v_delay) end,
    last_error=case when p_success then null else v_code end where id=s.event_id and tenant_id=s.tenant_id and property_id=s.property_id and published_at is null;
  return true;
end $fn$;

-- Exact-ID operator replay only; never replay a pre-cutover/historical source.
create function public.task7d_replay_qr_delivery(p_event_id bigint,p_expected_version bigint)
returns boolean language plpgsql set search_path=pg_catalog,public as $fn$
declare s public.task7d_qr_delivery_state%rowtype;
begin
  if current_user <> 'postgres' then raise exception 'TASK7D_OPERATOR_REQUIRED'; end if;
  select * into s from public.task7d_qr_delivery_state where event_id=p_event_id and status='DEAD_LETTER' and claim_version=p_expected_version for update;
  if not found or not exists(select 1 from public.task7d_qr_worker_control where singleton and enabled and p_event_id>=min_event_id) then return false; end if;
  perform 1 from public.qr_event_outbox q join public.hotels h on h.id=q.property_id and h.tenant_id=q.tenant_id and h.slug=q.hotel_slug
    join public.orders o on o.id::text=q.aggregate_id and o.tenant_id=q.tenant_id and o.property_id=q.property_id and o.hotel_slug=q.hotel_slug
    where q.id=s.event_id and q.tenant_id=s.tenant_id and q.property_id=s.property_id and q.published_at is null for update of q;
  if not found then return false; end if;
  update public.task7d_qr_delivery_state set status='READY',attempt_count=0,replay_count=replay_count+1,dead_lettered_at=null,
    last_error_code=null,available_at=clock_timestamp(),updated_at=clock_timestamp() where event_id=s.event_id;
  update public.qr_event_outbox set next_attempt_at=clock_timestamp(),last_error=null where id=s.event_id and tenant_id=s.tenant_id and property_id=s.property_id and published_at is null;
  return true;
end $fn$;

revoke all on function public.task7d_configure_qr_delivery(boolean),public.task7d_replay_qr_delivery(bigint,bigint)
  from public,anon,authenticated,service_role,app_tenant_runtime,app_tenant_rpc_owner;
revoke all on function public.task7d_qr_delivery_readiness(),public.task7d_claim_qr_delivery(uuid,integer),
  public.task7d_renew_qr_delivery(bigint,uuid,bigint,integer),public.task7d_complete_qr_delivery(bigint,uuid,bigint,boolean,text)
  from public,anon,authenticated,app_tenant_runtime,app_tenant_rpc_owner,service_role;
grant execute on function public.task7d_qr_delivery_readiness(),public.task7d_claim_qr_delivery(uuid,integer),
  public.task7d_renew_qr_delivery(bigint,uuid,bigint,integer),public.task7d_complete_qr_delivery(bigint,uuid,bigint,boolean,text) to service_role;
commit;
