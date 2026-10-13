-- Task 5: narrow trigger EXECUTE repair for staged gateway configuration.
-- USER-RUN CHECKPOINT: execute manually in Supabase SQL Editor.
--
-- This additive repair grants no table, Vault, secret-resolver, tenant, or
-- provider access. It permits only the existing isolated NOLOGIN gateway
-- function owner to execute the five trigger guards required by its writes.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '2min';
set local search_path = pg_catalog, public;

do $task5_trigger_execute_preflight$
declare
  missing_count integer;
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

  select count(*) into missing_count
  from (values
    ('public.task5_guard_gateway_policy()'),
    ('public.task5_guard_gateway_account()'),
    ('public.task5_guard_gateway_credential()'),
    ('public.task5_guard_gateway_webhook_secret()'),
    ('public.task5_assert_active_account_ready()')
  ) required(signature)
  where to_regprocedure(required.signature) is null;

  if missing_count <> 0 then
    raise exception 'TASK5_TRIGGER_FUNCTIONS_REQUIRED count=%', missing_count;
  end if;
end;
$task5_trigger_execute_preflight$;

revoke all on function
  public.task5_guard_gateway_policy(),
  public.task5_guard_gateway_account(),
  public.task5_guard_gateway_credential(),
  public.task5_guard_gateway_webhook_secret(),
  public.task5_assert_active_account_ready()
from public, anon, authenticated, app_tenant_runtime, app_tenant_rpc_owner, service_role;

grant execute on function
  public.task5_guard_gateway_policy(),
  public.task5_guard_gateway_account(),
  public.task5_guard_gateway_credential(),
  public.task5_guard_gateway_webhook_secret(),
  public.task5_assert_active_account_ready()
to app_payment_gateway_secret_owner;

do $task5_trigger_execute_guard$
declare
  target regprocedure;
  role_name text;
begin
  foreach target in array array[
    'public.task5_guard_gateway_policy()'::regprocedure,
    'public.task5_guard_gateway_account()'::regprocedure,
    'public.task5_guard_gateway_credential()'::regprocedure,
    'public.task5_guard_gateway_webhook_secret()'::regprocedure,
    'public.task5_assert_active_account_ready()'::regprocedure
  ] loop
    if not has_function_privilege(
      'app_payment_gateway_secret_owner', target, 'EXECUTE'
    ) then
      raise exception 'TASK5_TRIGGER_OWNER_EXECUTE_REQUIRED function=%', target;
    end if;

    foreach role_name in array array[
      'anon', 'authenticated', 'app_tenant_runtime',
      'app_tenant_rpc_owner', 'service_role'
    ] loop
      if has_function_privilege(role_name, target, 'EXECUTE') then
        raise exception 'TASK5_UNSAFE_TRIGGER_EXECUTE role=% function=%',
          role_name, target;
      end if;
    end loop;
  end loop;
end;
$task5_trigger_execute_guard$;

commit;
