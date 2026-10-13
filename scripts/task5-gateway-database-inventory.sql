-- Task 5 per-hotel payment gateway database inventory.
-- READ ONLY: this script is one SELECT statement and creates, alters, or
-- deletes nothing. Run it in the Supabase SQL Editor for the authorized
-- environment and return the complete result grid (CSV preferred).
--
-- DATA MINIMIZATION:
--   * No key ID, key secret, webhook secret, encrypted blob, token, password,
--     payment payload, order context, notes, customer data, or PII is selected.
--   * merchant_ref and credential_ref are deliberately included only as
--     non-secret Task 2 binding labels, aggregated with counts.
--   * Relation/column/constraint/index/policy/grant/routine metadata is safe
--     catalog evidence; function bodies are intentionally excluded.

with target_relations as (
  select
    c.oid as relation_oid,
    n.nspname as schema_name,
    c.relname as relation_name,
    c.relkind,
    c.relowner,
    c.relrowsecurity,
    c.relforcerowsecurity,
    c.relpersistence
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p', 'v', 'm')
    and (
      c.relname in (
        'tenants',
        'hotels',
        'payment_intents',
        'payment_attempts',
        'payment_webhook_inbox',
        'payment_webhook_events',
        'hotel_payment_route_settings',
        'hotel_ordering_settings',
        'hotel_ordering_settings_audit',
        'orders'
      )
      or c.relname ~* '(payment.*(gateway|config|setting|credential|merchant)|gateway|razorpay|merchant|credential)'
    )
),
relevant_routines as (
  select
    p.oid as routine_oid,
    n.nspname as routine_schema,
    p.proname as routine_name,
    p.proowner,
    p.prosecdef,
    p.provolatile,
    p.proparallel,
    p.prokind,
    p.prolang,
    p.proconfig
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and (
      p.proname ~* '(payment|gateway|razorpay|merchant|credential|tenant_context|inherit_payment_owner|canonical_owner)'
      or pg_get_function_identity_arguments(p.oid)
        ~* '(payment|merchant|credential|tenant|property|provider)'
    )
),
inventory as (
  select
    '00_inventory_context'::text as section,
    'database'::text as object_type,
    current_database()::text as object_identity,
    jsonb_build_object(
      'database_name', current_database(),
      'current_user', current_user,
      'session_user', session_user,
      'postgres_version', current_setting('server_version'),
      'transaction_read_only', current_setting('transaction_read_only'),
      'observed_at_utc', timezone('utc', statement_timestamp())
    ) as details

  union all

  select
    '01_security_capabilities',
    'extension',
    e.extname,
    jsonb_build_object(
      'version', e.extversion,
      'schema', n.nspname,
      'owner', pg_get_userbyid(e.extowner)
    )
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
  where e.extname in ('pgcrypto', 'pgsodium', 'supabase_vault', 'vault')

  union all

  select
    '01_security_capabilities',
    'schema',
    n.nspname,
    jsonb_build_object('owner', pg_get_userbyid(n.nspowner))
  from pg_namespace n
  where n.nspname in ('vault', 'pgsodium')

  union all

  select
    '02_relevant_relations',
    case r.relkind
      when 'r' then 'table'
      when 'p' then 'partitioned_table'
      when 'v' then 'view'
      when 'm' then 'materialized_view'
      else r.relkind::text
    end,
    format('%I.%I', r.schema_name, r.relation_name),
    jsonb_build_object(
      'owner', pg_get_userbyid(r.relowner),
      'rls_enabled', r.relrowsecurity,
      'force_rls', r.relforcerowsecurity,
      'persistence', r.relpersistence,
      'estimated_live_rows', coalesce(stats.n_live_tup, 0)::bigint
    )
  from target_relations r
  left join pg_stat_user_tables stats on stats.relid = r.relation_oid

  union all

  select
    '03_columns',
    'column',
    format('%I.%I.%I', cols.table_schema, cols.table_name, cols.column_name),
    jsonb_build_object(
      'ordinal_position', cols.ordinal_position,
      'data_type', cols.data_type,
      'udt_schema', cols.udt_schema,
      'udt_name', cols.udt_name,
      'nullable', cols.is_nullable,
      'safe_default', case
        when cols.column_name ~* '(secret|credential|key|token|password|payload|context|metadata|notes|email|phone|name)'
          then '[suppressed]'
        else coalesce(cols.column_default, '')
      end,
      'identity', cols.is_identity,
      'identity_generation', cols.identity_generation,
      'generated', cols.is_generated,
      'security_category', case
        when cols.column_name in ('tenant_id', 'property_id', 'hotel_id', 'hotel_slug') then 'ownership'
        when cols.column_name in ('provider', 'merchant_ref', 'credential_ref') then 'provider_binding'
        when cols.column_name ~* '(secret|private|cipher|encrypt|nonce|iv|tag|key_material)' then 'secret_material_candidate'
        when cols.column_name ~* '(key_id|public_key)' then 'public_credential_metadata_candidate'
        when cols.column_name ~* '(payload|context|metadata|notes)' then 'suppressed_application_data'
        when cols.column_name ~* '(status|enabled|disabled|active|mode)' then 'lifecycle_or_state'
        else 'other'
      end
    )
  from information_schema.columns cols
  join target_relations r
    on r.schema_name = cols.table_schema
   and r.relation_name = cols.table_name

  union all

  select
    '04_constraints',
    case con.contype
      when 'p' then 'primary_key'
      when 'f' then 'foreign_key'
      when 'u' then 'unique'
      when 'c' then 'check'
      when 'x' then 'exclusion'
      when 'n' then 'not_null'
      else con.contype::text
    end,
    format('%I.%I.%I', r.schema_name, r.relation_name, con.conname),
    jsonb_build_object(
      'definition', pg_get_constraintdef(con.oid, true),
      'validated', con.convalidated,
      'deferrable', con.condeferrable,
      'initially_deferred', con.condeferred,
      'referenced_relation', case
        when con.confrelid = 0 then null
        else con.confrelid::regclass::text
      end
    )
  from target_relations r
  join pg_constraint con on con.conrelid = r.relation_oid

  union all

  select
    '05_indexes',
    'index',
    format('%I.%I', idx.schemaname, idx.indexname),
    jsonb_build_object(
      'relation', format('%I.%I', idx.schemaname, idx.tablename),
      'definition', idx.indexdef
    )
  from pg_indexes idx
  join target_relations r
    on r.schema_name = idx.schemaname
   and r.relation_name = idx.tablename

  union all

  select
    '06_ownership_summary',
    'aggregate',
    'public.tenants',
    jsonb_build_object(
      'total_rows', count(*)
    )
  from public.tenants

  union all

  select
    '06_ownership_summary',
    'aggregate',
    'public.hotels',
    jsonb_build_object(
      'total_rows', count(*),
      'with_tenant_id', count(*) filter (where tenant_id is not null),
      'missing_tenant_id', count(*) filter (where tenant_id is null),
      'orphan_tenant_id', count(*) filter (
        where tenant_id is not null
          and not exists (select 1 from public.tenants t where t.id = hotels.tenant_id)
      )
    )
  from public.hotels

  union all

  select
    '06_ownership_summary',
    'aggregate',
    'public.payment_intents',
    jsonb_build_object(
      'total_rows', count(*),
      'canonical_owner_complete', count(*) filter (
        where tenant_id is not null and property_id is not null
      ),
      'canonical_owner_missing', count(*) filter (
        where tenant_id is null or property_id is null
      ),
      'canonical_hotel_match', count(*) filter (
        where exists (
          select 1
          from public.hotels h
          where h.id = payment_intents.property_id
            and h.tenant_id = payment_intents.tenant_id
            and h.slug = payment_intents.hotel_slug
        )
      ),
      'canonical_hotel_mismatch', count(*) filter (
        where tenant_id is not null
          and property_id is not null
          and not exists (
            select 1
            from public.hotels h
            where h.id = payment_intents.property_id
              and h.tenant_id = payment_intents.tenant_id
              and h.slug = payment_intents.hotel_slug
          )
      ),
      'missing_provider_binding', count(*) filter (
        where nullif(btrim(provider), '') is null
           or nullif(btrim(merchant_ref), '') is null
           or nullif(btrim(credential_ref), '') is null
      ),
      'legacy_platform_merchant_rows', count(*) filter (
        where merchant_ref = 'LEGACY_PLATFORM_RAZORPAY'
      ),
      'distinct_provider_count', count(distinct provider),
      'distinct_merchant_ref_count', count(distinct merchant_ref),
      'distinct_credential_ref_count', count(distinct credential_ref)
    )
  from public.payment_intents

  union all

  select
    '06_ownership_summary',
    'aggregate',
    'public.payment_attempts',
    jsonb_build_object(
      'total_rows', count(*),
      'canonical_owner_complete', count(*) filter (
        where a.tenant_id is not null and a.property_id is not null
      ),
      'missing_parent_intent', count(*) filter (where i.id is null),
      'parent_owner_mismatch', count(*) filter (
        where i.id is not null
          and (a.tenant_id is distinct from i.tenant_id
            or a.property_id is distinct from i.property_id)
      ),
      'parent_merchant_mismatch', count(*) filter (
        where i.id is not null and a.merchant_ref is distinct from i.merchant_ref
      )
    )
  from public.payment_attempts a
  left join public.payment_intents i on i.id = a.payment_intent_id

  union all

  select
    '06_ownership_summary',
    'aggregate',
    'public.payment_webhook_inbox',
    jsonb_build_object(
      'total_rows', count(*),
      'linked_rows', count(*) filter (where w.payment_intent_id is not null),
      'unlinked_rows', count(*) filter (where w.payment_intent_id is null),
      'unlinked_rows_with_owner', count(*) filter (
        where w.payment_intent_id is null
          and (w.tenant_id is not null or w.property_id is not null)
      ),
      'linked_rows_missing_owner', count(*) filter (
        where w.payment_intent_id is not null
          and (w.tenant_id is null or w.property_id is null)
      ),
      'missing_parent_intent', count(*) filter (
        where w.payment_intent_id is not null and i.id is null
      ),
      'parent_owner_mismatch', count(*) filter (
        where i.id is not null
          and (w.tenant_id is distinct from i.tenant_id
            or w.property_id is distinct from i.property_id)
      ),
      'parent_merchant_mismatch', count(*) filter (
        where i.id is not null and w.merchant_ref is distinct from i.merchant_ref
      )
    )
  from public.payment_webhook_inbox w
  left join public.payment_intents i on i.id = w.payment_intent_id

  union all

  select
    '06_ownership_summary',
    'aggregate',
    'public.hotel_payment_route_settings',
    jsonb_build_object(
      'total_rows', count(*),
      'canonical_owner_complete', count(*) filter (
        where tenant_id is not null and property_id is not null
      ),
      'canonical_hotel_match', count(*) filter (
        where exists (
          select 1
          from public.hotels h
          where h.id = hotel_payment_route_settings.property_id
            and h.tenant_id = hotel_payment_route_settings.tenant_id
            and h.slug = hotel_payment_route_settings.hotel_slug
        )
      ),
      'route_enabled_rows', count(*) filter (where route_enabled is true),
      'linked_account_configured_rows', count(*) filter (
        where nullif(btrim(razorpay_linked_account_id), '') is not null
      )
    )
  from public.hotel_payment_route_settings

  union all

  select
    '07_payment_binding_distribution',
    'aggregate',
    format(
      'provider=%s merchant_ref=%s credential_ref=%s',
      coalesce(provider, '[null]'),
      coalesce(merchant_ref, '[null]'),
      coalesce(credential_ref, '[null]')
    ),
    jsonb_build_object(
      'intent_count', count(*),
      'property_count', count(distinct property_id),
      'earliest_created_at', min(created_at),
      'latest_created_at', max(created_at),
      'paid_count', count(*) filter (where status = 'PAID'),
      'reconciliation_required_count', count(*) filter (where requires_reconciliation is true)
    )
  from public.payment_intents
  group by provider, merchant_ref, credential_ref

  union all

  select
    '08_rls_policies',
    'relation_rls_state',
    format('%I.%I', r.schema_name, r.relation_name),
    jsonb_build_object(
      'owner', pg_get_userbyid(r.relowner),
      'rls_enabled', r.relrowsecurity,
      'force_rls', r.relforcerowsecurity
    )
  from target_relations r
  where r.relkind in ('r', 'p')

  union all

  select
    '08_rls_policies',
    'policy',
    format('%I.%I.%I', pol.schemaname, pol.tablename, pol.policyname),
    jsonb_build_object(
      'permissive', pol.permissive,
      'roles', to_jsonb(pol.roles),
      'command', pol.cmd,
      'using_expression', pol.qual,
      'with_check_expression', pol.with_check
    )
  from pg_policies pol
  join target_relations r
    on r.schema_name = pol.schemaname
   and r.relation_name = pol.tablename

  union all

  select
    '09_table_grants',
    'table_grant',
    format('%I.%I:%s:%s', r.schema_name, r.relation_name, coalesce(grantee.rolname, 'PUBLIC'), acl.privilege_type),
    jsonb_build_object(
      'grantor', coalesce(grantor.rolname, 'PUBLIC'),
      'grantee', coalesce(grantee.rolname, 'PUBLIC'),
      'privilege', acl.privilege_type,
      'grantable', acl.is_grantable
    )
  from target_relations r
  cross join lateral aclexplode(coalesce(
    (select c.relacl from pg_class c where c.oid = r.relation_oid),
    acldefault('r', r.relowner)
  )) acl
  left join pg_roles grantor on grantor.oid = acl.grantor
  left join pg_roles grantee on grantee.oid = acl.grantee

  union all

  select
    '10_column_grants',
    'column_grant',
    format('%I.%I.%I:%s:%s', grants.table_schema, grants.table_name, grants.column_name, grants.grantee, grants.privilege_type),
    jsonb_build_object(
      'grantor', grants.grantor,
      'grantee', grants.grantee,
      'privilege', grants.privilege_type,
      'grantable', grants.is_grantable
    )
  from information_schema.column_privileges grants
  join target_relations r
    on r.schema_name = grants.table_schema
   and r.relation_name = grants.table_name

  union all

  select
    '11_routines',
    case rr.prokind when 'p' then 'procedure' else 'function' end,
    format('%I.%I(%s)', rr.routine_schema, rr.routine_name, pg_get_function_identity_arguments(rr.routine_oid)),
    jsonb_build_object(
      'owner', pg_get_userbyid(rr.proowner),
      'security_mode', case when rr.prosecdef then 'DEFINER' else 'INVOKER' end,
      'language', lang.lanname,
      'volatility', case rr.provolatile when 'i' then 'IMMUTABLE' when 's' then 'STABLE' else 'VOLATILE' end,
      'parallel', case rr.proparallel when 's' then 'SAFE' when 'r' then 'RESTRICTED' else 'UNSAFE' end,
      'returns', pg_get_function_result(rr.routine_oid),
      'configuration', to_jsonb(rr.proconfig)
    )
  from relevant_routines rr
  join pg_language lang on lang.oid = rr.prolang

  union all

  select
    '12_routine_grants',
    'execute_grant',
    format(
      '%I.%I(%s):%s:%s',
      rr.routine_schema,
      rr.routine_name,
      pg_get_function_identity_arguments(rr.routine_oid),
      coalesce(grantee.rolname, 'PUBLIC'),
      acl.privilege_type
    ),
    jsonb_build_object(
      'grantor', coalesce(grantor.rolname, 'PUBLIC'),
      'grantee', coalesce(grantee.rolname, 'PUBLIC'),
      'privilege', acl.privilege_type,
      'grantable', acl.is_grantable
    )
  from relevant_routines rr
  cross join lateral aclexplode(coalesce(
    (select p.proacl from pg_proc p where p.oid = rr.routine_oid),
    acldefault('f', rr.proowner)
  )) acl
  left join pg_roles grantor on grantor.oid = acl.grantor
  left join pg_roles grantee on grantee.oid = acl.grantee
  where acl.privilege_type = 'EXECUTE'

  union all

  select
    '13_triggers',
    'trigger',
    format('%I.%I.%I', r.schema_name, r.relation_name, trig.tgname),
    jsonb_build_object(
      'enabled_state', trig.tgenabled,
      'function', trig.tgfoid::regprocedure::text,
      'definition', pg_get_triggerdef(trig.oid, true)
    )
  from pg_trigger trig
  join target_relations r on r.relation_oid = trig.tgrelid
  where not trig.tgisinternal

  union all

  select
    '14_runtime_roles',
    'database_role',
    roles.rolname,
    jsonb_build_object(
      'login', roles.rolcanlogin,
      'superuser', roles.rolsuper,
      'bypass_rls', roles.rolbypassrls,
      'inherit', roles.rolinherit,
      'create_role', roles.rolcreaterole,
      'create_database', roles.rolcreatedb,
      'replication', roles.rolreplication
    )
  from pg_roles roles
  where roles.rolname in (
    'postgres', 'service_role', 'anon', 'authenticated', 'app_tenant_runtime'
  )

  union all

  select
    '15_secret_column_candidates',
    'column_metadata_only',
    format('%I.%I.%I', cols.table_schema, cols.table_name, cols.column_name),
    jsonb_build_object(
      'data_type', cols.data_type,
      'nullable', cols.is_nullable,
      'default', '[suppressed]',
      'warning', 'Metadata only; no stored value was read'
    )
  from information_schema.columns cols
  join target_relations r
    on r.schema_name = cols.table_schema
   and r.relation_name = cols.table_name
  where cols.column_name ~* '(secret|private|cipher|encrypt|nonce|iv|tag|key|credential|token|password)'
)
select section, object_type, object_identity, details
from inventory
order by section, object_type, object_identity;
