-- Task 5 per-hotel gateway permission diagnostics (READ ONLY)
--
-- Purpose:
--   Identify the narrow PostgreSQL privilege missing from the staged gateway
--   configuration path. This script reads catalog metadata only. It does not
--   read Vault secrets, gateway secret values, payment payloads, or PII.

begin transaction read only;

with checks as (
  select 1 as ordinal, 'restricted_owner_shape'::text as check_name,
    exists (
      select 1
      from pg_roles
      where rolname = 'app_payment_gateway_secret_owner'
        and not rolcanlogin
        and not rolsuper
        and not rolcreatedb
        and not rolcreaterole
        and not rolinherit
        and not rolreplication
        and not rolbypassrls
    ) as passed,
    jsonb_build_object(
      'role_present', exists (
        select 1 from pg_roles
        where rolname = 'app_payment_gateway_secret_owner'
      )
    ) as details

  union all
  select 2, 'configuration_function_ownership',
    count(*) = 2,
    jsonb_build_object('safe_functions', count(*), 'expected', 2)
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles r on r.oid = p.proowner
  where n.nspname = 'public'
    and p.proname in (
      'task5_configure_property_gateway',
      'task5_configure_property_gateway_staged'
    )
    and p.prosecdef
    and r.rolname = 'app_payment_gateway_secret_owner'

  union all
  select 3, 'configuration_function_execute_chain',
    has_function_privilege(
      'app_tenant_runtime',
      'public.task5_configure_property_gateway_staged(text,text,text,text,text,text,text,boolean,text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'app_payment_gateway_secret_owner',
      'public.task5_configure_property_gateway_staged(text,text,text,text,text,text,text,boolean,text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'app_payment_gateway_secret_owner',
      'public.task5_configure_property_gateway(text,text,text,text,text,text,text,boolean,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'app_tenant_runtime',
      'public.task5_configure_property_gateway(text,text,text,text,text,text,text,boolean,text)',
      'EXECUTE'
    ),
    jsonb_build_object(
      'runtime_staged_execute', has_function_privilege(
        'app_tenant_runtime',
        'public.task5_configure_property_gateway_staged(text,text,text,text,text,text,text,boolean,text)',
        'EXECUTE'
      ),
      'owner_staged_execute', has_function_privilege(
        'app_payment_gateway_secret_owner',
        'public.task5_configure_property_gateway_staged(text,text,text,text,text,text,text,boolean,text)',
        'EXECUTE'
      ),
      'owner_internal_writer_execute', has_function_privilege(
        'app_payment_gateway_secret_owner',
        'public.task5_configure_property_gateway(text,text,text,text,text,text,text,boolean,text)',
        'EXECUTE'
      ),
      'runtime_internal_writer_execute', has_function_privilege(
        'app_tenant_runtime',
        'public.task5_configure_property_gateway(text,text,text,text,text,text,text,boolean,text)',
        'EXECUTE'
      )
    )

  union all
  select 4, 'restricted_owner_gateway_table_dml',
    count(*) filter (where allowed) = 14,
    jsonb_build_object(
      'allowed_privileges', count(*) filter (where allowed),
      'expected', 14,
      'missing', coalesce(jsonb_agg(
        jsonb_build_object('table', table_name, 'privilege', privilege)
        order by table_name, privilege
      ) filter (where not allowed), '[]'::jsonb)
    )
  from (
    select required.table_name, required.privilege,
      has_table_privilege(
        'app_payment_gateway_secret_owner',
        format('public.%I', required.table_name),
        required.privilege
      ) as allowed
    from (values
      ('property_payment_gateway_policies', 'SELECT'),
      ('property_payment_gateway_policies', 'INSERT'),
      ('property_payment_gateway_policies', 'UPDATE'),
      ('payment_gateway_accounts', 'SELECT'),
      ('payment_gateway_accounts', 'INSERT'),
      ('payment_gateway_accounts', 'UPDATE'),
      ('payment_gateway_credentials', 'SELECT'),
      ('payment_gateway_credentials', 'INSERT'),
      ('payment_gateway_credentials', 'UPDATE'),
      ('payment_gateway_webhook_secrets', 'SELECT'),
      ('payment_gateway_webhook_secrets', 'INSERT'),
      ('payment_gateway_webhook_secrets', 'UPDATE'),
      ('payment_gateway_audit_events', 'SELECT'),
      ('payment_gateway_audit_events', 'INSERT')
    ) as required(table_name, privilege)
  ) table_checks

  union all
  select 5, 'restricted_owner_trigger_function_execute',
    count(*) filter (where allowed) = 5,
    jsonb_build_object(
      'allowed_functions', count(*) filter (where allowed),
      'expected', 5,
      'missing', coalesce(jsonb_agg(function_name order by function_name)
        filter (where not allowed), '[]'::jsonb)
    )
  from (
    select required.function_name,
      has_function_privilege(
        'app_payment_gateway_secret_owner',
        format('public.%I()', required.function_name),
        'EXECUTE'
      ) as allowed
    from (values
      ('task5_guard_gateway_policy'),
      ('task5_guard_gateway_account'),
      ('task5_guard_gateway_credential'),
      ('task5_guard_gateway_webhook_secret'),
      ('task5_assert_active_account_ready')
    ) as required(function_name)
  ) trigger_checks

  union all
  select 6, 'restricted_owner_schema_usage',
    has_schema_privilege('app_payment_gateway_secret_owner', 'public', 'USAGE')
    and has_schema_privilege('app_payment_gateway_secret_owner', 'vault', 'USAGE'),
    jsonb_build_object(
      'public_usage', has_schema_privilege(
        'app_payment_gateway_secret_owner', 'public', 'USAGE'
      ),
      'vault_usage', has_schema_privilege(
        'app_payment_gateway_secret_owner', 'vault', 'USAGE'
      )
    )

  union all
  select 7, 'restricted_owner_vault_access',
    has_table_privilege(
      'app_payment_gateway_secret_owner', 'vault.decrypted_secrets', 'SELECT'
    )
    and exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'vault'
        and p.proname = 'create_secret'
        and p.prosecdef
        and p.pronargs >= 3
        and has_function_privilege(
          'app_payment_gateway_secret_owner', p.oid, 'EXECUTE'
        )
    ),
    jsonb_build_object(
      'decrypted_view_select', has_table_privilege(
        'app_payment_gateway_secret_owner', 'vault.decrypted_secrets', 'SELECT'
      ),
      'callable_security_definer_create_secret_overloads', (
        select count(*)
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'vault'
          and p.proname = 'create_secret'
          and p.prosecdef
          and p.pronargs >= 3
          and has_function_privilege(
            'app_payment_gateway_secret_owner', p.oid, 'EXECUTE'
          )
      )
    )

  union all
  select 8, 'uuid_generator_access',
    count(*) filter (where callable) > 0,
    jsonb_build_object(
      'callable_candidates', count(*) filter (where callable),
      'candidates', coalesce(jsonb_agg(
        jsonb_build_object(
          'schema', schema_name,
          'schema_usage', schema_usage,
          'execute', function_execute
        ) order by schema_name
      ), '[]'::jsonb)
    )
  from (
    select n.nspname as schema_name,
      has_schema_privilege(
        'app_payment_gateway_secret_owner', n.oid, 'USAGE'
      ) as schema_usage,
      has_function_privilege(
        'app_payment_gateway_secret_owner', p.oid, 'EXECUTE'
      ) as function_execute,
      has_schema_privilege(
        'app_payment_gateway_secret_owner', n.oid, 'USAGE'
      ) and has_function_privilege(
        'app_payment_gateway_secret_owner', p.oid, 'EXECUTE'
      ) as callable
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'gen_random_uuid'
      and p.pronargs = 0
  ) uuid_candidates

  union all
  select 9, 'gateway_rls_policy_coverage',
    count(*) = 15,
    jsonb_build_object('matching_policies', count(*), 'expected', 15)
  from pg_policies
  where schemaname = 'public'
    and tablename in (
      'property_payment_gateway_policies',
      'payment_gateway_accounts',
      'payment_gateway_credentials',
      'payment_gateway_webhook_secrets',
      'payment_gateway_audit_events'
    )
    and 'app_payment_gateway_secret_owner' = any(roles)

  union all
  select 10, 'gateway_tables_force_rls',
    count(*) = 5,
    jsonb_build_object('force_rls_tables', count(*), 'expected', 5)
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in (
      'property_payment_gateway_policies',
      'payment_gateway_accounts',
      'payment_gateway_credentials',
      'payment_gateway_webhook_secrets',
      'payment_gateway_audit_events'
    )
    and c.relrowsecurity
    and c.relforcerowsecurity
)
select ordinal, check_name,
  case when passed then 'PASS' else 'FAIL' end as result,
  details
from checks
order by ordinal;

rollback;
