-- TASK6-D preflight revision 3: read-only checkout atomicity, idempotency, and final-folio inventory.
--
-- Run in Supabase SQL Editor before authoring or applying TASK6-D migration SQL.
-- This script returns schema/security checks and aggregate counts only. It does
-- not expose guest PII, modify data, validate constraints, or replace routines.

begin transaction read only;
set local search_path = pg_catalog, public;

with
public_schema as (
  select oid
  from pg_namespace
  where nspname = 'public'
),
pg_class_catalog as (
  select relation.oid
  from pg_class relation
  join pg_namespace relation_schema on relation_schema.oid = relation.relnamespace
  where relation_schema.nspname = 'pg_catalog'
    and relation.relname = 'pg_class'
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
),
required_columns(table_name, column_name) as (
  values
    ('room_bookings', 'id'),
    ('room_bookings', 'tenant_id'),
    ('room_bookings', 'property_id'),
    ('room_bookings', 'hotel_slug'),
    ('room_bookings', 'room_id'),
    ('room_bookings', 'booking_status'),
    ('room_bookings', 'payment_status'),
    ('room_bookings', 'total_amount'),
    ('room_bookings', 'advance_paid'),
    ('room_bookings', 'balance_amount'),
    ('room_bookings', 'checked_out_at'),
    ('room_checkout_receipts', 'id'),
    ('room_checkout_receipts', 'tenant_id'),
    ('room_checkout_receipts', 'property_id'),
    ('room_checkout_receipts', 'hotel_slug'),
    ('room_checkout_receipts', 'booking_id'),
    ('room_checkout_receipts', 'idempotency_key'),
    ('room_checkout_receipts', 'request_fingerprint'),
    ('room_checkout_receipts', 'amount'),
    ('room_checkout_receipts', 'room_amount'),
    ('room_checkout_receipts', 'food_amount'),
    ('room_checkout_receipts', 'payment_status'),
    ('room_checkout_receipts', 'settled_order_ids'),
    ('room_checkout_receipts', 'allocations_json'),
    ('room_checkout_bill_snapshots', 'id'),
    ('room_checkout_bill_snapshots', 'tenant_id'),
    ('room_checkout_bill_snapshots', 'property_id'),
    ('room_checkout_bill_snapshots', 'hotel_slug'),
    ('room_checkout_bill_snapshots', 'booking_id'),
    ('room_checkout_bill_snapshots', 'checkout_receipt_id'),
    ('room_checkout_bill_snapshots', 'folio_number'),
    ('room_checkout_bill_snapshots', 'invoice_number'),
    ('room_checkout_bill_snapshots', 'snapshot_json'),
    ('room_checkout_bill_snapshots', 'payload_hash'),
    ('orders', 'tenant_id'),
    ('orders', 'property_id'),
    ('orders', 'hotel_slug'),
    ('orders', 'room_booking_id'),
    ('orders', 'room_service_charge_to_room'),
    ('orders', 'financial_snapshot_version'),
    ('orders', 'items'),
    ('orders', 'totals'),
    ('orders', 'status'),
    ('orders', 'payment_status'),
    ('orders', 'billing_status')
),
checkout_routine as (
  select routine.*
  from pg_proc routine
  join public_schema on public_schema.oid = routine.pronamespace
  where routine.proname = 'settle_room_combined_checkout'
    and oidvectortypes(routine.proargtypes) =
      'text, bigint, numeric, text, text, text, text, text, text'
),
checkout_definition as (
  select coalesce(pg_get_functiondef(checkout_routine.oid), '') as source
  from checkout_routine
),
checks(check_name, expected, actual, result) as (
  select
    'app_tenant_rpc_owner_safe', 'true',
    exists (
      select 1 from pg_roles
      where rolname = 'app_tenant_rpc_owner'
        and not rolcanlogin and not rolsuper and not rolcreatedb
        and not rolcreaterole and not rolinherit
        and not rolreplication and not rolbypassrls
    )::text,
    case when exists (
      select 1 from pg_roles
      where rolname = 'app_tenant_rpc_owner'
        and not rolcanlogin and not rolsuper and not rolcreatedb
        and not rolcreaterole and not rolinherit
        and not rolreplication and not rolbypassrls
    ) then 'PASS' else 'FAIL' end

  union all

  select
    'app_tenant_runtime_safe', 'true',
    exists (
      select 1 from pg_roles
      where rolname = 'app_tenant_runtime'
        and rolcanlogin and not rolsuper and not rolcreatedb
        and not rolcreaterole and not rolinherit
        and not rolreplication and not rolbypassrls
    )::text,
    case when exists (
      select 1 from pg_roles
      where rolname = 'app_tenant_runtime'
        and rolcanlogin and not rolsuper and not rolcreatedb
        and not rolcreaterole and not rolinherit
        and not rolreplication and not rolbypassrls
    ) then 'PASS' else 'FAIL' end

  union all

  select 'required_relations_missing', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from required_relations expected_relation
  left join pg_class relation
    on relation.relname = expected_relation.name
   and relation.relnamespace = (select oid from public_schema)
   and relation.relkind in ('r', 'p')
  where relation.oid is null

  union all

  select 'required_relations_force_rls_missing', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from required_relations expected_relation
  left join pg_class relation
    on relation.relname = expected_relation.name
   and relation.relnamespace = (select oid from public_schema)
   and relation.relkind in ('r', 'p')
  where relation.oid is null
     or not relation.relrowsecurity
     or not relation.relforcerowsecurity

  union all

  select 'required_columns_missing', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from required_columns expected_column
  left join information_schema.columns actual_column
    on actual_column.table_schema = 'public'
   and actual_column.table_name = expected_column.table_name
   and actual_column.column_name = expected_column.column_name
  where actual_column.column_name is null

  union all

  select 'checkout_routine_present', '1', count(*)::text,
    case when count(*) = 1 then 'PASS' else 'FAIL' end
  from checkout_routine

  union all

  select 'checkout_routine_security_invoker', 'true',
    coalesce((select (not prosecdef)::text from checkout_routine), 'false'),
    case when coalesce((select not prosecdef from checkout_routine), false)
      then 'PASS' else 'FAIL' end

  union all

  select 'checkout_routine_owner_safe', 'app_tenant_rpc_owner',
    coalesce((select pg_get_userbyid(proowner) from checkout_routine), '<missing>'),
    case when coalesce((select pg_get_userbyid(proowner) from checkout_routine), '') = 'app_tenant_rpc_owner'
      then 'PASS' else 'FAIL' end

  union all

  select 'checkout_routine_search_path_pinned', 'true',
    coalesce((
      select ('search_path=pg_catalog, public' = any(coalesce(proconfig, array[]::text[])))::text
      from checkout_routine
    ), 'false'),
    case when coalesce((
      select 'search_path=pg_catalog, public' = any(coalesce(proconfig, array[]::text[]))
      from checkout_routine
    ), false) then 'PASS' else 'FAIL' end

  union all

  select 'checkout_routine_runtime_execute', 'true',
    coalesce((select has_function_privilege('app_tenant_runtime', oid, 'EXECUTE') from checkout_routine), false)::text,
    case when coalesce((select has_function_privilege('app_tenant_runtime', oid, 'EXECUTE') from checkout_routine), false)
      then 'PASS' else 'FAIL' end

  union all

  select 'checkout_routine_service_role_execute', 'true',
    coalesce((select has_function_privilege('service_role', oid, 'EXECUTE') from checkout_routine), false)::text,
    case when coalesce((select has_function_privilege('service_role', oid, 'EXECUTE') from checkout_routine), false)
      then 'PASS' else 'FAIL' end

  union all

  select 'checkout_routine_untrusted_execute_grants', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from checkout_routine routine
  where exists (
      select 1
      from aclexplode(coalesce(routine.proacl, acldefault('f', routine.proowner))) routine_acl
      where routine_acl.privilege_type = 'EXECUTE'
        and routine_acl.grantee in (
          0,
          (select oid from pg_roles where rolname = 'anon'),
          (select oid from pg_roles where rolname = 'authenticated')
        )
    )

  union all

  select 'checkout_routine_locks_booking', 'true',
    coalesce((select source ~* 'room_bookings[[:space:][:print:]]*for update' from checkout_definition), false)::text,
    case when coalesce((select source ~* 'room_bookings[[:space:][:print:]]*for update' from checkout_definition), false)
      then 'PASS' else 'FAIL' end

  union all

  select 'checkout_routine_locks_orders', 'true',
    coalesce((select source ~* 'from public\.orders[[:space:][:print:]]*for update' from checkout_definition), false)::text,
    case when coalesce((select source ~* 'from public\.orders[[:space:][:print:]]*for update' from checkout_definition), false)
      then 'PASS' else 'FAIL' end

  union all

  select 'checkout_routine_writes_final_snapshot_atomically', 'true',
    coalesce((select source ~* 'insert into public\.room_checkout_bill_snapshots' from checkout_definition), false)::text,
    case when coalesce((select source ~* 'insert into public\.room_checkout_bill_snapshots' from checkout_definition), false)
      then 'PASS' else 'FAIL' end

  union all

  select 'checkout_routine_checks_request_digest', 'true',
    coalesce((select source ~* 'request_fingerprint' from checkout_definition), false)::text,
    case when coalesce((select source ~* 'request_fingerprint' from checkout_definition), false)
      then 'PASS' else 'FAIL' end

  union all

  select 'checkout_routine_uses_task6_exact_order_total', 'true',
    coalesce((select source ~* 'task6_order_payable_total' from checkout_definition), false)::text,
    case when coalesce((select source ~* 'task6_order_payable_total' from checkout_definition), false)
      then 'PASS' else 'FAIL' end

  union all

  select 'checkout_routine_derives_canonical_owner', 'true',
    coalesce((select source ~* 'from public\.hotels' and source ~* 'tenant_id' and source ~* 'property_id' from checkout_definition), false)::text,
    case when coalesce((select source ~* 'from public\.hotels' and source ~* 'tenant_id' and source ~* 'property_id' from checkout_definition), false)
      then 'PASS' else 'FAIL' end

  union all

  select 'snapshot_protection_trigger_enabled', 'true',
    exists (
      select 1 from pg_trigger
      where tgrelid = (
        select relation.oid
        from pg_class relation
        join public_schema on public_schema.oid = relation.relnamespace
        where relation.relname = 'room_checkout_bill_snapshots'
      )
        and tgname = 'room_checkout_bill_snapshots_protect'
        and not tgisinternal and tgenabled <> 'D'
    )::text,
    case when exists (
      select 1 from pg_trigger
      where tgrelid = (
        select relation.oid
        from pg_class relation
        join public_schema on public_schema.oid = relation.relnamespace
        where relation.relname = 'room_checkout_bill_snapshots'
      )
        and tgname = 'room_checkout_bill_snapshots_protect'
        and not tgisinternal and tgenabled <> 'D'
    ) then 'PASS' else 'FAIL' end

  union all

  select 'guest_stay_sync_trigger_enabled', 'true',
    exists (
      select 1 from pg_trigger
      where tgrelid = (
        select relation.oid
        from pg_class relation
        join public_schema on public_schema.oid = relation.relnamespace
        where relation.relname = 'room_bookings'
      )
        and tgname = 'trg_sync_guest_stay_from_booking_status'
        and not tgisinternal and tgenabled <> 'D'
    )::text,
    case when exists (
      select 1 from pg_trigger
      where tgrelid = (
        select relation.oid
        from pg_class relation
        join public_schema on public_schema.oid = relation.relnamespace
        where relation.relname = 'room_bookings'
      )
        and tgname = 'trg_sync_guest_stay_from_booking_status'
        and not tgisinternal and tgenabled <> 'D'
    ) then 'PASS' else 'FAIL' end

  union all

  select 'room_service_scope_trigger_enabled', 'true',
    exists (
      select 1 from pg_trigger
      where tgrelid = (
        select relation.oid
        from pg_class relation
        join public_schema on public_schema.oid = relation.relnamespace
        where relation.relname = 'orders'
      )
        and tgname = 'orders_validate_room_service_booking_link'
        and not tgisinternal and tgenabled <> 'D'
    )::text,
    case when exists (
      select 1 from pg_trigger
      where tgrelid = (
        select relation.oid
        from pg_class relation
        join public_schema on public_schema.oid = relation.relnamespace
        where relation.relname = 'orders'
      )
        and tgname = 'orders_validate_room_service_booking_link'
        and not tgisinternal and tgenabled <> 'D'
    ) then 'PASS' else 'FAIL' end

  union all

  select 'receipt_booking_unique_constraint_present', 'true',
    exists (
      select 1
      from pg_constraint constraint_state
      where constraint_state.conrelid = (
        select relation.oid
        from pg_class relation
        join public_schema on public_schema.oid = relation.relnamespace
        where relation.relname = 'room_checkout_receipts'
      )
        and constraint_state.contype = 'u'
        and pg_get_constraintdef(constraint_state.oid) ~* '\(hotel_slug, booking_id\)'
    )::text,
    case when exists (
      select 1
      from pg_constraint constraint_state
      where constraint_state.conrelid = (
        select relation.oid
        from pg_class relation
        join public_schema on public_schema.oid = relation.relnamespace
        where relation.relname = 'room_checkout_receipts'
      )
        and constraint_state.contype = 'u'
        and pg_get_constraintdef(constraint_state.oid) ~* '\(hotel_slug, booking_id\)'
    ) then 'PASS' else 'FAIL' end

  union all

  select 'receipt_idempotency_unique_constraint_present', 'true',
    exists (
      select 1
      from pg_constraint constraint_state
      where constraint_state.conrelid = (
        select relation.oid
        from pg_class relation
        join public_schema on public_schema.oid = relation.relnamespace
        where relation.relname = 'room_checkout_receipts'
      )
        and constraint_state.contype = 'u'
        and pg_get_constraintdef(constraint_state.oid) ~* '\(hotel_slug, idempotency_key\)'
    )::text,
    case when exists (
      select 1
      from pg_constraint constraint_state
      where constraint_state.conrelid = (
        select relation.oid
        from pg_class relation
        join public_schema on public_schema.oid = relation.relnamespace
        where relation.relname = 'room_checkout_receipts'
      )
        and constraint_state.contype = 'u'
        and pg_get_constraintdef(constraint_state.oid) ~* '\(hotel_slug, idempotency_key\)'
    ) then 'PASS' else 'FAIL' end

  union all

  select 'checkout_fingerprint_constraint_present', 'true',
    exists (
      select 1 from pg_constraint
      where conrelid = (
        select relation.oid
        from pg_class relation
        join public_schema on public_schema.oid = relation.relnamespace
        where relation.relname = 'room_checkout_receipts'
      )
        and conname = 'task6_checkout_request_fingerprint_ck'
    )::text,
    case when exists (
      select 1 from pg_constraint
      where conrelid = (
        select relation.oid
        from pg_class relation
        join public_schema on public_schema.oid = relation.relnamespace
        where relation.relname = 'room_checkout_receipts'
      )
        and conname = 'task6_checkout_request_fingerprint_ck'
    ) then 'PASS' else 'FAIL' end

  union all

  select 'runtime_required_table_privileges_missing', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from (values
    ('hotels', 'SELECT'),
    ('room_bookings', 'SELECT'),
    ('room_bookings', 'UPDATE'),
    ('room_booking_payments', 'SELECT'),
    ('room_booking_payments', 'INSERT'),
    ('room_checkout_receipts', 'SELECT'),
    ('room_checkout_receipts', 'INSERT'),
    ('room_checkout_bill_snapshots', 'SELECT'),
    ('room_checkout_bill_snapshots', 'INSERT'),
    ('room_checkout_bill_audit', 'INSERT'),
    ('orders', 'SELECT'),
    ('orders', 'UPDATE'),
    ('guest_stays', 'SELECT'),
    ('guest_stays', 'INSERT'),
    ('guest_stays', 'UPDATE'),
    ('room_housekeeping_tasks', 'SELECT'),
    ('room_housekeeping_tasks', 'INSERT')
  ) expected(table_name, privilege_name)
  left join pg_namespace table_schema
    on table_schema.nspname = 'public'
  left join pg_class table_relation
    on table_relation.relnamespace = table_schema.oid
   and table_relation.relname = expected.table_name
   and table_relation.relkind in ('r', 'p')
  where table_relation.oid is null
     or not has_table_privilege(
       'app_tenant_runtime',
       table_relation.oid,
       expected.privilege_name
     )

  union all

  select 'runtime_required_sequence_usage_missing', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from (values
    ('room_booking_payments', 'id'),
    ('room_checkout_receipts', 'id'),
    ('room_checkout_bill_snapshots', 'id'),
    ('room_checkout_bill_audit', 'id'),
    ('guest_stays', 'id'),
    ('room_housekeeping_tasks', 'id')
  ) expected(table_name, column_name)
  where not exists (
    select 1
    from pg_namespace table_schema
    join pg_class table_relation
      on table_relation.relnamespace = table_schema.oid
     and table_relation.relname = expected.table_name
     and table_relation.relkind in ('r', 'p')
    join pg_attribute id_column
      on id_column.attrelid = table_relation.oid
     and id_column.attname = expected.column_name
     and not id_column.attisdropped
    join pg_depend sequence_dependency
      on sequence_dependency.refclassid = (select oid from pg_class_catalog)
     and sequence_dependency.refobjid = table_relation.oid
     and sequence_dependency.refobjsubid = id_column.attnum
     and sequence_dependency.classid = (select oid from pg_class_catalog)
     and sequence_dependency.deptype in ('a', 'i')
    join pg_class sequence_relation
      on sequence_relation.oid = sequence_dependency.objid
     and sequence_relation.relkind = 'S'
    where table_schema.nspname = 'public'
      and has_sequence_privilege(
        'app_tenant_runtime',
        sequence_relation.oid,
        'USAGE'
      )
  )

  union all

  select 'duplicate_receipts_per_booking', '0', coalesce(sum(group_count - 1), 0)::text,
    case when coalesce(sum(group_count - 1), 0) = 0 then 'PASS' else 'FAIL' end
  from (
    select count(*)::bigint as group_count
    from public.room_checkout_receipts
    group by hotel_slug, booking_id
    having count(*) > 1
  ) duplicate_groups

  union all

  select 'duplicate_receipt_idempotency_keys', '0', coalesce(sum(group_count - 1), 0)::text,
    case when coalesce(sum(group_count - 1), 0) = 0 then 'PASS' else 'FAIL' end
  from (
    select count(*)::bigint as group_count
    from public.room_checkout_receipts
    group by hotel_slug, idempotency_key
    having count(*) > 1
  ) duplicate_groups

  union all

  select 'receipt_invalid_amount_allocations', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.room_checkout_receipts
  where amount is null or room_amount is null or food_amount is null
     or amount < 0 or room_amount < 0 or food_amount < 0
     or round(amount, 2) is distinct from round(room_amount + food_amount, 2)
     or jsonb_typeof(settled_order_ids) is distinct from 'array'
     or jsonb_typeof(allocations_json) is distinct from 'array'

  union all

  select 'receipt_scope_or_booking_mismatch', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.room_checkout_receipts receipt
  left join public.room_bookings booking on booking.id = receipt.booking_id
  where booking.id is null
     or booking.hotel_slug is distinct from receipt.hotel_slug
     or booking.tenant_id is distinct from receipt.tenant_id
     or booking.property_id is distinct from receipt.property_id

  union all

  select 'paid_receipt_booking_state_mismatch', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.room_checkout_receipts receipt
  join public.room_bookings booking
    on booking.id = receipt.booking_id and booking.hotel_slug = receipt.hotel_slug
  where receipt.payment_status = 'paid'
    and (
      booking.booking_status <> 'checked_out'
      or booking.payment_status <> 'paid'
      or round(coalesce(booking.balance_amount, 0), 2) <> 0
      or booking.checked_out_at is null
    )

  union all

  select 'invalid_receipt_request_fingerprints', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.room_checkout_receipts
  where request_fingerprint is not null
    and request_fingerprint !~ '^[0-9a-f]{64}$'

  union all

  select 'legacy_receipts_without_request_digest', 'informational', count(*)::text, 'INFO'
  from public.room_checkout_receipts
  where request_fingerprint is null

  union all

  select 'receipts_missing_final_snapshot', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.room_checkout_receipts receipt
  where not exists (
    select 1
    from public.room_checkout_bill_snapshots snapshot
    where snapshot.hotel_slug = receipt.hotel_slug
      and snapshot.booking_id = receipt.booking_id
      and snapshot.checkout_receipt_id = receipt.id
  )

  union all

  select 'checked_out_bookings_without_receipt', 'informational', count(*)::text, 'INFO'
  from public.room_bookings booking
  where booking.booking_status = 'checked_out'
    and not exists (
      select 1 from public.room_checkout_receipts receipt
      where receipt.hotel_slug = booking.hotel_slug
        and receipt.booking_id = booking.id
    )

  union all

  select 'checked_out_financial_state_mismatch', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.room_bookings
  where booking_status = 'checked_out'
    and (
      checked_out_at is null
      or payment_status <> 'paid'
      or round(coalesce(balance_amount, 0), 2) <> 0
    )

  union all

  select 'snapshot_source_scope_mismatch', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.room_checkout_bill_snapshots snapshot
  left join public.room_bookings booking on booking.id = snapshot.booking_id
  left join public.room_checkout_receipts receipt on receipt.id = snapshot.checkout_receipt_id
  where booking.id is null
     or booking.hotel_slug is distinct from snapshot.hotel_slug
     or booking.tenant_id is distinct from snapshot.tenant_id
     or booking.property_id is distinct from snapshot.property_id
     or snapshot.checkout_receipt_id is null
     or receipt.id is null
     or receipt.hotel_slug is distinct from snapshot.hotel_slug
     or receipt.booking_id is distinct from snapshot.booking_id
     or receipt.tenant_id is distinct from snapshot.tenant_id
     or receipt.property_id is distinct from snapshot.property_id

  union all

  select 'invalid_final_snapshot_shape', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.room_checkout_bill_snapshots
  where jsonb_typeof(snapshot_json) is distinct from 'object'
     or payload_hash !~ '^[0-9a-f]{64}$'
     or coalesce(lower(snapshot_json ->> 'provisional'), 'true') <> 'false'
     or coalesce(snapshot_json ->> 'documentType', '') <> 'guest_folio'
     or nullif(btrim(coalesce(snapshot_json ->> 'folioNumber', '')), '') is null
     or nullif(btrim(coalesce(snapshot_json ->> 'invoiceNumber', '')), '') is null
     or jsonb_typeof(snapshot_json -> 'totals') is distinct from 'object'
     or jsonb_typeof(snapshot_json -> 'lines') is distinct from 'array'

  union all

  select 'duplicate_snapshot_folio_numbers', '0', coalesce(sum(group_count - 1), 0)::text,
    case when coalesce(sum(group_count - 1), 0) = 0 then 'PASS' else 'FAIL' end
  from (
    select count(*)::bigint as group_count
    from public.room_checkout_bill_snapshots
    group by hotel_slug, folio_number
    having count(*) > 1
  ) duplicate_groups

  union all

  select 'duplicate_snapshot_invoice_numbers', '0', coalesce(sum(group_count - 1), 0)::text,
    case when coalesce(sum(group_count - 1), 0) = 0 then 'PASS' else 'FAIL' end
  from (
    select count(*)::bigint as group_count
    from public.room_checkout_bill_snapshots
    where invoice_number is not null
    group by hotel_slug, invoice_number
    having count(*) > 1
  ) duplicate_groups

  union all

  select 'settled_receipt_orders_not_paid_and_billed', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.room_checkout_receipts receipt
  cross join lateral jsonb_array_elements_text(receipt.settled_order_ids) settled(order_id)
  left join public.orders source_order
    on source_order.id::text = settled.order_id
   and source_order.hotel_slug = receipt.hotel_slug
  where source_order.id is null
     or source_order.room_booking_id is distinct from receipt.booking_id
     or source_order.tenant_id is distinct from receipt.tenant_id
     or source_order.property_id is distinct from receipt.property_id
     or source_order.room_service_charge_to_room is distinct from true
     or lower(coalesce(source_order.payment_status, '')) <> 'paid'
     or lower(coalesce(source_order.billing_status, '')) <> 'billed'

  union all

  select 'versioned_checkout_orders_with_invalid_snapshot', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.orders source_order
  where source_order.room_service_charge_to_room is true
    and source_order.financial_snapshot_version is not null
    and not public.task6_order_snapshot_valid(source_order.items, source_order.totals)

  union all

  select 'active_checkout_orders_with_legacy_snapshot', 'informational', count(*)::text, 'INFO'
  from public.orders source_order
  join public.room_bookings booking
    on booking.id = source_order.room_booking_id
   and booking.hotel_slug = source_order.hotel_slug
  where source_order.room_service_charge_to_room is true
    and booking.booking_status = 'checked_in'
    and lower(coalesce(source_order.status, 'new')) not in ('cancelled', 'payment_failed')
    and lower(coalesce(source_order.payment_status, 'unpaid')) not in ('paid', 'refunded')
    and source_order.financial_snapshot_version is null

  union all

  select 'receipt_guest_stay_not_closed', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.room_checkout_receipts receipt
  where not exists (
    select 1 from public.guest_stays stay
    where stay.hotel_slug = receipt.hotel_slug
      and stay.booking_id = receipt.booking_id
      and stay.stay_status = 'checked_out'
      and stay.checked_out_at is not null
  )

  union all

  select 'receipt_missing_housekeeping_turnover', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.room_checkout_receipts receipt
  join public.room_bookings booking
    on booking.id = receipt.booking_id and booking.hotel_slug = receipt.hotel_slug
  where not exists (
    select 1 from public.room_housekeeping_tasks task
    where task.hotel_slug = receipt.hotel_slug
      and task.booking_id = receipt.booking_id
      and task.room_id = booking.room_id
  )

  union all

  select 'checkout_receipt_count', 'informational', count(*)::text, 'INFO'
  from public.room_checkout_receipts

  union all

  select 'final_checkout_snapshot_count', 'informational', count(*)::text, 'INFO'
  from public.room_checkout_bill_snapshots

  union all

  select 'booking_status_values', 'informational',
    coalesce((
      select jsonb_object_agg(status_value, row_count order by status_value)::text
      from (
        select coalesce(nullif(lower(btrim(booking_status)), ''), '<empty>') status_value,
               count(*) row_count
        from public.room_bookings
        group by 1
      ) status_counts
    ), '{}'::jsonb::text),
    'INFO'

  union all

  select 'receipt_payment_status_values', 'informational',
    coalesce((
      select jsonb_object_agg(status_value, row_count order by status_value)::text
      from (
        select coalesce(nullif(lower(btrim(payment_status)), ''), '<empty>') status_value,
               count(*) row_count
        from public.room_checkout_receipts
        group by 1
      ) status_counts
    ), '{}'::jsonb::text),
    'INFO'
)
select check_name, expected, actual, result
from checks
order by check_name;

rollback;
