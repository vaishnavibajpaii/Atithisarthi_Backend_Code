-- Task 6 follow-up diagnostic for the four non-zero inventory findings.
-- READ ONLY: this statement does not insert, update, delete, lock, or call a
-- mutating routine. It emits opaque record/group references and structural
-- metadata only. Guest/customer names, phone numbers, addresses, notes,
-- tokens, item names, and other PII are intentionally excluded.

with
missing_food_snapshots as (
  select
    left(md5(coalesce(o.tenant_id::text, '') || ':' || coalesce(o.property_id::text, '')), 16) as property_ref,
    left(md5(o.id::text), 16) as order_ref,
    coalesce(o.order_type, '[NULL]') as order_type,
    coalesce(o.order_source, '[NULL]') as order_source,
    coalesce(o.status, '[NULL]') as order_status,
    coalesce(o.kitchen_status, '[NULL]') as kitchen_status,
    coalesce(o.payment_status, '[NULL]') as payment_status,
    coalesce(o.billing_status, '[NULL]') as billing_status,
    o.bill_number is not null and btrim(o.bill_number) <> '' as has_bill_number,
    o.billed_at is not null as has_billed_at,
    o.paid_at is not null as has_paid_at,
    o.room_booking_id is not null as has_room_booking,
    o.parent_order_id is not null as is_addon_order,
    case
      when o.created_at >= now() - interval '30 days' then '00_to_30_days'
      when o.created_at >= now() - interval '180 days' then '31_to_180_days'
      when o.created_at >= now() - interval '365 days' then '181_to_365_days'
      else 'older_than_365_days'
    end as age_band,
    to_char(o.created_at at time zone 'UTC', 'YYYY-MM') as created_month_utc
  from public.orders o
  where lower(coalesce(o.billing_status, '')) = 'billed'
    and not exists (
      select 1
      from public.food_order_bill_snapshots s
      where s.hotel_slug = o.hotel_slug
        and s.order_id = o.id::text
    )
),
duplicate_order_groups as (
  select
    left(md5(
      coalesce(o.tenant_id::text, '') || ':' ||
      coalesce(o.property_id::text, '') || ':' ||
      coalesce(o.order_type, '') || ':' ||
      coalesce(o.table_number, '') || ':' ||
      coalesce(o.parent_order_id::text, '') || ':' ||
      to_jsonb(o.items)::text || ':' ||
      to_jsonb(o.totals)::text || ':' ||
      date_trunc('second', o.created_at)::text
    ), 16) as duplicate_group_ref,
    left(md5(coalesce(o.tenant_id::text, '') || ':' || coalesce(o.property_id::text, '')), 16) as property_ref,
    count(*)::bigint as row_count,
    jsonb_agg(left(md5(o.id::text), 16) order by o.created_at, o.id) as order_refs,
    jsonb_agg(coalesce(o.status, '[NULL]') order by o.created_at, o.id) as order_statuses,
    jsonb_agg(coalesce(o.kitchen_status, '[NULL]') order by o.created_at, o.id) as kitchen_statuses,
    jsonb_agg(coalesce(o.payment_status, '[NULL]') order by o.created_at, o.id) as payment_statuses,
    jsonb_agg(coalesce(o.billing_status, '[NULL]') order by o.created_at, o.id) as billing_statuses,
    jsonb_agg(coalesce(o.order_source, '[NULL]') order by o.created_at, o.id) as order_sources,
    coalesce(o.order_type, '[NULL]') as order_type,
    o.parent_order_id is not null as is_addon_order,
    bool_or(o.room_booking_id is not null) as any_room_booking,
    bool_or(nullif(btrim(coalesce(o.gateway_order_id, '')), '') is not null) as any_gateway_order,
    bool_or(nullif(btrim(coalesce(o.gateway_payment_id, '')), '') is not null) as any_gateway_payment,
    count(distinct nullif(btrim(coalesce(o.tracking_token, '')), '')) as distinct_tracking_token_count,
    count(distinct o.restaurant_table_id) filter (where o.restaurant_table_id is not null) as distinct_restaurant_table_count,
    date_trunc('second', min(o.created_at)) at time zone 'UTC' as created_second_utc
  from public.orders o
  group by
    o.tenant_id,
    o.property_id,
    coalesce(o.order_type, ''),
    coalesce(o.table_number, ''),
    coalesce(o.parent_order_id::text, ''),
    o.parent_order_id is not null,
    to_jsonb(o.items),
    to_jsonb(o.totals),
    date_trunc('second', o.created_at)
  having count(*) > 1
),
invalid_order_items as (
  select
    left(md5(coalesce(o.tenant_id::text, '') || ':' || coalesce(o.property_id::text, '')), 16) as property_ref,
    left(md5(o.id::text), 16) as order_ref,
    item_position,
    coalesce(o.order_type, '[NULL]') as order_type,
    coalesce(o.order_source, '[NULL]') as order_source,
    coalesce(o.status, '[NULL]') as order_status,
    coalesce(o.payment_status, '[NULL]') as payment_status,
    coalesce(o.billing_status, '[NULL]') as billing_status,
    o.parent_order_id is not null as is_addon_order,
    o.room_booking_id is not null as has_room_booking,
    coalesce(item->>'qty', '') = '' as quantity_missing,
    coalesce(item->>'qty', '') <> ''
      and coalesce(item->>'qty', '') !~ '^[0-9]+([.][0-9]+)?$' as quantity_non_numeric,
    case
      when coalesce(item->>'qty', '') ~ '^[0-9]+([.][0-9]+)?$'
        then (item->>'qty')::numeric <= 0
      else false
    end as quantity_non_positive,
    coalesce(item->>'price', '') = '' as price_missing,
    coalesce(item->>'price', '') <> ''
      and coalesce(item->>'price', '') !~ '^-?[0-9]+([.][0-9]+)?$' as price_non_numeric,
    case
      when coalesce(item->>'price', '') ~ '^-?[0-9]+([.][0-9]+)?$'
        then (item->>'price')::numeric < 0
      else false
    end as price_negative,
    coalesce((
      select jsonb_agg(key_name order by key_name)
      from jsonb_object_keys(
        case when jsonb_typeof(item) = 'object' then item else '{}'::jsonb end
      ) as keys(key_name)
    ), '[]'::jsonb) as item_key_names,
    to_char(o.created_at at time zone 'UTC', 'YYYY-MM') as created_month_utc
  from public.orders o
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(to_jsonb(o.items)) = 'array' then to_jsonb(o.items)
      else '[]'::jsonb
    end
  ) with ordinality as expanded(item, item_position)
  where coalesce(item->>'qty', '') !~ '^[0-9]+([.][0-9]+)?$'
     or coalesce(item->>'price', '') !~ '^-?[0-9]+([.][0-9]+)?$'
     or (
       case
         when coalesce(item->>'qty', '') ~ '^[0-9]+([.][0-9]+)?$'
           then (item->>'qty')::numeric
       end
     ) <= 0
     or (
       case
         when coalesce(item->>'price', '') ~ '^-?[0-9]+([.][0-9]+)?$'
           then (item->>'price')::numeric
       end
     ) < 0
),
legacy_checkout_candidates as (
  select
    left(md5(coalesce(b.tenant_id::text, '') || ':' || coalesce(b.property_id::text, '')), 16) as property_ref,
    left(md5(b.id::text), 16) as booking_ref,
    coalesce(b.booking_source, '[NULL]') as booking_source,
    coalesce(b.payment_status, '[NULL]') as payment_status,
    b.checked_out_at is not null as has_checked_out_at,
    b.balance_amount = 0 as zero_balance,
    b.advance_paid = b.total_amount as fully_allocated,
    exists (
      select 1
      from public.room_checkout_bill_snapshots s
      where s.hotel_slug = b.hotel_slug
        and s.booking_id = b.id
    ) as has_bill_snapshot,
    to_char(coalesce(b.checked_out_at, b.updated_at, b.created_at) at time zone 'UTC', 'YYYY-MM') as terminal_month_utc
  from public.room_bookings b
  where b.booking_status = 'checked_out'
    and not exists (
      select 1
      from public.room_checkout_receipts r
      where r.hotel_slug = b.hotel_slug
        and r.booking_id = b.id
    )
)
select section, finding, severity, details
from (
  select
    '00_summary'::text as section,
    'non_zero_inventory_findings'::text as finding,
    'INFO'::text as severity,
    jsonb_build_object(
      'missing_food_snapshot_orders', (select count(*) from missing_food_snapshots),
      'duplicate_candidate_groups', (select count(*) from duplicate_order_groups),
      'duplicate_candidate_excess_rows', (
        select coalesce(sum(row_count - 1), 0) from duplicate_order_groups
      ),
      'invalid_order_items', (select count(*) from invalid_order_items),
      'checked_out_without_receipt_candidates', (
        select count(*) from legacy_checkout_candidates
      ),
      'contains_pii', false,
      'mutates_data', false
    ) as details

  union all

  select
    '01_missing_food_snapshots',
    'billed_order_missing_final_snapshot',
    'P0',
    to_jsonb(missing_food_snapshots)
  from missing_food_snapshots

  union all

  select
    '02_duplicate_order_candidates',
    'logical_order_duplicate_candidate_group',
    'P0',
    to_jsonb(duplicate_order_groups)
  from duplicate_order_groups

  union all

  select
    '03_invalid_order_items',
    'order_item_invalid_quantity_or_price',
    'P0',
    to_jsonb(invalid_order_items)
  from invalid_order_items

  union all

  select
    '04_legacy_checkout_candidates',
    'checked_out_booking_without_checkout_receipt_candidate',
    'P1',
    to_jsonb(legacy_checkout_candidates)
  from legacy_checkout_candidates
) findings
order by section, finding, details::text;
