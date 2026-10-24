-- TASK6-E-B — forward-only POS order state and financial-finality guard.
--
-- Apply only after reviewing task6-e-b-pos-state-finality-preflight.sql in
-- the TEST database. This migration changes no historical order, bill,
-- snapshot, payment, invoice, or audit row. It adds one BEFORE UPDATE guard
-- for future writes only.
--
-- The guard deliberately does NOT change Task 2 provider-payment logic,
-- Task 6 checkout settlement, pricing, taxes, or historical data. It blocks:
--   * a paid/final billed order's source financial snapshot being rewritten;
--   * reversal of paid/final billing evidence through a generic update;
--   * a generic route resurrecting cancelled/payment-failed work; and
--   * illegal KDS transitions, including terminal -> preparing resurrection.
--
-- A verified Task 2 recovery (payment_pending/payment_failed -> new with
-- canonical verified gateway evidence) remains allowed. That condition is
-- intentionally narrow and does not authorize a generic status update.

begin;
set local lock_timeout = '10s';
set local statement_timeout = '60s';
set local search_path = pg_catalog, public;

do $task6_e_b_guard$
declare
  v_missing_columns text[];
begin
  if to_regclass('public.orders') is null
     or to_regclass('public.hotels') is null
     or to_regclass('public.food_order_bill_snapshots') is null then
    raise exception 'TASK6_E_B_REQUIRED_RELATION_MISSING';
  end if;

  select array_agg(expected.column_name order by expected.column_name)
    into v_missing_columns
  from (
    values
      ('tenant_id'), ('property_id'), ('hotel_slug'),
      ('status'), ('kitchen_status'), ('payment_status'), ('billing_status'),
      ('payment_method'), ('items'), ('totals'), ('financial_snapshot_version'),
      ('bill_number'), ('billed_at'), ('paid_at'),
      ('parent_order_id'), ('order_group_id'), ('order_type'),
      ('room_booking_id'), ('room_service_charge_to_room'),
      ('gateway_status'), ('gateway_order_id'), ('gateway_payment_id'),
      ('payment_verified_at')
  ) expected(column_name)
  left join information_schema.columns actual
    on actual.table_schema = 'public'
   and actual.table_name = 'orders'
   and actual.column_name = expected.column_name
  where actual.column_name is null;

  if coalesce(cardinality(v_missing_columns), 0) <> 0 then
    raise exception 'TASK6_E_B_REQUIRED_ORDER_COLUMNS_MISSING columns=%', v_missing_columns;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_class relation
    where relation.oid = 'public.orders'::regclass
      and relation.relrowsecurity
      and relation.relforcerowsecurity
  ) then
    raise exception 'TASK6_E_B_ORDERS_FORCE_RLS_REQUIRED';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc routine
    where routine.oid = to_regprocedure(
      'public.task6_finalize_order_family(text,bigint,text,text,text,timestamp with time zone,text,text,jsonb)'
    )
  ) then
    raise exception 'TASK6_E_B_BILL_FINALIZER_MISSING';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_trigger existing_trigger
    where existing_trigger.tgrelid = 'public.orders'::regclass
      and existing_trigger.tgname = 'orders_10_task6_state_finality_guard'
      and not existing_trigger.tgisinternal
      and existing_trigger.tgfoid <> coalesce(
        to_regprocedure('public.task6_guard_order_state_and_finality()'),
        0::regprocedure
      )
  ) then
    raise exception 'TASK6_E_B_TRIGGER_NAME_COLLISION';
  end if;
end;
$task6_e_b_guard$;

create or replace function public.task6_guard_order_state_and_finality()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $task6_guard_order_state_and_finality$
declare
  v_old_status text := lower(btrim(coalesce(old.status, '')));
  v_new_status text := lower(btrim(coalesce(new.status, '')));
  v_old_kitchen text := lower(btrim(coalesce(old.kitchen_status, '')));
  v_new_kitchen text := lower(btrim(coalesce(new.kitchen_status, '')));
  v_old_effective_kitchen text;
  v_new_effective_kitchen text;
  v_old_payment text := lower(btrim(coalesce(old.payment_status, 'unpaid')));
  v_new_payment text := lower(btrim(coalesce(new.payment_status, 'unpaid')));
  v_old_billing text := lower(btrim(coalesce(old.billing_status, 'not_billed')));
  v_new_billing text := lower(btrim(coalesce(new.billing_status, 'not_billed')));
  v_has_final_snapshot boolean := false;
  v_financially_final boolean := false;
  v_verified_provider_recovery boolean := false;
  v_verified_provider_failure boolean := false;
begin
  if tg_op <> 'UPDATE' then
    return new;
  end if;

  -- An explicit current KDS state wins. Older rows with an empty kitchen state
  -- keep their existing lifecycle meaning without being rewritten.
  v_old_effective_kitchen := case
    when v_old_kitchen in ('new', 'accepted', 'preparing', 'ready', 'served', 'delayed', 'cancelled')
      then v_old_kitchen
    when v_old_status in ('cancelled', 'payment_failed') then 'cancelled'
    when v_old_status = 'completed' then 'served'
    when v_old_status = 'preparing' then 'preparing'
    when v_old_status = 'confirmed' then 'accepted'
    else 'new'
  end;
  v_new_effective_kitchen := case
    when v_new_kitchen in ('new', 'accepted', 'preparing', 'ready', 'served', 'delayed', 'cancelled')
      then v_new_kitchen
    when v_new_status in ('cancelled', 'payment_failed') then 'cancelled'
    when v_new_status = 'completed' then 'served'
    when v_new_status = 'preparing' then 'preparing'
    when v_new_status = 'confirmed' then 'accepted'
    else 'new'
  end;

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

  -- Only the existing verified provider finalization shape may restore a
  -- payment exception to operational work. Generic staff/admin status routes
  -- cannot supply this full shape.
  v_verified_provider_recovery := v_old_status in ('payment_pending', 'payment_failed')
    and v_new_status = 'new'
    and v_old_payment not in ('paid', 'refunded')
    and v_new_payment = 'paid'
    and lower(btrim(coalesce(new.gateway_status, ''))) = 'paid'
    and nullif(btrim(coalesce(new.gateway_order_id, '')), '') is not null
    and nullif(btrim(coalesce(new.gateway_payment_id, '')), '') is not null
    and new.payment_verified_at is not null;

  v_verified_provider_failure := v_old_status = 'payment_pending'
    and v_new_status = 'payment_failed'
    and v_old_payment not in ('paid', 'refunded')
    and v_new_payment in ('', 'unpaid')
    and lower(btrim(coalesce(new.gateway_status, ''))) = 'failed'
    and nullif(btrim(coalesce(new.gateway_order_id, '')), '') is not null;

  -- A final bill or a settled payment freezes the source financial snapshot
  -- and canonical order identity. It does not prevent the normal kitchen path
  -- from finishing a legitimately prepaid order.
  if v_financially_final and (
    new.tenant_id is distinct from old.tenant_id
    or new.property_id is distinct from old.property_id
    or new.hotel_slug is distinct from old.hotel_slug
    or new.parent_order_id is distinct from old.parent_order_id
    or new.order_group_id is distinct from old.order_group_id
    or new.order_type is distinct from old.order_type
    or new.room_booking_id is distinct from old.room_booking_id
    or new.room_service_charge_to_room is distinct from old.room_service_charge_to_room
    or new.items is distinct from old.items
    or new.totals is distinct from old.totals
    or new.financial_snapshot_version is distinct from old.financial_snapshot_version
  ) then
    raise exception using
      errcode = '23514',
      message = 'TASK6_ORDER_FINAL_FINANCIAL_SNAPSHOT_IMMUTABLE';
  end if;

  if (v_old_billing = 'billed' or v_has_final_snapshot) and (
    v_new_billing is distinct from v_old_billing
    or new.bill_number is distinct from old.bill_number
    or new.billed_at is distinct from old.billed_at
  ) then
    raise exception using
      errcode = '23514',
      message = 'TASK6_ORDER_FINAL_BILL_IMMUTABLE';
  end if;

  if v_old_payment in ('paid', 'refunded') and (
    v_new_payment is distinct from v_old_payment
    or new.paid_at is distinct from old.paid_at
    or new.gateway_status is distinct from old.gateway_status
    or new.gateway_order_id is distinct from old.gateway_order_id
    or new.gateway_payment_id is distinct from old.gateway_payment_id
    or new.payment_verified_at is distinct from old.payment_verified_at
  ) then
    raise exception using
      errcode = '23514',
      message = 'TASK6_ORDER_FINAL_PAYMENT_IMMUTABLE';
  end if;

  -- Food-order refunds need their own durable evidence workflow. Existing
  -- historical refunded rows remain readable; this only prevents a generic
  -- status patch from manufacturing a new refund state.
  if v_old_payment <> 'refunded' and v_new_payment = 'refunded' then
    raise exception using
      errcode = '23514',
      message = 'TASK6_ORDER_REFUND_WORKFLOW_REQUIRED';
  end if;

  if v_old_status in ('cancelled', 'payment_failed')
     and v_new_status is distinct from v_old_status
     and not v_verified_provider_recovery then
    raise exception using
      errcode = '23514',
      message = 'TASK6_ORDER_TERMINAL_STATE_IMMUTABLE';
  end if;

  if v_new_status in ('payment_pending', 'payment_failed')
     and v_new_status is distinct from v_old_status
     and not v_verified_provider_failure then
    raise exception using
      errcode = '23514',
      message = 'TASK6_ORDER_PAYMENT_LIFECYCLE_REQUIRED';
  end if;

  if v_verified_provider_recovery or v_verified_provider_failure then
    return new;
  end if;

  if v_old_effective_kitchen is distinct from v_new_effective_kitchen
     and not (
       (v_old_effective_kitchen = 'new' and v_new_effective_kitchen in ('accepted', 'preparing', 'cancelled'))
       or (v_old_effective_kitchen = 'accepted' and v_new_effective_kitchen in ('preparing', 'delayed', 'cancelled'))
       or (v_old_effective_kitchen = 'preparing' and v_new_effective_kitchen in ('ready', 'delayed', 'cancelled'))
       or (v_old_effective_kitchen = 'delayed' and v_new_effective_kitchen in ('preparing', 'ready', 'cancelled'))
       or (v_old_effective_kitchen = 'ready' and v_new_effective_kitchen = 'served')
     ) then
    raise exception using
      errcode = '23514',
      message = 'TASK6_ORDER_KITCHEN_TRANSITION_INVALID';
  end if;

  return new;
end;
$task6_guard_order_state_and_finality$;

revoke all on function public.task6_guard_order_state_and_finality()
  from public, anon, authenticated;
grant execute on function public.task6_guard_order_state_and_finality()
  to app_tenant_runtime, service_role;

do $task6_e_b_trigger$
begin
  if not exists (
    select 1
    from pg_catalog.pg_trigger trigger
    where trigger.tgrelid = 'public.orders'::regclass
      and trigger.tgname = 'orders_10_task6_state_finality_guard'
      and not trigger.tgisinternal
  ) then
    create trigger orders_10_task6_state_finality_guard
    before update of
      tenant_id, property_id, hotel_slug,
      parent_order_id, order_group_id, order_type,
      room_booking_id, room_service_charge_to_room,
      status, kitchen_status, payment_status, billing_status,
      payment_method, items, totals, financial_snapshot_version,
      bill_number, billed_at, paid_at,
      gateway_status, gateway_order_id, gateway_payment_id, payment_verified_at
    on public.orders
    for each row
    execute function public.task6_guard_order_state_and_finality();
  end if;
end;
$task6_e_b_trigger$;

comment on function public.task6_guard_order_state_and_finality() is
  'Task 6 forward-only guard: freezes paid/final food order financial source state, rejects generic terminal-state resurrection and illegal KDS transitions, and preserves the verified Task 2 payment recovery shape.';

do $task6_e_b_owner_membership$
begin
  execute format(
    'grant app_tenant_rpc_owner to %I with admin false, inherit false, set true granted by %I',
    current_user,
    current_user
  );
end;
$task6_e_b_owner_membership$;

grant create on schema public to app_tenant_rpc_owner;
alter function public.task6_guard_order_state_and_finality() owner to app_tenant_rpc_owner;
revoke create on schema public from app_tenant_rpc_owner;

do $task6_e_b_owner_membership_cleanup$
begin
  execute format(
    'revoke app_tenant_rpc_owner from %I granted by %I restrict',
    current_user,
    current_user
  );
end;
$task6_e_b_owner_membership_cleanup$;

do $task6_e_b_owner_cleanup_guard$
begin
  if exists (
    select 1
    from pg_catalog.pg_auth_members membership
    where membership.roleid = (
      select oid from pg_catalog.pg_roles where rolname = 'app_tenant_rpc_owner'
    )
      and (membership.inherit_option or membership.set_option)
  ) then
    raise exception 'TASK6_E_B_RPC_OWNER_EFFECTIVE_MEMBERSHIP_REMAINS';
  end if;

  if has_schema_privilege('app_tenant_rpc_owner', 'public', 'CREATE') then
    raise exception 'TASK6_E_B_RPC_OWNER_SCHEMA_CREATE_REMAINS';
  end if;
end;
$task6_e_b_owner_cleanup_guard$;

commit;
