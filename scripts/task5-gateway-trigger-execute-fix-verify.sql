-- Task 5 trigger EXECUTE repair verification (READ ONLY).
-- This script reads catalog metadata only and never reads secret material.

begin transaction read only;

with required(function_name, signature) as (
  values
    ('task5_guard_gateway_policy',
      'public.task5_guard_gateway_policy()'),
    ('task5_guard_gateway_account',
      'public.task5_guard_gateway_account()'),
    ('task5_guard_gateway_credential',
      'public.task5_guard_gateway_credential()'),
    ('task5_guard_gateway_webhook_secret',
      'public.task5_guard_gateway_webhook_secret()'),
    ('task5_assert_active_account_ready',
      'public.task5_assert_active_account_ready()')
), function_access as (
  select r.function_name, r.signature,
    has_function_privilege(
      'app_payment_gateway_secret_owner', r.signature, 'EXECUTE'
    ) as restricted_owner_execute,
    has_function_privilege('anon', r.signature, 'EXECUTE')
      or has_function_privilege('authenticated', r.signature, 'EXECUTE')
      or has_function_privilege('app_tenant_runtime', r.signature, 'EXECUTE')
      or has_function_privilege('app_tenant_rpc_owner', r.signature, 'EXECUTE')
      or has_function_privilege('service_role', r.signature, 'EXECUTE')
      as unsafe_execute
  from required r
), verification as (
  select 1 as ordinal, 'trigger_functions_present'::text as check_name,
    count(to_regprocedure(signature)) = 5 as passed,
    jsonb_build_object(
      'observed', count(to_regprocedure(signature)), 'expected', 5
    ) as details
  from required

  union all
  select 2, 'restricted_owner_can_execute_gateway_triggers',
    count(*) filter (where restricted_owner_execute) = 5,
    jsonb_build_object(
      'allowed', count(*) filter (where restricted_owner_execute),
      'expected', 5,
      'missing', coalesce(jsonb_agg(function_name order by function_name)
        filter (where not restricted_owner_execute), '[]'::jsonb)
    )
  from function_access

  union all
  select 3, 'application_roles_cannot_execute_gateway_triggers',
    count(*) filter (where unsafe_execute) = 0,
    jsonb_build_object(
      'unsafe_functions', count(*) filter (where unsafe_execute),
      'expected', 0
    )
  from function_access

  union all
  select 4, 'restricted_owner_remains_nologin',
    exists (
      select 1 from pg_roles
      where rolname = 'app_payment_gateway_secret_owner'
        and not rolcanlogin and not rolsuper and not rolbypassrls
    ),
    jsonb_build_object(
      'safe_role_count', (
        select count(*) from pg_roles
        where rolname = 'app_payment_gateway_secret_owner'
          and not rolcanlogin and not rolsuper and not rolbypassrls
      )
    )
)
select ordinal, check_name,
  case when passed then 'PASS' else 'FAIL' end as result,
  details
from verification
order by ordinal;

rollback;
