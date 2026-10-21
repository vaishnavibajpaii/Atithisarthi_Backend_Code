-- TASK6-D-A: additive database guard for one successful checkout receipt per stay.
-- No existing booking, payment, receipt, order, or folio row is changed.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '5min';
set local search_path = pg_catalog, public;

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtext('task6-d-a-checkout-per-booking')
);

do $task6_d_a_guard$
declare
  duplicate_groups bigint;
  index_oid oid;
  index_state record;
  actual_definition text;
begin
  if to_regclass('public.room_checkout_receipts') is null then
    raise exception 'TASK6_D_A_RECEIPT_TABLE_MISSING';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_roles
    where rolname = 'app_tenant_runtime'
      and rolcanlogin
      and not rolsuper
      and not rolcreatedb
      and not rolcreaterole
      and not rolinherit
      and not rolreplication
      and not rolbypassrls
  ) then
    raise exception 'TASK6_D_A_RUNTIME_ROLE_UNSAFE_OR_MISSING';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_roles
    where rolname = 'app_tenant_rpc_owner'
      and not rolcanlogin
      and not rolsuper
      and not rolcreatedb
      and not rolcreaterole
      and not rolinherit
      and not rolreplication
      and not rolbypassrls
  ) then
    raise exception 'TASK6_D_A_RPC_OWNER_UNSAFE_OR_MISSING';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_class relation
    where relation.oid = 'public.room_checkout_receipts'::pg_catalog.regclass
      and relation.relrowsecurity
      and relation.relforcerowsecurity
  ) then
    raise exception 'TASK6_D_A_FORCE_RLS_REQUIRED';
  end if;

  if (
    select count(*) from information_schema.columns
    where table_schema = 'public'
      and table_name = 'room_checkout_receipts'
      and column_name in ('tenant_id', 'property_id', 'booking_id')
      and is_nullable = 'NO'
  ) <> 3 then
    raise exception 'TASK6_D_A_CANONICAL_OWNER_COLUMNS_MUST_BE_NOT_NULL';
  end if;

  select count(*) into duplicate_groups
  from (
    select tenant_id, property_id, booking_id
    from public.room_checkout_receipts
    group by tenant_id, property_id, booking_id
    having count(*) > 1
  ) duplicates;

  if duplicate_groups <> 0 then
    raise exception 'TASK6_D_A_DUPLICATE_RECEIPTS_PER_BOOKING groups=%', duplicate_groups;
  end if;

  index_oid := pg_catalog.to_regclass('public.task6_checkout_receipt_per_booking_uq');
  if index_oid is not null then
    if not exists (
      select 1 from pg_catalog.pg_index
      where indexrelid = index_oid
    ) then
      raise exception 'TASK6_D_A_EXISTING_INDEX_NAME_CONFLICT';
    end if;

    select index_meta.indisunique, index_meta.indisvalid, index_meta.indisready,
           index_meta.indnkeyatts, index_meta.indnatts, index_meta.indpred
      into index_state
    from pg_catalog.pg_index index_meta
    where index_meta.indexrelid = index_oid;

    select pg_catalog.pg_get_indexdef(index_oid) into actual_definition;

    if not coalesce(index_state.indisunique, false)
       or not coalesce(index_state.indisvalid, false)
       or not coalesce(index_state.indisready, false)
       or index_state.indnkeyatts <> 3
       or index_state.indnatts <> 3
       or index_state.indpred is not null
       or actual_definition not ilike '% (tenant_id, property_id, booking_id)' then
      raise exception 'TASK6_D_A_EXISTING_INDEX_NAME_CONFLICT definition=%', actual_definition;
    end if;
  end if;
end;
$task6_d_a_guard$;

create unique index if not exists task6_checkout_receipt_per_booking_uq
  on public.room_checkout_receipts (tenant_id, property_id, booking_id);

comment on index public.task6_checkout_receipt_per_booking_uq is
  'Task 6: one durable combined-checkout receipt per canonical tenant, property, and booking.';

commit;
