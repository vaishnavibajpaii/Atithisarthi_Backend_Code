-- Metadata/aggregates only; does not create, configure, claim, send or replay.
begin transaction isolation level repeatable read read only;
set local lock_timeout='2s';set local statement_timeout='10s';
with tables(name) as(values('task7d_public_notification_control'),('task7d_public_notification_intents')),
roles(name) as(values('anon'),('authenticated'),('service_role'),('app_tenant_runtime'),('app_tenant_rpc_owner')),
functions(signature,owner_name,definer,kind) as(values
 ('task7d_configure_public_notification_intents(boolean)','postgres',false,'operator'),
 ('task7d_record_public_notification_intent()','postgres',true,'trigger'),
 ('task7d_public_notification_producer_preflight()','postgres',true,'producer'),
 ('task7d_create_public_source_with_intent(text,jsonb)','postgres',false,'producer'),
 ('task7d_public_notification_readiness()','postgres',true,'worker'),
 ('task7d_list_public_notification_intents(integer)','postgres',true,'worker'),
 ('task7d_ack_public_notification_intent(bigint)','postgres',true,'worker')),
tmeta as(select t.name,c.oid,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) owner,(select count(*) from pg_policy p where p.polrelid=c.oid) policies from tables t left join pg_class c on c.oid=to_regclass('public.'||t.name)),
fmeta as(select f.*,p.oid,pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proconfig,md5(pg_get_functiondef(p.oid)) definition_md5 from functions f left join pg_proc p on p.oid=to_regprocedure('public.'||f.signature)),
expected_triggers(tab) as(values('reservations'),('inquiries'),('contact_submissions')),
trmeta as(select e.tab,t.oid,t.tgenabled,t.tgtype,t.tgnargs,t.tgfoid,t.tgisinternal,md5(pg_get_triggerdef(t.oid,true)) definition_md5 from expected_triggers e left join pg_trigger t on t.tgrelid=to_regclass('public.'||e.tab) and t.tgname='task7d_public_intent_capture'),
checks(name,passed) as(
 select 'two_private_force_rls_tables',coalesce(bool_and(oid is not null and owner='postgres' and relrowsecurity and relforcerowsecurity and policies=0),false) from tmeta
 union all select 'private_tables_denied_to_runtime_roles',coalesce(bool_and(not has_table_privilege(r.name,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),false) from tmeta t cross join roles r
 union all select 'seven_fixed_path_owned_routines',coalesce(bool_and(oid is not null and owner=owner_name and prosecdef=definer and proconfig=array['search_path=pg_catalog, public']),false) from fmeta
 union all select 'routine_role_contract',coalesce(bool_and(has_function_privilege(r.name,f.oid,'EXECUTE')=case when f.kind='producer' then r.name='app_tenant_runtime' when f.kind='worker' then r.name='service_role' else false end),false) from fmeta f cross join roles r
 union all select 'three_marked_insert_triggers',count(*)=3 and coalesce(bool_and(oid is not null and tgenabled='O' and tgtype=5 and tgnargs=0 and not tgisinternal and tgfoid=to_regprocedure('public.task7d_record_public_notification_intent()')),false) from trmeta
 union all select 'tenant_roles_restricted_no_schema_create',count(*)=2 and coalesce(bool_and(not rolsuper and not rolbypassrls and not rolinherit and not rolcreatedb and not rolcreaterole and not rolreplication and (rolname<>'app_tenant_rpc_owner' or not rolcanlogin) and not has_schema_privilege(rolname,'public','CREATE')),false) from pg_roles where rolname in ('app_tenant_runtime','app_tenant_rpc_owner')
 union all select 'control_disabled_no_floors',count(*)=1 and coalesce(bool_and(not enabled and min_event_id is null and reservation_floor is null and inquiry_floor is null and contact_submission_floor is null and activated_at is null and schema_version=1),false) from public.task7d_public_notification_control
 union all select 'no_intents_or_backfill',not exists(select 1 from public.task7d_public_notification_intents)
 union all select 'shared_delivery_control_still_disabled',count(*)=1 and coalesce(bool_and(not enabled and min_event_id is null and activated_at is null),false) from public.task7d_notification_worker_control
),result(section,object_identity,details) as(
 select 'context'::text,'execution'::text,jsonb_build_object('script','TASK7D_PUBLIC_OUTBOX_VERIFY_V2','scope','METADATA_AND_AGGREGATES_ONLY','captured_at',current_timestamp,'server_version',current_setting('server_version'),'transaction_read_only',current_setting('transaction_read_only'))
 union all select 'check',name,jsonb_build_object('passed',passed) from checks
 union all select 'relation','public.'||name,jsonb_build_object('present',oid is not null,'owner',owner,'rls_enabled',relrowsecurity,'force_rls',relforcerowsecurity,'policy_count',policies) from tmeta
 union all select 'routine','public.'||signature,jsonb_build_object('present',oid is not null,'owner',owner,'security_definer',prosecdef,'configuration',proconfig,'definition_md5',definition_md5) from fmeta
 union all select 'trigger','public.'||tab||'.task7d_public_intent_capture',jsonb_build_object('present',oid is not null,'enabled',tgenabled,'routine','task7d_record_public_notification_intent','definition_md5',definition_md5) from trmeta
 union all select 'queue_metric','notifications_total',jsonb_build_object('count',count(*)) from public.notification_events
 union all select 'queue_metric','notifications_pending',jsonb_build_object('count',count(*)) from public.notification_events where status='pending'
 union all select 'queue_metric','notifications_failed',jsonb_build_object('count',count(*)) from public.notification_events where status='failed'
)
select section,object_identity,details from result order by section,object_identity;
commit;
