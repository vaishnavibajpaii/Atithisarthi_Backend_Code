-- Task 5 runtime RPC verification. READ ONLY. Returns PASS/FAIL rows only.
-- It never reads Vault values, webhook payloads, payment payloads, or PII.

with checks as (
  select 1 as ordinal, 'runtime_rpc_manifest'::text as check_name,
    case when count(*) = 9 then 'PASS' else 'FAIL' end as result,
    jsonb_build_object('expected', 9, 'observed', count(*)) as details
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in (
    'task5_get_property_gateway_policy_internal',
    'task5_resolve_active_gateway_credential',
    'task5_resolve_bound_gateway_credential',
    'task5_resolve_webhook_candidates_internal',
    'task5_get_property_gateway_status',
    'task5_configure_property_gateway',
    'task5_set_property_gateway_enabled',
    'task5_configure_property_gateway_staged',
    'task5_set_property_gateway_resolution'
  )

  union all
  select 2, 'runtime_rpc_restricted_owner',
    case when count(*) = 9 then 'PASS' else 'FAIL' end,
    jsonb_build_object('safe_functions', count(*))
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles r on r.oid = p.proowner
  where n.nspname = 'public' and p.proname in (
    'task5_get_property_gateway_policy_internal',
    'task5_resolve_active_gateway_credential',
    'task5_resolve_bound_gateway_credential',
    'task5_resolve_webhook_candidates_internal',
    'task5_get_property_gateway_status',
    'task5_configure_property_gateway',
    'task5_set_property_gateway_enabled',
    'task5_configure_property_gateway_staged',
    'task5_set_property_gateway_resolution'
  ) and p.prosecdef and r.rolname = 'app_payment_gateway_secret_owner'
    and not r.rolsuper and not r.rolbypassrls

  union all
  select 3, 'hotel_roles_cannot_execute_secret_resolvers',
    case when unsafe_count = 0 then 'PASS' else 'FAIL' end,
    jsonb_build_object('unsafe_grants', unsafe_count)
  from (
    select count(*) as unsafe_count
    from (values ('anon'), ('authenticated'), ('service_role')) roles(role_name)
    cross join (values
      ('public.task5_resolve_active_gateway_credential(text)'),
      ('public.task5_resolve_bound_gateway_credential(uuid,text,text)')
    ) funcs(signature)
    where has_function_privilege(roles.role_name, funcs.signature, 'EXECUTE')
  ) q

  union all
  select 4, 'tenant_runtime_point_of_use_only',
    case when allowed_count = 6 and forbidden_count = 0 then 'PASS' else 'FAIL' end,
    jsonb_build_object('allowed_functions', allowed_count, 'forbidden_functions', forbidden_count)
  from (
    select
      (select count(*) from (values
        ('public.task5_resolve_active_gateway_credential(text)'),
        ('public.task5_resolve_bound_gateway_credential(uuid,text,text)'),
        ('public.task5_get_property_gateway_status()'),
        ('public.task5_configure_property_gateway_staged(text,text,text,text,text,text,text,boolean,text)'),
        ('public.task5_set_property_gateway_enabled(boolean,text)'),
        ('public.task5_set_property_gateway_resolution(text,text)')
      ) f(signature)
      where has_function_privilege('app_tenant_runtime', f.signature, 'EXECUTE')) as allowed_count,
      (select count(*) from (values
        ('public.task5_get_property_gateway_policy_internal(uuid,bigint,text)'),
        ('public.task5_resolve_webhook_candidates_internal(text)'),
        ('public.task5_configure_property_gateway(text,text,text,text,text,text,text,boolean,text)')
      ) f(signature)
      where has_function_privilege('app_tenant_runtime', f.signature, 'EXECUTE')) as forbidden_count
  ) q

  union all
  select 5, 'service_webhook_surface_bounded',
    case when policy_exec and webhook_exec and not active_exec and not bound_exec
      then 'PASS' else 'FAIL' end,
    jsonb_build_object(
      'policy_lookup', policy_exec,
      'webhook_candidates', webhook_exec,
      'active_credential', active_exec,
      'bound_credential', bound_exec
    )
  from (
    select
      has_function_privilege('service_role', 'public.task5_get_property_gateway_policy_internal(uuid,bigint,text)', 'EXECUTE') policy_exec,
      has_function_privilege('service_role', 'public.task5_resolve_webhook_candidates_internal(text)', 'EXECUTE') webhook_exec,
      has_function_privilege('service_role', 'public.task5_resolve_active_gateway_credential(text)', 'EXECUTE') active_exec,
      has_function_privilege('service_role', 'public.task5_resolve_bound_gateway_credential(uuid,text,text)', 'EXECUTE') bound_exec
  ) q

  union all
  select 6, 'webhook_selector_policy_is_narrow',
    case when count(*) = 1 then 'PASS' else 'FAIL' end,
    jsonb_build_object('matching_policies', count(*))
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'payment_gateway_accounts'
    and p.polname = 'task5_webhook_ref_selector'
    and (select oid from pg_roles where rolname = 'app_payment_gateway_secret_owner') = any(p.polroles)
    and pg_get_expr(p.polqual, p.polrelid) like '%app.task5_webhook_ref%'

  union all
  select 7, 'no_direct_gateway_or_vault_runtime_access',
    case when unsafe_count = 0 then 'PASS' else 'FAIL' end,
    jsonb_build_object('unsafe_grants', unsafe_count)
  from (
    select count(*) as unsafe_count
    from (values ('app_tenant_runtime'), ('anon'), ('authenticated')) roles(role_name)
    cross join (values
      ('public.property_payment_gateway_policies'),
      ('public.payment_gateway_accounts'),
      ('public.payment_gateway_credentials'),
      ('public.payment_gateway_webhook_secrets'),
      ('vault.decrypted_secrets')
    ) objects(object_name)
    where has_table_privilege(roles.role_name, objects.object_name, 'SELECT')
       or has_table_privilege(roles.role_name, objects.object_name, 'INSERT')
       or has_table_privilege(roles.role_name, objects.object_name, 'UPDATE')
       or has_table_privilege(roles.role_name, objects.object_name, 'DELETE')
  ) q

  union all
  select 8, 'secret_columns_remain_vault_references_only',
    case when plaintext_count = 0 and vault_ref_count = 2 then 'PASS' else 'FAIL' end,
    jsonb_build_object('plaintext_secret_columns', plaintext_count, 'vault_uuid_columns', vault_ref_count)
  from (
    select
      count(*) filter (where column_name in (
        'key_secret', 'webhook_secret', 'secret', 'secret_value', 'encrypted_secret'
      )) as plaintext_count,
      count(*) filter (where column_name = 'secret_vault_id' and data_type = 'uuid') as vault_ref_count
    from information_schema.columns
    where table_schema = 'public'
      and table_name in ('payment_gateway_credentials', 'payment_gateway_webhook_secrets')
  ) q
)
select ordinal, check_name, result, details
from checks
order by ordinal;
