-- Task 7C follow-up, READ ONLY. Run only in the same confirmed source project.
-- Bucket configuration, schema authority and policy metadata only.
-- No object paths/content, customer rows, secret/Vault rows or routine bodies.
begin transaction isolation level repeatable read read only;
set local statement_timeout = '10s';
set local lock_timeout = '2s';

with inventory as (
  select 'context'::text section, 'execution'::text object_identity,
    jsonb_build_object('captured_at', current_timestamp, 'server_version', current_setting('server_version'),
      'transaction_read_only', current_setting('transaction_read_only'), 'script', 'TASK7C_STORAGE_SECURITY_V1') details
  union all
  select 'bucket', id,
    jsonb_build_object('public', public, 'file_size_limit', file_size_limit, 'allowed_mime_types', allowed_mime_types)
  from storage.buckets
  union all
  select 'schema_privilege', format('%I/%I', r.rolname, n.nspname),
    jsonb_build_object('usage', has_schema_privilege(r.oid, n.oid, 'USAGE'), 'create', has_schema_privilege(r.oid, n.oid, 'CREATE'))
  from pg_roles r cross join pg_namespace n
  where r.rolname in ('anon', 'authenticated', 'app_tenant_runtime', 'app_tenant_rpc_owner', 'app_auth_rpc_owner', 'app_payment_gateway_secret_owner')
    and n.nspname in ('public', 'storage', 'vault')
  union all
  select 'storage_policy', format('%I.%I.%I', n.nspname, c.relname, p.polname),
    jsonb_build_object('command', p.polcmd, 'permissive', p.polpermissive,
      'roles', (select jsonb_agg(case when role_oid = 0 then 'PUBLIC' else pg_get_userbyid(role_oid)::text end)
        from unnest(p.polroles) role_oid),
      'using_md5', md5(pg_get_expr(p.polqual, p.polrelid)), 'check_md5', md5(pg_get_expr(p.polwithcheck, p.polrelid)))
  from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'storage'
  union all
  select 'effective_storage_privilege', format('%I/%I.%I', r.rolname, n.nspname, c.relname),
    jsonb_build_object('select', has_table_privilege(r.oid,c.oid,'SELECT'), 'insert', has_table_privilege(r.oid,c.oid,'INSERT'),
      'update', has_table_privilege(r.oid,c.oid,'UPDATE'), 'delete', has_table_privilege(r.oid,c.oid,'DELETE'))
  from pg_roles r cross join pg_class c join pg_namespace n on n.oid = c.relnamespace
  where r.rolname in ('anon', 'authenticated', 'app_tenant_runtime', 'app_tenant_rpc_owner', 'app_auth_rpc_owner', 'app_payment_gateway_secret_owner')
    and n.nspname in ('storage','vault') and c.relkind in ('r','p','v')
)
select section, object_identity, details from inventory order by section, object_identity;

commit;
