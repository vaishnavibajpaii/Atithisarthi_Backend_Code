-- MANUAL TEST EXPANSION ONLY. Disabled exact-ID gate; no queue scan or send.
-- Existing business/payment/notification producer functions and grants unchanged.
begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
do $preflight$
begin
  if current_user<>'postgres' then raise exception 'TASK7D_OPERATOR_REQUIRED'; end if;
  if not exists(select 1 from pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then raise exception 'TASK7D_DEFINER_FORCE_RLS_CAPABILITY_REQUIRED'; end if;
  if to_regclass('public.task7d_notification_worker_control') is not null
    or to_regclass('public.task7d_notification_delivery_state') is not null
    or to_regclass('public.task7d_notification_delivery_attempts') is not null then raise exception 'TASK7D_NOTIFICATION_ALREADY_PRESENT_REVIEW_VERIFY_INSTEAD'; end if;
  if not exists(select 1 from pg_class where oid='public.notification_events'::regclass and relrowsecurity and relforcerowsecurity)
    or not exists(select 1 from pg_roles where rolname='service_role') then raise exception 'TASK7D_NOTIFICATION_SOURCE_OR_ROLE_PRECONDITION_FAILED'; end if;
end $preflight$;

create table public.task7d_notification_worker_control (
  singleton boolean primary key default true check(singleton),enabled boolean not null default false,
  min_event_id bigint check(min_event_id>0),activated_at timestamptz,
  schema_version integer not null default 1 check(schema_version=1)
);
insert into public.task7d_notification_worker_control(singleton) values(true);
create table public.task7d_notification_delivery_state (
  event_id bigint primary key references public.notification_events(id),
  tenant_id uuid not null,property_id bigint not null,hotel_slug text not null,
  source_type text not null,source_id text not null,event_type text not null,
  status text not null default 'READY' check(status in ('READY','PROCESSING','SUCCEEDED','DEAD_LETTER')),
  attempt_count integer not null default 0 check(attempt_count between 0 and 12),
  claim_version bigint not null default 0 check(claim_version>=0),lease_owner uuid,lease_until timestamptz,heartbeat_at timestamptz,
  claimed_status text check(claimed_status in ('pending','failed')),
  claimed_retry_count integer check(claimed_retry_count>=0),
  available_at timestamptz not null default now(),dead_lettered_at timestamptz,
  last_error_code text check(last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{0,95}$'),
  replay_count integer not null default 0 check(replay_count>=0),updated_at timestamptz not null default now(),
  unique(event_id,tenant_id,property_id),foreign key(tenant_id,property_id) references public.hotels(tenant_id,id),
  check((status='PROCESSING' and lease_owner is not null and lease_until is not null and claimed_status is not null and claimed_retry_count is not null)
    or (status<>'PROCESSING' and lease_owner is null and lease_until is null)),
  check((status='DEAD_LETTER')=(dead_lettered_at is not null))
);
create index task7d_notification_delivery_ready_idx on public.task7d_notification_delivery_state(available_at,event_id)
  where status in ('READY','PROCESSING');
create table public.task7d_notification_delivery_attempts (
  event_id bigint not null,claim_version bigint not null,tenant_id uuid not null,property_id bigint not null,
  lease_owner uuid not null,attempt_number integer not null check(attempt_number between 1 and 12),
  replay_number integer not null,admission_mode text not null check(admission_mode in ('auto','admin')),
  started_at timestamptz not null default now(),finished_at timestamptz,
  outcome text not null default 'PROCESSING' check(outcome in ('PROCESSING','SUCCEEDED','SKIPPED','RETRY','DEAD_LETTER','LEASE_EXPIRED')),
  error_code text check(error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{0,95}$'),
  primary key(event_id,claim_version),foreign key(event_id,tenant_id,property_id) references public.task7d_notification_delivery_state(event_id,tenant_id,property_id)
);
alter table public.task7d_notification_worker_control enable row level security;
alter table public.task7d_notification_worker_control force row level security;
alter table public.task7d_notification_delivery_state enable row level security;
alter table public.task7d_notification_delivery_state force row level security;
alter table public.task7d_notification_delivery_attempts enable row level security;
alter table public.task7d_notification_delivery_attempts force row level security;
revoke all on public.task7d_notification_worker_control,public.task7d_notification_delivery_state,public.task7d_notification_delivery_attempts
  from public,anon,authenticated,app_tenant_runtime,app_tenant_rpc_owner,service_role;

create function public.task7d_configure_notification_delivery(p_enabled boolean)
returns jsonb language plpgsql set search_path=pg_catalog,public as $fn$
declare v_control public.task7d_notification_worker_control%rowtype;v_min bigint;
begin
  if current_user<>'postgres' then raise exception 'TASK7D_OPERATOR_REQUIRED'; end if;
  if p_enabled is null then raise exception 'TASK7D_NOTIFICATION_CONFIG_INVALID'; end if;
  select * into strict v_control from public.task7d_notification_worker_control where singleton for update;
  if exists(select 1 from public.task7d_notification_delivery_state where status='PROCESSING' and lease_until>clock_timestamp()) then raise exception 'TASK7D_ACTIVE_SENDERS_MUST_DRAIN'; end if;
  if p_enabled and v_control.min_event_id is null then
    lock table public.notification_events in share row exclusive mode;
    select coalesce(max(id),0)+1 into v_min from public.notification_events;
  else v_min:=v_control.min_event_id; end if;
  update public.task7d_notification_worker_control set enabled=p_enabled,min_event_id=v_min,
    activated_at=case when p_enabled then coalesce(activated_at,clock_timestamp()) else activated_at end where singleton;
  return jsonb_build_object('schema_version',1,'enabled',p_enabled,'min_event_id',v_min::text);
end $fn$;

create function public.task7d_notification_delivery_readiness()
returns jsonb language sql security definer set search_path=pg_catalog,public as $fn$
  select jsonb_build_object('schema_version',schema_version,'enabled',enabled,'min_event_id',min_event_id::text)
    from public.task7d_notification_worker_control where singleton
$fn$;

-- Global lock order: control, exact source, private state. Never scan pending work.
create function public.task7d_claim_notification_delivery(
  p_event_id bigint,p_tenant_id uuid,p_property_id bigint,p_hotel_slug text,p_lease_owner uuid,
  p_mode text,p_expected_status text,p_expected_retry integer,p_lease_seconds integer default 60)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $fn$
declare v_floor bigint;v_event public.notification_events%rowtype;s public.task7d_notification_delivery_state%rowtype;v_now timestamptz;
begin
  if p_event_id is null or p_event_id<1 or p_tenant_id is null or p_property_id is null or p_property_id<1
    or p_hotel_slug is null or btrim(p_hotel_slug)='' or p_hotel_slug<>btrim(p_hotel_slug) or p_lease_owner is null
    or p_mode is null or p_mode not in ('auto','admin') or p_lease_seconds is null or p_lease_seconds not between 30 and 300 then raise exception 'TASK7D_NOTIFICATION_ARGUMENT_INVALID'; end if;
  select min_event_id into v_floor from public.task7d_notification_worker_control where singleton and enabled for share;
  if v_floor is null then return jsonb_build_object('admission','disabled'); end if;
  if p_event_id<v_floor then return jsonb_build_object('admission','historical_excluded'); end if;
  select n.* into v_event from public.notification_events n join public.hotels h on h.id=n.property_id and h.tenant_id=n.tenant_id and h.slug=n.hotel_slug
    where n.id=p_event_id and n.tenant_id=p_tenant_id and n.property_id=p_property_id and n.hotel_slug=p_hotel_slug for update of n skip locked;
  if not found then return jsonb_build_object('admission','busy_or_scope'); end if;
  if p_mode='auto' and v_event.status in ('sent','skipped') then
    return jsonb_build_object('admission','terminal','event',to_jsonb(v_event)||jsonb_build_object('id',v_event.id::text,'property_id',v_event.property_id::text));
  end if;
  -- Reject stale/over-limit admin requests before any expiry cleanup/write.
  if p_mode='admin' then
    if v_event.status not in ('failed','skipped') or p_expected_status is distinct from v_event.status
      or p_expected_retry is distinct from v_event.retry_count then return jsonb_build_object('admission','stale_admin'); end if;
    if v_event.retry_count>=3 then return jsonb_build_object('admission','admin_limit'); end if;
  elsif v_event.status not in ('pending','failed') then return jsonb_build_object('admission','busy_or_scope'); end if;
  select * into s from public.task7d_notification_delivery_state where event_id=p_event_id for update skip locked;
  if not found and exists(select 1 from public.task7d_notification_delivery_state where event_id=p_event_id) then return jsonb_build_object('admission','busy_or_scope'); end if;
  if found then
    if s.tenant_id<>v_event.tenant_id or s.property_id<>v_event.property_id or s.hotel_slug<>v_event.hotel_slug
      or s.source_type<>v_event.source_type or s.source_id<>v_event.source_id or s.event_type<>v_event.event_type then return jsonb_build_object('admission','busy_or_scope'); end if;
    if s.status='PROCESSING' and s.lease_until>clock_timestamp() then return jsonb_build_object('admission','busy_or_scope'); end if;
    if s.status='DEAD_LETTER' then return jsonb_build_object('admission','retry_exhausted'); end if;
    if s.status='PROCESSING' and s.attempt_count>=12 then
      v_now:=clock_timestamp();
      update public.task7d_notification_delivery_state set status='DEAD_LETTER',dead_lettered_at=v_now,lease_owner=null,lease_until=null,
        last_error_code='NOTIFICATION_LEASE_EXPIRED_AT_MAX',updated_at=v_now where event_id=p_event_id;
      update public.task7d_notification_delivery_attempts set finished_at=v_now,outcome='DEAD_LETTER',error_code='NOTIFICATION_LEASE_EXPIRED_AT_MAX'
        where event_id=p_event_id and claim_version=s.claim_version;
      update public.notification_events set status='failed',error_message='NOTIFICATION_LEASE_EXPIRED_AT_MAX',processed_at=v_now,updated_at=v_now where id=p_event_id;
      return jsonb_build_object('admission','retry_exhausted');
    end if;
    if s.attempt_count>=12 then return jsonb_build_object('admission','retry_exhausted'); end if;
    if s.available_at>clock_timestamp() then return jsonb_build_object('admission','retry_later'); end if;
  end if;
  if s.event_id is null then
    insert into public.task7d_notification_delivery_state(event_id,tenant_id,property_id,hotel_slug,source_type,source_id,event_type)
      values(v_event.id,v_event.tenant_id,v_event.property_id,v_event.hotel_slug,v_event.source_type,v_event.source_id,v_event.event_type) returning * into s;
  end if;
  v_now:=clock_timestamp();
  if s.status='PROCESSING' then
    update public.task7d_notification_delivery_attempts set finished_at=v_now,outcome='LEASE_EXPIRED',error_code='NOTIFICATION_LEASE_EXPIRED'
      where event_id=s.event_id and claim_version=s.claim_version;
  end if;
  if p_mode='admin' then
    update public.notification_events set status='pending',error_message=null,processed_at=null,retry_count=retry_count+1,last_retry_at=v_now,updated_at=v_now
      where id=p_event_id returning * into v_event;
  end if;
  update public.task7d_notification_delivery_state set status='PROCESSING',attempt_count=attempt_count+1,claim_version=claim_version+1,
    lease_owner=p_lease_owner,lease_until=v_now+make_interval(secs=>p_lease_seconds),heartbeat_at=v_now,claimed_status=v_event.status,
    claimed_retry_count=v_event.retry_count,last_error_code=null,dead_lettered_at=null,updated_at=v_now where event_id=p_event_id returning * into s;
  insert into public.task7d_notification_delivery_attempts(event_id,claim_version,tenant_id,property_id,lease_owner,attempt_number,replay_number,admission_mode)
    values(s.event_id,s.claim_version,s.tenant_id,s.property_id,p_lease_owner,s.attempt_count,s.replay_count,p_mode);
  return jsonb_build_object('admission','claimed','event',to_jsonb(v_event)||jsonb_build_object('id',v_event.id::text,'property_id',v_event.property_id::text),
    'lease',jsonb_build_object('owner',p_lease_owner,'version',s.claim_version::text,'until',s.lease_until));
end $fn$;

create function public.task7d_renew_notification_delivery(p_event_id bigint,p_lease_owner uuid,p_claim_version bigint,p_lease_seconds integer default 60)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $fn$
declare v_event public.notification_events%rowtype;s public.task7d_notification_delivery_state%rowtype;
begin
  if p_lease_seconds is null or p_lease_seconds not between 30 and 300 then return false; end if;
  perform 1 from public.task7d_notification_worker_control where singleton and enabled for share;
  if not found then return false; end if;
  select * into v_event from public.notification_events where id=p_event_id for update;
  if not found then return false; end if;
  select * into s from public.task7d_notification_delivery_state where event_id=p_event_id and lease_owner=p_lease_owner and claim_version=p_claim_version and status='PROCESSING' for update;
  if not found or s.lease_until<=clock_timestamp() then return false; end if;
  if s.tenant_id<>v_event.tenant_id or s.property_id<>v_event.property_id or s.hotel_slug is distinct from v_event.hotel_slug
    or s.source_type<>v_event.source_type or s.source_id<>v_event.source_id or s.event_type<>v_event.event_type
    or s.claimed_status<>v_event.status or s.claimed_retry_count<>v_event.retry_count
    or not exists(select 1 from public.hotels where id=s.property_id and tenant_id=s.tenant_id and slug=s.hotel_slug) then return false; end if;
  update public.task7d_notification_delivery_state set lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),heartbeat_at=clock_timestamp(),updated_at=clock_timestamp() where event_id=p_event_id;
  return true;
end $fn$;

create function public.task7d_complete_notification_delivery(p_event_id bigint,p_lease_owner uuid,p_claim_version bigint,p_status text,p_error_message text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $fn$
declare v_event public.notification_events%rowtype;s public.task7d_notification_delivery_state%rowtype;v_now timestamptz;v_error text;v_code text;v_delay double precision;
begin
  if p_status is null or p_status not in ('sent','skipped','failed') then return null; end if;
  perform 1 from public.task7d_notification_worker_control where singleton and enabled for share;
  if not found then return null; end if;
  select * into v_event from public.notification_events where id=p_event_id for update;
  if not found then return null; end if;
  select * into s from public.task7d_notification_delivery_state where event_id=p_event_id and lease_owner=p_lease_owner and claim_version=p_claim_version and status='PROCESSING' for update;
  if not found or s.lease_until<=clock_timestamp() then return null; end if;
  if s.tenant_id<>v_event.tenant_id or s.property_id<>v_event.property_id or s.hotel_slug is distinct from v_event.hotel_slug
    or s.source_type<>v_event.source_type or s.source_id<>v_event.source_id or s.event_type<>v_event.event_type
    or s.claimed_status<>v_event.status or s.claimed_retry_count<>v_event.retry_count
    or not exists(select 1 from public.hotels where id=s.property_id and tenant_id=s.tenant_id and slug=s.hotel_slug) then return null; end if;
  v_now:=clock_timestamp();
  v_code:=case when p_error_message ~ '^NOTIFICATION_[A-Z0-9_]{1,80}$' then p_error_message else 'NOTIFICATION_DELIVERY_ERROR' end;
  v_error:=case when p_status='sent' then null when p_status='failed' then v_code
    when p_error_message in ('Notification event missing hotel slug','Notification settings not configured for hotel','Hotel email notifications disabled',
      'Hotel notification email not configured','Notification delivery disabled by config','Notification delivery channel is internal only',
      'Notification SMTP/email configuration is incomplete')
      or p_error_message ~ '^Notification type "(order|reservation|inquiry|contact_submission|testimonial|support_request)" disabled for hotel$'
      or p_error_message ~ '^Notification delivery channel "[a-z_]{1,32}" is not implemented yet$' then p_error_message
    else 'Notification delivery skipped' end;
  v_delay:=greatest(5,least(300,5*power(2,least(6,s.attempt_count-1))*(0.8+random()*0.4)));
  update public.task7d_notification_delivery_state set status=case when p_status<>'failed' then 'SUCCEEDED' when s.attempt_count>=12 then 'DEAD_LETTER' else 'READY' end,
    lease_owner=null,lease_until=null,dead_lettered_at=case when p_status='failed' and s.attempt_count>=12 then v_now else null end,
    available_at=case when p_status='failed' then v_now+make_interval(secs=>v_delay) else v_now end,
    last_error_code=case when p_status='failed' then v_code else null end,updated_at=v_now where event_id=p_event_id;
  update public.task7d_notification_delivery_attempts set finished_at=v_now,
    outcome=case when p_status='sent' then 'SUCCEEDED' when p_status='skipped' then 'SKIPPED' when s.attempt_count>=12 then 'DEAD_LETTER' else 'RETRY' end,
    error_code=case when p_status='failed' then v_code else null end where event_id=p_event_id and claim_version=s.claim_version;
  update public.notification_events set status=p_status,error_message=v_error,processed_at=v_now,updated_at=v_now where id=p_event_id returning * into v_event;
  return to_jsonb(v_event)||jsonb_build_object('id',v_event.id::text,'property_id',v_event.property_id::text);
end $fn$;

create function public.task7d_replay_notification_delivery(p_event_id bigint,p_expected_version bigint)
returns boolean language plpgsql set search_path=pg_catalog,public as $fn$
declare v_event public.notification_events%rowtype;s public.task7d_notification_delivery_state%rowtype;
begin
  if current_user<>'postgres' then raise exception 'TASK7D_OPERATOR_REQUIRED'; end if;
  perform 1 from public.task7d_notification_worker_control where singleton and enabled and p_event_id>=min_event_id for share;
  if not found then return false; end if;
  select * into v_event from public.notification_events where id=p_event_id for update;
  if not found then return false; end if;
  select * into s from public.task7d_notification_delivery_state where event_id=p_event_id and claim_version=p_expected_version and status='DEAD_LETTER' for update;
  if not found or v_event.status<>'failed' then return false; end if;
  if s.tenant_id<>v_event.tenant_id or s.property_id<>v_event.property_id or s.hotel_slug is distinct from v_event.hotel_slug
    or s.source_type<>v_event.source_type or s.source_id<>v_event.source_id or s.event_type<>v_event.event_type
    or not exists(select 1 from public.hotels where id=s.property_id and tenant_id=s.tenant_id and slug=s.hotel_slug) then return false; end if;
  update public.task7d_notification_delivery_state set status='READY',attempt_count=0,replay_count=replay_count+1,dead_lettered_at=null,
    last_error_code=null,available_at=clock_timestamp(),updated_at=clock_timestamp() where event_id=p_event_id;
  return true;
end $fn$;

revoke all on function public.task7d_configure_notification_delivery(boolean),public.task7d_replay_notification_delivery(bigint,bigint)
  from public,anon,authenticated,app_tenant_runtime,app_tenant_rpc_owner,service_role;
revoke all on function public.task7d_notification_delivery_readiness(),public.task7d_claim_notification_delivery(bigint,uuid,bigint,text,uuid,text,text,integer,integer),
  public.task7d_renew_notification_delivery(bigint,uuid,bigint,integer),public.task7d_complete_notification_delivery(bigint,uuid,bigint,text,text)
  from public,anon,authenticated,app_tenant_runtime,app_tenant_rpc_owner,service_role;
grant execute on function public.task7d_notification_delivery_readiness(),public.task7d_claim_notification_delivery(bigint,uuid,bigint,text,uuid,text,text,integer,integer),
  public.task7d_renew_notification_delivery(bigint,uuid,bigint,integer),public.task7d_complete_notification_delivery(bigint,uuid,bigint,text,text) to service_role;
commit;
