-- Task 5 Vault decrypt dependency grant verification (READ ONLY).

begin transaction read only;

with dependencies as (
  select distinct p.oid,
    n.nspname as schema_name,
    p.proname as function_name,
    pg_get_function_identity_arguments(p.oid) as identity_arguments,
    r.rolname as owner_name,
    p.prosecdef as security_definer,
    has_function_privilege(
      'app_payment_gateway_secret_owner', p.oid, 'EXECUTE'
    ) as restricted_owner_execute
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles r on r.oid = p.proowner
  join pg_depend dep on dep.refobjid = p.oid
  join pg_rewrite rw on rw.oid = dep.objid
  where n.nspname = 'vault'
    and p.proname = '_crypto_aead_det_decrypt'
    and rw.ev_class = 'vault.decrypted_secrets'::regclass
), verification as (
  select 1 as ordinal, 'exact_vault_decrypt_dependency'::text as check_name,
    count(*) = 1 as passed,
    jsonb_build_object(
      'observed', count(*),
      'expected', 1,
      'functions', coalesce(jsonb_agg(jsonb_build_object(
        'schema', schema_name,
        'name', function_name,
        'identity_arguments', identity_arguments,
        'owner', owner_name,
        'security_definer', security_definer
      )), '[]'::jsonb)
    ) as details
  from dependencies

  union all
  select 2, 'restricted_owner_can_execute_vault_decrypt_dependency',
    count(*) = 1 and count(*) filter (where restricted_owner_execute) = 1,
    jsonb_build_object(
      'dependencies', count(*),
      'allowed', count(*) filter (where restricted_owner_execute),
      'expected', 1
    )
  from dependencies

  union all
  select 3, 'tenant_runtime_has_no_direct_vault_access',
    not has_schema_privilege('app_tenant_runtime', 'vault', 'USAGE')
    and not has_table_privilege(
      'app_tenant_runtime', 'vault.decrypted_secrets', 'SELECT'
    )
    and not has_function_privilege(
      'app_tenant_runtime',
      'vault._crypto_aead_det_decrypt(bytea,bytea,bigint,bytea,bytea)',
      'EXECUTE'
    ),
    jsonb_build_object(
      'schema_usage', has_schema_privilege(
        'app_tenant_runtime', 'vault', 'USAGE'
      ),
      'view_select', has_table_privilege(
        'app_tenant_runtime', 'vault.decrypted_secrets', 'SELECT'
      ),
      'decrypt_execute', has_function_privilege(
        'app_tenant_runtime',
        'vault._crypto_aead_det_decrypt(bytea,bytea,bigint,bytea,bytea)',
        'EXECUTE'
      )
    )

  union all
  select 4, 'gateway_secret_owner_remains_restricted',
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
