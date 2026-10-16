-- TASK6-B: atomic, key+digest protected creation for no-advance bookings.
--
-- This migration creates one routine only. It does not update historical data,
-- alter Task 2 payments, change the live overlap constraint, or relax RLS.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '5min';
set local search_path = pg_catalog, public;

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtext('task6-b-booking-atomic-create')
);

do $task6_b_guard$
begin
  if not exists (
    select 1 from pg_roles
    where rolname = 'app_tenant_rpc_owner'
      and not rolcanlogin and not rolsuper and not rolbypassrls
  ) then
    raise exception 'TASK6_B_RPC_OWNER_UNSAFE_OR_MISSING';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.room_bookings'::regclass
      and conname = 'room_bookings_no_active_overlap'
      and convalidated
  ) then
    raise exception 'TASK6_B_BOOKING_OVERLAP_CONSTRAINT_NOT_READY';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.room_bookings'::regclass
      and conname = 'task6_booking_request_fingerprint_ck'
  ) then
    raise exception 'TASK6_B_TASK6_A_FINGERPRINT_CHECK_NOT_READY';
  end if;
end;
$task6_b_guard$;

create or replace function public.task6_create_room_booking_atomic(
  p_hotel_slug text,
  p_booking jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $task6_create_room_booking_atomic$
declare
  v_slug text := btrim(coalesce(p_hotel_slug, ''));
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := lower(btrim(coalesce(p_booking->>'request_fingerprint', '')));
  v_hotel public.hotels%rowtype;
  v_room public.rooms%rowtype;
  v_existing public.room_bookings%rowtype;
  v_created public.room_bookings%rowtype;
  v_check_in date;
  v_check_out date;
  v_room_price numeric;
  v_tax_amount numeric;
  v_discount_amount numeric;
  v_total_amount numeric;
  v_advance_paid numeric;
  v_balance_amount numeric;
  v_booking_status text;
  v_payment_status text;
begin
  if v_slug = '' then
    raise exception using errcode = '22023', message = 'TASK6_BOOKING_HOTEL_REQUIRED';
  end if;
  if jsonb_typeof(coalesce(p_booking, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = 'TASK6_BOOKING_PAYLOAD_INVALID';
  end if;
  if char_length(v_key) < 8 or char_length(v_key) > 200
     or v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' then
    raise exception using errcode = '22023', message = 'TASK6_BOOKING_IDEMPOTENCY_KEY_INVALID';
  end if;
  if v_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'TASK6_BOOKING_REQUEST_FINGERPRINT_INVALID';
  end if;
  if btrim(coalesce(p_booking->>'hotel_slug', '')) <> v_slug then
    raise exception using errcode = '22023', message = 'TASK6_BOOKING_HOTEL_MISMATCH';
  end if;

  -- Same scope/key requests serialize before reading or inserting. This makes
  -- a concurrent retry converge even when the booking exclusion constraint
  -- would otherwise be the first constraint to report a conflict.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'task6-booking-create:' || lower(v_slug) || ':' || v_key,
      0
    )
  );

  select * into v_existing
  from public.room_bookings
  where hotel_slug = v_slug
    and idempotency_key = v_key
  for update;

  if found then
    if lower(coalesce(v_existing.request_fingerprint, '')) <> v_fingerprint then
      raise exception using
        errcode = 'P0001',
        message = 'TASK6_BOOKING_IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object(
      'idempotent', true,
      'booking', to_jsonb(v_existing)
    );
  end if;

  select * into v_hotel
  from public.hotels
  where slug = v_slug
  for key share;
  if not found then
    raise exception using errcode = 'P0001', message = 'TASK6_BOOKING_HOTEL_NOT_FOUND';
  end if;

  if nullif(p_booking->>'tenant_id', '') is not null
     and (p_booking->>'tenant_id')::uuid <> v_hotel.tenant_id then
    raise exception using errcode = '42501', message = 'TASK6_BOOKING_TENANT_MISMATCH';
  end if;
  if nullif(p_booking->>'property_id', '') is not null
     and (p_booking->>'property_id')::bigint <> v_hotel.id then
    raise exception using errcode = '42501', message = 'TASK6_BOOKING_PROPERTY_MISMATCH';
  end if;

  select * into v_room
  from public.rooms
  where id = (p_booking->>'room_id')::bigint
    and tenant_id = v_hotel.tenant_id
    and property_id = v_hotel.id
    and hotel_slug = v_slug
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'TASK6_BOOKING_ROOM_NOT_FOUND';
  end if;
  if not coalesce(v_room.is_active, false)
     or v_room.status in ('maintenance', 'inactive') then
    raise exception using errcode = 'P0001', message = 'TASK6_BOOKING_ROOM_NOT_BOOKABLE';
  end if;

  v_check_in := (p_booking->>'check_in_date')::date;
  v_check_out := (p_booking->>'check_out_date')::date;
  if v_check_out <= v_check_in then
    raise exception using errcode = '22023', message = 'TASK6_BOOKING_DATE_RANGE_INVALID';
  end if;
  if coalesce((p_booking->>'total_nights')::integer, 0) <> (v_check_out - v_check_in) then
    raise exception using errcode = '22023', message = 'TASK6_BOOKING_NIGHT_COUNT_MISMATCH';
  end if;

  v_room_price := round((p_booking->>'room_price')::numeric, 2);
  v_tax_amount := round((p_booking->>'tax_amount')::numeric, 2);
  v_discount_amount := round((p_booking->>'discount_amount')::numeric, 2);
  v_total_amount := round((p_booking->>'total_amount')::numeric, 2);
  v_advance_paid := round((p_booking->>'advance_paid')::numeric, 2);
  v_balance_amount := round((p_booking->>'balance_amount')::numeric, 2);
  v_booking_status := lower(btrim(coalesce(p_booking->>'booking_status', '')));
  v_payment_status := lower(btrim(coalesce(p_booking->>'payment_status', '')));

  if v_room_price is null or v_tax_amount is null or v_discount_amount is null
     or v_total_amount is null or v_advance_paid is null or v_balance_amount is null
     or least(v_room_price, v_tax_amount, v_discount_amount, v_total_amount,
           v_advance_paid, v_balance_amount) < 0
     or v_total_amount <> round(v_room_price + v_tax_amount - v_discount_amount, 2)
     or v_advance_paid <> 0
     or v_balance_amount <> v_total_amount
     or v_payment_status <> 'unpaid' then
    raise exception using errcode = '22023', message = 'TASK6_BOOKING_FINANCIAL_SNAPSHOT_INVALID';
  end if;
  if v_booking_status not in ('pending', 'confirmed') then
    raise exception using errcode = '22023', message = 'TASK6_BOOKING_INITIAL_STATUS_INVALID';
  end if;
  if coalesce((p_booking->>'adults')::integer, 1) < 1
     or coalesce((p_booking->>'children')::integer, 0) < 0
     or btrim(coalesce(p_booking->>'guest_name', '')) = ''
     or btrim(coalesce(p_booking->>'guest_phone', '')) = '' then
    raise exception using errcode = '22023', message = 'TASK6_BOOKING_GUEST_REQUIRED';
  end if;

  if exists (
    select 1
    from public.room_maintenance m
    where m.tenant_id = v_hotel.tenant_id
      and m.property_id = v_hotel.id
      and m.room_id = v_room.id
      and m.status in ('open', 'in_progress')
      and m.start_at < (v_check_out::timestamp at time zone 'UTC')
      and (m.end_at is null or m.end_at > (v_check_in::timestamp at time zone 'UTC'))
  ) then
    raise exception using errcode = 'P0001', message = 'TASK6_BOOKING_MAINTENANCE_CONFLICT';
  end if;

  insert into public.room_bookings (
    tenant_id, property_id, hotel_slug, room_id,
    guest_name, guest_phone, guest_email, guest_id_proof,
    check_in_date, check_out_date, adults, children, total_nights,
    room_price, tax_amount, discount_amount, total_amount,
    advance_paid, balance_amount, booking_status, payment_status,
    booking_source, created_by_user_id, created_by_role, notes,
    rate_plan_id, pricing_snapshot, idempotency_key,
    tax_rule_id, tax_snapshot, pricing_version,
    guest_company_name, guest_gstin, guest_place_of_supply,
    request_fingerprint, updated_at
  ) values (
    v_hotel.tenant_id, v_hotel.id, v_slug, v_room.id,
    btrim(p_booking->>'guest_name'), btrim(p_booking->>'guest_phone'),
    nullif(btrim(coalesce(p_booking->>'guest_email', '')), ''),
    nullif(btrim(coalesce(p_booking->>'guest_id_proof', '')), ''),
    v_check_in, v_check_out,
    coalesce((p_booking->>'adults')::integer, 1),
    coalesce((p_booking->>'children')::integer, 0),
    (v_check_out - v_check_in),
    v_room_price, v_tax_amount, v_discount_amount, v_total_amount,
    0, v_total_amount, v_booking_status, 'unpaid',
    btrim(coalesce(p_booking->>'booking_source', 'online')),
    nullif(btrim(coalesce(p_booking->>'created_by_user_id', '')), ''),
    nullif(btrim(coalesce(p_booking->>'created_by_role', '')), ''),
    coalesce(p_booking->>'notes', ''),
    nullif(p_booking->>'rate_plan_id', '')::bigint,
    coalesce(p_booking->'pricing_snapshot', '{}'::jsonb),
    v_key,
    nullif(p_booking->>'tax_rule_id', '')::bigint,
    coalesce(p_booking->'tax_snapshot', '{}'::jsonb),
    coalesce((p_booking->>'pricing_version')::integer, 1),
    coalesce(p_booking->>'guest_company_name', ''),
    coalesce(p_booking->>'guest_gstin', ''),
    coalesce(p_booking->>'guest_place_of_supply', ''),
    v_fingerprint,
    pg_catalog.now()
  )
  returning * into v_created;

  return jsonb_build_object(
    'idempotent', false,
    'booking', to_jsonb(v_created)
  );
end;
$task6_create_room_booking_atomic$;

revoke all on function public.task6_create_room_booking_atomic(text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.task6_create_room_booking_atomic(text, jsonb, text)
  to app_tenant_runtime, service_role;

comment on function public.task6_create_room_booking_atomic(text, jsonb, text) is
  'Task 6 atomic no-advance booking creation with canonical ownership, key+digest replay, room lock, maintenance check, exact financial validation, and exclusion-constraint concurrency authority.';

-- PostgreSQL requires both SET membership in the destination role and CREATE
-- on the containing schema before ownership can be transferred. Mirror the
-- reviewed TASK3-G pattern: add only a transaction-local effective membership,
-- transfer ownership, then remove both temporary capabilities before commit.
do $task6_b_owner_membership$
begin
  execute format(
    'grant app_tenant_rpc_owner to %I with admin false, inherit false, set true granted by %I',
    current_user,
    current_user
  );
end;
$task6_b_owner_membership$;

grant create on schema public to app_tenant_rpc_owner;

alter function public.task6_create_room_booking_atomic(text, jsonb, text)
  owner to app_tenant_rpc_owner;

revoke create on schema public from app_tenant_rpc_owner;

do $task6_b_owner_membership_cleanup$
begin
  execute format(
    'revoke app_tenant_rpc_owner from %I granted by %I restrict',
    current_user,
    current_user
  );
end;
$task6_b_owner_membership_cleanup$;

do $task6_b_owner_cleanup_guard$
begin
  if exists (
    select 1
    from pg_auth_members membership
    where membership.roleid = (
      select oid from pg_roles where rolname = 'app_tenant_rpc_owner'
    )
      and (membership.inherit_option or membership.set_option)
  ) then
    raise exception 'TASK6_B_RPC_OWNER_EFFECTIVE_MEMBERSHIP_REMAINS';
  end if;

  if has_schema_privilege('app_tenant_rpc_owner', 'public', 'CREATE') then
    raise exception 'TASK6_B_RPC_OWNER_SCHEMA_CREATE_REMAINS';
  end if;
end;
$task6_b_owner_cleanup_guard$;

commit;
