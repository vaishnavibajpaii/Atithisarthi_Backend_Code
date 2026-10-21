-- TASK6-D read-only privilege diagnostic (no PII and no writes).
-- Run in Supabase SQL Editor. Sequence ownership is resolved directly from each
-- table's id column so unrelated pg_depend entries are never counted as sequences.

with
required_table_privileges(relation_name, privilege_name) as (
  values
    ('room_bookings', 'SELECT'),
    ('room_bookings', 'UPDATE'),
    ('orders', 'SELECT'),
    ('orders', 'UPDATE'),
    ('room_booking_payments', 'SELECT'),
    ('room_booking_payments', 'INSERT'),
    ('room_checkout_receipts', 'SELECT'),
    ('room_checkout_receipts', 'INSERT'),
    ('room_checkout_bill_snapshots', 'SELECT'),
    ('room_checkout_bill_snapshots', 'INSERT'),
    ('room_checkout_bill_audit', 'SELECT'),
    ('room_checkout_bill_audit', 'INSERT'),
    ('hotels', 'SELECT')
),
table_privilege_results as (
  select
    required.relation_name,
    required.privilege_name,
    pg_catalog.has_table_privilege(
      'app_tenant_runtime',
      pg_catalog.format('public.%I', required.relation_name),
      required.privilege_name
    ) as has_privilege
  from required_table_privileges required
),
sequence_targets(table_name) as (
  values
    ('room_booking_payments'),
    ('room_checkout_receipts'),
    ('room_checkout_bill_snapshots'),
    ('room_checkout_bill_audit')
),
sequence_results as (
  select
    target.table_name,
    pg_catalog.pg_get_serial_sequence(
      pg_catalog.format('public.%I', target.table_name),
      'id'
    ) as sequence_name
  from sequence_targets target
),
sequence_privilege_results as (
  select
    sequence_result.table_name,
    sequence_result.sequence_name,
    coalesce(
      pg_catalog.has_sequence_privilege(
        'app_tenant_runtime',
        sequence_result.sequence_name,
        'USAGE'
      ),
      false
    ) as has_usage
  from sequence_results sequence_result
),
checks as (
  select
    'runtime_required_table_privileges_missing'::text as check_name,
    '0'::text as expected,
    count(*) filter (where not has_privilege)::text as actual,
    case when count(*) filter (where not has_privilege) = 0
      then 'PASS' else 'FAIL' end as result
  from table_privilege_results

  union all

  select
    'runtime_required_sequence_usage_missing',
    '0',
    count(*) filter (where not has_usage)::text,
    case when count(*) filter (where not has_usage) = 0
      then 'PASS' else 'FAIL' end
  from sequence_privilege_results

  union all

  select
    'sequence_usage:' || table_name,
    'present and USAGE=true',
    coalesce(sequence_name, 'missing') || '; USAGE=' || has_usage::text,
    case when sequence_name is not null and has_usage then 'PASS' else 'FAIL' end
  from sequence_privilege_results
)
select check_name, expected, actual, result
from checks
order by check_name;
