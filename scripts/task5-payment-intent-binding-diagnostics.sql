-- Task 5 read-only diagnostic: PaymentIntent BYOG binding failure.
--
-- This script inspects only PostgreSQL metadata, privilege booleans, policy
-- definitions, and aggregate counts. It does not return gateway secrets,
-- Vault values, payment payloads, payment identifiers, hotel identifiers, or
-- customer data. Run it in the Supabase SQL Editor as the database owner.

with
target_roles as (
  select oid, rolname, rolcanlogin, rolsuper, rolbypassrls
  from pg_roles
  where rolname in ('app_tenant_rpc_owner', 'app_tenant_runtime')
),
payment_intent_triggers as (
  select
    t.tgname,
    p.proname as function_name,
    t.tgenabled,
    pg_get_triggerdef(t.oid, true) as trigger_definition
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_proc p on p.oid = t.tgfoid
  where n.nspname = 'public'
    and c.relname = 'payment_intents'
    and not t.tgisinternal
    and pg_get_triggerdef(t.oid, true) ilike '%before%insert%'
),
ordered_relevant_triggers as (
  select *
  from payment_intent_triggers
  where function_name in (
    'task3c_apply_canonical_owner',
    'task5_guard_payment_intent_gateway_binding'
  )
),
target_functions as (
  select
    p.oid,
    p.proname,
    r.rolname as owner_name,
    p.prosecdef,
    p.proconfig,
    lower(pg_get_functiondef(p.oid)) as function_definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles r on r.oid = p.proowner
  where n.nspname = 'public'
    and p.proname in (
      'task3c_apply_canonical_owner',
      'task5_guard_payment_intent_gateway_binding'
    )
    and pg_get_function_identity_arguments(p.oid) = ''
),
gateway_select_policies as (
  select
    c.relname as table_name,
    p.polname,
    pg_get_expr(p.polqual, p.polrelid) as using_expression,
    p.polroles
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in (
      'payment_gateway_accounts',
      'payment_gateway_credentials'
    )
    and p.polname = 'task5_tenant_select'
),
configured_bindings as (
  select
    count(*) filter (
      where policy.resolution_mode = 'PER_PROPERTY'
    ) as per_property_policies,
    count(*) filter (
      where policy.resolution_mode = 'PER_PROPERTY'
        and exists (
          select 1
          from public.payment_gateway_accounts account
          join public.payment_gateway_credentials credential
            on credential.account_id = account.id
           and credential.tenant_id = account.tenant_id
           and credential.property_id = account.property_id
           and credential.status = 'ACTIVE'
          where account.tenant_id = policy.tenant_id
            and account.property_id = policy.property_id
            and account.provider = policy.provider
            and account.mode = policy.mode
            and account.status = 'ACTIVE'
        )
    ) as complete_active_bindings
  from public.property_payment_gateway_policies policy
)
select
  1 as ordinal,
  'payment_intent_before_insert_trigger_order' as check_name,
  case
    when (select count(*) from ordered_relevant_triggers) = 2
     and (select tgname from ordered_relevant_triggers
          where function_name = 'task3c_apply_canonical_owner')
         <
         (select tgname from ordered_relevant_triggers
          where function_name = 'task5_guard_payment_intent_gateway_binding')
    then 'PASS'
    else 'FAIL'
  end as result,
  jsonb_build_object(
    'expected_relevant_triggers', 2,
    'observed_relevant_triggers', (select count(*) from ordered_relevant_triggers),
    'firing_order', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'trigger', tgname,
          'function', function_name,
          'enabled', tgenabled
        ) order by tgname
      )
      from ordered_relevant_triggers
    ), '[]'::jsonb)
  ) as details

union all

select
  2,
  'binding_function_restricted_security_definer',
  case when (
    select count(*) = 1
    from target_functions
    where proname = 'task5_guard_payment_intent_gateway_binding'
      and owner_name = 'app_tenant_rpc_owner'
      and prosecdef
      and proconfig @> array['search_path=pg_catalog, public']
  ) then 'PASS' else 'FAIL' end,
  jsonb_build_object(
    'matching_functions', (
      select count(*)
      from target_functions
      where proname = 'task5_guard_payment_intent_gateway_binding'
        and owner_name = 'app_tenant_rpc_owner'
        and prosecdef
        and proconfig @> array['search_path=pg_catalog, public']
    )
  )

union all

select
  3,
  'canonical_owner_trigger_shape',
  case when (
    select count(*) = 1
    from target_functions
    where proname = 'task3c_apply_canonical_owner'
      and prosecdef
      and function_definition like '%from public.hotels%'
      and function_definition like '%new.tenant_id := expected_tenant%'
      and function_definition like '%new.property_id := expected_property%'
  ) then 'PASS' else 'FAIL' end,
  jsonb_build_object(
    'canonical_lookup_present', coalesce((
      select function_definition like '%from public.hotels%'
      from target_functions
      where proname = 'task3c_apply_canonical_owner'
    ), false),
    'canonical_assignment_present', coalesce((
      select function_definition like '%new.tenant_id := expected_tenant%'
         and function_definition like '%new.property_id := expected_property%'
      from target_functions
      where proname = 'task3c_apply_canonical_owner'
    ), false)
  )

union all

select
  4,
  'binding_function_has_no_tenant_context_setup',
  case when (
    select count(*) = 1
    from target_functions
    where proname = 'task5_guard_payment_intent_gateway_binding'
      and function_definition not like '%set_config(%'
      and function_definition not like '%app.tenant_id%'
      and function_definition not like '%app.property_id%'
  ) then 'CONFIRMED' else 'NOT_CONFIRMED' end,
  jsonb_build_object(
    'sets_transaction_context', coalesce((
      select function_definition like '%set_config(%'
          or function_definition like '%app.tenant_id%'
          or function_definition like '%app.property_id%'
      from target_functions
      where proname = 'task5_guard_payment_intent_gateway_binding'
    ), false)
  )

union all

select
  5,
  'gateway_select_policies_require_transaction_context',
  case when (
    select count(*) = 2
    from gateway_select_policies policy
    join target_roles owner_role
      on owner_role.rolname = 'app_tenant_rpc_owner'
     and owner_role.oid = any(policy.polroles)
    where policy.using_expression like '%app.tenant_id%'
      and policy.using_expression like '%app.property_id%'
  ) then 'PASS' else 'FAIL' end,
  jsonb_build_object(
    'expected_context_policies', 2,
    'observed_context_policies', (
      select count(*)
      from gateway_select_policies policy
      join target_roles owner_role
        on owner_role.rolname = 'app_tenant_rpc_owner'
       and owner_role.oid = any(policy.polroles)
      where policy.using_expression like '%app.tenant_id%'
        and policy.using_expression like '%app.property_id%'
    )
  )

union all

select
  6,
  'binding_owner_table_privileges',
  case when
    has_table_privilege('app_tenant_rpc_owner', 'public.payment_gateway_accounts', 'SELECT')
    and has_table_privilege('app_tenant_rpc_owner', 'public.payment_gateway_credentials', 'SELECT')
  then 'PASS' else 'FAIL' end,
  jsonb_build_object(
    'gateway_accounts_select', has_table_privilege(
      'app_tenant_rpc_owner', 'public.payment_gateway_accounts', 'SELECT'
    ),
    'gateway_credentials_select', has_table_privilege(
      'app_tenant_rpc_owner', 'public.payment_gateway_credentials', 'SELECT'
    ),
    'hotels_select', has_table_privilege(
      'app_tenant_rpc_owner', 'public.hotels', 'SELECT'
    )
  )

union all

select
  7,
  'restricted_roles_remain_non_bypass',
  case when (
    select count(*) = 2
    from target_roles
    where not rolsuper and not rolbypassrls
  ) then 'PASS' else 'FAIL' end,
  jsonb_build_object(
    'expected_roles', 2,
    'safe_roles', (
      select count(*)
      from target_roles
      where not rolsuper and not rolbypassrls
    )
  )

union all

select
  8,
  'configured_per_property_binding_complete',
  case when complete_active_bindings = per_property_policies
    and per_property_policies > 0
    then 'PASS'
    else 'FAIL'
  end,
  jsonb_build_object(
    'per_property_policies', per_property_policies,
    'complete_active_bindings', complete_active_bindings
  )
from configured_bindings

order by ordinal;
