-- Task 5: narrow Supabase Vault decrypt dependency grant.
-- USER-RUN CHECKPOINT: execute manually in Supabase SQL Editor.
--
-- The provider-managed vault.decrypted_secrets view invokes one internal
-- decrypt helper as the querying role. Grant EXECUTE only on the exact helper
-- referenced by that view, and only to the existing restricted NOLOGIN gateway
-- secret owner. This script does not change provider-managed ACLs.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '2min';
set local search_path = pg_catalog, public;

do $task5_vault_decrypt_grant$
declare
  target record;
  dependency_count integer := 0;
begin
  if not exists (
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
  ) then
    raise exception 'TASK5_SECRET_OWNER_ROLE_REQUIRED';
  end if;

  if not has_schema_privilege(
      'app_payment_gateway_secret_owner', 'vault', 'USAGE'
    )
    or not has_table_privilege(
      'app_payment_gateway_secret_owner',
      'vault.decrypted_secrets',
      'SELECT'
    ) then
    raise exception 'TASK5_VAULT_BASE_ACCESS_REQUIRED';
  end if;

  for target in
    select distinct p.oid, p.oid::regprocedure as routine_name
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_depend dep on dep.refobjid = p.oid
    join pg_rewrite rw on rw.oid = dep.objid
    where n.nspname = 'vault'
      and p.proname = '_crypto_aead_det_decrypt'
      and rw.ev_class = 'vault.decrypted_secrets'::regclass
  loop
    dependency_count := dependency_count + 1;

    if not has_function_privilege(
      current_user, target.oid, 'EXECUTE WITH GRANT OPTION'
    ) then
      raise exception 'TASK5_VAULT_DECRYPT_GRANT_OPTION_REQUIRED';
    end if;

    execute format(
      'grant execute on function %s to app_payment_gateway_secret_owner',
      target.routine_name
    );
  end loop;

  if dependency_count <> 1 then
    raise exception 'TASK5_VAULT_DECRYPT_DEPENDENCY_UNEXPECTED count=%',
      dependency_count;
  end if;
end;
$task5_vault_decrypt_grant$;

do $task5_vault_decrypt_guard$
declare
  dependency_count integer;
  allowed_count integer;
begin
  select count(*), count(*) filter (where has_function_privilege(
    'app_payment_gateway_secret_owner', dependency.oid, 'EXECUTE'
  ))
  into dependency_count, allowed_count
  from (
    select distinct p.oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_depend dep on dep.refobjid = p.oid
    join pg_rewrite rw on rw.oid = dep.objid
    where n.nspname = 'vault'
      and p.proname = '_crypto_aead_det_decrypt'
      and rw.ev_class = 'vault.decrypted_secrets'::regclass
  ) dependency;

  if dependency_count <> 1 or allowed_count <> 1 then
    raise exception 'TASK5_VAULT_DECRYPT_GRANT_GUARD_FAILED dependencies=% allowed=%',
      dependency_count, allowed_count;
  end if;

  if has_function_privilege(
      'app_tenant_runtime',
      'vault._crypto_aead_det_decrypt(bytea,bytea,bigint,bytea,bytea)',
      'EXECUTE'
    )
    or has_schema_privilege('app_tenant_runtime', 'vault', 'USAGE')
    or has_table_privilege(
      'app_tenant_runtime', 'vault.decrypted_secrets', 'SELECT'
    ) then
    raise exception 'TASK5_RUNTIME_VAULT_ACCESS_EXPANDED';
  end if;
end;
$task5_vault_decrypt_guard$;

commit;
