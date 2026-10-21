-- TASK6-D minimal context diagnostic.
-- Read-only. No table data, PII, or mutations.

begin transaction read only;

with public_schema as (
  select oid
  from pg_catalog.pg_namespace
  where nspname = 'public'
),
required_relations(name) as (
  values
    ('hotels'),
    ('rooms'),
    ('room_bookings'),
    ('room_booking_payments'),
    ('room_checkout_receipts'),
    ('room_checkout_bill_snapshots'),
    ('room_checkout_bill_audit'),
    ('guest_stays'),
    ('room_housekeeping_tasks'),
    ('orders')
)
select
  current_database() as database_name,
  current_user as execution_role,
  current_setting('search_path') as configured_search_path,
  exists (select 1 from public_schema) as public_schema_exists,
  (
    select count(*)
    from required_relations expected
    join pg_catalog.pg_class relation on relation.relname = expected.name
    join public_schema on public_schema.oid = relation.relnamespace
    where relation.relkind in ('r', 'p')
  ) as required_relations_visible,
  (
    select count(*)
    from pg_catalog.pg_proc routine
    join public_schema on public_schema.oid = routine.pronamespace
    where routine.proname = 'settle_room_combined_checkout'
  ) as checkout_routine_overloads_visible;

rollback;
