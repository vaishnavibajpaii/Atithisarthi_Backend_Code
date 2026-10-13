-- Task 5: secure commit-time readiness trigger repair.
-- USER-RUN CHECKPOINT: execute manually in Supabase SQL Editor.
--
-- The readiness constraint is initially deferred. At COMMIT it must inspect
-- gateway metadata without giving app_tenant_runtime direct table access.
-- This repair makes only that trigger function SECURITY DEFINER under the
-- existing restricted NOLOGIN gateway owner and pins its search path.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '2min';
set local search_path = pg_catalog, public;

do $task5_deferred_trigger_preflight$
begin
  if to_regprocedure(
    'public.task5_assert_active_account_ready()'
  ) is null then
    raise exception 'TASK5_READINESS_TRIGGER_FUNCTION_REQUIRED';
  end if;

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
end;
$task5_deferred_trigger_preflight$;

alter function public.task5_assert_active_account_ready()
  security definer;
alter function public.task5_assert_active_account_ready()
  set search_path = pg_catalog, public;

do $task5_deferred_trigger_owner$
begin
  execute format(
    'grant app_payment_gateway_secret_owner to %I with admin false, inherit false, set true granted by %I',
    current_user,
    current_user
  );
  grant create on schema public to app_payment_gateway_secret_owner;
  alter function public.task5_assert_active_account_ready()
    owner to app_payment_gateway_secret_owner;
  revoke create on schema public from app_payment_gateway_secret_owner;
end;
$task5_deferred_trigger_owner$;

set local role app_payment_gateway_secret_owner;
revoke all on function public.task5_assert_active_account_ready()
  from public, anon, authenticated, app_tenant_runtime,
    app_tenant_rpc_owner, service_role;
grant execute on function public.task5_assert_active_account_ready()
  to app_payment_gateway_secret_owner;
reset role;

do $task5_deferred_trigger_membership_cleanup$
begin
  execute format(
    'revoke app_payment_gateway_secret_owner from %I granted by %I restrict',
    current_user,
    current_user
  );
end;
$task5_deferred_trigger_membership_cleanup$;

do $task5_deferred_trigger_guard$
declare
  unsafe_count integer;
begin
  select count(*) into unsafe_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles r on r.oid = p.proowner
  where n.nspname = 'public'
    and p.proname = 'task5_assert_active_account_ready'
    and (
      not p.prosecdef
      or r.rolname <> 'app_payment_gateway_secret_owner'
      or r.rolcanlogin
      or r.rolsuper
      or r.rolbypassrls
      or not p.proconfig @> array['search_path=pg_catalog, public']
    );

  if unsafe_count <> 0 then
    raise exception 'TASK5_DEFERRED_TRIGGER_SECURITY_GUARD_FAILED';
  end if;

  if has_function_privilege(
      'app_tenant_runtime',
      'public.task5_assert_active_account_ready()',
      'EXECUTE'
    )
    or has_table_privilege(
      'app_tenant_runtime', 'public.payment_gateway_accounts', 'SELECT'
    ) then
    raise exception 'TASK5_RUNTIME_GATEWAY_ACCESS_EXPANDED';
  end if;
end;
$task5_deferred_trigger_guard$;

commit;
