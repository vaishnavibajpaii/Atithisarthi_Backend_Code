-- TASK6-D-B read-only post-migration verifier.
-- One SELECT against PostgreSQL catalogs only; returns no application or guest data.
-- Schema names are resolved through pg_namespace OIDs to avoid SQL-editor
-- search_path ambiguity around the word "public".
with public_schema as (
  select oid
  from pg_catalog.pg_namespace
  where nspname = 'public'
), named_functions as (
  select
    proc.oid,
    proc.proowner,
    proc.prosecdef,
    proc.proconfig,
    proc.proacl,
    proc.proargtypes,
    pg_catalog.pg_get_userbyid(proc.proowner) as owner_name,
    pg_catalog.pg_get_functiondef(proc.oid) as definition,
    pg_catalog.oidvectortypes(proc.proargtypes) as argument_types
  from pg_catalog.pg_proc proc
  join pg_catalog.pg_namespace ns
    on ns.oid = proc.pronamespace
  where ns.nspname = 'public'
    and proc.proname = 'task6_finalize_room_checkout'
), finalizer as (
  select *
  from named_functions
  where argument_types = 'text, bigint, numeric, text, text, text, text, text, text, text, text, jsonb, text'
), routine_acl as (
  select permissions.grantee, permissions.privilege_type
  from finalizer
  cross join lateral pg_catalog.aclexplode(
    coalesce(finalizer.proacl, pg_catalog.acldefault('f', finalizer.proowner))
  ) as permissions
), required_relations(relation_name) as (
  values
    ('hotels'),
    ('room_bookings'),
    ('room_booking_payments'),
    ('orders'),
    ('room_checkout_receipts'),
    ('room_checkout_bill_snapshots'),
    ('room_checkout_bill_audit')
), relation_state as (
  select
    required.relation_name,
    rel.oid,
    rel.relrowsecurity,
    rel.relforcerowsecurity
  from required_relations required
  cross join public_schema
  left join pg_catalog.pg_class rel
    on rel.relnamespace = public_schema.oid
   and rel.relname = required.relation_name
   and rel.relkind in ('r', 'p')
), checkout_index as (
  select index_state.indisunique,
         index_state.indisvalid,
         index_state.indisready,
         index_state.indpred,
         pg_catalog.pg_get_indexdef(index_state.indexrelid) as index_definition
  from pg_catalog.pg_class index_relation
  join pg_catalog.pg_index index_state
    on index_state.indexrelid = index_relation.oid
  join pg_catalog.pg_class table_relation
    on table_relation.oid = index_state.indrelid
  cross join public_schema
  where index_relation.relnamespace = public_schema.oid
    and index_relation.relname = 'task6_checkout_receipt_per_booking_uq'
    and table_relation.relnamespace = public_schema.oid
    and table_relation.relname = 'room_checkout_receipts'
), snapshot_trigger as (
  select trg.tgenabled
  from pg_catalog.pg_trigger trg
  join pg_catalog.pg_class rel
    on rel.oid = trg.tgrelid
  cross join public_schema
  where rel.relnamespace = public_schema.oid
    and rel.relname = 'room_checkout_bill_snapshots'
    and trg.tgname = 'room_checkout_bill_snapshots_protect'
    and not trg.tgisinternal
), checks(check_name, expected, actual, result) as (
  select
    'finalizer_routine_overload_count', '1',
    (select pg_catalog.count(*)::text from named_functions),
    case when (select pg_catalog.count(*) from named_functions) = 1 then 'PASS' else 'FAIL' end
  union all
  select
    'finalizer_exact_signature_present', '1',
    (select pg_catalog.count(*)::text from finalizer),
    case when exists (select 1 from finalizer) then 'PASS' else 'FAIL' end
  union all
  select
    'finalizer_security_invoker', 'true',
    coalesce((select (not prosecdef)::text from finalizer), 'false'),
    case when coalesce((select not prosecdef from finalizer), false) then 'PASS' else 'FAIL' end
  union all
  select
    'finalizer_owner_safe', 'app_tenant_rpc_owner',
    coalesce((select owner_name from finalizer), '<missing>'),
    case when exists (
      select 1
      from finalizer
      join pg_catalog.pg_roles owner_role on owner_role.rolname = finalizer.owner_name
      where finalizer.owner_name = 'app_tenant_rpc_owner'
        and not owner_role.rolcanlogin and not owner_role.rolsuper
        and not owner_role.rolcreatedb and not owner_role.rolcreaterole
        and not owner_role.rolinherit and not owner_role.rolreplication and not owner_role.rolbypassrls
    ) then 'PASS' else 'FAIL' end
  union all
  select
    'finalizer_search_path_pinned', 'true',
    coalesce((select (pg_catalog.array_to_string(proconfig, ',') like '%search_path=pg_catalog, public%')::text from finalizer), 'false'),
    case when exists (
      select 1 from finalizer
      where pg_catalog.array_to_string(proconfig, ',') like '%search_path=pg_catalog, public%'
    ) then 'PASS' else 'FAIL' end
  union all
  select
    'finalizer_runtime_execute', 'true',
    coalesce((select pg_catalog.has_function_privilege('app_tenant_runtime', oid, 'EXECUTE')::text from finalizer), 'false'),
    case when exists (select 1 from finalizer where pg_catalog.has_function_privilege('app_tenant_runtime', oid, 'EXECUTE')) then 'PASS' else 'FAIL' end
  union all
  select
    'finalizer_service_role_execute', 'true',
    coalesce((select pg_catalog.has_function_privilege('service_role', oid, 'EXECUTE')::text from finalizer), 'false'),
    case when exists (select 1 from finalizer where pg_catalog.has_function_privilege('service_role', oid, 'EXECUTE')) then 'PASS' else 'FAIL' end
  union all
  select
    'finalizer_untrusted_execute_grants', '0',
    (select pg_catalog.count(*)::text from routine_acl
      where privilege_type = 'EXECUTE'
        and grantee in (
          0,
          coalesce((select oid from pg_catalog.pg_roles where rolname = 'anon'), 0),
          coalesce((select oid from pg_catalog.pg_roles where rolname = 'authenticated'), 0)
        )),
    case when (select pg_catalog.count(*) from routine_acl
      where privilege_type = 'EXECUTE'
        and grantee in (
          0,
          coalesce((select oid from pg_catalog.pg_roles where rolname = 'anon'), 0),
          coalesce((select oid from pg_catalog.pg_roles where rolname = 'authenticated'), 0)
        )) = 0 then 'PASS' else 'FAIL' end
  union all
  select
    'finalizer_checks_request_digest', 'true',
    coalesce((select (lower(definition) like '%request_fingerprint is distinct from v_fingerprint%')::text from finalizer), 'false'),
    case when exists (select 1 from finalizer where lower(definition) like '%request_fingerprint is distinct from v_fingerprint%') then 'PASS' else 'FAIL' end
  union all
  select
    'finalizer_reads_canonical_hotel', 'true',
    coalesce((select (lower(definition) like '%from public.hotels%' and lower(definition) like '%where slug = v_slug%')::text from finalizer), 'false'),
    case when exists (select 1 from finalizer where lower(definition) like '%from public.hotels%' and lower(definition) like '%where slug = v_slug%') then 'PASS' else 'FAIL' end
  union all
  select
    'finalizer_locks_booking', 'true',
    coalesce((select (lower(definition) like '%from public.room_bookings%' and lower(definition) like '%for update%')::text from finalizer), 'false'),
    case when exists (select 1 from finalizer where lower(definition) like '%from public.room_bookings%' and lower(definition) like '%for update%') then 'PASS' else 'FAIL' end
  union all
  select
    'finalizer_locks_linked_orders', 'true',
    coalesce((select (lower(definition) like '%from public.orders%' and lower(definition) like '%for update%')::text from finalizer), 'false'),
    case when exists (select 1 from finalizer where lower(definition) like '%from public.orders%' and lower(definition) like '%for update%') then 'PASS' else 'FAIL' end
  union all
  select
    'finalizer_uses_exact_versioned_order_payable', 'true',
    coalesce((select (lower(definition) like '%task6_order_payable_total%')::text from finalizer), 'false'),
    case when exists (select 1 from finalizer where lower(definition) like '%task6_order_payable_total%') then 'PASS' else 'FAIL' end
  union all
  select
    'finalizer_writes_receipt_snapshot_audit_atomically', 'true',
    coalesce((select (
      pg_catalog.strpos(lower(definition), 'insert into public.room_checkout_receipts') > 0
      and pg_catalog.strpos(lower(definition), 'insert into public.room_checkout_bill_snapshots') > pg_catalog.strpos(lower(definition), 'insert into public.room_checkout_receipts')
      and pg_catalog.strpos(lower(definition), 'insert into public.room_checkout_bill_audit') > pg_catalog.strpos(lower(definition), 'insert into public.room_checkout_bill_snapshots')
    )::text from finalizer), 'false'),
    case when exists (select 1 from finalizer where
      pg_catalog.strpos(lower(definition), 'insert into public.room_checkout_receipts') > 0
      and pg_catalog.strpos(lower(definition), 'insert into public.room_checkout_bill_snapshots') > pg_catalog.strpos(lower(definition), 'insert into public.room_checkout_receipts')
      and pg_catalog.strpos(lower(definition), 'insert into public.room_checkout_bill_audit') > pg_catalog.strpos(lower(definition), 'insert into public.room_checkout_bill_snapshots')
    ) then 'PASS' else 'FAIL' end
  union all
  select
    'receipt_booking_unique_index_valid', 'true',
    coalesce((select (indisunique and indisvalid and indisready and indpred is null
      and index_definition ilike '%(tenant_id, property_id, booking_id)%')::text from checkout_index), 'false'),
    case when exists (select 1 from checkout_index where indisunique and indisvalid and indisready and indpred is null
      and index_definition ilike '%(tenant_id, property_id, booking_id)%') then 'PASS' else 'FAIL' end
  union all
  select
    'snapshot_protection_trigger_enabled', 'true',
    coalesce((select (tgenabled in ('O', 'A'))::text from snapshot_trigger), 'false'),
    case when exists (select 1 from snapshot_trigger where tgenabled in ('O', 'A')) then 'PASS' else 'FAIL' end
  union all
  select
    'required_relations_missing', '0',
    (select pg_catalog.count(*)::text from relation_state where oid is null),
    case when (select pg_catalog.count(*) from relation_state where oid is null) = 0 then 'PASS' else 'FAIL' end
  union all
  select
    'required_force_rls_missing', '0',
    (select pg_catalog.count(*)::text from relation_state where oid is null or not relrowsecurity or not relforcerowsecurity),
    case when (select pg_catalog.count(*) from relation_state where oid is null or not relrowsecurity or not relforcerowsecurity) = 0 then 'PASS' else 'FAIL' end
)
select check_name, expected, actual, result
from checks
order by check_name;
