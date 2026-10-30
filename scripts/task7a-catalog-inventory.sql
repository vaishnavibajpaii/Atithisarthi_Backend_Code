-- TASK 7A-CATALOG-01: metadata only, PostgreSQL 17 / Supabase.
-- Run this WHOLE file in the SQL Editor of the explicitly identified project.
-- No business rows, routine execution, function bodies, default literals,
-- policy expressions, connection strings, role passwords or Vault data returned.
-- Fingerprints detect drift; they are not proof of migration deployment.
-- READ ONLY. On error, ROLLBACK; do not remove safety controls to get a result.
begin transaction isolation level repeatable read read only;
set local statement_timeout = '30s';
set local lock_timeout = '2s';

with
schemas as (
  select oid, nspname, nspowner, nspacl from pg_namespace
  where nspname not in ('pg_catalog', 'information_schema')
    and nspname not like 'pg_toast%' and nspname not like 'pg_temp%'
),
relations as (
  select c.*, s.nspname from pg_class c join schemas s on s.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
),
routines as (
  select p.*, s.nspname from pg_proc p join schemas s on s.oid = p.pronamespace
  where p.prokind in ('f', 'p', 'w')
),
expected_relations(name) as (
  values ('tenants'), ('hotels'), ('orders'), ('room_bookings'),
    ('room_checkout_receipts'), ('room_checkout_bill_snapshots'),
    ('food_order_bill_snapshots'), ('payment_intents'), ('payment_attempts'),
    ('payment_webhook_inbox'), ('auth_sessions'), ('auth_refresh_token_history'),
    ('auth_security_events'), ('property_payment_gateway_policies'),
    ('payment_gateway_accounts'), ('payment_gateway_credentials'),
    ('payment_gateway_webhook_secrets'), ('payment_gateway_audit_events'),
    ('qr_customer_sessions'), ('qr_idempotency_records'), ('qr_event_outbox'),
    ('notification_events'), ('guest_stays'), ('room_housekeeping_tasks')
),
expected_routines(name) as (
  values ('task6_create_room_booking_atomic'), ('task6_create_order_atomic'),
    ('task6_finalize_room_checkout'), ('task6_finalize_order_family'),
    ('submit_secure_qr_table_order'), ('edit_secure_qr_submission')
),
inventory as (
  select '00_context'::text as section, 'execution'::text as object_identity,
    jsonb_build_object('captured_at', current_timestamp,
      'database', current_database(), 'current_role', current_user,
      'server_version', current_setting('server_version'),
      'transaction_read_only', current_setting('transaction_read_only'),
      'scope', 'CATALOG_ONLY_NO_CUSTOMER_ROWS', 'script_version', 'TASK7A_CATALOG_V1') as details
  union all
  select '01_expected_relation', 'public.' || e.name,
    jsonb_build_object('present', to_regclass('public.' || e.name) is not null)
  from expected_relations e
  union all
  select '02_expected_routine', 'public.' || e.name,
    jsonb_build_object('overloads', (select count(*) from routines p where p.nspname = 'public' and p.proname = e.name))
  from expected_routines e
  union all
  select '03_schema', s.nspname,
    jsonb_build_object('owner', pg_get_userbyid(s.nspowner), 'acl', s.nspacl::text)
  from schemas s
  union all
  select '04_relation', format('%I.%I', c.nspname, c.relname),
    jsonb_build_object('kind', c.relkind, 'owner', pg_get_userbyid(c.relowner),
      'rls_enabled', c.relrowsecurity, 'force_rls', c.relforcerowsecurity,
      'persistence', c.relpersistence, 'acl', c.relacl::text,
      'view_definition_md5', case when c.relkind in ('v','m') then md5(pg_get_viewdef(c.oid, true)) end,
      'security_invoker_view', coalesce('security_invoker=true' = any(c.reloptions), false))
  from relations c
  union all
  select '05_column', format('%I.%I.%I', c.nspname, c.relname, a.attname),
    jsonb_build_object('position', a.attnum, 'type', format_type(a.atttypid, a.atttypmod),
      'not_null', a.attnotnull, 'identity', a.attidentity, 'generated', a.attgenerated,
      'default_present', d.oid is not null,
      'default_expression_md5', case when d.oid is not null then md5(pg_get_expr(d.adbin, d.adrelid)) end,
      'column_acl', a.attacl::text)
  from relations c join pg_attribute a on a.attrelid = c.oid
  left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
  where a.attnum > 0 and not a.attisdropped
  union all
  select '06_constraint', format('%I.%I.%I', c.nspname, c.relname, x.conname),
    jsonb_build_object('type', x.contype, 'validated', x.convalidated,
      'deferrable', x.condeferrable, 'initially_deferred', x.condeferred,
      'columns', (select jsonb_agg(a.attname order by k.ord) from unnest(x.conkey) with ordinality k(attnum, ord)
        join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum),
      'referenced_relation', case when x.confrelid <> 0 then x.confrelid::regclass::text end,
      'referenced_columns', (select jsonb_agg(a.attname order by k.ord) from unnest(x.confkey) with ordinality k(attnum, ord)
        join pg_attribute a on a.attrelid = x.confrelid and a.attnum = k.attnum),
      'definition_md5', md5(pg_get_constraintdef(x.oid, true)))
  from relations c join pg_constraint x on x.conrelid = c.oid
  union all
  select '07_policy', format('%I.%I.%I', c.nspname, c.relname, p.polname),
    jsonb_build_object('command', p.polcmd, 'permissive', p.polpermissive,
      'roles', (select jsonb_agg(case when r = 0 then 'PUBLIC' else pg_get_userbyid(r)::text end order by r) from unnest(p.polroles) r),
      'using_present', p.polqual is not null, 'check_present', p.polwithcheck is not null,
      'using_md5', md5(pg_get_expr(p.polqual, p.polrelid)),
      'check_md5', md5(pg_get_expr(p.polwithcheck, p.polrelid)))
  from relations c join pg_policy p on p.polrelid = c.oid
  union all
  select '08_role', r.rolname,
    jsonb_build_object('superuser', r.rolsuper, 'bypass_rls', r.rolbypassrls,
      'can_login', r.rolcanlogin, 'inherit', r.rolinherit, 'create_role', r.rolcreaterole,
      'create_db', r.rolcreatedb, 'replication', r.rolreplication,
      'connection_limit', r.rolconnlimit, 'owned_application_tables',
        (select count(*) from relations c where c.nspname = 'public' and c.relowner = r.oid and c.relkind in ('r','p')))
  from pg_roles r
  union all
  select '09_membership', format('%I -> %I', pg_get_userbyid(m.member), pg_get_userbyid(m.roleid)),
    jsonb_build_object('grantor', pg_get_userbyid(m.grantor), 'admin', m.admin_option,
      'inherit', m.inherit_option, 'set', m.set_option)
  from pg_auth_members m
  union all
  select '10_routine', format('%I.%I(%s)', p.nspname, p.proname, pg_get_function_identity_arguments(p.oid)),
    jsonb_build_object('owner', pg_get_userbyid(p.proowner), 'kind', p.prokind,
      'security_definer', p.prosecdef, 'volatility', p.provolatile, 'parallel', p.proparallel,
      'language', l.lanname, 'acl', p.proacl::text,
      'search_path', (select split_part(v, '=', 2) from unnest(p.proconfig) v where v like 'search_path=%' limit 1),
      'configuration_keys', (select jsonb_agg(split_part(v, '=', 1) order by v) from unnest(p.proconfig) v),
      'definition_md5', md5(pg_get_functiondef(p.oid)),
      'extension', (select e.extname from pg_depend d join pg_extension e on e.oid = d.refobjid
        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e' limit 1))
  from routines p join pg_language l on l.oid = p.prolang
  union all
  select '11_trigger', format('%I.%I.%I', c.nspname, c.relname, t.tgname),
    jsonb_build_object('enabled', t.tgenabled, 'internal', t.tgisinternal,
      'function', t.tgfoid::regprocedure::text, 'definition_md5', md5(pg_get_triggerdef(t.oid, true)))
  from relations c join pg_trigger t on t.tgrelid = c.oid
  union all
  select '12_index', format('%I.%I', c.nspname, idx.relname),
    jsonb_build_object('table', c.relname, 'valid', i.indisvalid, 'ready', i.indisready,
      'unique', i.indisunique, 'primary', i.indisprimary, 'exclusion', i.indisexclusion,
      'definition_md5', md5(pg_get_indexdef(i.indexrelid)),
      'predicate_md5', md5(pg_get_expr(i.indpred, i.indrelid)))
  from relations c join pg_index i on i.indrelid = c.oid join pg_class idx on idx.oid = i.indexrelid
  union all
  select '13_extension', e.extname,
    jsonb_build_object('version', e.extversion, 'schema', n.nspname, 'owner', pg_get_userbyid(e.extowner))
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace
  union all
  select '14_default_privilege', format('%I/%s/%s', pg_get_userbyid(d.defaclrole), coalesce(n.nspname, '*'), d.defaclobjtype),
    jsonb_build_object('acl', d.defaclacl::text)
  from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
  union all
  select '15_setting', name, jsonb_build_object('value', setting, 'unit', unit, 'source', source)
  from pg_settings where name in ('server_version', 'max_connections', 'statement_timeout', 'lock_timeout',
    'idle_in_transaction_session_timeout', 'row_security', 'default_transaction_read_only',
    'log_min_duration_statement', 'track_activities', 'track_counts', 'shared_preload_libraries', 'TimeZone')
  union all
  select '16_effective_table_privilege', format('%I/%I.%I', r.rolname, c.nspname, c.relname),
    jsonb_build_object('select', has_table_privilege(r.oid,c.oid,'SELECT'),
      'insert', has_table_privilege(r.oid,c.oid,'INSERT'), 'update', has_table_privilege(r.oid,c.oid,'UPDATE'),
      'delete', has_table_privilege(r.oid,c.oid,'DELETE'), 'truncate', has_table_privilege(r.oid,c.oid,'TRUNCATE'))
  from relations c cross join pg_roles r
  where c.nspname in ('public','storage','vault') and c.relkind in ('r','p','v','m')
    and r.rolname in ('anon','authenticated','app_tenant_runtime','app_tenant_rpc_owner','service_role')
  union all
  select '17_effective_routine_privilege', format('%I/%I.%I(%s)', r.rolname, p.nspname, p.proname, pg_get_function_identity_arguments(p.oid)),
    jsonb_build_object('execute', has_function_privilege(r.oid,p.oid,'EXECUTE'))
  from routines p cross join pg_roles r
  where p.nspname in ('public','vault')
    and r.rolname in ('anon','authenticated','app_tenant_runtime','app_tenant_rpc_owner','service_role')
  union all
  select '18_effective_sequence_privilege', format('%I/%I.%I', r.rolname, c.nspname, c.relname),
    jsonb_build_object('usage', has_sequence_privilege(r.oid,c.oid,'USAGE'),
      'select', has_sequence_privilege(r.oid,c.oid,'SELECT'), 'update', has_sequence_privilege(r.oid,c.oid,'UPDATE'))
  from relations c cross join pg_roles r
  where c.nspname = 'public' and c.relkind = 'S'
    and r.rolname in ('anon','authenticated','app_tenant_runtime','app_tenant_rpc_owner','service_role')
  union all
  select '19_effective_schema_privilege', format('%I/%I', r.rolname, s.nspname),
    jsonb_build_object('usage', has_schema_privilege(r.oid,s.oid,'USAGE'), 'create', has_schema_privilege(r.oid,s.oid,'CREATE'))
  from schemas s cross join pg_roles r
  where s.nspname in ('public','storage','vault')
    and r.rolname in ('anon','authenticated','app_tenant_runtime','app_tenant_rpc_owner','service_role')
  union all
  select '20_optional_evidence', name,
    jsonb_build_object('present', to_regclass(name) is not null, 'row_data_read', false)
  from (values ('storage.buckets'), ('cron.job'), ('supabase_migrations.schema_migrations'), ('vault.secrets')) o(name)
)
select section, object_identity, details from inventory order by section, object_identity;

commit;
