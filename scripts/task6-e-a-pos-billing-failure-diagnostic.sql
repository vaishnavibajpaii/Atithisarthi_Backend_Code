-- TASK 6 E-A — READ-ONLY diagnostic for a failed synthetic POS bill attempt.
--
-- Safety:
--   * No INSERT, UPDATE, DELETE, DDL, RPC finalization, or transaction control.
--   * Does not select customer/guest PII, addresses, phones, item names, or raw keys.
--   * The target below is the recorded synthetic TEST order 274 only.
--
-- Run in Supabase SQL Editor and return every result row exactly as produced.

with target as (
  select
    o.id,
    o.hotel_slug,
    o.tenant_id,
    o.property_id,
    o.status,
    o.payment_status,
    o.billing_status,
    o.bill_number,
    o.billed_at,
    o.financial_snapshot_version,
    o.billing_idempotency_scope,
    o.billing_idempotency_key,
    o.billing_request_fingerprint,
    o.items,
    o.totals,
    h.tenant_id as hotel_tenant_id,
    h.id as hotel_property_id
  from public.orders o
  join public.hotels h on h.slug = o.hotel_slug
  where o.id = 274
    and o.hotel_slug = 'hotel-sai-raj'
),
line_shape as (
  select
    t.id,
    count(line.value)::integer as item_count,
    coalesce(bool_and(
      jsonb_typeof(line.value) = 'object'
      and line.value ? 'qty'
      and line.value ? 'price'
      and line.value ? 'lineTotal'
    ), true) as all_lines_have_authoritative_money_shape
  from target t
  left join lateral jsonb_array_elements(coalesce(to_jsonb(t.items), '[]'::jsonb)) line(value) on true
  group by t.id
),
snapshot_counts as (
  select
    t.id,
    count(snapshot.id)::integer as final_snapshot_rows,
    count(snapshot.id) filter (
      where snapshot.invoice_number is not null
        and snapshot.payload_hash ~ '^[a-f0-9]{64}$'
    )::integer as well_formed_snapshot_rows
  from target t
  left join public.food_order_bill_snapshots snapshot
    on snapshot.order_id = t.id::text
   and snapshot.hotel_slug = t.hotel_slug
   and snapshot.tenant_id = t.tenant_id
   and snapshot.property_id = t.property_id
  group by t.id
),
audit_counts as (
  select
    t.id,
    count(audit.id)::integer as final_bill_audit_rows
  from target t
  left join public.food_order_bill_audit audit
    on audit.order_id = t.id::text
   and audit.hotel_slug = t.hotel_slug
   and audit.action = 'food_bill_issued'
  group by t.id
)
select
  'order_integrity' as section,
  jsonb_build_object(
    'order_id', t.id::text,
    'hotel_slug', t.hotel_slug,
    'order_status', t.status,
    'payment_status', t.payment_status,
    'billing_status', t.billing_status,
    'has_bill_number', nullif(btrim(coalesce(t.bill_number, '')), '') is not null,
    'billed_at_present', t.billed_at is not null,
    'financial_snapshot_version', t.financial_snapshot_version,
    'canonical_owner_matches_hotel', t.tenant_id = t.hotel_tenant_id and t.property_id = t.hotel_property_id,
    'source_snapshot_valid', public.task6_order_snapshot_valid(to_jsonb(t.items), to_jsonb(t.totals)),
    'server_payable_amount', public.task6_order_payable_total(to_jsonb(t.items), to_jsonb(t.totals)),
    'billing_identity_present',
      t.billing_idempotency_scope is not null
      or t.billing_idempotency_key is not null
      or t.billing_request_fingerprint is not null,
    'billing_scope', t.billing_idempotency_scope
  ) as details
from target t
union all
select
  'order_line_shape' as section,
  jsonb_build_object(
    'order_id', shape.id::text,
    'item_count', shape.item_count,
    'all_lines_have_authoritative_money_shape', shape.all_lines_have_authoritative_money_shape
  ) as details
from line_shape shape
union all
select
  'final_bill_snapshot' as section,
  jsonb_build_object(
    'order_id', snapshots.id::text,
    'final_snapshot_rows', snapshots.final_snapshot_rows,
    'well_formed_snapshot_rows', snapshots.well_formed_snapshot_rows
  ) as details
from snapshot_counts snapshots
union all
select
  'final_bill_audit' as section,
  jsonb_build_object(
    'order_id', audits.id::text,
    'food_bill_issued_audit_rows', audits.final_bill_audit_rows
  ) as details
from audit_counts audits
order by section;
