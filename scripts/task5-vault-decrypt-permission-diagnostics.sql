-- Task 5 Vault decrypt dependency diagnostics (READ ONLY).
--
-- This script inspects PostgreSQL catalog metadata only. It does not select
-- from vault.decrypted_secrets, decrypt values, read gateway credentials,
-- inspect payment payloads, or access PII.

begin transaction read only;

with decrypt_functions as (
  select p.oid,
    n.nspname as schema_name,
    p.proname as function_name,
    pg_get_function_identity_arguments(p.oid) as identity_arguments,
    r.rolname as owner_name,
    p.prosecdef as security_definer,
    has_schema_privilege(
      'app_payment_gateway_secret_owner', n.oid, 'USAGE'
    ) as restricted_owner_schema_usage,
    has_function_privilege(
      'app_payment_gateway_secret_owner', p.oid, 'EXECUTE'
    ) as restricted_owner_execute
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles r on r.oid = p.proowner
  where p.proname = '_crypto_aead_det_decrypt'
), view_dependencies as (
  select distinct d.oid
  from decrypt_functions d
  join pg_depend dep on dep.refobjid = d.oid
  join pg_rewrite rw on rw.oid = dep.objid
  where rw.ev_class = 'vault.decrypted_secrets'::regclass
), diagnostics as (
  select 1 as ordinal, 'vault_decrypt_function_candidates'::text as check_name,
    case when count(*) > 0 then 'PASS' else 'FAIL' end as result,
    jsonb_build_object(
      'observed', count(*),
      'functions', coalesce(jsonb_agg(jsonb_build_object(
        'schema', schema_name,
        'name', function_name,
        'identity_arguments', identity_arguments,
        'owner', owner_name,
        'security_definer', security_definer,
        'restricted_owner_schema_usage', restricted_owner_schema_usage,
        'restricted_owner_execute', restricted_owner_execute
      ) order by schema_name, identity_arguments), '[]'::jsonb)
    ) as details
  from decrypt_functions

  union all
  select 2, 'vault_view_decrypt_dependencies',
    case when count(*) = 1 then 'PASS' else 'FAIL' end,
    jsonb_build_object(
      'expected', 1,
      'observed', count(*),
      'functions', coalesce(jsonb_agg(jsonb_build_object(
        'schema', d.schema_name,
        'name', d.function_name,
        'identity_arguments', d.identity_arguments,
        'owner', d.owner_name,
        'security_definer', d.security_definer,
        'restricted_owner_schema_usage', d.restricted_owner_schema_usage,
        'restricted_owner_execute', d.restricted_owner_execute
      ) order by d.schema_name, d.identity_arguments), '[]'::jsonb)
    )
  from decrypt_functions d
  join view_dependencies vd on vd.oid = d.oid

  union all
  select 3, 'gateway_secret_owner_remains_restricted',
    case when exists (
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
    ) then 'PASS' else 'FAIL' end,
    jsonb_build_object(
      'safe_role_count', (
        select count(*)
        from pg_roles
        where rolname = 'app_payment_gateway_secret_owner'
          and not rolcanlogin
          and not rolsuper
          and not rolbypassrls
      )
    )
)
select ordinal, check_name, result, details
from diagnostics
order by ordinal;

rollback;
