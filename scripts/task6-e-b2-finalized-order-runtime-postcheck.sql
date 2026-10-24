-- TASK6-E-B2 read-only evidence check after the rollback-only runtime test.
-- Targets only synthetic TEST order 274 and emits no customer/guest PII.

begin transaction read only;
set local search_path = pg_catalog, public;

with target_order as (
  select order_row.id, order_row.tenant_id, order_row.property_id, order_row.hotel_slug,
         order_row.status, order_row.kitchen_status, order_row.billing_status,
         order_row.bill_number, order_row.financial_snapshot_version
  from public.orders order_row
  where order_row.id = 274
    and order_row.hotel_slug = 'hotel-sai-raj'
), checks(check_name, expected, actual, result) as (
  select 'synthetic_final_order_present_once', '1', count(*)::text,
    case when count(*) = 1 then 'PASS' else 'FAIL' end
  from target_order

  union all

  select 'final_billing_identity_preserved', 'true', coalesce((
    select (lower(coalesce(billing_status, '')) = 'billed' and nullif(btrim(coalesce(bill_number, '')), '') is not null)::text
    from target_order
  ), 'false'),
  case when coalesce((
    select lower(coalesce(billing_status, '')) = 'billed' and nullif(btrim(coalesce(bill_number, '')), '') is not null
    from target_order
  ), false) then 'PASS' else 'FAIL' end

  union all

  select 'final_order_not_cancelled_or_failed', 'true', coalesce((
    select (
      lower(coalesce(status, '')) not in ('cancelled', 'payment_failed')
      and lower(coalesce(kitchen_status, '')) <> 'cancelled'
    )::text
    from target_order
  ), 'false'),
  case when coalesce((
    select lower(coalesce(status, '')) not in ('cancelled', 'payment_failed')
      and lower(coalesce(kitchen_status, '')) <> 'cancelled'
    from target_order
  ), false) then 'PASS' else 'FAIL' end

  union all

  select 'final_snapshot_preserved_once', '1', count(*)::text,
    case when count(*) = 1 then 'PASS' else 'FAIL' end
  from public.food_order_bill_snapshots snapshot
  join target_order order_row
    on snapshot.tenant_id = order_row.tenant_id
   and snapshot.property_id = order_row.property_id
   and snapshot.hotel_slug = order_row.hotel_slug
   and snapshot.order_id = order_row.id::text

  union all

  select 'final_bill_audit_preserved_once', '1', count(*)::text,
    case when count(*) = 1 then 'PASS' else 'FAIL' end
  from public.food_order_bill_audit audit
  join target_order order_row
    on audit.tenant_id = order_row.tenant_id
   and audit.property_id = order_row.property_id
   and audit.hotel_slug = order_row.hotel_slug
   and audit.order_id = order_row.id::text
  where audit.action = 'food_bill_issued'
)
select check_name, expected, actual, result
from checks
order by check_name;

commit;
