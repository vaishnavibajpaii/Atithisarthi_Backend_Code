-- TASK6-D-B: expand with a dormant, transactionally complete checkout RPC.
-- The current application does not call this function until the matching
-- backend revision is deployed and the checkout feature gate is enabled.
-- Historical bookings, receipts, and bill snapshots are never updated here.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '5min';
set local search_path = pg_catalog, public;

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtext('task6-d-b-atomic-checkout-finalizer')
);

do $task6_d_b_guard$
begin
  if not exists (
    select 1 from pg_catalog.pg_roles
    where rolname = 'app_tenant_runtime'
      and rolcanlogin and not rolsuper and not rolcreatedb
      and not rolcreaterole and not rolinherit
      and not rolreplication and not rolbypassrls
  ) then
    raise exception 'TASK6_D_B_RUNTIME_ROLE_UNSAFE_OR_MISSING';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_roles
    where rolname = 'app_tenant_rpc_owner'
      and not rolcanlogin and not rolsuper and not rolcreatedb
      and not rolcreaterole and not rolinherit
      and not rolreplication and not rolbypassrls
  ) then
    raise exception 'TASK6_D_B_RPC_OWNER_UNSAFE_OR_MISSING';
  end if;

  if to_regprocedure('public.task6_order_payable_total(jsonb,jsonb)') is null then
    raise exception 'TASK6_D_B_TASK6_C_PAYABLE_HELPER_MISSING';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_class index_relation
    join pg_catalog.pg_index index_state
      on index_state.indexrelid = index_relation.oid
    where index_relation.relnamespace = 'public'::regnamespace
      and index_relation.relname = 'task6_checkout_receipt_per_booking_uq'
      and index_state.indisunique and index_state.indisvalid and index_state.indisready
      and index_state.indnkeyatts = 3 and index_state.indpred is null
  ) then
    raise exception 'TASK6_D_B_RECEIPT_PER_BOOKING_INDEX_NOT_READY';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_class relation
    where relation.oid = 'public.room_checkout_receipts'::regclass
      and relation.relrowsecurity and relation.relforcerowsecurity
  ) or not exists (
    select 1 from pg_catalog.pg_class relation
    where relation.oid = 'public.room_checkout_bill_snapshots'::regclass
      and relation.relrowsecurity and relation.relforcerowsecurity
  ) then
    raise exception 'TASK6_D_B_FORCE_RLS_REQUIRED';
  end if;
end;
$task6_d_b_guard$;

create or replace function public.task6_finalize_room_checkout(
  p_hotel_slug text,
  p_booking_id bigint,
  p_amount numeric,
  p_payment_method text,
  p_transaction_id text,
  p_notes text,
  p_created_by_user_id text,
  p_created_by_role text,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_currency text,
  p_snapshot_json jsonb,
  p_payload_hash text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $task6_finalize_room_checkout$
declare
  v_hotel public.hotels%rowtype;
  v_booking public.room_bookings%rowtype;
  v_existing_receipt public.room_checkout_receipts%rowtype;
  v_receipt public.room_checkout_receipts%rowtype;
  v_existing_snapshot public.room_checkout_bill_snapshots%rowtype;
  v_snapshot public.room_checkout_bill_snapshots%rowtype;
  v_order record;
  v_room_due numeric(12,2);
  v_food_due numeric(12,2) := 0;
  v_food_total numeric(12,2) := 0;
  v_order_amount numeric(12,2);
  v_final_due numeric(12,2);
  v_snapshot_grand_total numeric(12,2);
  v_snapshot_paid numeric(12,2);
  v_snapshot_balance numeric(12,2);
  v_order_ids jsonb := '[]'::jsonb;
  v_allocations jsonb := '[]'::jsonb;
  v_updated_order_count integer := 0;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_hotel_token text;
  v_invoice_number text;
  v_snapshot_version integer;
  v_template_version integer;
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := lower(btrim(coalesce(p_request_fingerprint, '')));
  v_slug text := btrim(coalesce(p_hotel_slug, ''));
begin
  if v_slug = '' or p_booking_id is null or p_booking_id <= 0 then
    raise exception using errcode = '22023', message = 'TASK6_CHECKOUT_SCOPE_INVALID';
  end if;
  if v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception using errcode = '22023', message = 'TASK6_CHECKOUT_IDEMPOTENCY_KEY_INVALID';
  end if;
  if v_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'TASK6_CHECKOUT_REQUEST_FINGERPRINT_INVALID';
  end if;
  if nullif(btrim(coalesce(p_payment_method, '')), '') is null
     or char_length(btrim(p_payment_method)) > 80
     or lower(btrim(p_payment_method)) ~ '(razorpay|gateway|online)'
     or char_length(btrim(coalesce(p_transaction_id, ''))) > 200
     or char_length(coalesce(p_notes, '')) > 2000
     or nullif(btrim(coalesce(p_currency, '')), '') is null
     or upper(btrim(p_currency)) !~ '^[A-Z]{3,8}$' then
    raise exception using errcode = '22023', message = 'TASK6_CHECKOUT_PAYMENT_METADATA_INVALID_OR_PROVIDER_PAYMENT';
  end if;
  if p_amount is null or p_amount < 0 or p_amount > 99999999.99 then
    raise exception using errcode = '22023', message = 'TASK6_CHECKOUT_AMOUNT_INVALID';
  end if;
  if jsonb_typeof(p_snapshot_json) is distinct from 'object'
     or coalesce(p_snapshot_json->>'documentType', '') <> 'guest_folio'
     or coalesce(p_snapshot_json->>'provisional', 'true') <> 'false'
     or coalesce(p_snapshot_json->>'checkoutStatus', '') <> 'checked_out'
     or coalesce(p_snapshot_json->>'paymentStatus', '') <> 'paid'
     or jsonb_typeof(p_snapshot_json->'totals') is distinct from 'object'
     or jsonb_typeof(p_snapshot_json->'lines') is distinct from 'array'
     or jsonb_typeof(p_snapshot_json->'stay') is distinct from 'object'
     or coalesce(p_payload_hash, '') !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'TASK6_CHECKOUT_FINAL_SNAPSHOT_INVALID';
  end if;

  select * into v_hotel
  from public.hotels
  where slug = v_slug;
  if not found then
    raise exception using errcode = 'P0002', message = 'TASK6_CHECKOUT_HOTEL_NOT_FOUND';
  end if;

  -- Serialize identical operation keys across booking ids before any row locks.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      v_hotel.tenant_id::text || ':' || v_hotel.id::text || ':' || v_key,
      0
    )
  );

  select * into v_booking
  from public.room_bookings
  where id = p_booking_id
    and hotel_slug = v_slug
    and tenant_id = v_hotel.tenant_id
    and property_id = v_hotel.id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'TASK6_CHECKOUT_BOOKING_NOT_FOUND';
  end if;

  select * into v_existing_receipt
  from public.room_checkout_receipts
  where tenant_id = v_hotel.tenant_id
    and property_id = v_hotel.id
    and idempotency_key = v_key
  limit 1;
  if found then
    if v_existing_receipt.booking_id <> v_booking.id
       or v_existing_receipt.request_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '23505', message = 'TASK6_CHECKOUT_IDEMPOTENCY_CONFLICT';
    end if;
    select * into v_existing_snapshot
    from public.room_checkout_bill_snapshots
    where tenant_id = v_hotel.tenant_id
      and property_id = v_hotel.id
      and booking_id = v_booking.id
      and checkout_receipt_id = v_existing_receipt.id
    limit 1;
    if not found then
      raise exception using errcode = '23514', message = 'TASK6_CHECKOUT_SNAPSHOT_MISSING';
    end if;
    return jsonb_build_object(
      'idempotentReplay', true,
      'receipt', to_jsonb(v_existing_receipt),
      'booking', to_jsonb(v_booking),
      'snapshot', to_jsonb(v_existing_snapshot),
      'settledOrderCount', jsonb_array_length(v_existing_receipt.settled_order_ids)
    );
  end if;

  select * into v_existing_receipt
  from public.room_checkout_receipts
  where tenant_id = v_hotel.tenant_id
    and property_id = v_hotel.id
    and booking_id = v_booking.id
  limit 1;
  if found or v_booking.booking_status = 'checked_out' then
    raise exception using errcode = '23514', message = 'TASK6_CHECKOUT_ALREADY_FINALIZED';
  end if;
  if v_booking.booking_status <> 'checked_in' then
    raise exception using errcode = '23514', message = 'TASK6_CHECKOUT_BOOKING_NOT_CHECKED_IN';
  end if;
  if exists (
    select 1 from public.room_checkout_bill_snapshots
    where tenant_id = v_hotel.tenant_id
      and property_id = v_hotel.id
      and booking_id = v_booking.id
  ) then
    raise exception using errcode = '23514', message = 'TASK6_CHECKOUT_SNAPSHOT_PREEXISTS';
  end if;

  v_room_due := round(greatest(
    0,
    coalesce(v_booking.balance_amount, v_booking.total_amount - v_booking.advance_paid, 0)
  ), 2);
  if v_booking.total_amount is null or v_booking.total_amount < 0
     or v_booking.advance_paid is null or v_booking.advance_paid < 0 then
    raise exception using errcode = '22023', message = 'TASK6_CHECKOUT_BOOKING_FINANCIAL_STATE_INVALID';
  end if;

  -- The booking row lock is also acquired by the room-service link guard, so a
  -- new linked order cannot slip between this locked order set and checkout.
  for v_order in
    select
      orders.id,
      orders.created_at,
      orders.items,
      orders.totals,
      orders.status,
      orders.payment_status,
      orders.financial_snapshot_version
    from public.orders
    where orders.tenant_id = v_hotel.tenant_id
      and orders.property_id = v_hotel.id
      and orders.hotel_slug = v_booking.hotel_slug
      and orders.room_booking_id = v_booking.id
      and orders.room_service_charge_to_room is true
      and lower(coalesce(orders.status, 'new')) not in ('cancelled', 'payment_failed')
    order by orders.created_at, orders.id::text
    for update
  loop
    if v_order.financial_snapshot_version is not null then
      v_order_amount := public.task6_order_payable_total(
        to_jsonb(v_order.items), to_jsonb(v_order.totals)
      );
    else
      v_order_amount := round(coalesce(
        public.task6_safe_numeric(to_jsonb(v_order.totals)->>'gpayFinalTotal'),
        public.task6_safe_numeric(to_jsonb(v_order.totals)->>'final'),
        public.task6_safe_numeric(to_jsonb(v_order.totals)->>'total'),
        public.task6_safe_numeric(to_jsonb(v_order.totals)->>'normalTotal'),
        (
          select coalesce(sum(
            coalesce(public.task6_safe_numeric(item->>'qty'), 0) *
            coalesce(public.task6_safe_numeric(item->>'price'), 0)
          ), 0)
          from jsonb_array_elements(
            case when jsonb_typeof(to_jsonb(v_order.items)) = 'array'
              then to_jsonb(v_order.items) else '[]'::jsonb end
          ) as item
        ),
        0
      ), 2);
    end if;
    if v_order_amount is null or v_order_amount < 0 then
      raise exception using errcode = '22023', message = 'TASK6_CHECKOUT_ORDER_AMOUNT_INVALID';
    end if;

    v_food_total := round(v_food_total + v_order_amount, 2);
    if lower(coalesce(v_order.payment_status, 'unpaid')) not in ('paid', 'refunded') then
      v_food_due := round(v_food_due + v_order_amount, 2);
      v_order_ids := v_order_ids || jsonb_build_array(v_order.id::text);
      v_allocations := v_allocations || jsonb_build_array(jsonb_build_object(
        'orderId', v_order.id::text,
        'amount', v_order_amount
      ));
    end if;
  end loop;

  v_final_due := round(v_room_due + v_food_due, 2);
  if round(p_amount, 2) <> v_final_due then
    raise exception using errcode = '22023', message = 'TASK6_CHECKOUT_AMOUNT_MISMATCH';
  end if;

  v_snapshot_grand_total := public.task6_safe_numeric(p_snapshot_json->'totals'->>'grandTotal');
  v_snapshot_paid := public.task6_safe_numeric(p_snapshot_json->'totals'->>'paid');
  v_snapshot_balance := public.task6_safe_numeric(p_snapshot_json->'totals'->>'balance');
  if v_snapshot_grand_total is null
     or round(v_snapshot_grand_total, 2) <> round(v_booking.total_amount + v_food_total, 2)
     or v_snapshot_paid is null
     or round(v_snapshot_paid, 2) <> round(v_snapshot_grand_total, 2)
     or v_snapshot_balance is null
     or round(v_snapshot_balance, 2) <> 0
     or nullif(btrim(coalesce(p_snapshot_json->>'folioNumber', '')), '') is null
     or nullif(btrim(coalesce(p_snapshot_json->>'issuedAt', '')), '') is null then
    raise exception using errcode = '22023', message = 'TASK6_CHECKOUT_SNAPSHOT_TOTAL_MISMATCH';
  end if;
  v_snapshot_version := coalesce(nullif(p_snapshot_json->>'snapshotVersion', '')::integer, 0);
  v_template_version := coalesce(nullif(p_snapshot_json->>'templateVersion', '')::integer, 0);
  if v_snapshot_version <= 0 or v_template_version <= 0 then
    raise exception using errcode = '22023', message = 'TASK6_CHECKOUT_SNAPSHOT_VERSION_INVALID';
  end if;
  v_now := (p_snapshot_json->>'issuedAt')::timestamptz;
  v_hotel_token := left(trim(both '-' from regexp_replace(upper(v_slug), '[^A-Z0-9]+', '-', 'g')), 16);
  if v_hotel_token = '' then v_hotel_token := 'HOTEL'; end if;
  if p_snapshot_json->>'folioNumber' <> ('GF-' || v_hotel_token || '-' || v_booking.id::text) then
    raise exception using errcode = '22023', message = 'TASK6_CHECKOUT_FOLIO_NUMBER_MISMATCH';
  end if;

  if v_room_due > 0 then
    insert into public.room_booking_payments (
      tenant_id, property_id, hotel_slug, booking_id, amount,
      payment_method, payment_status, transaction_id, notes, paid_at, updated_at
    ) values (
      v_hotel.tenant_id, v_hotel.id, v_booking.hotel_slug, v_booking.id, v_room_due,
      btrim(p_payment_method), 'paid', nullif(btrim(coalesce(p_transaction_id, '')), ''),
      left(coalesce(p_notes, ''), 1000), v_now, v_now
    );
  end if;

  update public.orders as target
  set
    payment_status = 'paid',
    billing_status = 'billed',
    paid_at = coalesce(target.paid_at, v_now),
    billed_at = coalesce(target.billed_at, v_now),
    bill_number = coalesce(
      nullif(target.bill_number, ''),
      concat(
        'BILL-',
        left(trim(both '-' from regexp_replace(upper(coalesce(target.hotel_slug, 'HOTEL')), '[^A-Z0-9]+', '-', 'g')), 18),
        '-', to_char(v_now at time zone 'UTC', 'YYYYMMDD'), '-',
        right(regexp_replace(upper(target.id::text), '[^A-Z0-9]', '', 'g'), 8)
      )
    )
  where target.tenant_id = v_hotel.tenant_id
    and target.property_id = v_hotel.id
    and target.hotel_slug = v_booking.hotel_slug
    and target.room_booking_id = v_booking.id
    and target.room_service_charge_to_room is true
    and lower(coalesce(target.status, 'new')) not in ('cancelled', 'payment_failed')
    and lower(coalesce(target.payment_status, 'unpaid')) not in ('paid', 'refunded');
  get diagnostics v_updated_order_count = row_count;
  if v_updated_order_count <> jsonb_array_length(v_order_ids) then
    raise exception using errcode = '40001', message = 'TASK6_CHECKOUT_ORDER_SET_CHANGED';
  end if;

  update public.room_bookings
  set advance_paid = total_amount,
      balance_amount = 0,
      payment_status = 'paid',
      booking_status = 'checked_out',
      checked_out_at = v_now,
      updated_at = pg_catalog.clock_timestamp()
  where id = v_booking.id
    and tenant_id = v_hotel.tenant_id
    and property_id = v_hotel.id
    and hotel_slug = v_booking.hotel_slug
  returning * into v_booking;

  insert into public.room_checkout_receipts (
    tenant_id, property_id, hotel_slug, booking_id, idempotency_key,
    request_fingerprint, amount, room_amount, food_amount, currency,
    payment_method, payment_status, transaction_id, settled_order_ids,
    allocations_json, notes, created_by_user_id, created_by_role, paid_at, updated_at
  ) values (
    v_hotel.tenant_id, v_hotel.id, v_booking.hotel_slug, v_booking.id, v_key,
    v_fingerprint, v_final_due, v_room_due, v_food_due, upper(btrim(p_currency)),
    btrim(p_payment_method), 'paid', nullif(btrim(coalesce(p_transaction_id, '')), ''),
    v_order_ids, v_allocations, left(coalesce(p_notes, ''), 2000),
    nullif(btrim(coalesce(p_created_by_user_id, '')), ''),
    nullif(btrim(coalesce(p_created_by_role, '')), ''), v_now, v_now
  ) returning * into v_receipt;

  v_invoice_number := 'RCPT-' || v_hotel_token || '-' || v_receipt.id::text;
  insert into public.room_checkout_bill_snapshots (
    tenant_id, property_id, hotel_slug, booking_id, checkout_receipt_id,
    folio_number, invoice_number, snapshot_version, template_version,
    snapshot_json, payload_hash, issued_by, issued_by_role, issued_at
  ) values (
    v_hotel.tenant_id, v_hotel.id, v_booking.hotel_slug, v_booking.id, v_receipt.id,
    p_snapshot_json->>'folioNumber', v_invoice_number, v_snapshot_version, v_template_version,
    p_snapshot_json, lower(p_payload_hash), nullif(btrim(coalesce(p_created_by_user_id, '')), ''),
    left(coalesce(p_created_by_role, ''), 80), v_now
  ) returning * into v_snapshot;

  insert into public.room_checkout_bill_audit (
    hotel_slug, actor_id, actor_role, action, booking_id, snapshot_id,
    format_version, details_json
  ) values (
    v_booking.hotel_slug,
    nullif(btrim(coalesce(p_created_by_user_id, '')), ''),
    left(coalesce(p_created_by_role, ''), 80),
    'bill_issued', v_booking.id, v_snapshot.id, v_template_version,
    jsonb_build_object('payloadHash', lower(p_payload_hash), 'checkoutReceiptId', v_receipt.id)
  );

  return jsonb_build_object(
    'idempotentReplay', false,
    'receipt', to_jsonb(v_receipt),
    'booking', to_jsonb(v_booking),
    'snapshot', to_jsonb(v_snapshot),
    'settledOrderCount', v_updated_order_count
  );
end;
$task6_finalize_room_checkout$;

revoke all on function public.task6_finalize_room_checkout(
  text, bigint, numeric, text, text, text, text, text, text, text, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.task6_finalize_room_checkout(
  text, bigint, numeric, text, text, text, text, text, text, text, text, jsonb, text
) to app_tenant_runtime, service_role;

comment on function public.task6_finalize_room_checkout(
  text, bigint, numeric, text, text, text, text, text, text, text, text, jsonb, text
) is 'Task 6 dormant atomic room checkout finalizer: canonical tenant scope, key+digest replay, locked exact order payable, booking settlement, receipt, immutable final folio, and bill audit in one transaction.';

do $task6_d_b_owner_membership$
begin
  execute format(
    'grant app_tenant_rpc_owner to %I with admin false, inherit false, set true granted by %I',
    current_user,
    current_user
  );
end;
$task6_d_b_owner_membership$;

grant create on schema public to app_tenant_rpc_owner;
alter function public.task6_finalize_room_checkout(
  text, bigint, numeric, text, text, text, text, text, text, text, text, jsonb, text
) owner to app_tenant_rpc_owner;
revoke create on schema public from app_tenant_rpc_owner;

do $task6_d_b_owner_membership_cleanup$
begin
  execute format(
    'revoke app_tenant_rpc_owner from %I granted by %I restrict',
    current_user,
    current_user
  );
end;
$task6_d_b_owner_membership_cleanup$;

do $task6_d_b_owner_cleanup_guard$
begin
  if exists (
    select 1 from pg_catalog.pg_auth_members membership
    where membership.roleid = (select oid from pg_catalog.pg_roles where rolname = 'app_tenant_rpc_owner')
      and (membership.inherit_option or membership.set_option)
  ) then
    raise exception 'TASK6_D_B_RPC_OWNER_EFFECTIVE_MEMBERSHIP_REMAINS';
  end if;
  if has_schema_privilege('app_tenant_rpc_owner', 'public', 'CREATE') then
    raise exception 'TASK6_D_B_RPC_OWNER_SCHEMA_CREATE_REMAINS';
  end if;
end;
$task6_d_b_owner_cleanup_guard$;

commit;
