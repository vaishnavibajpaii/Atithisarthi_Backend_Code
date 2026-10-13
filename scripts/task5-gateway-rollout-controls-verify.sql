-- Task 5 staged rollout controls verification (read-only).
-- USER-RUN CHECKPOINT: execute manually in Supabase SQL Editor after
-- task5-gateway-rollout-controls.sql. Returns metadata only; no secrets/PII.

with checks as (
  select 1 as ordinal, 'rollout_function_manifest'::text as check_name,
    case when count(*) = 2 then 'PASS' else 'FAIL' end as result,
    jsonb_build_object('expected', 2, 'observed', count(*)) as details
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'task5_configure_property_gateway_staged',
      'task5_set_property_gateway_resolution'
    )

  union all

  select 2, 'rollout_functions_restricted_owner',
    case when count(*) = 2 then 'PASS' else 'FAIL' end,
    jsonb_build_object('safe_functions', count(*))
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles r on r.oid = p.proowner
  where n.nspname = 'public'
    and p.proname in (
      'task5_configure_property_gateway_staged',
      'task5_set_property_gateway_resolution'
    )
    and p.prosecdef
    and r.rolname = 'app_payment_gateway_secret_owner'
    and not r.rolsuper and not r.rolbypassrls

  union all

  select 3, 'runtime_uses_staged_config_only',
    case when
      has_function_privilege('app_tenant_runtime',
        'public.task5_configure_property_gateway_staged(text,text,text,text,text,text,text,boolean,text)',
        'EXECUTE')
      and not has_function_privilege('app_tenant_runtime',
        'public.task5_configure_property_gateway(text,text,text,text,text,text,text,boolean,text)',
        'EXECUTE')
      and not has_function_privilege('authenticated',
        'public.task5_configure_property_gateway_staged(text,text,text,text,text,text,text,boolean,text)',
        'EXECUTE')
      and not has_function_privilege('anon',
        'public.task5_configure_property_gateway_staged(text,text,text,text,text,text,text,boolean,text)',
        'EXECUTE')
      then 'PASS' else 'FAIL' end,
    jsonb_build_object(
      'staged_execute', has_function_privilege('app_tenant_runtime',
        'public.task5_configure_property_gateway_staged(text,text,text,text,text,text,text,boolean,text)',
        'EXECUTE'),
      'direct_vault_writer_execute', has_function_privilege('app_tenant_runtime',
        'public.task5_configure_property_gateway(text,text,text,text,text,text,text,boolean,text)',
        'EXECUTE'),
      'authenticated_staged_execute', has_function_privilege('authenticated',
        'public.task5_configure_property_gateway_staged(text,text,text,text,text,text,text,boolean,text)',
        'EXECUTE'),
      'anon_staged_execute', has_function_privilege('anon',
        'public.task5_configure_property_gateway_staged(text,text,text,text,text,text,text,boolean,text)',
        'EXECUTE')
    )

  union all

  select 4, 'runtime_resolution_switch_is_bounded',
    case when
      has_function_privilege('app_tenant_runtime',
        'public.task5_set_property_gateway_resolution(text,text)', 'EXECUTE')
      and not has_function_privilege('authenticated',
        'public.task5_set_property_gateway_resolution(text,text)', 'EXECUTE')
      and not has_function_privilege('anon',
        'public.task5_set_property_gateway_resolution(text,text)', 'EXECUTE')
      then 'PASS' else 'FAIL' end,
    jsonb_build_object(
      'tenant_runtime', has_function_privilege('app_tenant_runtime',
        'public.task5_set_property_gateway_resolution(text,text)', 'EXECUTE'),
      'authenticated', has_function_privilege('authenticated',
        'public.task5_set_property_gateway_resolution(text,text)', 'EXECUTE'),
      'anon', has_function_privilege('anon',
        'public.task5_set_property_gateway_resolution(text,text)', 'EXECUTE')
    )

  union all

  select 5, 'configuration_preserves_resolution_mode',
    case when pg_get_functiondef(
      'public.task5_configure_property_gateway_staged(text,text,text,text,text,text,text,boolean,text)'::regprocedure
    ) like '%v_prior_resolution_mode%'
      and pg_get_functiondef(
      'public.task5_configure_property_gateway_staged(text,text,text,text,text,text,text,boolean,text)'::regprocedure
    ) like '%resolution_mode = v_prior_resolution_mode%'
      then 'PASS' else 'FAIL' end,
    jsonb_build_object('staged_configuration', true)

  union all

  select 6, 'no_direct_gateway_or_vault_runtime_access',
    case when count(*) = 0 then 'PASS' else 'FAIL' end,
    jsonb_build_object('unsafe_grants', count(*))
  from information_schema.role_table_grants g
  where g.grantee = 'app_tenant_runtime'
    and (
      (g.table_schema = 'public' and g.table_name in (
        'payment_gateway_accounts', 'payment_gateway_credentials',
        'payment_gateway_webhook_secrets', 'property_payment_gateway_policies'
      ))
      or g.table_schema = 'vault'
    )
)
select ordinal, check_name, result, details
from checks
order by ordinal;
