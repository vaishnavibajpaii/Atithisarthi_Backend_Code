-- TASK6-C read-only verification for synthetic TEST order 273.
-- Run only after cancelling the order through the normal TEST staff/admin flow.
-- This script exposes no guest PII and performs no mutation.

begin transaction read only;
set local search_path = pg_catalog, public;

with synthetic_order as (
  select *
  from public.orders
  where id::text = '273'
    and note = 'TASK6 POS synthetic 0afc0872-ae70-43bb-a5ac-789d01f0c75d'
),
checks(check_name, expected, actual, result) as (
  select 'synthetic_order_present', '1', count(*)::text,
    case when count(*) = 1 then 'PASS' else 'FAIL' end
  from synthetic_order

  union all

  select 'synthetic_order_cancelled', '1', count(*)::text,
    case when count(*) = 1 then 'PASS' else 'FAIL' end
  from synthetic_order
  where lower(btrim(status)) = 'cancelled'

  union all

  select 'synthetic_order_unpaid', '1', count(*)::text,
    case when count(*) = 1 then 'PASS' else 'FAIL' end
  from synthetic_order
  where lower(btrim(coalesce(payment_status, ''))) = 'unpaid'

  union all

  select 'synthetic_order_not_billed', '1', count(*)::text,
    case when count(*) = 1 then 'PASS' else 'FAIL' end
  from synthetic_order
  where lower(btrim(coalesce(billing_status, ''))) = 'not_billed'

  union all

  select 'synthetic_snapshot_version_one', '1', count(*)::text,
    case when count(*) = 1 then 'PASS' else 'FAIL' end
  from synthetic_order
  where financial_snapshot_version = 1

  union all

  select 'synthetic_snapshot_valid', '1', count(*)::text,
    case when count(*) = 1 then 'PASS' else 'FAIL' end
  from synthetic_order
  where public.task6_order_snapshot_valid(items, totals)

  union all

  select 'synthetic_server_price_snapshot', '1', count(*)::text,
    case when count(*) = 1 then 'PASS' else 'FAIL' end
  from synthetic_order
  where jsonb_array_length(items) = 1
    and public.task6_safe_numeric(items->0->>'price') = 120.00
    and public.task6_safe_numeric(items->0->>'lineTotal') = 120.00
    and public.task6_safe_numeric(totals->>'subtotal') = 120.00
    and public.task6_safe_numeric(totals->>'total') = 126.00

  union all

  select 'synthetic_creation_identity_complete', '1', count(*)::text,
    case when count(*) = 1 then 'PASS' else 'FAIL' end
  from synthetic_order
  where creation_idempotency_scope = 'public_order_create'
    and nullif(btrim(creation_idempotency_key), '') is not null
    and creation_request_fingerprint ~ '^[0-9a-f]{64}$'

  union all

  select 'synthetic_creation_identity_duplicates', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from (
    select orders.tenant_id, orders.property_id,
           orders.creation_idempotency_scope, orders.creation_idempotency_key
    from public.orders orders
    join synthetic_order target
      on target.tenant_id = orders.tenant_id
     and target.property_id = orders.property_id
     and target.creation_idempotency_scope = orders.creation_idempotency_scope
     and target.creation_idempotency_key = orders.creation_idempotency_key
    group by 1, 2, 3, 4
    having count(*) > 1
  ) duplicate_identity
)
select check_name, expected, actual, result
from checks
order by check_name;

rollback;

