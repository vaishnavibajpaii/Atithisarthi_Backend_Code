-- TASK6-E-B2 TEST-only runtime failure-injection check.
--
-- This script targets only synthetic TEST order 274. Every attempted UPDATE is
-- expected to be rejected by a BEFORE UPDATE guard. The outer transaction is
-- rolled back unconditionally, so it leaves no order, bill, snapshot, audit,
-- payment, notification, or other durable row change.
--
-- It intentionally uses no temporary tables: Supabase SQL Editor may not keep
-- a temporary relation available for every statement in a submitted script.
-- Do not run against production or a different order id.

begin;
set local lock_timeout = '10s';
set local statement_timeout = '60s';
set local search_path = pg_catalog, public;

do $task6_e_b2_runtime_test$
declare
  v_order_id bigint := 274;
  v_hotel_slug text := 'hotel-sai-raj';
begin
  if not exists (
    select 1
    from public.orders order_row
    join public.food_order_bill_snapshots snapshot
      on snapshot.tenant_id = order_row.tenant_id
     and snapshot.property_id = order_row.property_id
     and snapshot.hotel_slug = order_row.hotel_slug
     and snapshot.order_id = order_row.id::text
    where order_row.id = v_order_id
      and order_row.hotel_slug = v_hotel_slug
      and lower(coalesce(order_row.billing_status, '')) = 'billed'
  ) then
    raise exception 'TASK6_E_B2_RUNTIME_TEST_TARGET_NOT_FINALIZED';
  end if;

  begin
    update public.orders
       set financial_snapshot_version = financial_snapshot_version + 1
     where id = v_order_id
       and hotel_slug = v_hotel_slug;
    raise exception 'TASK6_E_B2_RUNTIME_TEST_EXPECTED_SOURCE_SNAPSHOT_GUARD';
  exception when check_violation then
    if position('TASK6_ORDER_FINAL_FINANCIAL_SNAPSHOT_IMMUTABLE' in sqlerrm) = 0 then
      raise exception 'TASK6_E_B2_RUNTIME_TEST_UNEXPECTED_SOURCE_GUARD error=%', sqlerrm;
    end if;
  end;

  begin
    update public.orders
       set bill_number = 'TASK6-MUTATION-PROBE'
     where id = v_order_id
       and hotel_slug = v_hotel_slug;
    raise exception 'TASK6_E_B2_RUNTIME_TEST_EXPECTED_BILL_GUARD';
  exception when check_violation then
    if position('TASK6_ORDER_FINAL_BILL_IMMUTABLE' in sqlerrm) = 0 then
      raise exception 'TASK6_E_B2_RUNTIME_TEST_UNEXPECTED_BILL_GUARD error=%', sqlerrm;
    end if;
  end;

  begin
    update public.orders
       set status = 'cancelled'
     where id = v_order_id
       and hotel_slug = v_hotel_slug;
    raise exception 'TASK6_E_B2_RUNTIME_TEST_EXPECTED_STATUS_GUARD';
  exception when check_violation then
    if position('TASK6_ORDER_FINAL_OPERATIONAL_STATE_IMMUTABLE' in sqlerrm) = 0 then
      raise exception 'TASK6_E_B2_RUNTIME_TEST_UNEXPECTED_STATUS_GUARD error=%', sqlerrm;
    end if;
  end;

  begin
    update public.orders
       set kitchen_status = 'cancelled'
     where id = v_order_id
       and hotel_slug = v_hotel_slug;
    raise exception 'TASK6_E_B2_RUNTIME_TEST_EXPECTED_KITCHEN_GUARD';
  exception when check_violation then
    if position('TASK6_ORDER_FINAL_OPERATIONAL_STATE_IMMUTABLE' in sqlerrm) = 0 then
      raise exception 'TASK6_E_B2_RUNTIME_TEST_UNEXPECTED_KITCHEN_GUARD error=%', sqlerrm;
    end if;
  end;
end;
$task6_e_b2_runtime_test$;

select check_name, expected, actual, result
from (
  values
    ('final_source_snapshot_mutation_denied', 'TASK6_ORDER_FINAL_FINANCIAL_SNAPSHOT_IMMUTABLE', 'guard rejected mutation', 'PASS'),
    ('final_bill_mutation_denied', 'TASK6_ORDER_FINAL_BILL_IMMUTABLE', 'guard rejected mutation', 'PASS'),
    ('final_status_cancellation_denied', 'TASK6_ORDER_FINAL_OPERATIONAL_STATE_IMMUTABLE', 'guard rejected mutation', 'PASS'),
    ('final_kitchen_cancellation_denied', 'TASK6_ORDER_FINAL_OPERATIONAL_STATE_IMMUTABLE', 'guard rejected mutation', 'PASS')
) as results(check_name, expected, actual, result)
order by check_name;

rollback;
