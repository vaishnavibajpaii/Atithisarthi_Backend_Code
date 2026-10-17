-- TASK6-C: atomic, key+digest protected POS order creation.
--
-- Activates only new order writes. Historical orders are not updated, assigned a
-- snapshot version, repriced, or otherwise reinterpreted.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '5min';
set local search_path = pg_catalog, public;

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtext('task6-c-order-atomic-idempotency')
);

do $task6_c_guard$
begin
  if not exists (
    select 1 from pg_roles
    where rolname = 'app_tenant_rpc_owner'
      and not rolcanlogin and not rolsuper and not rolbypassrls
  ) then
    raise exception 'TASK6_C_RPC_OWNER_UNSAFE_OR_MISSING';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'task6_orders_creation_idempotency_shape_ck'
  ) then
    raise exception 'TASK6_C_IDEMPOTENCY_SHAPE_NOT_READY';
  end if;

  if not exists (
    select 1
    from pg_class index_relation
    join pg_index index_state on index_state.indexrelid = index_relation.oid
    where index_relation.relnamespace = 'public'::regnamespace
      and index_relation.relname = 'task6_orders_creation_idempotency_uq'
      and index_state.indisvalid and index_state.indisready and index_state.indisunique
  ) then
    raise exception 'TASK6_C_IDEMPOTENCY_INDEX_NOT_READY';
  end if;

  if to_regprocedure('public.task6_order_snapshot_valid(jsonb,jsonb)') is null then
    raise exception 'TASK6_C_SNAPSHOT_VALIDATOR_NOT_READY';
  end if;
end;
$task6_c_guard$;

create or replace function public.task6_create_order_atomic(
  p_operation_scope text,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_order jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $task6_create_order_atomic$
declare
  v_scope text := lower(btrim(coalesce(p_operation_scope, '')));
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := lower(btrim(coalesce(p_request_fingerprint, '')));
  v_slug text := btrim(coalesce(p_order->>'hotel_slug', ''));
  v_hotel public.hotels%rowtype;
  v_existing public.orders%rowtype;
  v_created public.orders%rowtype;
  v_parent public.orders%rowtype;
  v_table public.restaurant_tables%rowtype;
  v_booking public.room_bookings%rowtype;
  v_room public.rooms%rowtype;
  v_active_order jsonb;
  v_order_type text := lower(btrim(coalesce(p_order->>'order_type', '')));
  v_order_source text := lower(btrim(coalesce(p_order->>'order_source', '')));
  v_payment_status text := lower(btrim(coalesce(p_order->>'payment_status', 'unpaid')));
  v_billing_status text := lower(btrim(coalesce(p_order->>'billing_status', 'not_billed')));
  v_table_number text := btrim(coalesce(p_order->>'table_number', ''));
  v_table_id bigint;
  v_room_id bigint;
  v_booking_id bigint;
  v_parent_id text := btrim(coalesce(p_order->>'parent_order_id', ''));
  v_enforce_table_master boolean := false;
  v_addon_sequence integer;
  v_addon_remaining integer;
  v_addon_suffix text := '';
  v_sequence_label text;
  v_whatsapp_message text := coalesce(p_order->>'whatsapp_message', '');
begin
  if jsonb_typeof(coalesce(p_order, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = 'TASK6_ORDER_PAYLOAD_INVALID';
  end if;
  if v_scope not in (
    'public_order_create',
    'staff_table_order_create',
    'staff_room_service_order_create',
    'public_order_addon_create'
  ) then
    raise exception using errcode = '22023', message = 'TASK6_ORDER_SCOPE_INVALID';
  end if;
  if char_length(v_key) < 8 or char_length(v_key) > 200
     or v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' then
    raise exception using errcode = '22023', message = 'TASK6_ORDER_IDEMPOTENCY_KEY_INVALID';
  end if;
  if v_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'TASK6_ORDER_REQUEST_FINGERPRINT_INVALID';
  end if;
  if v_slug = '' then
    raise exception using errcode = '22023', message = 'TASK6_ORDER_HOTEL_REQUIRED';
  end if;

  -- Plain canonical read: Task 3 intentionally grants hotels SELECT, not UPDATE.
  select * into v_hotel
  from public.hotels
  where slug = v_slug;

  if not found then
    raise exception using errcode = 'P0001', message = 'TASK6_ORDER_HOTEL_NOT_FOUND';
  end if;
  if nullif(p_order->>'tenant_id', '') is not null
     and (p_order->>'tenant_id')::uuid <> v_hotel.tenant_id then
    raise exception using errcode = '42501', message = 'TASK6_ORDER_TENANT_MISMATCH';
  end if;
  if nullif(p_order->>'property_id', '') is not null
     and (p_order->>'property_id')::bigint <> v_hotel.id then
    raise exception using errcode = '42501', message = 'TASK6_ORDER_PROPERTY_MISMATCH';
  end if;

  -- Serialize all calls sharing one canonical operation identity before lookup.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'task6-order-create:' || v_hotel.tenant_id::text || ':' ||
      v_hotel.id::text || ':' || v_scope || ':' || v_key,
      0
    )
  );

  select * into v_existing
  from public.orders
  where tenant_id = v_hotel.tenant_id
    and property_id = v_hotel.id
    and creation_idempotency_scope = v_scope
    and creation_idempotency_key = v_key
  for update;

  if found then
    if lower(coalesce(v_existing.creation_request_fingerprint, '')) <> v_fingerprint then
      raise exception using
        errcode = 'P0001',
        message = 'TASK6_ORDER_IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object(
      'created', false,
      'idempotent', true,
      'order', to_jsonb(v_existing)
    );
  end if;

  if not public.task6_order_snapshot_valid(p_order->'items', p_order->'totals') then
    raise exception using errcode = '22023', message = 'TASK6_ORDER_FINANCIAL_SNAPSHOT_INVALID';
  end if;
  if lower(btrim(coalesce(p_order->>'status', 'new'))) <> 'new'
     or v_payment_status not in ('unpaid', 'customer_confirmed')
     or v_billing_status <> 'not_billed' then
    raise exception using errcode = '22023', message = 'TASK6_ORDER_INITIAL_STATE_INVALID';
  end if;
  if nullif(btrim(coalesce(p_order->>'tracking_token', '')), '') is null then
    raise exception using errcode = '22023', message = 'TASK6_ORDER_TRACKING_TOKEN_REQUIRED';
  end if;

  if v_scope = 'staff_table_order_create' then
    if v_order_type <> 'dine-in' or v_order_source <> 'staff'
       or v_parent_id <> '' or v_table_number = '' then
      raise exception using errcode = '22023', message = 'TASK6_ORDER_STAFF_TABLE_CONTEXT_INVALID';
    end if;
  elsif v_scope = 'staff_room_service_order_create' then
    if v_order_type <> 'room_service' or v_order_source <> 'room_service'
       or v_parent_id <> '' then
      raise exception using errcode = '22023', message = 'TASK6_ORDER_ROOM_SERVICE_CONTEXT_INVALID';
    end if;
  elsif v_scope = 'public_order_addon_create' then
    if v_order_type <> 'dine-in' or v_parent_id = '' then
      raise exception using errcode = '22023', message = 'TASK6_ORDER_ADDON_CONTEXT_INVALID';
    end if;
  elsif v_parent_id <> '' or v_order_type = 'room_service' then
    raise exception using errcode = '22023', message = 'TASK6_ORDER_PUBLIC_CONTEXT_INVALID';
  end if;

  if v_scope = 'public_order_addon_create' then
    select * into v_parent
    from public.orders
    where id::text = v_parent_id
      and tenant_id = v_hotel.tenant_id
      and property_id = v_hotel.id
      and hotel_slug = v_slug
      and tracking_token = btrim(coalesce(p_order->>'parent_tracking_token', ''))
    for update;

    if not found then
      raise exception using errcode = 'P0001', message = 'TASK6_ORDER_ADDON_PARENT_NOT_FOUND';
    end if;
    if lower(btrim(coalesce(v_parent.order_type, ''))) <> 'dine-in'
       or v_parent.parent_order_id is not null
       or lower(btrim(coalesce(v_parent.status, 'new'))) in ('completed', 'cancelled', 'payment_failed', 'payment_pending')
       or lower(btrim(coalesce(v_parent.payment_status, 'unpaid'))) in ('paid', 'refunded')
       or lower(btrim(coalesce(v_parent.billing_status, 'not_billed'))) in ('bill_ready', 'billed', 'closed') then
      raise exception using errcode = 'P0001', message = 'TASK6_ORDER_ADDON_PARENT_FINALIZED';
    end if;

    select coalesce(max(addon_sequence), 0) + 1
      into v_addon_sequence
    from public.orders
    where tenant_id = v_hotel.tenant_id
      and property_id = v_hotel.id
      and parent_order_id = v_parent.id::text;

    v_addon_remaining := v_addon_sequence;
    while v_addon_remaining > 0 loop
      v_addon_remaining := v_addon_remaining - 1;
      v_addon_suffix := chr(65 + mod(v_addon_remaining, 26)) || v_addon_suffix;
      v_addon_remaining := v_addon_remaining / 26;
    end loop;
    v_sequence_label := '#' || v_parent.id::text || '-' || coalesce(nullif(v_addon_suffix, ''), 'A');
    v_whatsapp_message := replace(
      v_whatsapp_message,
      '__TASK6_ADDON_SEQUENCE_LABEL__',
      v_sequence_label
    );
    v_table_number := coalesce(v_parent.table_number, '');
    v_order_source := coalesce(nullif(lower(btrim(v_parent.order_source)), ''), 'qr');
    v_table_id := v_parent.restaurant_table_id;
  elsif v_order_type = 'dine-in' then
    if v_table_number = '' then
      raise exception using errcode = '22023', message = 'TASK6_ORDER_TABLE_REQUIRED';
    end if;
    if coalesce(p_order->>'restaurant_table_id', '') ~ '^[0-9]+$' then
      v_table_id := (p_order->>'restaurant_table_id')::bigint;
    end if;

    select coalesce(settings.enforce_table_master, false)
      into v_enforce_table_master
    from public.hotel_ordering_settings settings
    where settings.tenant_id = v_hotel.tenant_id
      and settings.property_id = v_hotel.id
      and settings.hotel_slug = v_slug;
    v_enforce_table_master := coalesce(v_enforce_table_master, false);

    if v_table_id is not null then
      select * into v_table
      from public.restaurant_tables
      where id = v_table_id
        and tenant_id = v_hotel.tenant_id
        and property_id = v_hotel.id
        and hotel_slug = v_slug
      for update;
    else
      select * into v_table
      from public.restaurant_tables
      where tenant_id = v_hotel.tenant_id
        and property_id = v_hotel.id
        and hotel_slug = v_slug
        and lower(btrim(table_code)) = lower(v_table_number)
      for update;
    end if;

    if found then
      if not v_table.is_active or v_table.operational_status <> 'active' then
        raise exception using errcode = 'P0001', message = 'TABLE_NOT_OPERATIONAL';
      end if;
      v_table_id := v_table.id;
      v_table_number := v_table.table_code;
    elsif v_table_id is not null or v_enforce_table_master then
      raise exception using errcode = 'P0001', message = 'TABLE_NOT_CONFIGURED';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(lower(v_slug)),
      pg_catalog.hashtext(lower(btrim(v_table_number)))
    );
    v_active_order := public.get_staff_active_table_order(v_slug, v_table_number);
    if v_active_order is not null then
      return jsonb_build_object(
        'created', false,
        'idempotent', false,
        'code', 'TABLE_HAS_ACTIVE_ORDER',
        'activeOrder', v_active_order
      );
    end if;
  elsif v_scope = 'staff_room_service_order_create' then
    if coalesce(p_order->>'room_booking_id', '') !~ '^[0-9]+$'
       or coalesce(p_order->>'room_id', '') !~ '^[0-9]+$' then
      raise exception using errcode = '22023', message = 'TASK6_ORDER_ROOM_SERVICE_LINK_REQUIRED';
    end if;
    v_booking_id := (p_order->>'room_booking_id')::bigint;
    v_room_id := (p_order->>'room_id')::bigint;

    select * into v_booking
    from public.room_bookings
    where id = v_booking_id
      and tenant_id = v_hotel.tenant_id
      and property_id = v_hotel.id
      and hotel_slug = v_slug
    for update;
    if not found or v_booking.booking_status <> 'checked_in'
       or v_booking.room_id <> v_room_id then
      raise exception using errcode = 'P0001', message = 'TASK6_ORDER_ROOM_SERVICE_BOOKING_INVALID';
    end if;

    select * into v_room
    from public.rooms
    where id = v_room_id
      and tenant_id = v_hotel.tenant_id
      and property_id = v_hotel.id
      and hotel_slug = v_slug;
    if not found or not coalesce(v_room.is_active, false)
       or lower(btrim(coalesce(v_room.status, ''))) in ('inactive', 'maintenance') then
      raise exception using errcode = 'P0001', message = 'TASK6_ORDER_ROOM_SERVICE_ROOM_INVALID';
    end if;
  end if;

  insert into public.orders (
    tenant_id, property_id,
    hotel_name, hotel_slug, customer_name, customer_phone, customer_address,
    payment_method, note, items, totals, whatsapp_message, status,
    order_type, restaurant_table_id, table_number, order_source,
    payment_status, billing_status, created_by_staff_id,
    tracking_token, tracking_token_created_at,
    room_id, room_booking_id, room_number, room_service_guest_name,
    room_service_charge_to_room,
    parent_order_id, order_group_id, order_entry_type,
    order_sequence_label, addon_sequence,
    creation_idempotency_scope, creation_idempotency_key,
    creation_request_fingerprint, financial_snapshot_version
  ) values (
    v_hotel.tenant_id, v_hotel.id,
    case when v_scope = 'public_order_addon_create' then v_parent.hotel_name else coalesce(p_order->>'hotel_name', '') end,
    v_slug,
    case when v_scope = 'public_order_addon_create' then v_parent.customer_name else coalesce(p_order->>'customer_name', '') end,
    case when v_scope = 'public_order_addon_create' then v_parent.customer_phone else coalesce(p_order->>'customer_phone', '') end,
    case when v_scope = 'public_order_addon_create' then v_parent.customer_address else coalesce(p_order->>'customer_address', '') end,
    coalesce(p_order->>'payment_method', 'COD'),
    coalesce(p_order->>'note', ''),
    p_order->'items', p_order->'totals', v_whatsapp_message, 'new',
    nullif(v_order_type, ''), v_table_id, nullif(v_table_number, ''), nullif(v_order_source, ''),
    v_payment_status, v_billing_status,
    nullif(p_order->>'created_by_staff_id', '')::bigint,
    btrim(p_order->>'tracking_token'),
    coalesce(nullif(p_order->>'tracking_token_created_at', '')::timestamptz, pg_catalog.now()),
    case when v_scope = 'staff_room_service_order_create' then v_room_id else null end,
    case when v_scope = 'staff_room_service_order_create' then v_booking_id else null end,
    case when v_scope = 'staff_room_service_order_create' then coalesce(p_order->>'room_number', '') else null end,
    case when v_scope = 'staff_room_service_order_create' then coalesce(p_order->>'room_service_guest_name', '') else null end,
    case when v_scope = 'staff_room_service_order_create' then coalesce((p_order->>'room_service_charge_to_room')::boolean, false) else false end,
    case when v_scope = 'public_order_addon_create' then v_parent.id::text else null end,
    case when v_scope = 'public_order_addon_create' then coalesce(v_parent.order_group_id, v_parent.id::text) else null end,
    case when v_scope = 'public_order_addon_create' then 'add_on' else null end,
    case when v_scope = 'public_order_addon_create' then v_sequence_label else null end,
    case when v_scope = 'public_order_addon_create' then v_addon_sequence else null end,
    v_scope, v_key, v_fingerprint, 1
  )
  returning * into v_created;

  return jsonb_build_object(
    'created', true,
    'idempotent', false,
    'order', to_jsonb(v_created)
  );
end;
$task6_create_order_atomic$;

revoke all on function public.task6_create_order_atomic(text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.task6_create_order_atomic(text, text, text, jsonb)
  to app_tenant_runtime, service_role;

comment on function public.task6_create_order_atomic(text, text, text, jsonb) is
  'Task 6 atomic order creation with canonical tenant ownership, key+digest replay, exact financial snapshot validation, table/booking/parent locks, and retry-safe root/add-on sequencing.';

do $task6_c_owner_membership$
begin
  execute format(
    'grant app_tenant_rpc_owner to %I with admin false, inherit false, set true granted by %I',
    current_user,
    current_user
  );
end;
$task6_c_owner_membership$;

grant create on schema public to app_tenant_rpc_owner;

alter function public.task6_create_order_atomic(text, text, text, jsonb)
  owner to app_tenant_rpc_owner;

revoke create on schema public from app_tenant_rpc_owner;

do $task6_c_owner_membership_cleanup$
begin
  execute format(
    'revoke app_tenant_rpc_owner from %I granted by %I restrict',
    current_user,
    current_user
  );
end;
$task6_c_owner_membership_cleanup$;

do $task6_c_owner_cleanup_guard$
begin
  if exists (
    select 1
    from pg_auth_members membership
    where membership.roleid = (
      select oid from pg_roles where rolname = 'app_tenant_rpc_owner'
    )
      and (membership.inherit_option or membership.set_option)
  ) then
    raise exception 'TASK6_C_RPC_OWNER_EFFECTIVE_MEMBERSHIP_REMAINS';
  end if;

  if has_schema_privilege('app_tenant_rpc_owner', 'public', 'CREATE') then
    raise exception 'TASK6_C_RPC_OWNER_SCHEMA_CREATE_REMAINS';
  end if;
end;
$task6_c_owner_cleanup_guard$;

commit;
