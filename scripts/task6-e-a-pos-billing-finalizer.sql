-- TASK6-E-A: dormant, atomic food-order billing finalizer.
--
-- EXPAND / VERIFY / ACTIVATE sequence:
--   1. This migration adds only nullable operation metadata and a dormant RPC.
--   2. It does not alter or backfill historical orders, bills, snapshots, or payments.
--   3. The legacy HTTP paths remain active until the separately deployed feature gate
--      is enabled after TEST acceptance.
--
-- Payment finality is intentionally outside this routine. Razorpay/gateway payment
-- confirmation remains exclusively in the Task 2 verified-payment flow.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '5min';
set local search_path = pg_catalog, public;

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtext('task6-e-a-pos-billing-finalizer')
);

do $task6_e_a_guard$
declare
  v_missing_relations integer;
begin
  if not exists (
    select 1 from pg_catalog.pg_roles
    where rolname = 'app_tenant_runtime'
      and rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole
      and not rolinherit and not rolreplication and not rolbypassrls
  ) then
    raise exception 'TASK6_E_A_RUNTIME_ROLE_UNSAFE_OR_MISSING';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_roles
    where rolname = 'app_tenant_rpc_owner'
      and not rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole
      and not rolinherit and not rolreplication and not rolbypassrls
  ) then
    raise exception 'TASK6_E_A_RPC_OWNER_UNSAFE_OR_MISSING';
  end if;

  select count(*) into v_missing_relations
  from (values
    ('hotels'), ('orders'), ('food_order_bill_snapshots'), ('food_order_bill_audit')
  ) expected(name)
  left join pg_catalog.pg_class relation
    on relation.relname = expected.name
   and relation.relnamespace = 'public'::regnamespace
   and relation.relkind in ('r', 'p')
  where relation.oid is null or not relation.relrowsecurity or not relation.relforcerowsecurity;

  if v_missing_relations <> 0 then
    raise exception 'TASK6_E_A_REQUIRED_FORCE_RLS_RELATION_UNSAFE count=%', v_missing_relations;
  end if;

  if to_regprocedure('public.task6_order_snapshot_valid(jsonb,jsonb)') is null
     or to_regprocedure('public.task6_order_payable_total(jsonb,jsonb)') is null
     or to_regprocedure('public.task6_safe_numeric(text)') is null then
    raise exception 'TASK6_E_A_TASK6_A_FINANCIAL_HELPERS_MISSING';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_class index_relation
    join pg_catalog.pg_index index_state on index_state.indexrelid = index_relation.oid
    where index_relation.relnamespace = 'public'::regnamespace
      and index_relation.relname = 'task6_orders_billing_idempotency_uq'
      and index_state.indisunique and index_state.indisvalid and index_state.indisready
  ) then
    raise exception 'TASK6_E_A_BILLING_IDEMPOTENCY_INDEX_NOT_READY';
  end if;
end;
$task6_e_a_guard$;

-- This column distinguishes a one-order bill from a table-family bill on the
-- durable Task 6 billing key. It is nullable so historical rows are unchanged.
alter table public.orders
  add column if not exists billing_idempotency_scope text;

do $task6_e_a_scope_constraint$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'task6_orders_billing_idempotency_scope_ck'
  ) then
    alter table public.orders
      add constraint task6_orders_billing_idempotency_scope_ck
      check (
        (
          billing_idempotency_scope is null
          and billing_idempotency_key is null
          and billing_request_fingerprint is null
        )
        or (
          billing_idempotency_scope in ('single_bill', 'family_bill')
          and billing_idempotency_key is not null
          and char_length(btrim(billing_idempotency_key)) between 8 and 200
          and billing_request_fingerprint ~ '^[a-f0-9]{64}$'
        )
      ) not valid;
  end if;
end;
$task6_e_a_scope_constraint$;

create or replace function public.task6_finalize_order_family(
  p_hotel_slug text,
  p_order_id bigint,
  p_finalize_scope text,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_issued_at timestamptz,
  p_actor_id text,
  p_actor_role text,
  p_snapshots jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $task6_finalize_order_family$
declare
  v_hotel public.hotels%rowtype;
  v_anchor public.orders%rowtype;
  v_existing_anchor public.orders%rowtype;
  v_order public.orders%rowtype;
  v_updated_order public.orders%rowtype;
  v_snapshot public.food_order_bill_snapshots%rowtype;
  v_snapshot_input jsonb;
  v_snapshot_json jsonb;
  v_source_line record;
  v_snapshot_line jsonb;
  v_scope text := lower(btrim(coalesce(p_finalize_scope, '')));
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := lower(btrim(coalesce(p_request_fingerprint, '')));
  v_slug text := btrim(coalesce(p_hotel_slug, ''));
  v_hotel_token text;
  v_expected_invoice text;
  v_payable numeric(12,2);
  v_snapshot_total numeric(12,2);
  v_snapshot_paid numeric(12,2);
  v_target_count integer := 0;
  v_snapshot_count integer := 0;
  v_matching_snapshot_count integer := 0;
  v_order_ids jsonb := '[]'::jsonb;
  v_orders jsonb := '[]'::jsonb;
  v_snapshots jsonb := '[]'::jsonb;
begin
  if v_slug = '' or p_order_id is null or p_order_id <= 0 then
    raise exception using errcode = '22023', message = 'TASK6_ORDER_BILL_SCOPE_INVALID';
  end if;
  if v_scope not in ('single_bill', 'family_bill') then
    raise exception using errcode = '22023', message = 'TASK6_ORDER_BILL_FINALIZE_SCOPE_INVALID';
  end if;
  if v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception using errcode = '22023', message = 'TASK6_ORDER_BILL_IDEMPOTENCY_KEY_INVALID';
  end if;
  if v_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'TASK6_ORDER_BILL_REQUEST_FINGERPRINT_INVALID';
  end if;
  if p_issued_at is null
     or p_issued_at < '2020-01-01 00:00:00+00'::timestamptz
     or p_issued_at > pg_catalog.clock_timestamp() + interval '1 day'
     or char_length(coalesce(p_actor_id, '')) > 200
     or char_length(coalesce(p_actor_role, '')) > 80
     or jsonb_typeof(p_snapshots) <> 'array'
     or jsonb_array_length(p_snapshots) = 0 then
    raise exception using errcode = '22023', message = 'TASK6_ORDER_BILL_INPUT_INVALID';
  end if;

  -- Canonical ownership always comes from hotels, never from the request body.
  select * into v_hotel
  from public.hotels
  where slug = v_slug;
  if not found then
    raise exception using errcode = 'P0002', message = 'TASK6_ORDER_BILL_HOTEL_NOT_FOUND';
  end if;

  -- Serialize any reuse of the durable operation key before inspecting state.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'task6-order-bill:' || v_hotel.tenant_id::text || ':' || v_hotel.id::text || ':' || v_key,
      0
    )
  );

  select * into v_existing_anchor
  from public.orders
  where tenant_id = v_hotel.tenant_id
    and property_id = v_hotel.id
    and billing_idempotency_key = v_key
  for update;

  if found then
    if v_existing_anchor.billing_idempotency_scope is distinct from v_scope
       or v_existing_anchor.billing_request_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '23505', message = 'TASK6_ORDER_BILL_IDEMPOTENCY_CONFLICT';
    end if;

    if v_scope = 'family_bill' then
      select * into v_anchor
      from public.orders
      where id = v_existing_anchor.id
        and tenant_id = v_hotel.tenant_id
        and property_id = v_hotel.id
        and hotel_slug = v_slug
        and parent_order_id is null
      for update;
      if not found then
        raise exception using errcode = '23514', message = 'TASK6_ORDER_BILL_REPLAY_FAMILY_INVALID';
      end if;

      v_orders := '[]'::jsonb;
      for v_order in
        select *
        from public.orders target
        where target.tenant_id = v_hotel.tenant_id
          and target.property_id = v_hotel.id
          and target.hotel_slug = v_slug
          and (target.id = v_anchor.id or target.parent_order_id = v_anchor.id::text)
        order by target.id
        for update
      loop
        v_orders := v_orders || jsonb_build_array(to_jsonb(v_order));
      end loop;
    else
      v_orders := jsonb_build_array(to_jsonb(v_existing_anchor));
    end if;

    select coalesce(jsonb_agg(to_jsonb(snapshot) order by snapshot.order_id), '[]'::jsonb)
      into v_snapshots
    from public.food_order_bill_snapshots snapshot
    where snapshot.tenant_id = v_hotel.tenant_id
      and snapshot.property_id = v_hotel.id
      and snapshot.hotel_slug = v_slug
      and snapshot.order_id in (
        select element->>'id'
        from jsonb_array_elements(v_orders) element
      );

    if jsonb_array_length(v_orders) <> jsonb_array_length(v_snapshots) then
      raise exception using errcode = '23514', message = 'TASK6_ORDER_BILL_REPLAY_SNAPSHOT_MISSING';
    end if;

    return jsonb_build_object(
      'idempotentReplay', true,
      'orders', v_orders,
      'snapshots', v_snapshots
    );
  end if;

  select * into v_anchor
  from public.orders
  where id = p_order_id
    and tenant_id = v_hotel.tenant_id
    and property_id = v_hotel.id
    and hotel_slug = v_slug
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'TASK6_ORDER_BILL_ORDER_NOT_FOUND';
  end if;

  if v_scope = 'family_bill' and v_anchor.parent_order_id is not null then
    raise exception using errcode = '23514', message = 'TASK6_ORDER_BILL_FAMILY_ROOT_REQUIRED';
  end if;
  if v_scope = 'single_bill' and (
    v_anchor.parent_order_id is not null
    or exists (
      select 1 from public.orders child
      where child.tenant_id = v_hotel.tenant_id
        and child.property_id = v_hotel.id
        and child.hotel_slug = v_slug
        and child.parent_order_id = v_anchor.id::text
    )
  ) then
    raise exception using errcode = '23514', message = 'TASK6_ORDER_BILL_FAMILY_FINALIZATION_REQUIRED';
  end if;

  -- Lock all family rows in a deterministic order. A failed validation or insert
  -- aborts this entire function call, including every previous write in the loop.
  for v_order in
    select *
    from public.orders target
    where target.tenant_id = v_hotel.tenant_id
      and target.property_id = v_hotel.id
      and target.hotel_slug = v_slug
      and (
        target.id = v_anchor.id
        or (v_scope = 'family_bill' and target.parent_order_id = v_anchor.id::text)
      )
    order by target.id
    for update
  loop
    v_target_count := v_target_count + 1;
    v_order_ids := v_order_ids || jsonb_build_array(v_order.id::text);

    if lower(coalesce(v_order.status, 'new')) in ('cancelled', 'payment_failed') then
      raise exception using errcode = '23514', message = 'TASK6_ORDER_BILL_NON_BILLABLE_STATE';
    end if;
    if lower(coalesce(v_order.billing_status, 'not_billed')) = 'billed'
       or v_order.financial_snapshot_version is null
       or not public.task6_order_snapshot_valid(to_jsonb(v_order.items), to_jsonb(v_order.totals)) then
      raise exception using errcode = '23514', message = 'TASK6_ORDER_BILL_FINANCIAL_SNAPSHOT_NOT_FINALIZABLE';
    end if;
    if exists (
      select 1 from public.food_order_bill_snapshots existing_snapshot
      where existing_snapshot.tenant_id = v_hotel.tenant_id
        and existing_snapshot.property_id = v_hotel.id
        and existing_snapshot.hotel_slug = v_slug
        and existing_snapshot.order_id = v_order.id::text
    ) then
      raise exception using errcode = '23514', message = 'TASK6_ORDER_BILL_SNAPSHOT_PREEXISTS';
    end if;
  end loop;

  select count(*) into v_snapshot_count
  from jsonb_array_elements(p_snapshots);
  if v_target_count = 0 or v_snapshot_count <> v_target_count then
    raise exception using errcode = '22023', message = 'TASK6_ORDER_BILL_SNAPSHOT_SET_INVALID';
  end if;

  v_hotel_token := left(
    trim(both '-' from regexp_replace(upper(v_slug), '[^A-Z0-9]+', '-', 'g')),
    18
  );
  if v_hotel_token = '' then
    v_hotel_token := 'HOTEL';
  end if;

  for v_order in
    select *
    from public.orders target
    where target.tenant_id = v_hotel.tenant_id
      and target.property_id = v_hotel.id
      and target.hotel_slug = v_slug
      and (
        target.id = v_anchor.id
        or (v_scope = 'family_bill' and target.parent_order_id = v_anchor.id::text)
      )
    order by target.id
    for update
  loop
    select count(*) into v_matching_snapshot_count
    from jsonb_array_elements(p_snapshots) candidate
    where candidate->>'orderId' = v_order.id::text;
    if v_matching_snapshot_count <> 1 then
      raise exception using errcode = '22023', message = 'TASK6_ORDER_BILL_SNAPSHOT_ORDER_SET_INVALID';
    end if;

    select candidate into v_snapshot_input
    from jsonb_array_elements(p_snapshots) candidate
    where candidate->>'orderId' = v_order.id::text;
    v_snapshot_json := v_snapshot_input->'snapshotJson';
    v_expected_invoice := concat(
      'BILL-', v_hotel_token, '-',
      to_char(p_issued_at at time zone 'UTC', 'YYYYMMDD'), '-',
      right(regexp_replace(upper(v_order.id::text), '[^A-Z0-9]', '', 'g'), 8)
    );
    v_payable := public.task6_order_payable_total(
      to_jsonb(v_order.items), to_jsonb(v_order.totals)
    );
    v_snapshot_total := public.task6_safe_numeric(v_snapshot_json->'totals'->>'grandTotal');
    v_snapshot_paid := public.task6_safe_numeric(v_snapshot_json->'totals'->>'paid');

    if jsonb_typeof(v_snapshot_input) <> 'object'
       or coalesce(v_snapshot_input->>'payloadHash', '') !~ '^[a-f0-9]{64}$'
       or jsonb_typeof(v_snapshot_json) <> 'object'
       or jsonb_typeof(v_snapshot_json->'items') <> 'array'
       or jsonb_typeof(v_snapshot_json->'totals') <> 'object'
       or coalesce(v_snapshot_json->>'documentType', '') <> 'food_order_bill'
       or coalesce(v_snapshot_json->>'provisional', 'true') <> 'false'
       or coalesce(v_snapshot_json->>'cancelled', 'true') <> 'false'
       or coalesce(v_snapshot_json->>'orderReference', '') <> v_order.id::text
       or coalesce(v_snapshot_json->>'invoiceNumber', '') <> v_expected_invoice
       or lower(coalesce(v_snapshot_json->>'billingStatus', '')) <> 'billed'
       or lower(coalesce(v_snapshot_json->>'paymentStatus', ''))
            <> lower(coalesce(v_order.payment_status, 'unpaid'))
       or coalesce(v_snapshot_json->>'snapshotVersion', '') !~ '^[1-9][0-9]{0,8}$'
       or coalesce(v_snapshot_json->>'templateVersion', '') !~ '^[1-9][0-9]{0,8}$'
       or v_snapshot_total is null
       or round(v_snapshot_total, 2) <> round(v_payable, 2)
       or v_snapshot_paid is null
       or jsonb_array_length(v_snapshot_json->'items')
            <> jsonb_array_length(to_jsonb(v_order.items)) then
      raise exception using errcode = '22023', message = 'TASK6_ORDER_BILL_SNAPSHOT_MISMATCH';
    end if;

    -- Verify every financial line against the immutable-at-creation order
    -- snapshot. Extra display fields are allowed, money fields are not trusted.
    for v_source_line in
      select source_item.value, source_item.ordinality
      from jsonb_array_elements(to_jsonb(v_order.items)) with ordinality as source_item(value, ordinality)
      order by source_item.ordinality
    loop
      select bill_item.value into v_snapshot_line
      from jsonb_array_elements(v_snapshot_json->'items') with ordinality as bill_item(value, ordinality)
      where bill_item.ordinality = v_source_line.ordinality;

      if jsonb_typeof(v_snapshot_line) <> 'object'
         or public.task6_safe_numeric(v_snapshot_line->>'quantity')
              is distinct from public.task6_safe_numeric(v_source_line.value->>'qty')
         or public.task6_safe_numeric(v_snapshot_line->>'unitRate')
              is distinct from public.task6_safe_numeric(v_source_line.value->>'price')
         or public.task6_safe_numeric(v_snapshot_line->>'amount')
              is distinct from public.task6_safe_numeric(v_source_line.value->>'lineTotal') then
        raise exception using errcode = '22023', message = 'TASK6_ORDER_BILL_SNAPSHOT_LINE_MISMATCH';
      end if;
    end loop;

    update public.orders target
    set billing_status = 'billed',
        billed_at = p_issued_at,
        bill_number = v_expected_invoice,
        order_version = greatest(1, coalesce(target.order_version, 1)) + 1,
        billing_idempotency_scope = case when target.id = v_anchor.id then v_scope else target.billing_idempotency_scope end,
        billing_idempotency_key = case when target.id = v_anchor.id then v_key else target.billing_idempotency_key end,
        billing_request_fingerprint = case when target.id = v_anchor.id then v_fingerprint else target.billing_request_fingerprint end
    where target.id = v_order.id
      and target.tenant_id = v_hotel.tenant_id
      and target.property_id = v_hotel.id
      and target.hotel_slug = v_slug
    returning * into v_updated_order;

    insert into public.food_order_bill_snapshots (
      tenant_id, property_id, hotel_slug, order_id, invoice_number,
      snapshot_version, template_version, snapshot_json, payload_hash,
      issued_by, issued_by_role, issued_at
    ) values (
      v_hotel.tenant_id, v_hotel.id, v_slug, v_updated_order.id::text, v_expected_invoice,
      coalesce(nullif(v_snapshot_json->>'snapshotVersion', '')::integer, 0),
      coalesce(nullif(v_snapshot_json->>'templateVersion', '')::integer, 0),
      v_snapshot_json, lower(v_snapshot_input->>'payloadHash'),
      nullif(btrim(coalesce(p_actor_id, '')), ''), left(coalesce(p_actor_role, ''), 80), p_issued_at
    ) returning * into v_snapshot;

    insert into public.food_order_bill_audit (
      tenant_id, property_id, hotel_slug, actor_id, actor_role,
      action, order_id, invoice_number, snapshot_id, format_version, details_json
    ) values (
      v_hotel.tenant_id, v_hotel.id, v_slug,
      nullif(btrim(coalesce(p_actor_id, '')), ''), left(coalesce(p_actor_role, ''), 80),
      'food_bill_issued', v_updated_order.id::text, v_expected_invoice, v_snapshot.id,
      v_snapshot.template_version,
      jsonb_build_object(
        'payloadHash', lower(v_snapshot_input->>'payloadHash'),
        'finalizeScope', v_scope,
        'requestFingerprint', v_fingerprint,
        'serverPayable', v_payable
      )
    );

    v_orders := v_orders || jsonb_build_array(to_jsonb(v_updated_order));
    v_snapshots := v_snapshots || jsonb_build_array(to_jsonb(v_snapshot));
  end loop;

  return jsonb_build_object(
    'idempotentReplay', false,
    'orderIds', v_order_ids,
    'orders', v_orders,
    'snapshots', v_snapshots
  );
end;
$task6_finalize_order_family$;

revoke all on function public.task6_finalize_order_family(
  text, bigint, text, text, text, timestamptz, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.task6_finalize_order_family(
  text, bigint, text, text, text, timestamptz, text, text, jsonb
) to app_tenant_runtime, service_role;

comment on column public.orders.billing_idempotency_scope is
  'Task 6 immutable operation namespace for atomic single-order or table-family food bill finalization.';
comment on function public.task6_finalize_order_family(
  text, bigint, text, text, text, timestamptz, text, text, jsonb
) is 'Task 6 dormant atomic food billing finalizer: canonical tenant scope, key+digest replay, deterministic family locks, exact versioned price snapshot checks, immutable bill snapshots, and audit writes in one transaction. Provider payment finality remains Task 2 controlled.';

do $task6_e_a_owner_membership$
begin
  execute format(
    'grant app_tenant_rpc_owner to %I with admin false, inherit false, set true granted by %I',
    current_user,
    current_user
  );
end;
$task6_e_a_owner_membership$;

grant create on schema public to app_tenant_rpc_owner;
alter function public.task6_finalize_order_family(
  text, bigint, text, text, text, timestamptz, text, text, jsonb
) owner to app_tenant_rpc_owner;
revoke create on schema public from app_tenant_rpc_owner;

do $task6_e_a_owner_membership_cleanup$
begin
  execute format(
    'revoke app_tenant_rpc_owner from %I granted by %I restrict',
    current_user,
    current_user
  );
end;
$task6_e_a_owner_membership_cleanup$;

do $task6_e_a_owner_cleanup_guard$
begin
  if exists (
    select 1
    from pg_catalog.pg_auth_members membership
    where membership.roleid = (
      select oid from pg_catalog.pg_roles where rolname = 'app_tenant_rpc_owner'
    )
      and (membership.inherit_option or membership.set_option)
  ) then
    raise exception 'TASK6_E_A_RPC_OWNER_EFFECTIVE_MEMBERSHIP_REMAINS';
  end if;

  if has_schema_privilege('app_tenant_rpc_owner', 'public', 'CREATE') then
    raise exception 'TASK6_E_A_RPC_OWNER_SCHEMA_CREATE_REMAINS';
  end if;
end;
$task6_e_a_owner_cleanup_guard$;

commit;
