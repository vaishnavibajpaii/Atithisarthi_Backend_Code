-- TASK6-F: make secure QR writes compatible with the restricted Task 3 runtime.
--
-- Scope:
--   * grants only the two SQL helper functions needed by existing QR routines;
--   * version-tags newly created QR root orders with their canonical snapshot;
--   * preserves the existing QR session idempotency table and outbox transaction.
--
-- This does not update historical orders, bills, payments, or QR records.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '5min';
set local search_path = pg_catalog, public;

select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('task6-f-secure-qr-runtime'));

do $task6_f_guard$
begin
  if not exists (
    select 1 from pg_roles
    where rolname = 'app_tenant_runtime'
      and rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole
      and not rolinherit and not rolreplication and not rolbypassrls
  ) then
    raise exception 'TASK6_F_RUNTIME_ROLE_UNSAFE_OR_MISSING';
  end if;

  if not exists (
    select 1 from pg_roles
    where rolname = 'app_tenant_rpc_owner'
      and not rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole
      and not rolinherit and not rolreplication and not rolbypassrls
  ) then
    raise exception 'TASK6_F_RPC_OWNER_UNSAFE_OR_MISSING';
  end if;

  if to_regprocedure('public.submit_secure_qr_table_order(text,text,text,text,jsonb,text)') is null
     or to_regprocedure('public.merge_qr_order_totals(jsonb,jsonb)') is null
     or to_regprocedure('public.replace_qr_order_totals(jsonb,jsonb,jsonb)') is null
     or to_regprocedure('public.task6_order_snapshot_valid(jsonb,jsonb)') is null then
    raise exception 'TASK6_F_REQUIRED_QR_ROUTINE_MISSING';
  end if;

  if not exists (
    select 1 from pg_attribute
    where attrelid = 'public.orders'::regclass
      and attname = 'financial_snapshot_version' and not attisdropped
  ) then
    raise exception 'TASK6_F_ORDER_SNAPSHOT_VERSION_COLUMN_MISSING';
  end if;
end;
$task6_f_guard$;

-- These helper functions are not public API endpoints. Their execution is
-- needed inside security-invoker QR routines under the restricted runtime role.
revoke all on function public.merge_qr_order_totals(jsonb,jsonb)
  from public, anon, authenticated;
revoke all on function public.replace_qr_order_totals(jsonb,jsonb,jsonb)
  from public, anon, authenticated;
grant execute on function public.merge_qr_order_totals(jsonb,jsonb)
  to app_tenant_runtime, service_role;
grant execute on function public.replace_qr_order_totals(jsonb,jsonb,jsonb)
  to app_tenant_runtime, service_role;

create or replace function public.submit_secure_qr_table_order(
  p_token_hash text,
  p_session_hash text,
  p_idempotency_key_hash text,
  p_request_fingerprint text,
  p_order jsonb,
  p_request_id text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $task6_f_submit_secure_qr$
declare
  v_token public.restaurant_table_qr_tokens%rowtype;
  v_session public.qr_customer_sessions%rowtype;
  v_table public.restaurant_tables%rowtype;
  v_order public.orders%rowtype;
  v_round public.order_rounds%rowtype;
  v_submission public.qr_order_submissions%rowtype;
  v_idempotency public.qr_idempotency_records%rowtype;
  v_sequence integer := 1;
  v_kot_reference text;
  v_items jsonb := coalesce(p_order->'items', '[]'::jsonb);
  v_totals jsonb := coalesce(p_order->'totals', '{}'::jsonb);
  v_response jsonb;
  v_first_order boolean := false;
begin
  if coalesce(p_token_hash, '') = '' or coalesce(p_session_hash, '') = '' or
     coalesce(p_idempotency_key_hash, '') !~ '^[a-f0-9]{64}$' or
     coalesce(p_request_fingerprint, '') !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_SECURE_CONTEXT');
  end if;
  if jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) = 0 then
    return jsonb_build_object('ok', false, 'code', 'EMPTY_ITEMS');
  end if;
  if not public.task6_order_snapshot_valid(v_items, v_totals) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_FINANCIAL_SNAPSHOT');
  end if;

  select * into v_token from public.restaurant_table_qr_tokens
   where token_hash = p_token_hash and is_active = true and revoked_at is null for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'INVALID_QR_TOKEN'); end if;

  select * into v_table from public.restaurant_tables
   where id = v_token.restaurant_table_id and hotel_slug = v_token.hotel_slug for update;
  if not found or v_table.is_active is not true or v_table.operational_status <> 'active' then
    return jsonb_build_object('ok', false, 'code', 'QR_TABLE_INACTIVE');
  end if;

  select * into v_session from public.qr_customer_sessions
   where session_token_hash = p_session_hash for update;
  if not found or v_session.revoked_at is not null or v_session.expires_at <= now() or
     v_session.hotel_slug <> v_token.hotel_slug or
     v_session.restaurant_table_id <> v_token.restaurant_table_id or
     v_session.qr_token_id <> v_token.id or
     v_session.qr_token_version <> v_token.token_version then
    return jsonb_build_object('ok', false, 'code', 'QR_SESSION_INVALID');
  end if;

  select * into v_idempotency from public.qr_idempotency_records
   where qr_session_id = v_session.id and action_scope = 'submit'
     and idempotency_key_hash = p_idempotency_key_hash;
  if found then
    if v_idempotency.request_fingerprint <> p_request_fingerprint then
      return jsonb_build_object('ok', false, 'code', 'IDEMPOTENCY_KEY_REUSED');
    end if;
    return v_idempotency.response_json || jsonb_build_object('duplicate', true);
  end if;

  select * into v_order from public.orders
   where hotel_slug = v_token.hotel_slug
     and restaurant_table_id = v_token.restaurant_table_id
     and order_type = 'dine-in' and parent_order_id is null
     and (lower(coalesce(status, '')) in ('new','confirmed','preparing') or
       lower(coalesce(kitchen_status, '')) in ('new','accepted','preparing','ready','delayed'))
     and lower(coalesce(payment_status, 'unpaid')) in ('','unpaid','customer_confirmed')
   order by created_at desc, id desc limit 1 for update;

  if not found then
    v_first_order := true;
    insert into public.orders (
      hotel_name, hotel_slug, customer_name, customer_phone, customer_address,
      payment_method, note, items, totals, whatsapp_message, status,
      kitchen_status, order_type, table_number, order_source,
      restaurant_table_id, payment_status, billing_status,
      tracking_token, tracking_token_created_at, order_version,
      creation_idempotency_scope, creation_idempotency_key,
      creation_request_fingerprint, financial_snapshot_version
    ) values (
      p_order->>'hotelName', v_token.hotel_slug, p_order->>'customerName',
      p_order->>'customerPhone', p_order->>'customerAddress',
      coalesce(p_order->>'paymentMethod', 'COD'), p_order->>'note', v_items, v_totals,
      p_order->>'whatsappMessage', 'new', 'new', 'dine-in', v_table.table_code, 'qr',
      v_table.id, coalesce(p_order->>'paymentStatus', 'unpaid'), 'not_billed',
      p_order->>'trackingToken', now(), 1,
      'secure_qr_order_create', p_idempotency_key_hash,
      p_request_fingerprint, 1
    ) returning * into v_order;
    v_sequence := 1;
    v_kot_reference := 'KOT-' || regexp_replace(v_order.id::text, '[^A-Za-z0-9_-]+', '', 'g') || '-01';
  else
    select coalesce(max(sequence_number), 1) + 1 into v_sequence
      from public.order_rounds where hotel_slug = v_token.hotel_slug and order_id = v_order.id::text;
    v_kot_reference := 'KOT-' || regexp_replace(v_order.id::text, '[^A-Za-z0-9_-]+', '', 'g') || '-' || lpad(v_sequence::text, 2, '0');
    insert into public.order_rounds (
      hotel_slug, order_id, sequence_number, kot_reference, source, status,
      items, totals_delta, note, idempotency_key, request_fingerprint,
      created_by_staff_id, created_by_role
    ) values (
      v_token.hotel_slug, v_order.id::text, v_sequence, v_kot_reference, 'qr', 'new',
      v_items, v_totals, nullif(p_order->>'note', ''), p_idempotency_key_hash,
      p_request_fingerprint, null, 'qr_customer'
    ) returning * into v_round;
    update public.orders set
      items = coalesce(items, '[]'::jsonb) || v_items,
      totals = public.merge_qr_order_totals(totals, v_totals),
      order_version = coalesce(order_version, 1) + 1,
      last_item_added_at = now()
     where id = v_order.id returning * into v_order;
  end if;

  insert into public.qr_order_submissions (
    public_reference, hotel_slug, restaurant_table_id, qr_session_id, order_id,
    round_sequence, status, items, totals_delta, note, edit_expires_at
  ) values (
    (p_order->>'submissionReference')::uuid, v_token.hotel_slug, v_table.id, v_session.id, v_order.id::text,
    v_sequence, 'new', v_items, v_totals, nullif(p_order->>'note', ''), now() + interval '10 minutes'
  ) returning * into v_submission;

  v_response := jsonb_build_object(
    'ok', true, 'duplicate', false, 'firstOrder', v_first_order,
    'order', to_jsonb(v_order), 'round', case when v_first_order then null else to_jsonb(v_round) end,
    'submission', to_jsonb(v_submission), 'kotReference', v_kot_reference
  );

  insert into public.qr_idempotency_records (
    hotel_slug, qr_session_id, action_scope, idempotency_key_hash,
    request_fingerprint, response_json, expires_at
  ) values (
    v_token.hotel_slug, v_session.id, 'submit', p_idempotency_key_hash,
    p_request_fingerprint, v_response, now() + interval '24 hours'
  );
  insert into public.qr_event_outbox (
    hotel_slug, aggregate_type, aggregate_id, event_type, deduplication_key, payload
  ) values (
    v_token.hotel_slug, 'order', v_order.id::text,
    case when v_first_order then 'QR_ORDER_CREATED' else 'QR_ITEMS_ADDED' end,
    'qr-submit:' || v_session.id::text || ':' || p_idempotency_key_hash,
    jsonb_build_object('orderId', v_order.id, 'tableNumber', v_table.table_code,
      'roundSequence', v_sequence, 'submissionReference', v_submission.public_reference,
      'kotReference', v_kot_reference, 'source', 'qr')
  );
  insert into public.qr_security_events (
    hotel_slug, restaurant_table_id, order_id, submission_reference,
    actor_reference, event_type, request_id, safe_context
  ) values (
    v_token.hotel_slug, v_table.id, v_order.id::text, v_submission.public_reference::text,
    v_session.public_reference::text, case when v_first_order then 'QR_ORDER_CREATED' else 'QR_ITEMS_ADDED' end,
    nullif(p_request_id, ''), jsonb_build_object('roundSequence', v_sequence, 'itemCount', jsonb_array_length(v_items))
  );
  update public.restaurant_table_qr_tokens set last_used_at = now() where id = v_token.id;
  update public.qr_customer_sessions set last_seen_at = now() where id = v_session.id;
  return v_response;
end;
$task6_f_submit_secure_qr$;

revoke all on function public.submit_secure_qr_table_order(text,text,text,text,jsonb,text)
  from public, anon, authenticated;
grant execute on function public.submit_secure_qr_table_order(text,text,text,text,jsonb,text)
  to app_tenant_runtime, service_role;

do $task6_f_owner_membership$
begin
  execute format(
    'grant app_tenant_rpc_owner to %I with admin false, inherit false, set true granted by %I',
    current_user,
    current_user
  );
end;
$task6_f_owner_membership$;

grant create on schema public to app_tenant_rpc_owner;
alter function public.submit_secure_qr_table_order(text,text,text,text,jsonb,text)
  owner to app_tenant_rpc_owner;
revoke create on schema public from app_tenant_rpc_owner;

do $task6_f_owner_membership_cleanup$
begin
  execute format(
    'revoke app_tenant_rpc_owner from %I granted by %I',
    current_user,
    current_user
  );
end;
$task6_f_owner_membership_cleanup$;

comment on function public.submit_secure_qr_table_order(text,text,text,text,jsonb,text) is
  'Task 6 secure QR atomic order submit: tenant-safe helper grants, canonical price snapshot validation, durable QR idempotency, KOT/outbox transaction, and no client authority over monetary data.';

commit;
