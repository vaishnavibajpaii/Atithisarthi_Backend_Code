-- Read-only Task 7D worker metadata/aggregate inventory. No payloads, error text,
-- customer identifiers, secrets or function bodies. Never claims/replays jobs.
begin transaction isolation level repeatable read read only;
set local statement_timeout='10s';
set local lock_timeout='2s';
with source_tables(name) as (
 values ('notification_events'),('qr_event_outbox'),('payment_webhook_inbox'),('orders'),('room_bookings'),('testimonials'),('reservations'),('inquiries'),('contact_submissions'),('order_support_requests')
), notification_groups as (
 select case when source_type in ('order','room_booking','reservation','inquiry','contact_submission','testimonial','support_request') then source_type else 'other' end source,
 case when status in ('pending','failed','sent','skipped') then status else 'other' end state,
 count(*) event_count,coalesce(extract(epoch from current_timestamp-min(created_at)),0) oldest_seconds from public.notification_events group by 1,2
), queue_metrics(name,value) as (
 select 'qr_unpublished',count(*) from public.qr_event_outbox where published_at is null
 union all select 'qr_due',count(*) from public.qr_event_outbox where published_at is null and next_attempt_at<=current_timestamp
 union all select 'qr_retry_count_at_least_12',count(*) from public.qr_event_outbox where published_at is null and attempt_count>=12
 union all select 'qr_invalid_payload_type',count(*) from public.qr_event_outbox where published_at is null and coalesce(jsonb_typeof(payload),'null')<>'object'
 union all select 'qr_invalid_owner_or_order',count(*) from public.qr_event_outbox q
 left join public.hotels h on h.id=q.property_id and h.tenant_id=q.tenant_id and h.slug=q.hotel_slug
 left join public.orders o on o.id::text=q.aggregate_id and o.tenant_id=q.tenant_id and o.property_id=q.property_id and o.hotel_slug=q.hotel_slug
 where q.published_at is null and (h.id is null or o.id is null or q.aggregate_type<>'order')
 union all select 'qr_unpublished_with_existing_failed_notification',count(*) from public.qr_event_outbox q where q.published_at is null and exists(
 select 1 from public.notification_events n where n.tenant_id=q.tenant_id and n.property_id=q.property_id and n.hotel_slug=q.hotel_slug and n.source_type='order' and n.source_id=q.aggregate_id and n.status='failed' and n.payload @> jsonb_build_object('qrOutboxDeduplicationKey',q.deduplication_key))
 union all select 'qr_published_with_nonterminal_notification',count(*) from public.qr_event_outbox q where q.published_at is not null and exists(
 select 1 from public.notification_events n where n.tenant_id=q.tenant_id and n.property_id=q.property_id and n.hotel_slug=q.hotel_slug and n.source_type='order' and n.source_id=q.aggregate_id and n.status in ('pending','failed') and n.payload @> jsonb_build_object('qrOutboxDeduplicationKey',q.deduplication_key))
 union all select 'notification_failed_retry_count_at_least_3',count(*) from public.notification_events where status='failed' and retry_count>=3
 union all select 'payment_inbox_backlog',count(*) from public.payment_webhook_inbox where status in ('RECEIVED','FAILED','PROCESSING')
 union all select 'payment_inbox_dead_letter',count(*) from public.payment_webhook_inbox where status='DEAD_LETTER'
 union all select 'payment_inbox_expired_processing',count(*) from public.payment_webhook_inbox where status='PROCESSING' and lease_until<current_timestamp
), inventory(section,object_identity,details) as (
 select 'context'::text,'execution'::text,jsonb_build_object('script','TASK7D_WORKER_STATE_V1','captured_at',current_timestamp,'server_version',current_setting('server_version'),'transaction_read_only',current_setting('transaction_read_only'),'scope','METADATA_AND_AGGREGATES_ONLY')
 union all select 'relation','public.'||s.name,jsonb_build_object('present',c.oid is not null,'owner',pg_get_userbyid(c.relowner),'rls_enabled',c.relrowsecurity,'force_rls',c.relforcerowsecurity)
 from source_tables s left join pg_namespace ns on ns.nspname='public' left join pg_class c on c.relnamespace=ns.oid and c.relname=s.name and c.relkind in ('r','p')
 union all select 'worker_column',format('%I.%I.%I',ns.nspname,c.relname,a.attname),jsonb_build_object('type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default_md5',md5(pg_get_expr(d.adbin,d.adrelid)))
 from pg_class c join pg_namespace ns on ns.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
 where ns.nspname='public' and c.relname in ('notification_events','qr_event_outbox','payment_webhook_inbox')
 union all select 'worker_constraint',format('%I.%I.%I',ns.nspname,c.relname,x.conname),jsonb_build_object('type',x.contype,'validated',x.convalidated,'definition_md5',md5(pg_get_constraintdef(x.oid,true)))
 from pg_constraint x join pg_class c on c.oid=x.conrelid join pg_namespace ns on ns.oid=c.relnamespace where ns.nspname='public' and c.relname in ('notification_events','qr_event_outbox','payment_webhook_inbox')
 union all select 'trigger',format('%I.%I.%I',ns.nspname,c.relname,t.tgname),jsonb_build_object('enabled',t.tgenabled,'routine',p.proname,'definition_md5',md5(pg_get_triggerdef(t.oid,true)))
 from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace ns on ns.oid=c.relnamespace join pg_proc p on p.oid=t.tgfoid join source_tables s on s.name=c.relname where ns.nspname='public' and not t.tgisinternal
 union all select 'routine',format('%I.%I(%s)',ns.nspname,p.proname,pg_get_function_identity_arguments(p.oid)),jsonb_build_object('owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,'search_path',(select substr(setting,13) from unnest(p.proconfig) setting where setting like 'search_path=%' limit 1),'configuration_keys',(select jsonb_agg(split_part(setting,'=',1)) from unnest(p.proconfig) setting),'definition_md5',md5(pg_get_functiondef(p.oid)))
 from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proname in ('record_operational_notification_event','claim_payment_webhook','complete_payment_webhook','task3c_apply_canonical_owner')
 union all select 'queue_metric',name,jsonb_build_object('count',value) from queue_metrics
 union all select 'notification_group',source||'/'||state,jsonb_build_object('count',event_count,'oldest_seconds',oldest_seconds) from notification_groups
)
select section,object_identity,details from inventory order by section,object_identity;
commit;
