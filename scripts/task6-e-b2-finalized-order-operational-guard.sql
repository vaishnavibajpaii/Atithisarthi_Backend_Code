-- TASK6-E-B2 — finalized-order operational-state guard.
--
-- Apply after task6-e-b-order-state-finality-guard.sql. This is a deliberately
-- small follow-up checkpoint: it closes the remaining path where a billed or
-- paid order could otherwise be moved to cancelled/payment_failed without
-- changing its financial fields. No historical order, payment, bill, snapshot,
-- invoice, or audit record is updated.

begin;
set local lock_timeout = '10s';
set local statement_timeout = '60s';
set local search_path = pg_catalog, public;

do $task6_e_b2_guard$
begin
  if to_regclass('public.orders') is null
     or to_regclass('public.food_order_bill_snapshots') is null
     or to_regprocedure('public.task6_guard_order_state_and_finality()') is null then
    raise exception 'TASK6_E_B2_PREREQUISITE_MISSING';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_class relation
    where relation.oid = 'public.orders'::regclass
      and relation.relrowsecurity
      and relation.relforcerowsecurity
  ) then
    raise exception 'TASK6_E_B2_ORDERS_FORCE_RLS_REQUIRED';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_trigger existing_trigger
    where existing_trigger.tgrelid = 'public.orders'::regclass
      and existing_trigger.tgname = 'orders_11_task6_finalized_operational_guard'
      and not existing_trigger.tgisinternal
      and existing_trigger.tgfoid <> coalesce(
        to_regprocedure('public.task6_guard_finalized_order_operational_state()'),
        0::regprocedure
      )
  ) then
    raise exception 'TASK6_E_B2_TRIGGER_NAME_COLLISION';
  end if;
end;
$task6_e_b2_guard$;

create or replace function public.task6_guard_finalized_order_operational_state()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $task6_guard_finalized_order_operational_state$
declare
  v_old_status text := lower(btrim(coalesce(old.status, '')));
  v_new_status text := lower(btrim(coalesce(new.status, '')));
  v_old_kitchen text := lower(btrim(coalesce(old.kitchen_status, '')));
  v_new_kitchen text := lower(btrim(coalesce(new.kitchen_status, '')));
  v_old_payment text := lower(btrim(coalesce(old.payment_status, 'unpaid')));
  v_old_billing text := lower(btrim(coalesce(old.billing_status, 'not_billed')));
  v_has_final_snapshot boolean := false;
  v_financially_final boolean := false;
begin
  if tg_op <> 'UPDATE' then
    return new;
  end if;

  select exists (
    select 1
    from public.food_order_bill_snapshots snapshot
    where snapshot.tenant_id = old.tenant_id
      and snapshot.property_id = old.property_id
      and snapshot.hotel_slug = old.hotel_slug
      and snapshot.order_id = old.id::text
  ) into v_has_final_snapshot;

  v_financially_final := v_has_final_snapshot
    or v_old_billing = 'billed'
    or v_old_payment in ('paid', 'refunded');

  if v_financially_final
     and (
       (v_new_status in ('cancelled', 'payment_failed') and v_new_status is distinct from v_old_status)
       or (v_new_kitchen = 'cancelled' and v_new_kitchen is distinct from v_old_kitchen)
     ) then
    raise exception using
      errcode = '23514',
      message = 'TASK6_ORDER_FINAL_OPERATIONAL_STATE_IMMUTABLE';
  end if;

  return new;
end;
$task6_guard_finalized_order_operational_state$;

revoke all on function public.task6_guard_finalized_order_operational_state()
  from public, anon, authenticated;
grant execute on function public.task6_guard_finalized_order_operational_state()
  to app_tenant_runtime, service_role;

do $task6_e_b2_trigger$
begin
  if not exists (
    select 1
    from pg_catalog.pg_trigger trigger
    where trigger.tgrelid = 'public.orders'::regclass
      and trigger.tgname = 'orders_11_task6_finalized_operational_guard'
      and not trigger.tgisinternal
  ) then
    create trigger orders_11_task6_finalized_operational_guard
    before update of status, kitchen_status, payment_status, billing_status
    on public.orders
    for each row
    execute function public.task6_guard_finalized_order_operational_state();
  end if;
end;
$task6_e_b2_trigger$;

comment on function public.task6_guard_finalized_order_operational_state() is
  'Task 6 follow-up guard: a paid, refunded, billed, or food-snapshot-final order cannot be cancelled or marked payment-failed by a generic operational update.';

do $task6_e_b2_owner_membership$
begin
  execute format(
    'grant app_tenant_rpc_owner to %I with admin false, inherit false, set true granted by %I',
    current_user,
    current_user
  );
end;
$task6_e_b2_owner_membership$;

grant create on schema public to app_tenant_rpc_owner;
alter function public.task6_guard_finalized_order_operational_state() owner to app_tenant_rpc_owner;
revoke create on schema public from app_tenant_rpc_owner;

do $task6_e_b2_owner_membership_cleanup$
begin
  execute format(
    'revoke app_tenant_rpc_owner from %I granted by %I restrict',
    current_user,
    current_user
  );
end;
$task6_e_b2_owner_membership_cleanup$;

do $task6_e_b2_owner_cleanup_guard$
begin
  if exists (
    select 1
    from pg_catalog.pg_auth_members membership
    where membership.roleid = (
      select oid from pg_catalog.pg_roles where rolname = 'app_tenant_rpc_owner'
    )
      and (membership.inherit_option or membership.set_option)
  ) then
    raise exception 'TASK6_E_B2_RPC_OWNER_EFFECTIVE_MEMBERSHIP_REMAINS';
  end if;

  if has_schema_privilege('app_tenant_rpc_owner', 'public', 'CREATE') then
    raise exception 'TASK6_E_B2_RPC_OWNER_SCHEMA_CREATE_REMAINS';
  end if;
end;
$task6_e_b2_owner_cleanup_guard$;

commit;
