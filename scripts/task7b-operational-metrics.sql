-- Task 7B manual operational snapshot. NOT executed by the agent.
-- Confirm target/project and catalog first. READ ONLY; aggregate counts only.
-- No guest data, payloads, raw SQL, credentials, intent/job IDs or error messages.
begin transaction isolation level repeatable read read only;
set local statement_timeout = '10s';
set local lock_timeout = '2s';

with metrics as (
  select 'payment_intents_pending'::text metric, count(*)::numeric value
  from public.payment_intents where status not in ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'FAILED', 'CANCELLED')
  union all
  select 'payments_captured_not_finalized', count(*) from public.payment_intents
  where lower(coalesce(provider_status, '')) = 'captured' and status not in ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')
  union all
  select 'payment_reconciliation_required', count(*) from public.payment_intents where requires_reconciliation
  union all
  select 'webhook_backlog', count(*) from public.payment_webhook_inbox where status in ('RECEIVED', 'FAILED', 'PROCESSING')
  union all
  select 'webhook_oldest_backlog_seconds', coalesce(extract(epoch from (current_timestamp - min(received_at))), 0)
  from public.payment_webhook_inbox where status in ('RECEIVED', 'FAILED', 'PROCESSING')
  union all
  select 'webhook_dead_letter', count(*) from public.payment_webhook_inbox where status = 'DEAD_LETTER'
  union all
  select 'webhook_expired_processing_lease', count(*) from public.payment_webhook_inbox
  where status = 'PROCESSING' and lease_until < current_timestamp
  union all
  select 'notification_pending', count(*) from public.notification_events where status = 'pending'
  union all
  select 'notification_failed', count(*) from public.notification_events where status = 'failed'
  union all
  select 'notification_retry_exhausted', count(*) from public.notification_events where status = 'failed' and retry_count >= 3
  union all
  select 'qr_outbox_unpublished', count(*) from public.qr_event_outbox where published_at is null
  union all
  select 'qr_outbox_oldest_unpublished_seconds', coalesce(extract(epoch from (current_timestamp - min(created_at))), 0)
  from public.qr_event_outbox where published_at is null
  union all
  select 'database_backends', numbackends from pg_stat_database where datname = current_database()
  union all
  select 'database_deadlocks_since_stats_reset', deadlocks from pg_stat_database where datname = current_database()
  union all
  select 'database_rollbacks_since_stats_reset', xact_rollback from pg_stat_database where datname = current_database()
  union all
  select 'database_waiting_locks', count(*) from pg_locks
  where not granted and database = (select oid from pg_database where datname = current_database())
)
select current_timestamp as observed_at, metric, value from metrics order by metric;

commit;
