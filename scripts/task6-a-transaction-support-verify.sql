-- TASK6-A read-only verification.
-- Run only after task6-a-transaction-support-expand.sql commits.

with
expected_columns(table_name, column_name, data_type) as (
  values
    ('orders', 'creation_idempotency_scope', 'text'),
    ('orders', 'creation_idempotency_key', 'text'),
    ('orders', 'creation_request_fingerprint', 'text'),
    ('orders', 'billing_idempotency_key', 'text'),
    ('orders', 'billing_request_fingerprint', 'text'),
    ('orders', 'financial_snapshot_version', 'integer'),
    ('room_checkout_receipts', 'request_fingerprint', 'text')
),
expected_constraints(table_name, constraint_name) as (
  values
    ('orders', 'task6_orders_creation_idempotency_shape_ck'),
    ('orders', 'task6_orders_billing_idempotency_shape_ck'),
    ('orders', 'task6_orders_financial_snapshot_version_ck'),
    ('room_checkout_receipts', 'task6_checkout_request_fingerprint_ck'),
    ('room_bookings', 'task6_booking_request_fingerprint_ck')
),
expected_indexes(index_name, is_unique) as (
  values
    ('task6_orders_creation_idempotency_uq', true),
    ('task6_orders_billing_idempotency_uq', true),
    ('task6_orders_financial_snapshot_version_idx', false)
),
expected_routines(signature) as (
  values
    ('public.task6_safe_numeric(text)'::regprocedure),
    ('public.task6_order_snapshot_valid(jsonb,jsonb)'::regprocedure),
    ('public.task6_order_payable_total(jsonb,jsonb)'::regprocedure)
),
checks as (
  select 'columns_missing_or_wrong_type'::text as check_name, '0'::text as expected,
    count(*)::text as actual, 'EQUAL'::text as mode
  from expected_columns expected_column
  left join information_schema.columns actual_column
    on actual_column.table_schema = 'public'
   and actual_column.table_name = expected_column.table_name
   and actual_column.column_name = expected_column.column_name
   and actual_column.data_type = expected_column.data_type
  where actual_column.column_name is null

  union all

  select 'new_columns_unexpectedly_populated', '0', (
    (select count(*) from public.orders
      where creation_idempotency_scope is not null
         or creation_idempotency_key is not null
         or creation_request_fingerprint is not null
         or billing_idempotency_key is not null
         or billing_request_fingerprint is not null
         or financial_snapshot_version is not null)
    +
    (select count(*) from public.room_checkout_receipts
      where request_fingerprint is not null)
  )::text, 'EQUAL'

  union all

  select 'constraints_missing', '0', count(*)::text, 'EQUAL'
  from expected_constraints expected_constraint
  left join pg_constraint actual_constraint
    on actual_constraint.conrelid = format('public.%I', expected_constraint.table_name)::regclass
   and actual_constraint.conname = expected_constraint.constraint_name
  where actual_constraint.oid is null

  union all

  select 'expand_constraints_prematurely_validated', '0', count(*)::text, 'EQUAL'
  from expected_constraints expected_constraint
  join pg_constraint actual_constraint
    on actual_constraint.conrelid = format('public.%I', expected_constraint.table_name)::regclass
   and actual_constraint.conname = expected_constraint.constraint_name
  where actual_constraint.convalidated

  union all

  select 'indexes_missing_invalid_or_wrong_uniqueness', '0', count(*)::text, 'EQUAL'
  from expected_indexes expected_index
  left join pg_class index_relation
    on index_relation.relname = expected_index.index_name
   and index_relation.relnamespace = 'public'::regnamespace
   and index_relation.relkind = 'i'
  left join pg_index index_state on index_state.indexrelid = index_relation.oid
  where index_relation.oid is null
     or not index_state.indisvalid
     or not index_state.indisready
     or index_state.indisunique is distinct from expected_index.is_unique

  union all

  select 'routines_missing', '0', count(*)::text, 'EQUAL'
  from expected_routines expected_routine
  left join pg_proc routine on routine.oid = expected_routine.signature
  where routine.oid is null

  union all

  select 'routines_security_definer', '0', count(*)::text, 'EQUAL'
  from expected_routines expected_routine
  join pg_proc routine on routine.oid = expected_routine.signature
  where routine.prosecdef

  union all

  select 'routines_unpinned_search_path', '0', count(*)::text, 'EQUAL'
  from expected_routines expected_routine
  join pg_proc routine on routine.oid = expected_routine.signature
  where not ('search_path=pg_catalog, public' = any(coalesce(routine.proconfig, array[]::text[])))

  union all

  select 'routines_untrusted_execute', '0', count(*)::text, 'EQUAL'
  from expected_routines expected_routine
  where has_function_privilege('anon', expected_routine.signature, 'EXECUTE')
     or has_function_privilege('authenticated', expected_routine.signature, 'EXECUTE')

  union all

  select 'routines_tenant_runtime_execute_missing', '0', count(*)::text, 'EQUAL'
  from expected_routines expected_routine
  where not has_function_privilege('app_tenant_runtime', expected_routine.signature, 'EXECUTE')

  union all

  select 'task3_force_rls_missing', '0', count(*)::text, 'EQUAL'
  from (values
    ('orders'),
    ('room_bookings'),
    ('room_checkout_receipts'),
    ('food_order_bill_snapshots'),
    ('hotels')
  ) expected(name)
  left join pg_class relation
    on relation.relname = expected.name
   and relation.relnamespace = 'public'::regnamespace
   and relation.relkind in ('r', 'p')
  where relation.oid is null or not relation.relrowsecurity or not relation.relforcerowsecurity

  union all

  select 'valid_snapshot_fixture', 'true', public.task6_order_snapshot_valid(
    '[{"id":"fixture","name":"Fixture","qty":2,"price":50,"lineTotal":100}]'::jsonb,
    '{"subtotal":100,"gst":5,"deliveryCharge":0,"gstPercent":5,"normalTotal":105,"total":105}'::jsonb
  )::text, 'EQUAL'

  union all

  select 'valid_upi_snapshot_fixture', 'true', public.task6_order_snapshot_valid(
    '[{"id":"fixture","name":"Fixture","qty":2,"price":50,"lineTotal":100}]'::jsonb,
    '{"subtotal":100,"gst":5,"deliveryCharge":0,"gstPercent":5,"normalTotal":105,"upiDiscountPercent":10,"gpayDiscount":11,"gpayFinalTotal":94,"total":94}'::jsonb
  )::text, 'EQUAL'

  union all

  select 'tampered_total_fixture_rejected', 'false', public.task6_order_snapshot_valid(
    '[{"id":"fixture","name":"Fixture","qty":2,"price":50,"lineTotal":100}]'::jsonb,
    '{"subtotal":100,"gst":5,"deliveryCharge":0,"gstPercent":5,"normalTotal":105,"total":1}'::jsonb
  )::text, 'EQUAL'

  union all

  select 'missing_price_fixture_rejected', 'false', public.task6_order_snapshot_valid(
    '[{"id":"fixture","name":"Fixture","qty":2,"lineTotal":100}]'::jsonb,
    '{"subtotal":100,"gst":5,"deliveryCharge":0,"gstPercent":5,"normalTotal":105,"total":105}'::jsonb
  )::text, 'EQUAL'

  union all

  select 'exact_payable_fixture', '94.00', public.task6_order_payable_total(
    '[{"id":"fixture","name":"Fixture","qty":2,"price":50,"lineTotal":100}]'::jsonb,
    '{"subtotal":100,"gst":5,"deliveryCharge":0,"gstPercent":5,"normalTotal":105,"upiDiscountPercent":10,"gpayDiscount":11,"gpayFinalTotal":94,"total":94}'::jsonb
  )::text, 'NUMERIC_EQUAL'
)
select
  check_name,
  expected,
  actual,
  case
    when mode = 'NUMERIC_EQUAL' and expected::numeric = actual::numeric then 'PASS'
    when mode = 'EQUAL' and expected = actual then 'PASS'
    else 'FAIL'
  end as result
from checks
order by check_name;
