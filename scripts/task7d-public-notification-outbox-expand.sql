-- Revision 2: invoker producer + marked INSERT triggers. MANUAL TEST only.
-- No owner transfer, role membership/schema CREATE grant, backfill or activation.
begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
do $preflight$
begin
  if current_user<>'postgres' or not exists(select 1 from pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then raise exception 'TASK7D_OPERATOR_REQUIRED'; end if;
  if to_regclass('public.task7d_public_notification_control') is not null or to_regclass('public.task7d_public_notification_intents') is not null then raise exception 'TASK7D_PUBLIC_OUTBOX_ALREADY_PRESENT_REVIEW_VERIFY'; end if;
  if not exists(select 1 from pg_roles where rolname='app_tenant_rpc_owner' and not rolcanlogin and not rolsuper and not rolbypassrls and not rolinherit and not rolcreatedb and not rolcreaterole and not rolreplication)
    or has_schema_privilege('app_tenant_rpc_owner','public','CREATE') then raise exception 'TASK7D_RPC_OWNER_UNSAFE'; end if;
  if not exists(select 1 from pg_roles where rolname='app_tenant_runtime' and not rolsuper and not rolbypassrls and not rolcreatedb and not rolcreaterole and not rolreplication and not rolinherit)
    or has_schema_privilege('app_tenant_runtime','public','CREATE') then raise exception 'TASK7D_RUNTIME_ROLE_UNSAFE'; end if;
  if exists(select 1 from pg_proc where pronamespace='public'::regnamespace and proname in ('task7d_create_public_source_with_intent','task7d_record_public_notification_intent','task7d_public_notification_producer_preflight','task7d_configure_public_notification_intents','task7d_public_notification_readiness','task7d_list_public_notification_intents','task7d_ack_public_notification_intent')) then raise exception 'TASK7D_PUBLIC_OUTBOX_ROUTINE_ALREADY_PRESENT'; end if;
  if to_regclass('public.task7d_notification_delivery_state') is null or to_regclass('public.task7d_notification_worker_control') is null then raise exception 'TASK7D_SHARED_NOTIFICATION_SCHEMA_REQUIRED'; end if;
  if exists(select 1 from public.task7d_notification_worker_control where enabled) then raise exception 'TASK7D_DISABLED_SHARED_GATE_REQUIRED_FOR_EXPANSION'; end if;
  if exists(select 1 from (values ('reservations'),('inquiries'),('contact_submissions'),('notification_events')) x(name)
    left join pg_class c on c.oid=to_regclass('public.'||x.name) where c.oid is null or not c.relrowsecurity or not c.relforcerowsecurity)
    or not has_table_privilege('app_tenant_runtime','public.hotels','SELECT')
    or not has_table_privilege('app_tenant_runtime','public.notification_events','SELECT')
    or exists(select 1 from (values ('reservations'),('inquiries'),('contact_submissions')) x(name)
      where not has_table_privilege('app_tenant_runtime','public.'||name,'SELECT') or not has_table_privilege('app_tenant_runtime','public.'||name,'INSERT')) then raise exception 'TASK7D_PUBLIC_SOURCE_AUTHORITY_PRECONDITION_FAILED'; end if;
  if exists(
    with expected(tab,col,typ) as (
      select t.tab,c.col,c.typ from (values('reservations'),('inquiries'),('contact_submissions')) t(tab)
      cross join (values('id','bigint'),('tenant_id','uuid'),('property_id','bigint'),('hotel_slug','text'),('hotel_name','text'),('name','text'),('status','text'),('created_at','timestamp with time zone')) c(col,typ)
      union all select t.tab,c.col,'text' from (values('reservations'),('inquiries')) t(tab) cross join (values('phone'),('date'),('guests')) c(col)
      union all select 'reservations',c.col,'text' from (values('time'),('note')) c(col)
      union all select 'inquiries',c.col,'text' from (values('event_type'),('special_requirements')) c(col)
      union all select 'contact_submissions',c.col,c.typ from (values('email','text'),('subject','text'),('message','text'),('source','text'),('google_sheet_status','text'),('google_sheet_response','jsonb'),('metadata','jsonb'),('updated_at','timestamp with time zone')) c(col,typ)
    ) select 1 from expected e left join pg_attribute a on a.attrelid=to_regclass('public.'||e.tab) and a.attname=e.col and not a.attisdropped
      where a.attnum is null or format_type(a.atttypid,a.atttypmod)<>e.typ
  ) then raise exception 'TASK7D_PUBLIC_SOURCE_COLUMN_CONTRACT_CHANGED'; end if;
  if exists(select 1 from (values('reservations'),('inquiries'),('contact_submissions')) t(tab)
    where pg_get_serial_sequence('public.'||tab,'id') is null or not coalesce(has_sequence_privilege('app_tenant_runtime',pg_get_serial_sequence('public.'||tab,'id'),'USAGE'),false)) then raise exception 'TASK7D_PUBLIC_SOURCE_SEQUENCE_AUTHORITY_REQUIRED'; end if;
end $preflight$;

create table public.task7d_public_notification_control (
  singleton boolean primary key default true check(singleton),enabled boolean not null default false,
  min_event_id bigint check(min_event_id>0),reservation_floor bigint check(reservation_floor>0),
  inquiry_floor bigint check(inquiry_floor>0),contact_submission_floor bigint check(contact_submission_floor>0),
  activated_at timestamptz,schema_version integer not null default 1 check(schema_version=1),
  check(not enabled or (min_event_id is not null and reservation_floor is not null and inquiry_floor is not null and contact_submission_floor is not null and activated_at is not null))
);
insert into public.task7d_public_notification_control(singleton) values(true);
create table public.task7d_public_notification_intents (
  event_id bigint primary key references public.notification_events(id),tenant_id uuid not null,property_id bigint not null,
  hotel_slug text not null,source_type text not null check(source_type in ('reservation','inquiry','contact_submission')),
  source_id bigint not null check(source_id>0),event_type text not null,
  created_at timestamptz not null default now(),completed_at timestamptz,
  unique(tenant_id,property_id,source_type,source_id),foreign key(tenant_id,property_id) references public.hotels(tenant_id,id)
);
create index task7d_public_notification_pending_idx on public.task7d_public_notification_intents(created_at,event_id) where completed_at is null;
alter table public.task7d_public_notification_control enable row level security;
alter table public.task7d_public_notification_control force row level security;
alter table public.task7d_public_notification_intents enable row level security;
alter table public.task7d_public_notification_intents force row level security;
revoke all on public.task7d_public_notification_control,public.task7d_public_notification_intents from public,anon,authenticated,service_role,app_tenant_runtime,app_tenant_rpc_owner;

create function public.task7d_configure_public_notification_intents(p_enabled boolean)
returns jsonb language plpgsql set search_path=pg_catalog,public as $fn$
declare c public.task7d_public_notification_control%rowtype;
begin
  if current_user<>'postgres' then raise exception 'TASK7D_OPERATOR_REQUIRED'; end if;
  if p_enabled is null then raise exception 'TASK7D_PUBLIC_CONFIG_INVALID'; end if;
  select * into strict c from public.task7d_public_notification_control where singleton for update;
  if p_enabled then
    perform 1 from public.task7d_notification_worker_control where singleton and enabled and min_event_id is not null for share;
    if not found then raise exception 'TASK7D_SHARED_GATE_MUST_ACTIVATE_FIRST'; end if;
  end if;
  if exists(select 1 from public.task7d_public_notification_intents i join public.task7d_notification_delivery_state d on d.event_id=i.event_id where d.status='PROCESSING' and d.lease_until>clock_timestamp()) then raise exception 'TASK7D_ACTIVE_SENDERS_MUST_DRAIN'; end if;
  if p_enabled and c.min_event_id is null then
    lock table public.contact_submissions,public.inquiries,public.reservations,public.notification_events in share row exclusive mode;
    select coalesce(max(id),0)+1 into c.min_event_id from public.notification_events;
    select coalesce(max(id),0)+1 into c.reservation_floor from public.reservations;
    select coalesce(max(id),0)+1 into c.inquiry_floor from public.inquiries;
    select coalesce(max(id),0)+1 into c.contact_submission_floor from public.contact_submissions;
  end if;
  update public.task7d_public_notification_control set enabled=p_enabled,min_event_id=c.min_event_id,reservation_floor=c.reservation_floor,
    inquiry_floor=c.inquiry_floor,contact_submission_floor=c.contact_submission_floor,
    activated_at=case when p_enabled then coalesce(activated_at,clock_timestamp()) else activated_at end where singleton;
  return jsonb_build_object('enabled',p_enabled,'schema_version',1,'min_event_id',c.min_event_id::text);
end $fn$;

-- A narrow lock-only preflight keeps configure -> producer lock order. It does
-- not reveal private state, accept a source ID, write an intent or change roles.
create function public.task7d_public_notification_producer_preflight()
returns void language plpgsql security definer set search_path=pg_catalog,public as $fn$
begin
  if not (current_setting('role',true)='app_tenant_runtime' or (coalesce(current_setting('role',true),'none')='none' and session_user='app_tenant_runtime')) then raise exception 'TASK7D_PUBLIC_RUNTIME_REQUIRED'; end if;
  if nullif(current_setting('app.tenant_id',true),'') is null or nullif(current_setting('app.property_id',true),'') is null then raise exception 'TASK7D_PUBLIC_CONTEXT_REQUIRED'; end if;
  perform 1 from public.task7d_public_notification_control where singleton and enabled for share;
  if not found then raise exception 'TASK7D_PUBLIC_INTENT_DISABLED'; end if;
end $fn$;

-- Only actual marked AFTER INSERTs reach the privileged intent writer. This
-- trigger function has no runtime EXECUTE grant; UPDATE cannot impersonate INSERT.
create function public.task7d_record_public_notification_intent()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $fn$
declare c public.task7d_public_notification_control%rowtype;t uuid;p bigint;r jsonb;payload_value jsonb;event_value text;dedupe_value text;version_type text;n public.notification_events%rowtype;source_floor bigint;p_source_type text;p_source_id bigint;
begin
  if tg_table_schema<>'public' or tg_op<>'INSERT' or tg_when<>'AFTER' or tg_level<>'ROW' or tg_nargs<>0 then raise exception 'TASK7D_PUBLIC_TRIGGER_BINDING_INVALID'; end if;
  p_source_type:=case tg_table_name when 'reservations' then 'reservation' when 'inquiries' then 'inquiry' when 'contact_submissions' then 'contact_submission' else null end;
  if p_source_type is null then raise exception 'TASK7D_PUBLIC_TRIGGER_BINDING_INVALID'; end if;
  if current_setting('app.task7d_public_source_type',true) is distinct from p_source_type then return new; end if;
  if not (current_setting('role',true)='app_tenant_runtime' or (coalesce(current_setting('role',true),'none')='none' and session_user='app_tenant_runtime')) then raise exception 'TASK7D_PUBLIC_RUNTIME_REQUIRED'; end if;
  p_source_id:=new.id;r:=to_jsonb(new);
  begin t:=nullif(current_setting('app.tenant_id',true),'')::uuid;p:=nullif(current_setting('app.property_id',true),'')::bigint;
  exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'TASK7D_PUBLIC_CONTEXT_REQUIRED'; end;
  if t is null or p is null or p<1 or p_source_id is null or p_source_id<1 or new.tenant_id<>t or new.property_id<>p then raise exception 'TASK7D_PUBLIC_CONTEXT_OR_SOURCE_INVALID'; end if;
  select * into c from public.task7d_public_notification_control where singleton and enabled for share;
  if not found then raise exception 'TASK7D_PUBLIC_INTENT_DISABLED'; end if;
  source_floor:=case p_source_type when 'reservation' then c.reservation_floor when 'inquiry' then c.inquiry_floor else c.contact_submission_floor end;
  if p_source_id<source_floor then raise exception 'TASK7D_PUBLIC_FRESH_SOURCE_REQUIRED'; end if;
  if not exists(select 1 from public.hotels h where h.id=p and h.tenant_id=t and h.slug=r->>'hotel_slug') then raise exception 'TASK7D_PUBLIC_CANONICAL_SOURCE_REQUIRED'; end if;
  if p_source_type='reservation' then
    event_value:='reservation_created';payload_value:=jsonb_build_object('reservationId',p_source_id::text,'hotelName',coalesce(r->>'hotel_name',''),'name',r->>'name','phone',r->>'phone','date',r->>'date','time',r->>'time','guests',coalesce(r->>'guests',''),'note',coalesce(r->>'note',''),'status',coalesce(nullif(r->>'status',''),'new'));
  elsif p_source_type='inquiry' then
    event_value:='inquiry_created';payload_value:=jsonb_build_object('inquiryId',p_source_id::text,'hotelName',coalesce(r->>'hotel_name',''),'name',r->>'name','phone',r->>'phone','eventType',r->>'event_type','date',r->>'date','guests',coalesce(r->>'guests',''),'specialRequirements',coalesce(r->>'special_requirements',''),'status',coalesce(nullif(r->>'status',''),'new'));
  else
    event_value:='contact_submission_created';payload_value:=jsonb_build_object('contactSubmissionId',p_source_id::text,'hotelName',coalesce(r->>'hotel_name',''),'hotelSlug',r->>'hotel_slug','name',r->>'name','email',r->>'email','subject',coalesce(r->>'subject',''),'message',r->>'message','status',coalesce(nullif(r->>'status',''),'new'),'source',coalesce(nullif(r->>'source',''),'website_contact'),'googleSheetStatus',coalesce(nullif(r->>'google_sheet_status',''),'not_attempted'));
  end if;
  version_type:=case when coalesce(payload_value->>'eventType','')<>'' then payload_value->>'eventType' else event_value end;
  dedupe_value:=lower(p_source_type||':'||p_source_id::text||':'||btrim(version_type)||':');
  insert into public.notification_events(tenant_id,property_id,hotel_slug,source_type,source_id,event_type,dedupe_key,delivery_channel,status,payload,error_message,processed_at,updated_at)
    values(t,p,r->>'hotel_slug',p_source_type,p_source_id::text,event_value,dedupe_value,'internal','pending',payload_value,null,null,clock_timestamp())
    on conflict(hotel_slug,dedupe_key) where dedupe_key is not null do nothing returning * into n;
  if not found then
    select * into n from public.notification_events where hotel_slug=r->>'hotel_slug' and dedupe_key=dedupe_value for share;
  end if;
  if n.id is null or n.id<c.min_event_id or n.tenant_id<>t or n.property_id<>p or n.hotel_slug is distinct from r->>'hotel_slug'
    or n.source_type<>p_source_type or n.source_id<>p_source_id::text or n.event_type<>event_value or n.payload is distinct from payload_value then raise exception 'TASK7D_PUBLIC_NOTIFICATION_BINDING_CONFLICT'; end if;
  insert into public.task7d_public_notification_intents(event_id,tenant_id,property_id,hotel_slug,source_type,source_id,event_type)
    values(n.id,t,p,n.hotel_slug,p_source_type,p_source_id,event_value) on conflict(event_id) do nothing;
  if not exists(select 1 from public.task7d_public_notification_intents i where i.event_id=n.id and i.tenant_id=t and i.property_id=p and i.hotel_slug=n.hotel_slug and i.source_type=p_source_type and i.source_id=p_source_id and i.event_type=event_value) then raise exception 'TASK7D_PUBLIC_INTENT_BINDING_CONFLICT'; end if;
  perform set_config('app.task7d_public_notification_result',jsonb_build_object('source_type',p_source_type,'source_id',p_source_id::text,'event_id',n.id::text)::text,true);
  return new;
end $fn$;

create trigger task7d_public_intent_capture after insert on public.reservations for each row execute function public.task7d_record_public_notification_intent();
create trigger task7d_public_intent_capture after insert on public.inquiries for each row execute function public.task7d_record_public_notification_intent();
create trigger task7d_public_intent_capture after insert on public.contact_submissions for each row execute function public.task7d_record_public_notification_intent();

create function public.task7d_create_public_source_with_intent(p_source_type text,p_source jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $fn$
declare t uuid;p bigint;h text;s jsonb;source_id_value bigint;n jsonb;receipt jsonb;old_mode text:=current_setting('app.task7d_public_source_type',true);old_result text:=current_setting('app.task7d_public_notification_result',true);
begin
  if current_user<>'app_tenant_runtime' then raise exception 'TASK7D_PUBLIC_RUNTIME_REQUIRED'; end if;
  begin t:=nullif(current_setting('app.tenant_id',true),'')::uuid;p:=nullif(current_setting('app.property_id',true),'')::bigint;
  exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'TASK7D_PUBLIC_CONTEXT_REQUIRED'; end;
  if t is null or p is null or p<1 or jsonb_typeof(p_source) is distinct from 'object' or p_source_type is null or p_source_type not in ('reservation','inquiry','contact_submission') then raise exception 'TASK7D_PUBLIC_CONTEXT_OR_SOURCE_INVALID'; end if;
  if (p_source->>'tenant_id') is distinct from t::text or (p_source->>'property_id') is distinct from p::text then raise exception 'TASK7D_PUBLIC_OWNER_MISMATCH'; end if;
  h:=p_source->>'hotel_slug';
  if h is null or h='' or h<>btrim(h) or not exists(select 1 from public.hotels where id=p and tenant_id=t and slug=h) then raise exception 'TASK7D_PUBLIC_CANONICAL_SOURCE_REQUIRED'; end if;
  perform public.task7d_public_notification_producer_preflight();
  if coalesce(length(p_source->>'hotel_name'),0)<1 or coalesce(length(p_source->>'name'),0)<2 then raise exception 'TASK7D_PUBLIC_INPUT_INVALID'; end if;
  if p_source_type in ('reservation','inquiry') and (coalesce(length(p_source->>'phone'),0)<8 or length(p_source->>'phone')>20 or coalesce(length(p_source->>'date'),0)<1 or length(p_source->>'date')>50) then raise exception 'TASK7D_PUBLIC_INPUT_INVALID'; end if;
  perform set_config('app.task7d_public_source_type',p_source_type,true);
  perform set_config('app.task7d_public_notification_result','',true);
  begin
  if p_source_type='reservation' then
    if coalesce(length(p_source->>'time'),0)<1 or length(p_source->>'time')>50 or not p_source?'guests' then raise exception 'TASK7D_PUBLIC_INPUT_INVALID'; end if;
    insert into public.reservations as x(tenant_id,property_id,hotel_slug,hotel_name,name,phone,date,"time",guests,note,status)
      values(t,p,h,p_source->>'hotel_name',p_source->>'name',p_source->>'phone',p_source->>'date',p_source->>'time',p_source->>'guests',coalesce(p_source->>'note',''),'new') returning id,to_jsonb(x) into source_id_value,s;
  elsif p_source_type='inquiry' then
    if coalesce(length(p_source->>'event_type'),0)<2 or length(p_source->>'event_type')>100 then raise exception 'TASK7D_PUBLIC_INPUT_INVALID'; end if;
    insert into public.inquiries as x(tenant_id,property_id,hotel_slug,hotel_name,name,phone,event_type,date,guests,special_requirements,status)
      values(t,p,h,p_source->>'hotel_name',p_source->>'name',p_source->>'phone',p_source->>'event_type',p_source->>'date',coalesce(p_source->>'guests',''),coalesce(p_source->>'special_requirements',''),'new') returning id,to_jsonb(x) into source_id_value,s;
  else
    if coalesce(length(p_source->>'email'),0)<3 or length(p_source->>'email')>320 or coalesce(length(p_source->>'message'),0)<2 or length(p_source->>'message')>4000 then raise exception 'TASK7D_PUBLIC_INPUT_INVALID'; end if;
    insert into public.contact_submissions as x(tenant_id,property_id,hotel_slug,hotel_name,name,email,subject,message,status,source,google_sheet_status,google_sheet_response,updated_at)
      values(t,p,h,p_source->>'hotel_name',p_source->>'name',p_source->>'email',coalesce(p_source->>'subject',''),p_source->>'message','new','website_contact',coalesce(nullif(p_source->>'google_sheet_status',''),'not_attempted'),case when jsonb_typeof(p_source->'google_sheet_response')='object' then p_source->'google_sheet_response' else '{}'::jsonb end,clock_timestamp()) returning id,to_jsonb(x) into source_id_value,s;
  end if;
  receipt:=nullif(current_setting('app.task7d_public_notification_result',true),'')::jsonb;
  if jsonb_typeof(receipt) is distinct from 'object' or receipt->>'source_type' is distinct from p_source_type or receipt->>'source_id' is distinct from source_id_value::text or coalesce(receipt->>'event_id','') !~ '^[1-9][0-9]*$' then raise exception 'TASK7D_PUBLIC_INSERT_RECEIPT_REQUIRED'; end if;
  select to_jsonb(e)||jsonb_build_object('id',e.id::text,'property_id',e.property_id::text) into n from public.notification_events e
    where e.id=(receipt->>'event_id')::bigint and e.tenant_id=t and e.property_id=p and e.hotel_slug=h and e.source_type=p_source_type and e.source_id=source_id_value::text;
  if n is null then raise exception 'TASK7D_PUBLIC_NOTIFICATION_NOT_VISIBLE'; end if;
  exception when others then
    perform set_config('app.task7d_public_source_type',coalesce(old_mode,''),true);
    perform set_config('app.task7d_public_notification_result',coalesce(old_result,''),true);
    raise;
  end;
  perform set_config('app.task7d_public_source_type',coalesce(old_mode,''),true);
  perform set_config('app.task7d_public_notification_result',coalesce(old_result,''),true);
  return jsonb_build_object('source_record',s||jsonb_build_object('id',source_id_value::text,'property_id',p::text),'notification_event',n);
end $fn$;

create function public.task7d_public_notification_readiness()
returns jsonb language sql security definer set search_path=pg_catalog,public as $fn$
  select jsonb_build_object('schema_version',schema_version,'enabled',enabled,'min_event_id',min_event_id::text,
    'shared_enabled',(select enabled from public.task7d_notification_worker_control where singleton),
    'pending_intents',(select count(*) from public.task7d_public_notification_intents where completed_at is null),
    'oldest_pending_seconds',(select coalesce(extract(epoch from clock_timestamp()-min(created_at)),0) from public.task7d_public_notification_intents where completed_at is null),
    'active_leases',(select count(*) from public.task7d_public_notification_intents i join public.task7d_notification_delivery_state d on d.event_id=i.event_id where i.completed_at is null and d.status='PROCESSING' and d.lease_until>clock_timestamp()),
    'dead_letters',(select count(*) from public.task7d_public_notification_intents i join public.task7d_notification_delivery_state d on d.event_id=i.event_id where i.completed_at is null and d.status='DEAD_LETTER'))
  from public.task7d_public_notification_control where singleton
$fn$;

create function public.task7d_list_public_notification_intents(p_limit integer default 25)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $fn$
declare c public.task7d_public_notification_control%rowtype;shared_floor bigint;result jsonb;
begin
  if p_limit is null or p_limit not between 1 and 25 then raise exception 'TASK7D_PUBLIC_LIMIT_INVALID'; end if;
  select * into c from public.task7d_public_notification_control where singleton and enabled for share;
  if not found then return '[]'::jsonb; end if;
  select min_event_id into shared_floor from public.task7d_notification_worker_control where singleton and enabled for share;
  if shared_floor is null then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(row_value order by created_at,event_id),'[]'::jsonb) into result from (
    select to_jsonb(n)||jsonb_build_object('id',n.id::text,'property_id',n.property_id::text) row_value,i.created_at,i.event_id
    from public.task7d_public_notification_intents i join public.notification_events n on n.id=i.event_id
    join public.hotels h on h.id=i.property_id and h.tenant_id=i.tenant_id and h.slug=i.hotel_slug
    left join public.task7d_notification_delivery_state d on d.event_id=i.event_id
    where i.completed_at is null and i.event_id>=c.min_event_id and i.event_id>=shared_floor
      and i.source_id>=case i.source_type when 'reservation' then c.reservation_floor when 'inquiry' then c.inquiry_floor else c.contact_submission_floor end
      and n.tenant_id=i.tenant_id and n.property_id=i.property_id and n.hotel_slug=i.hotel_slug and n.source_type=i.source_type and n.source_id=i.source_id::text and n.event_type=i.event_type
      and ((n.status in ('pending','failed') and (d.event_id is null or (d.status in ('READY','PROCESSING') and (d.attempt_count<12 or (d.status='PROCESSING' and d.attempt_count=12)) and d.available_at<=clock_timestamp() and (d.lease_until is null or d.lease_until<=clock_timestamp())
        and d.tenant_id=i.tenant_id and d.property_id=i.property_id and d.hotel_slug=i.hotel_slug and d.source_type=i.source_type and d.source_id=i.source_id::text and d.event_type=i.event_type)))
        or (n.status in ('sent','skipped') and d.status='SUCCEEDED' and d.tenant_id=i.tenant_id and d.property_id=i.property_id and d.hotel_slug=i.hotel_slug and d.source_type=i.source_type and d.source_id=i.source_id::text and d.event_type=i.event_type and d.claimed_retry_count=n.retry_count))
    order by i.created_at,i.event_id limit p_limit
  ) candidates;
  return result;
end $fn$;

create function public.task7d_ack_public_notification_intent(p_event_id bigint)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $fn$
declare n public.notification_events%rowtype;d public.task7d_notification_delivery_state%rowtype;i public.task7d_public_notification_intents%rowtype;
begin
  perform 1 from public.task7d_public_notification_control where singleton and enabled and p_event_id>=min_event_id for share;
  if not found then return false; end if;
  select * into n from public.notification_events where id=p_event_id for update;
  if not found or n.status not in ('sent','skipped') then return false; end if;
  select * into d from public.task7d_notification_delivery_state where event_id=p_event_id and status='SUCCEEDED' for share;
  if not found then return false; end if;
  select * into i from public.task7d_public_notification_intents where event_id=p_event_id for update;
  if not found or n.tenant_id<>i.tenant_id or n.property_id<>i.property_id or n.hotel_slug is distinct from i.hotel_slug or n.source_type<>i.source_type or n.source_id<>i.source_id::text or n.event_type<>i.event_type
    or d.tenant_id<>i.tenant_id or d.property_id<>i.property_id or d.hotel_slug<>i.hotel_slug or d.source_type<>i.source_type or d.source_id<>i.source_id::text or d.event_type<>i.event_type or d.claimed_retry_count<>n.retry_count
    or not exists(select 1 from public.hotels where id=i.property_id and tenant_id=i.tenant_id and slug=i.hotel_slug) then return false; end if;
  update public.task7d_public_notification_intents set completed_at=coalesce(completed_at,clock_timestamp()) where event_id=p_event_id;
  return true;
end $fn$;

revoke all on function public.task7d_configure_public_notification_intents(boolean),public.task7d_record_public_notification_intent(),public.task7d_public_notification_producer_preflight(),public.task7d_create_public_source_with_intent(text,jsonb),
  public.task7d_public_notification_readiness(),public.task7d_list_public_notification_intents(integer),public.task7d_ack_public_notification_intent(bigint)
  from public,anon,authenticated,service_role,app_tenant_runtime,app_tenant_rpc_owner;
grant execute on function public.task7d_create_public_source_with_intent(text,jsonb),public.task7d_public_notification_producer_preflight() to app_tenant_runtime;
grant execute on function public.task7d_public_notification_readiness(),public.task7d_list_public_notification_intents(integer),public.task7d_ack_public_notification_intent(bigint) to service_role;
do $final_assert$ begin
  if has_schema_privilege('app_tenant_rpc_owner','public','CREATE') or exists(select 1 from pg_roles where rolname='app_tenant_rpc_owner' and (rolcanlogin or rolsuper or rolbypassrls or rolinherit or rolcreatedb or rolcreaterole or rolreplication)) then raise exception 'TASK7D_RPC_OWNER_FINAL_AUTHORITY_UNSAFE'; end if;
end $final_assert$;
commit;
