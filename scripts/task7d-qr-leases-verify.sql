-- Expand-only verification. Does not claim, configure, replay or send anything.
begin transaction isolation level repeatable read read only;
set local statement_timeout='10s';
set local lock_timeout='2s';
with tables(name) as (
  values ('task7d_qr_worker_control'),('task7d_qr_delivery_state'),('task7d_qr_delivery_attempts')
), functions(signature,is_worker) as (
  values ('task7d_configure_qr_delivery(boolean)',false),('task7d_replay_qr_delivery(bigint,bigint)',false),
    ('task7d_qr_delivery_readiness()',true),('task7d_claim_qr_delivery(uuid,integer)',true),
    ('task7d_renew_qr_delivery(bigint,uuid,bigint,integer)',true),('task7d_complete_qr_delivery(bigint,uuid,bigint,boolean,text)',true)
), roles(name) as (
  values ('anon'),('authenticated'),('app_tenant_runtime'),('app_tenant_rpc_owner'),('service_role')
), table_metadata as (
  select t.name,c.oid,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) owner,
    (select count(*) from pg_policy p where p.polrelid=c.oid) policy_count
  from tables t left join pg_class c on c.oid=to_regclass('public.'||t.name)
), function_metadata as (
  select f.*,p.oid,pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proconfig,md5(pg_get_functiondef(p.oid)) definition_md5
  from functions f left join pg_proc p on p.oid=to_regprocedure('public.'||f.signature)
), checks(name,passed) as (
  select 'three_private_force_rls_tables',coalesce(bool_and(oid is not null and owner='postgres' and relrowsecurity and relforcerowsecurity and policy_count=0),false) from table_metadata
  union all select 'table_grants_denied_for_all_runtime_roles',coalesce(bool_and(not has_table_privilege(r.name,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),false) from table_metadata t cross join roles r
  union all select 'six_owned_fixed_path_routines',coalesce(bool_and(oid is not null and owner='postgres' and prosecdef=is_worker and proconfig=array['search_path=pg_catalog, public']),false) from function_metadata
  union all select 'rpc_access_matches_worker_only_contract',coalesce(bool_and(has_function_privilege(r.name,f.oid,'EXECUTE')=(f.is_worker and r.name='service_role')),false) from function_metadata f cross join roles r
  union all select 'control_disabled_and_no_cutover',count(*)=1 and coalesce(bool_and(not enabled and min_event_id is null and activated_at is null and schema_version=1),false) from public.task7d_qr_worker_control
  union all select 'new_delivery_state_empty',not exists(select 1 from public.task7d_qr_delivery_state)
  union all select 'new_attempt_audit_empty',not exists(select 1 from public.task7d_qr_delivery_attempts)
), result(section,object_identity,details) as (
  select 'context'::text,'execution'::text,jsonb_build_object('script','TASK7D_QR_LEASES_EXPAND_VERIFY_V1',
    'captured_at',current_timestamp,'server_version',current_setting('server_version'),
    'transaction_read_only',current_setting('transaction_read_only'),'scope','METADATA_AND_AGGREGATES_ONLY')
  union all select 'check',name,jsonb_build_object('passed',passed) from checks
  union all select 'relation','public.'||name,jsonb_build_object('present',oid is not null,'owner',owner,'rls_enabled',relrowsecurity,'force_rls',relforcerowsecurity,'policy_count',policy_count) from table_metadata
  union all select 'routine','public.'||signature,jsonb_build_object('present',oid is not null,'owner',owner,'security_definer',prosecdef,'configuration',proconfig,'definition_md5',definition_md5) from function_metadata
  union all select 'queue_metric','qr_unpublished',jsonb_build_object('count',count(*)) from public.qr_event_outbox where published_at is null
  union all select 'queue_metric','qr_retry_count_at_least_12',jsonb_build_object('count',count(*)) from public.qr_event_outbox where published_at is null and attempt_count>=12
  union all select 'queue_metric','notifications_total',jsonb_build_object('count',count(*)) from public.notification_events
)
select section,object_identity,details from result order by section,object_identity;
commit;
