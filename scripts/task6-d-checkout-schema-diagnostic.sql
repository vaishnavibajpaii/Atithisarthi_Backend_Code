-- TASK6-D schema/security diagnostic, stage 1 of 2.
-- Read-only catalog inspection. No application table rows are read.

begin transaction read only;

with
public_schema as (
  select oid from pg_catalog.pg_namespace where nspname = 'public'
),
required_relations(name) as (
  values
    ('hotels'), ('rooms'), ('room_bookings'), ('room_booking_payments'),
    ('room_checkout_receipts'), ('room_checkout_bill_snapshots'),
    ('room_checkout_bill_audit'), ('guest_stays'),
    ('room_housekeeping_tasks'), ('orders')
),
required_columns(table_name, column_name) as (
  values
    ('room_bookings', 'tenant_id'),
    ('room_bookings', 'property_id'),
    ('room_bookings', 'hotel_slug'),
    ('room_bookings', 'booking_status'),
    ('room_bookings', 'payment_status'),
    ('room_bookings', 'balance_amount'),
    ('room_bookings', 'checked_out_at'),
    ('room_checkout_receipts', 'tenant_id'),
    ('room_checkout_receipts', 'property_id'),
    ('room_checkout_receipts', 'hotel_slug'),
    ('room_checkout_receipts', 'booking_id'),
    ('room_checkout_receipts', 'idempotency_key'),
    ('room_checkout_receipts', 'request_fingerprint'),
    ('room_checkout_receipts', 'amount'),
    ('room_checkout_receipts', 'room_amount'),
    ('room_checkout_receipts', 'food_amount'),
    ('room_checkout_receipts', 'settled_order_ids'),
    ('room_checkout_receipts', 'allocations_json'),
    ('room_checkout_bill_snapshots', 'tenant_id'),
    ('room_checkout_bill_snapshots', 'property_id'),
    ('room_checkout_bill_snapshots', 'hotel_slug'),
    ('room_checkout_bill_snapshots', 'booking_id'),
    ('room_checkout_bill_snapshots', 'checkout_receipt_id'),
    ('room_checkout_bill_snapshots', 'snapshot_json'),
    ('room_checkout_bill_snapshots', 'payload_hash'),
    ('orders', 'financial_snapshot_version')
),
checkout_routine as (
  select routine.*
  from pg_catalog.pg_proc routine
  join public_schema on public_schema.oid = routine.pronamespace
  where routine.proname = 'settle_room_combined_checkout'
),
checkout_definition as (
  select lower(pg_catalog.pg_get_functiondef(oid)) as source
  from checkout_routine
),
checks(check_name, expected, actual, result) as (
  select 'public_schema_present', 'true',
    exists (select 1 from public_schema)::text,
    case when exists (select 1 from public_schema) then 'PASS' else 'FAIL' end

  union all

  select 'required_relations_missing', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from required_relations expected
  where not exists (
    select 1
    from pg_catalog.pg_class relation
    join public_schema on public_schema.oid = relation.relnamespace
    where relation.relname = expected.name
      and relation.relkind in ('r', 'p')
  )

  union all

  select 'required_relations_force_rls_missing', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from required_relations expected
  where not exists (
    select 1
    from pg_catalog.pg_class relation
    join public_schema on public_schema.oid = relation.relnamespace
    where relation.relname = expected.name
      and relation.relkind in ('r', 'p')
      and relation.relrowsecurity
      and relation.relforcerowsecurity
  )

  union all

  select 'required_columns_missing', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from required_columns expected
  where not exists (
    select 1
    from information_schema.columns actual
    where actual.table_schema = 'public'
      and actual.table_name = expected.table_name
      and actual.column_name = expected.column_name
  )

  union all

  select 'checkout_routine_overload_count', '1', count(*)::text,
    case when count(*) = 1 then 'PASS' else 'FAIL' end
  from checkout_routine

  union all

  select 'checkout_routine_security_invoker', 'true',
    coalesce((select (not prosecdef)::text from checkout_routine limit 1), 'false'),
    case when coalesce((select not prosecdef from checkout_routine limit 1), false)
      then 'PASS' else 'FAIL' end

  union all

  select 'checkout_routine_owner_safe', 'app_tenant_rpc_owner',
    coalesce((select pg_catalog.pg_get_userbyid(proowner) from checkout_routine limit 1), '<missing>'),
    case when coalesce((select pg_catalog.pg_get_userbyid(proowner) from checkout_routine limit 1), '') = 'app_tenant_rpc_owner'
      then 'PASS' else 'FAIL' end

  union all

  select 'checkout_routine_search_path_pinned', 'true',
    coalesce((
      select ('search_path=pg_catalog, public' = any(coalesce(proconfig, array[]::text[])))::text
      from checkout_routine limit 1
    ), 'false'),
    case when coalesce((
      select 'search_path=pg_catalog, public' = any(coalesce(proconfig, array[]::text[]))
      from checkout_routine limit 1
    ), false) then 'PASS' else 'FAIL' end

  union all

  select marker.check_name, 'true',
    coalesce((select position(marker.needle in source) > 0 from checkout_definition limit 1), false)::text,
    case when coalesce((select position(marker.needle in source) > 0 from checkout_definition limit 1), false)
      then 'PASS' else 'FAIL' end
  from (values
    ('checkout_locks_booking', 'for update'),
    ('checkout_writes_receipt', 'insert into public.room_checkout_receipts'),
    ('checkout_writes_final_snapshot_atomically', 'insert into public.room_checkout_bill_snapshots'),
    ('checkout_checks_request_digest', 'request_fingerprint'),
    ('checkout_uses_exact_order_payable', 'task6_order_payable_total'),
    ('checkout_reads_canonical_hotel', 'from public.hotels')
  ) marker(check_name, needle)

  union all

  select expected.check_name, 'true',
    exists (
      select 1
      from pg_catalog.pg_trigger trigger_state
      join pg_catalog.pg_class relation on relation.oid = trigger_state.tgrelid
      join public_schema on public_schema.oid = relation.relnamespace
      where relation.relname = expected.table_name
        and trigger_state.tgname = expected.trigger_name
        and not trigger_state.tgisinternal
        and trigger_state.tgenabled <> 'D'
    )::text,
    case when exists (
      select 1
      from pg_catalog.pg_trigger trigger_state
      join pg_catalog.pg_class relation on relation.oid = trigger_state.tgrelid
      join public_schema on public_schema.oid = relation.relnamespace
      where relation.relname = expected.table_name
        and trigger_state.tgname = expected.trigger_name
        and not trigger_state.tgisinternal
        and trigger_state.tgenabled <> 'D'
    ) then 'PASS' else 'FAIL' end
  from (values
    ('snapshot_protection_trigger_enabled', 'room_checkout_bill_snapshots', 'room_checkout_bill_snapshots_protect'),
    ('guest_stay_sync_trigger_enabled', 'room_bookings', 'trg_sync_guest_stay_from_booking_status'),
    ('room_service_scope_trigger_enabled', 'orders', 'orders_validate_room_service_booking_link')
  ) expected(check_name, table_name, trigger_name)

  union all

  select expected.check_name, 'true',
    exists (
      select 1
      from pg_catalog.pg_constraint constraint_state
      join pg_catalog.pg_class relation on relation.oid = constraint_state.conrelid
      join public_schema on public_schema.oid = relation.relnamespace
      where relation.relname = expected.table_name
        and (
          constraint_state.conname = expected.constraint_name
          or pg_catalog.pg_get_constraintdef(constraint_state.oid) ~* expected.definition_pattern
        )
    )::text,
    case when exists (
      select 1
      from pg_catalog.pg_constraint constraint_state
      join pg_catalog.pg_class relation on relation.oid = constraint_state.conrelid
      join public_schema on public_schema.oid = relation.relnamespace
      where relation.relname = expected.table_name
        and (
          constraint_state.conname = expected.constraint_name
          or pg_catalog.pg_get_constraintdef(constraint_state.oid) ~* expected.definition_pattern
        )
    ) then 'PASS' else 'FAIL' end
  from (values
    ('checkout_fingerprint_constraint_present', 'room_checkout_receipts', 'task6_checkout_request_fingerprint_ck', 'request_fingerprint'),
    ('receipt_idempotency_unique_present', 'room_checkout_receipts', '<by-definition>', 'unique.*hotel_slug.*idempotency_key'),
    ('receipt_booking_unique_present', 'room_checkout_receipts', '<by-definition>', 'unique.*hotel_slug.*booking_id')
  ) expected(check_name, table_name, constraint_name, definition_pattern)
)
select check_name, expected, actual, result
from checks
order by check_name;

rollback;
