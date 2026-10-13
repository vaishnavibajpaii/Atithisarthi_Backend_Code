-- Task 5 secure deferred-trigger repair verification (READ ONLY).

begin transaction read only;

with verification as (
  select 1 as ordinal,
    'readiness_trigger_is_restricted_security_definer'::text as check_name,
    exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_roles r on r.oid = p.proowner
      where n.nspname = 'public'
        and p.proname = 'task5_assert_active_account_ready'
        and p.prosecdef
        and r.rolname = 'app_payment_gateway_secret_owner'
        and not r.rolcanlogin
        and not r.rolsuper
        and not r.rolbypassrls
        and p.proconfig @> array['search_path=pg_catalog, public']
    ) as passed,
    jsonb_build_object(
      'safe_functions', (
        select count(*)
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join pg_roles r on r.oid = p.proowner
        where n.nspname = 'public'
          and p.proname = 'task5_assert_active_account_ready'
          and p.prosecdef
          and r.rolname = 'app_payment_gateway_secret_owner'
          and not r.rolcanlogin
          and not r.rolsuper
          and not r.rolbypassrls
          and p.proconfig @> array['search_path=pg_catalog, public']
      )
    ) as details

  union all
  select 2, 'application_roles_cannot_call_readiness_trigger',
    not has_function_privilege(
      'anon', 'public.task5_assert_active_account_ready()', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'public.task5_assert_active_account_ready()', 'EXECUTE'
    )
    and not has_function_privilege(
      'app_tenant_runtime', 'public.task5_assert_active_account_ready()', 'EXECUTE'
    )
    and not has_function_privilege(
      'service_role', 'public.task5_assert_active_account_ready()', 'EXECUTE'
    ),
    jsonb_build_object(
      'unsafe_role_count',
        (case when has_function_privilege(
          'anon', 'public.task5_assert_active_account_ready()', 'EXECUTE'
        ) then 1 else 0 end)
        + (case when has_function_privilege(
          'authenticated', 'public.task5_assert_active_account_ready()', 'EXECUTE'
        ) then 1 else 0 end)
        + (case when has_function_privilege(
          'app_tenant_runtime', 'public.task5_assert_active_account_ready()', 'EXECUTE'
        ) then 1 else 0 end)
        + (case when has_function_privilege(
          'service_role', 'public.task5_assert_active_account_ready()', 'EXECUTE'
        ) then 1 else 0 end)
    )

  union all
  select 3, 'tenant_runtime_still_has_no_gateway_table_access',
    not exists (
      select 1
      from information_schema.role_table_grants g
      where g.grantee = 'app_tenant_runtime'
        and g.table_schema in ('public', 'vault')
        and (
          g.table_name in (
            'property_payment_gateway_policies',
            'payment_gateway_accounts',
            'payment_gateway_credentials',
            'payment_gateway_webhook_secrets',
            'payment_gateway_audit_events'
          )
          or g.table_schema = 'vault'
        )
    ),
    jsonb_build_object(
      'unsafe_grants', (
        select count(*)
        from information_schema.role_table_grants g
        where g.grantee = 'app_tenant_runtime'
          and g.table_schema in ('public', 'vault')
          and (
            g.table_name in (
              'property_payment_gateway_policies',
              'payment_gateway_accounts',
              'payment_gateway_credentials',
              'payment_gateway_webhook_secrets',
              'payment_gateway_audit_events'
            )
            or g.table_schema = 'vault'
          )
      )
    )

  union all
  select 4, 'readiness_constraint_remains_deferred',
    count(*) = 3,
    jsonb_build_object('deferred_triggers', count(*), 'expected', 3)
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and t.tgname in (
      'task5_gateway_account_ready_constraint_trg',
      'task5_gateway_credential_ready_constraint_trg',
      'task5_gateway_webhook_ready_constraint_trg'
    )
    and t.tgconstraint <> 0
    and exists (
      select 1 from pg_constraint con
      where con.oid = t.tgconstraint
        and con.condeferrable
        and con.condeferred
    )
)
select ordinal, check_name,
  case when passed then 'PASS' else 'FAIL' end as result,
  details
from verification
order by ordinal;

rollback;
