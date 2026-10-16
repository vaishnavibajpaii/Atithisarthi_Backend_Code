-- TASK6-A: expand-only transaction/idempotency and exact-order-money support.
--
-- Data policy:
--   * No existing row is updated or deleted.
--   * No historical order, booking, receipt, bill, or payment is backfilled.
--   * New columns are nullable and existing application behavior remains valid.
--   * NOT VALID checks protect populated new fields without scanning or
--     rewriting legacy rows.
--
-- This file does not change Task 2 payment finality, Task 3 ownership/RLS,
-- Task 4 authorization, or Task 5 gateway ownership.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '5min';
set local search_path = pg_catalog, public;

select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('task6-a-transaction-support-expand'));

do $task6_a_guard$
declare
  unsafe_count bigint;
begin
  if not exists (
    select 1 from pg_roles
    where rolname = 'app_tenant_runtime'
      and rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole
      and not rolinherit and not rolreplication and not rolbypassrls
  ) then
    raise exception 'TASK6_A_RUNTIME_ROLE_UNSAFE_OR_MISSING';
  end if;

  if not exists (
    select 1 from pg_roles
    where rolname = 'app_tenant_rpc_owner'
      and not rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole
      and not rolinherit and not rolreplication and not rolbypassrls
  ) then
    raise exception 'TASK6_A_RPC_OWNER_UNSAFE_OR_MISSING';
  end if;

  select count(*) into unsafe_count
  from (values
    ('orders'),
    ('room_bookings'),
    ('room_checkout_receipts'),
    ('food_order_bill_snapshots'),
    ('hotels')
  ) expected(name)
  left join pg_class c
    on c.relname = expected.name
   and c.relnamespace = 'public'::regnamespace
   and c.relkind in ('r', 'p')
  where c.oid is null or not c.relrowsecurity or not c.relforcerowsecurity;

  if unsafe_count <> 0 then
    raise exception 'TASK6_A_REQUIRED_FORCE_RLS_RELATION_UNSAFE count=%', unsafe_count;
  end if;
end;
$task6_a_guard$;

alter table public.orders
  add column if not exists creation_idempotency_scope text,
  add column if not exists creation_idempotency_key text,
  add column if not exists creation_request_fingerprint text,
  add column if not exists billing_idempotency_key text,
  add column if not exists billing_request_fingerprint text,
  add column if not exists financial_snapshot_version integer;

alter table public.room_checkout_receipts
  add column if not exists request_fingerprint text;

do $task6_a_constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'task6_orders_creation_idempotency_shape_ck'
  ) then
    alter table public.orders
      add constraint task6_orders_creation_idempotency_shape_ck
      check (
        (
          creation_idempotency_scope is null
          and creation_idempotency_key is null
          and creation_request_fingerprint is null
        )
        or (
          creation_idempotency_scope is not null
          and char_length(btrim(creation_idempotency_scope)) between 1 and 80
          and creation_idempotency_key is not null
          and char_length(btrim(creation_idempotency_key)) between 8 and 200
          and creation_request_fingerprint ~ '^[a-f0-9]{64}$'
        )
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'task6_orders_billing_idempotency_shape_ck'
  ) then
    alter table public.orders
      add constraint task6_orders_billing_idempotency_shape_ck
      check (
        (
          billing_idempotency_key is null
          and billing_request_fingerprint is null
        )
        or (
          billing_idempotency_key is not null
          and char_length(btrim(billing_idempotency_key)) between 8 and 200
          and billing_request_fingerprint ~ '^[a-f0-9]{64}$'
        )
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'task6_orders_financial_snapshot_version_ck'
  ) then
    alter table public.orders
      add constraint task6_orders_financial_snapshot_version_ck
      check (financial_snapshot_version is null or financial_snapshot_version > 0)
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.room_checkout_receipts'::regclass
      and conname = 'task6_checkout_request_fingerprint_ck'
  ) then
    alter table public.room_checkout_receipts
      add constraint task6_checkout_request_fingerprint_ck
      check (
        request_fingerprint is null
        or request_fingerprint ~ '^[a-f0-9]{64}$'
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.room_bookings'::regclass
      and conname = 'task6_booking_request_fingerprint_ck'
  ) then
    alter table public.room_bookings
      add constraint task6_booking_request_fingerprint_ck
      check (
        request_fingerprint is null
        or request_fingerprint ~ '^[a-f0-9]{64}$'
      ) not valid;
  end if;
end;
$task6_a_constraints$;

create unique index if not exists task6_orders_creation_idempotency_uq
  on public.orders (
    tenant_id,
    property_id,
    creation_idempotency_scope,
    creation_idempotency_key
  )
  where creation_idempotency_key is not null;

create unique index if not exists task6_orders_billing_idempotency_uq
  on public.orders (tenant_id, property_id, billing_idempotency_key)
  where billing_idempotency_key is not null;

create index if not exists task6_orders_financial_snapshot_version_idx
  on public.orders (tenant_id, property_id, financial_snapshot_version, created_at desc)
  where financial_snapshot_version is not null;

create or replace function public.task6_safe_numeric(p_value text)
returns numeric
language plpgsql
immutable
parallel safe
set search_path = pg_catalog, public
as $task6_safe_numeric$
begin
  if p_value is null or btrim(p_value) !~ '^-?[0-9]+([.][0-9]+)?$' then
    return null;
  end if;

  begin
    return btrim(p_value)::numeric;
  exception
    when numeric_value_out_of_range or invalid_text_representation then
      return null;
  end;
end;
$task6_safe_numeric$;

create or replace function public.task6_order_snapshot_valid(
  p_items jsonb,
  p_totals jsonb
)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = pg_catalog, public
as $task6_order_snapshot_valid$
declare
  item jsonb;
  quantity numeric;
  unit_price numeric;
  line_total numeric;
  item_sum numeric := 0;
  subtotal numeric;
  gst numeric;
  gst_percent numeric;
  delivery_charge numeric;
  normal_total numeric;
  payable_total numeric;
  upi_discount numeric;
  upi_discount_percent numeric;
  upi_final_total numeric;
begin
  if jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0
     or jsonb_typeof(p_totals) <> 'object' then
    return false;
  end if;

  for item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(item) <> 'object' then
      return false;
    end if;

    quantity := public.task6_safe_numeric(item->>'qty');
    unit_price := public.task6_safe_numeric(item->>'price');
    line_total := public.task6_safe_numeric(item->>'lineTotal');

    if quantity is null or quantity <= 0 or trunc(quantity) <> quantity
       or unit_price is null or unit_price < 0
       or line_total is null or line_total < 0
       or round(line_total, 2) <> round(quantity * unit_price, 2) then
      return false;
    end if;

    item_sum := item_sum + round(line_total, 2);
  end loop;

  subtotal := public.task6_safe_numeric(p_totals->>'subtotal');
  gst := public.task6_safe_numeric(p_totals->>'gst');
  gst_percent := public.task6_safe_numeric(p_totals->>'gstPercent');
  delivery_charge := public.task6_safe_numeric(p_totals->>'deliveryCharge');
  normal_total := public.task6_safe_numeric(p_totals->>'normalTotal');
  payable_total := public.task6_safe_numeric(p_totals->>'total');

  if subtotal is null or subtotal < 0
     or gst is null or gst < 0
     or gst_percent is null or gst_percent < 0 or gst_percent > 100
     or delivery_charge is null or delivery_charge < 0
     or normal_total is null or normal_total < 0
     or payable_total is null or payable_total < 0
     or round(subtotal, 2) <> round(item_sum, 2)
     or round(gst, 2) <> round(subtotal * gst_percent / 100, 0)
     or round(normal_total, 2) <> round(subtotal + gst + delivery_charge, 2) then
    return false;
  end if;

  if p_totals ? 'gpayFinalTotal' or p_totals ? 'gpayDiscount' then
    upi_discount := public.task6_safe_numeric(p_totals->>'gpayDiscount');
    upi_discount_percent := public.task6_safe_numeric(p_totals->>'upiDiscountPercent');
    upi_final_total := public.task6_safe_numeric(p_totals->>'gpayFinalTotal');

    if upi_discount is null or upi_discount < 0
       or upi_discount_percent is null or upi_discount_percent < 0 or upi_discount_percent > 100
       or upi_final_total is null or upi_final_total < 0
       or round(upi_discount, 2) <> round(normal_total * upi_discount_percent / 100, 0)
       or round(upi_final_total, 2) <> round(greatest(0, normal_total - upi_discount), 2)
       or round(payable_total, 2) <> round(upi_final_total, 2) then
      return false;
    end if;
  elsif round(payable_total, 2) <> round(normal_total, 2) then
    return false;
  end if;

  return true;
exception
  when others then
    return false;
end;
$task6_order_snapshot_valid$;

create or replace function public.task6_order_payable_total(
  p_items jsonb,
  p_totals jsonb
)
returns numeric
language plpgsql
immutable
parallel safe
set search_path = pg_catalog, public
as $task6_order_payable_total$
declare
  payable numeric;
begin
  if not public.task6_order_snapshot_valid(p_items, p_totals) then
    raise exception using
      errcode = '22023',
      message = 'ORDER_FINANCIAL_SNAPSHOT_INVALID';
  end if;

  payable := public.task6_safe_numeric(p_totals->>'total');
  return round(payable, 2);
end;
$task6_order_payable_total$;

revoke all on function public.task6_safe_numeric(text)
  from public, anon, authenticated;
revoke all on function public.task6_order_snapshot_valid(jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.task6_order_payable_total(jsonb, jsonb)
  from public, anon, authenticated;

grant execute on function public.task6_safe_numeric(text)
  to app_tenant_runtime, app_tenant_rpc_owner, service_role;
grant execute on function public.task6_order_snapshot_valid(jsonb, jsonb)
  to app_tenant_runtime, app_tenant_rpc_owner, service_role;
grant execute on function public.task6_order_payable_total(jsonb, jsonb)
  to app_tenant_runtime, app_tenant_rpc_owner, service_role;

comment on column public.orders.creation_idempotency_scope is
  'Task 6 operation namespace for durable order-creation retry identity.';
comment on column public.orders.creation_idempotency_key is
  'Task 6 durable client operation key; never an authorization credential.';
comment on column public.orders.creation_request_fingerprint is
  'Lowercase SHA-256 digest of the canonical server request bound to creation_idempotency_key.';
comment on column public.orders.billing_idempotency_key is
  'Task 6 durable key for atomic order or order-family billing finalization.';
comment on column public.orders.billing_request_fingerprint is
  'Lowercase SHA-256 digest bound to billing_idempotency_key.';
comment on column public.orders.financial_snapshot_version is
  'Version of the validated server-authoritative order item/totals snapshot; NULL denotes legacy data.';
comment on column public.room_checkout_receipts.request_fingerprint is
  'Lowercase SHA-256 digest bound to the checkout idempotency key; NULL denotes a pre-Task-6 receipt.';

commit;
