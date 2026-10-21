-- TASK6-D-A read-only verification. Returns no PII and makes no writes.

with
expected_relations(relation_name) as (
  values ('room_checkout_receipts')
),
checks as (
  select
    'receipt_booking_unique_index_valid'::text as check_name,
    'true'::text as expected,
    coalesce((
      select index_meta.indisunique
         and index_meta.indisvalid
         and index_meta.indisready
         and pg_catalog.pg_get_indexdef(index_meta.indexrelid)
           ilike '%(tenant_id, property_id, booking_id)%'
      from pg_catalog.pg_class index_relation
      join pg_catalog.pg_index index_meta
        on index_meta.indexrelid = index_relation.oid
      where index_relation.relnamespace = pg_catalog.to_regnamespace('public')
        and index_relation.relname = 'task6_checkout_receipt_per_booking_uq'
        and index_relation.relkind = 'i'
    ), false)::text as actual

  union all

  select
    'duplicate_receipts_per_booking',
    '0',
    count(*)::text
  from (
    select tenant_id, property_id, booking_id
    from public.room_checkout_receipts
    group by tenant_id, property_id, booking_id
    having count(*) > 1
  ) duplicates

  union all

  select
    'required_force_rls_missing',
    '0',
    count(*)::text
  from expected_relations expected_relation
  left join pg_catalog.pg_class relation
    on relation.relname = expected_relation.relation_name
   and relation.relnamespace = pg_catalog.to_regnamespace('public')
   and relation.relkind in ('r', 'p')
  where relation.oid is null
     or not relation.relrowsecurity
     or not relation.relforcerowsecurity
)
select
  check_name,
  expected,
  actual,
  case
    when check_name = 'receipt_booking_unique_index_valid'
      and actual = 'true' then 'PASS'
    when check_name <> 'receipt_booking_unique_index_valid'
      and actual = '0' then 'PASS'
    else 'FAIL'
  end as result
from checks
order by check_name;
