-- Task 5 per-hotel gateway schema verification.
-- READ ONLY. Returns metadata/counts only: no secret value, payload, or PII.
-- Run manually in Supabase SQL Editor after task5-per-hotel-gateway.sql.

begin transaction read only;

set local statement_timeout = '5min';
set local search_path = pg_catalog, public;

with verification as (
  select
    1 as ordinal,
    'task5_tables_present'::text as check_name,
    (select count(*) = 5
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p')
       and c.relname in (
         'property_payment_gateway_policies',
         'payment_gateway_accounts',
         'payment_gateway_credentials',
         'payment_gateway_webhook_secrets',
         'payment_gateway_audit_events'
       )) as passed,
    jsonb_build_object(
      'expected', 5,
      'observed', (
        select count(*)
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind in ('r', 'p')
          and c.relname in (
            'property_payment_gateway_policies',
            'payment_gateway_accounts',
            'payment_gateway_credentials',
            'payment_gateway_webhook_secrets',
            'payment_gateway_audit_events'
          )
      )
    ) as details

  union all
  select 2, 'payment_binding_columns_present',
    (select count(*) = 5
     from information_schema.columns
     where table_schema = 'public'
       and (table_name, column_name) in (
         ('payment_intents', 'gateway_account_id'),
         ('payment_attempts', 'credential_ref'),
         ('payment_webhook_inbox', 'gateway_account_id'),
         ('payment_webhook_inbox', 'webhook_secret_ref'),
         ('payment_gateway_credentials', 'secret_vault_id')
       )),
    jsonb_build_object('expected', 5, 'observed', (
      select count(*)
      from information_schema.columns
      where table_schema = 'public'
        and (table_name, column_name) in (
          ('payment_intents', 'gateway_account_id'),
          ('payment_attempts', 'credential_ref'),
          ('payment_webhook_inbox', 'gateway_account_id'),
          ('payment_webhook_inbox', 'webhook_secret_ref'),
          ('payment_gateway_credentials', 'secret_vault_id')
        )
    ))

  union all
  select 3, 'gateway_tables_force_rls',
    (select count(*) = 5
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
       and c.relrowsecurity and c.relforcerowsecurity),
    jsonb_build_object('expected', 5, 'observed', (
      select count(*)
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
        and c.relrowsecurity and c.relforcerowsecurity
    ))

  union all
  select 4, 'gateway_rls_policy_manifest',
    (select count(*) = 15
     from pg_policy p
     join pg_class c on c.oid = p.polrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in (
         'property_payment_gateway_policies',
         'payment_gateway_accounts',
         'payment_gateway_credentials',
         'payment_gateway_webhook_secrets',
         'payment_gateway_audit_events'
       )
       and (select oid from pg_roles where rolname = 'app_payment_gateway_secret_owner') = any(p.polroles))
    and (select count(*) = 1
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = 'payment_gateway_accounts'
        and p.polname = 'task5_webhook_ref_selector'
        and p.polcmd = 'r'
        and p.polpermissive
        and (select oid from pg_roles where rolname = 'app_payment_gateway_secret_owner') = any(p.polroles)
        and pg_get_expr(p.polqual, p.polrelid) like '%app.task5_webhook_ref%'),
    jsonb_build_object('expected', 15, 'observed', (
      select count(*)
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in (
          'property_payment_gateway_policies',
          'payment_gateway_accounts',
          'payment_gateway_credentials',
          'payment_gateway_webhook_secrets',
          'payment_gateway_audit_events'
        )
        and (select oid from pg_roles where rolname = 'app_payment_gateway_secret_owner') = any(p.polroles)
    ), 'bounded_webhook_selector_policies', (
      select count(*)
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = 'payment_gateway_accounts'
        and p.polname = 'task5_webhook_ref_selector'
        and p.polcmd = 'r'
        and p.polpermissive
        and (select oid from pg_roles where rolname = 'app_payment_gateway_secret_owner') = any(p.polroles)
        and pg_get_expr(p.polqual, p.polrelid) like '%app.task5_webhook_ref%'
    ))

  union all
  select 5, 'secret_owner_role_restricted',
    exists (
      select 1 from pg_roles
      where rolname = 'app_payment_gateway_secret_owner'
        and not rolcanlogin and not rolsuper and not rolcreatedb
        and not rolcreaterole and not rolinherit and not rolreplication
        and not rolbypassrls
    ) and not exists (
      select 1
      from pg_auth_members m
      where m.roleid = (
        select oid from pg_roles where rolname = 'app_payment_gateway_secret_owner'
      ) and (m.inherit_option or m.set_option)
    ),
    jsonb_build_object('safe_role_count', (
      select count(*) from pg_roles
      where rolname = 'app_payment_gateway_secret_owner'
        and not rolcanlogin and not rolsuper and not rolbypassrls
    ))

  union all
  select 6, 'hotel_runtime_has_no_direct_gateway_table_access',
    not exists (
      select 1
      from unnest(array[
        'property_payment_gateway_policies',
        'payment_gateway_accounts',
        'payment_gateway_credentials',
        'payment_gateway_webhook_secrets',
        'payment_gateway_audit_events'
      ]) table_name
      cross join unnest(array['anon', 'authenticated', 'app_tenant_runtime', 'service_role']) role_name
      where has_table_privilege(role_name, format('public.%I', table_name), 'SELECT')
         or has_table_privilege(role_name, format('public.%I', table_name), 'INSERT')
         or has_table_privilege(role_name, format('public.%I', table_name), 'UPDATE')
         or has_table_privilege(role_name, format('public.%I', table_name), 'DELETE')
    ),
    jsonb_build_object('unsafe_grants', (
      select count(*)
      from unnest(array[
        'property_payment_gateway_policies',
        'payment_gateway_accounts',
        'payment_gateway_credentials',
        'payment_gateway_webhook_secrets',
        'payment_gateway_audit_events'
      ]) table_name
      cross join unnest(array['anon', 'authenticated', 'app_tenant_runtime', 'service_role']) role_name
      where has_table_privilege(role_name, format('public.%I', table_name), 'SELECT')
         or has_table_privilege(role_name, format('public.%I', table_name), 'INSERT')
         or has_table_privilege(role_name, format('public.%I', table_name), 'UPDATE')
         or has_table_privilege(role_name, format('public.%I', table_name), 'DELETE')
    ))

  union all
  select 7, 'vault_access_isolated',
    has_schema_privilege('app_payment_gateway_secret_owner', 'vault', 'USAGE')
    and has_table_privilege(
      'app_payment_gateway_secret_owner', 'vault.decrypted_secrets', 'SELECT'
    )
    and not (
      has_schema_privilege('anon', 'vault', 'USAGE')
      or has_schema_privilege('authenticated', 'vault', 'USAGE')
      or has_schema_privilege('app_tenant_runtime', 'vault', 'USAGE')
      or has_table_privilege('anon', 'vault.decrypted_secrets', 'SELECT')
      or has_table_privilege('authenticated', 'vault.decrypted_secrets', 'SELECT')
      or has_table_privilege('app_tenant_runtime', 'vault.decrypted_secrets', 'SELECT')
    ),
    jsonb_build_object(
      'secret_owner_has_vault_access',
        has_schema_privilege('app_payment_gateway_secret_owner', 'vault', 'USAGE')
        and has_table_privilege(
          'app_payment_gateway_secret_owner', 'vault.decrypted_secrets', 'SELECT'
        ),
      'tenant_runtime_has_vault_access',
        has_schema_privilege('app_tenant_runtime', 'vault', 'USAGE')
        or has_table_privilege('app_tenant_runtime', 'vault.decrypted_secrets', 'SELECT')
    )

  union all
  select 8, 'secret_columns_are_vault_uuid_references_only',
    (select count(*) = 2
     from information_schema.columns
     where table_schema = 'public'
       and table_name in (
         'payment_gateway_credentials', 'payment_gateway_webhook_secrets'
       )
       and column_name = 'secret_vault_id'
       and data_type = 'uuid')
    and not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name in (
          'property_payment_gateway_policies',
          'payment_gateway_accounts',
          'payment_gateway_credentials',
          'payment_gateway_webhook_secrets',
          'payment_gateway_audit_events'
        )
        and column_name ~* '(key_secret|api_secret|webhook_secret_value|password|authorization|encrypted_blob|ciphertext)'
    ),
    jsonb_build_object('vault_uuid_columns', (
      select count(*)
      from information_schema.columns
      where table_schema = 'public'
        and table_name in (
          'payment_gateway_credentials', 'payment_gateway_webhook_secrets'
        )
        and column_name = 'secret_vault_id'
        and data_type = 'uuid'
    ))

  union all
  select 9, 'canonical_gateway_ownership',
    not exists (
      select 1
      from public.payment_gateway_accounts a
      left join public.hotels h
        on h.tenant_id = a.tenant_id and h.id = a.property_id
      where h.id is null
    ) and not exists (
      select 1
      from public.payment_gateway_credentials c
      join public.payment_gateway_accounts a on a.id = c.account_id
      where c.tenant_id is distinct from a.tenant_id
         or c.property_id is distinct from a.property_id
    ) and not exists (
      select 1
      from public.payment_gateway_webhook_secrets w
      join public.payment_gateway_accounts a on a.id = w.account_id
      where w.tenant_id is distinct from a.tenant_id
         or w.property_id is distinct from a.property_id
    ),
    jsonb_build_object(
      'orphan_accounts', (
        select count(*)
        from public.payment_gateway_accounts a
        left join public.hotels h
          on h.tenant_id = a.tenant_id and h.id = a.property_id
        where h.id is null
      ),
      'credential_owner_mismatches', (
        select count(*)
        from public.payment_gateway_credentials c
        join public.payment_gateway_accounts a on a.id = c.account_id
        where c.tenant_id is distinct from a.tenant_id
           or c.property_id is distinct from a.property_id
      ),
      'webhook_owner_mismatches', (
        select count(*)
        from public.payment_gateway_webhook_secrets w
        join public.payment_gateway_accounts a on a.id = w.account_id
        where w.tenant_id is distinct from a.tenant_id
           or w.property_id is distinct from a.property_id
      )
    )

  union all
  select 10, 'one_active_account_per_property_mode',
    not exists (
      select 1
      from public.payment_gateway_accounts
      where status = 'ACTIVE'
      group by tenant_id, property_id, provider, mode
      having count(*) > 1
    ),
    jsonb_build_object('conflicting_groups', (
      select count(*) from (
        select 1
        from public.payment_gateway_accounts
        where status = 'ACTIVE'
        group by tenant_id, property_id, provider, mode
        having count(*) > 1
      ) conflicts
    ))

  union all
  select 11, 'one_active_credential_and_webhook_per_account',
    not exists (
      select 1
      from public.payment_gateway_credentials
      where status = 'ACTIVE'
      group by account_id having count(*) > 1
    ) and not exists (
      select 1
      from public.payment_gateway_webhook_secrets
      where status = 'ACTIVE'
      group by account_id having count(*) > 1
    ),
    jsonb_build_object(
      'credential_conflicts', (
        select count(*) from (
          select 1 from public.payment_gateway_credentials
          where status = 'ACTIVE'
          group by account_id having count(*) > 1
        ) conflicts
      ),
      'webhook_conflicts', (
        select count(*) from (
          select 1 from public.payment_gateway_webhook_secrets
          where status = 'ACTIVE'
          group by account_id having count(*) > 1
        ) conflicts
      )
    )

  union all
  select 12, 'credential_versions_unique_and_positive',
    not exists (
      select 1
      from public.payment_gateway_credentials
      group by account_id, version
      having count(*) > 1 or min(version) <= 0
    ) and not exists (
      select 1
      from public.payment_gateway_webhook_secrets
      group by account_id, version
      having count(*) > 1 or min(version) <= 0
    ),
    jsonb_build_object(
      'api_credential_versions', (select count(*) from public.payment_gateway_credentials),
      'webhook_secret_versions', (select count(*) from public.payment_gateway_webhook_secrets)
    )

  union all
  select 13, 'vault_handles_exist_without_reading_secrets',
    not exists (
      select 1
      from public.payment_gateway_credentials c
      left join vault.secrets s on s.id = c.secret_vault_id
      where s.id is null
    ) and not exists (
      select 1
      from public.payment_gateway_webhook_secrets w
      left join vault.secrets s on s.id = w.secret_vault_id
      where s.id is null
    ),
    jsonb_build_object(
      'missing_api_secret_handles', (
        select count(*)
        from public.payment_gateway_credentials c
        left join vault.secrets s on s.id = c.secret_vault_id
        where s.id is null
      ),
      'missing_webhook_secret_handles', (
        select count(*)
        from public.payment_gateway_webhook_secrets w
        left join vault.secrets s on s.id = w.secret_vault_id
        where s.id is null
      )
    )

  union all
  select 14, 'active_accounts_are_ready',
    not exists (
      select 1
      from public.payment_gateway_accounts a
      where a.status = 'ACTIVE'
        and (
          (select count(*) from public.payment_gateway_credentials c
           where c.account_id = a.id and c.status = 'ACTIVE') <> 1
          or
          (select count(*) from public.payment_gateway_webhook_secrets w
           where w.account_id = a.id and w.status = 'ACTIVE') <> 1
        )
    ),
    jsonb_build_object('unready_active_accounts', (
      select count(*)
      from public.payment_gateway_accounts a
      where a.status = 'ACTIVE'
        and (
          (select count(*) from public.payment_gateway_credentials c
           where c.account_id = a.id and c.status = 'ACTIVE') <> 1
          or
          (select count(*) from public.payment_gateway_webhook_secrets w
           where w.account_id = a.id and w.status = 'ACTIVE') <> 1
        )
    ))

  union all
  select 15, 'per_property_policies_are_ready',
    not exists (
      select 1
      from public.property_payment_gateway_policies p
      where p.resolution_mode = 'PER_PROPERTY'
        and not exists (
          select 1
          from public.payment_gateway_accounts a
          join public.payment_gateway_credentials c
            on c.account_id = a.id and c.status = 'ACTIVE'
          join public.payment_gateway_webhook_secrets w
            on w.account_id = a.id and w.status = 'ACTIVE'
          where a.tenant_id = p.tenant_id
            and a.property_id = p.property_id
            and a.provider = p.provider
            and a.mode = p.mode
            and a.status = 'ACTIVE'
        )
    ),
    jsonb_build_object('unready_per_property_policies', (
      select count(*)
      from public.property_payment_gateway_policies p
      where p.resolution_mode = 'PER_PROPERTY'
        and not exists (
          select 1
          from public.payment_gateway_accounts a
          join public.payment_gateway_credentials c
            on c.account_id = a.id and c.status = 'ACTIVE'
          join public.payment_gateway_webhook_secrets w
            on w.account_id = a.id and w.status = 'ACTIVE'
          where a.tenant_id = p.tenant_id
            and a.property_id = p.property_id
            and a.provider = p.provider
            and a.mode = p.mode
            and a.status = 'ACTIVE'
        )
    ))

  union all
  select 16, 'payment_intent_gateway_bindings_valid',
    not exists (
      select 1
      from public.payment_intents i
      where (i.gateway_account_id is null and not (
        i.provider = 'razorpay' and i.merchant_ref = 'LEGACY_PLATFORM_RAZORPAY'
      )) or (i.gateway_account_id is not null and not exists (
        select 1
        from public.payment_gateway_accounts a
        join public.payment_gateway_credentials c on c.account_id = a.id
        where a.id = i.gateway_account_id
          and a.tenant_id = i.tenant_id
          and a.property_id = i.property_id
          and a.provider = i.provider
          and a.merchant_ref = i.merchant_ref
          and c.credential_ref = i.credential_ref
      ))
    ),
    jsonb_build_object(
      'legacy_intents', (
        select count(*) from public.payment_intents where gateway_account_id is null
      ),
      'byog_intents', (
        select count(*) from public.payment_intents where gateway_account_id is not null
      )
    )

  union all
  select 17, 'payment_attempt_credential_binding_valid',
    not exists (
      select 1
      from public.payment_attempts a
      join public.payment_intents i on i.id = a.payment_intent_id
      where a.tenant_id is distinct from i.tenant_id
         or a.property_id is distinct from i.property_id
         or a.provider is distinct from i.provider
         or a.merchant_ref is distinct from i.merchant_ref
         or a.credential_ref is distinct from i.credential_ref
    ),
    jsonb_build_object('mismatches', (
      select count(*)
      from public.payment_attempts a
      join public.payment_intents i on i.id = a.payment_intent_id
      where a.tenant_id is distinct from i.tenant_id
         or a.property_id is distinct from i.property_id
         or a.provider is distinct from i.provider
         or a.merchant_ref is distinct from i.merchant_ref
         or a.credential_ref is distinct from i.credential_ref
    ))

  union all
  select 18, 'webhook_account_boundaries_valid',
    not exists (
      select 1
      from public.payment_webhook_inbox w
      join public.payment_gateway_accounts a on a.id = w.gateway_account_id
      where w.provider is distinct from a.provider
         or w.merchant_ref is distinct from a.merchant_ref
         or (w.payment_intent_id is not null and not exists (
           select 1
           from public.payment_intents i
           where i.id = w.payment_intent_id
             and i.tenant_id = a.tenant_id
             and i.property_id = a.property_id
             and i.gateway_account_id = a.id
             and i.provider = a.provider
             and i.merchant_ref = a.merchant_ref
         ))
    ),
    jsonb_build_object('boundary_mismatches', (
      select count(*)
      from public.payment_webhook_inbox w
      join public.payment_gateway_accounts a on a.id = w.gateway_account_id
      where w.provider is distinct from a.provider
         or w.merchant_ref is distinct from a.merchant_ref
         or (w.payment_intent_id is not null and not exists (
           select 1
           from public.payment_intents i
           where i.id = w.payment_intent_id
             and i.tenant_id = a.tenant_id
             and i.property_id = a.property_id
             and i.gateway_account_id = a.id
             and i.provider = a.provider
             and i.merchant_ref = a.merchant_ref
         ))
    ))

  union all
  select 19, 'historical_legacy_evidence_preserved',
    not exists (
      select 1
      from public.payment_intents
      where merchant_ref = 'LEGACY_PLATFORM_RAZORPAY'
        and gateway_account_id is not null
    ) and not exists (
      select 1
      from public.payment_intents
      where gateway_account_id is null
        and (merchant_ref <> 'LEGACY_PLATFORM_RAZORPAY' or credential_ref is null)
    ),
    jsonb_build_object(
      'legacy_intents', (
        select count(*)
        from public.payment_intents
        where merchant_ref = 'LEGACY_PLATFORM_RAZORPAY'
      ),
      'legacy_intents_with_account_rewrite', (
        select count(*)
        from public.payment_intents
        where merchant_ref = 'LEGACY_PLATFORM_RAZORPAY'
          and gateway_account_id is not null
      )
    )

  union all
  select 20, 'task5_constraint_and_trigger_manifest',
    (select count(*) >= 24
     from pg_constraint con
     join pg_class c on c.oid = con.conrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and con.conname like 'task5_%')
    and (select count(*) >= 14
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           and not t.tgisinternal
           and t.tgname like 'task5_%'),
    jsonb_build_object(
      'task5_constraints', (
        select count(*)
        from pg_constraint con
        join pg_class c on c.oid = con.conrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and con.conname like 'task5_%'
      ),
      'task5_triggers', (
        select count(*)
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and not t.tgisinternal
          and t.tgname like 'task5_%'
      )
    )

  union all
  select 21, 'binding_functions_use_restricted_owner',
    (select count(*) = 2
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     join pg_roles r on r.oid = p.proowner
     where n.nspname = 'public'
       and p.proname in (
         'task5_guard_payment_intent_gateway_binding',
         'task5_guard_webhook_gateway_binding'
       )
       and p.prosecdef
       and r.rolname = 'app_tenant_rpc_owner'
       and p.proconfig @> array['search_path=pg_catalog, public']),
    jsonb_build_object('safe_binding_functions', (
      select count(*)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_roles r on r.oid = p.proowner
      where n.nspname = 'public'
        and p.proname in (
          'task5_guard_payment_intent_gateway_binding',
          'task5_guard_webhook_gateway_binding'
        )
        and p.prosecdef
        and r.rolname = 'app_tenant_rpc_owner'
        and p.proconfig @> array['search_path=pg_catalog, public']
    ))

  union all
  select 22, 'secret_owner_has_supported_vault_create_access',
    exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'vault'
        and p.proname = 'create_secret'
        and p.prosecdef
        and has_function_privilege(
          'app_payment_gateway_secret_owner', p.oid, 'EXECUTE'
        )
    ),
    jsonb_build_object('supported_create_secret_overloads', (
      select count(*)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'vault'
        and p.proname = 'create_secret'
        and p.prosecdef
        and has_function_privilege(
          'app_payment_gateway_secret_owner', p.oid, 'EXECUTE'
        )
    ))
)
select
  ordinal,
  check_name,
  case when passed then 'PASS' else 'FAIL' end as result,
  details
from verification
order by ordinal;

rollback;
