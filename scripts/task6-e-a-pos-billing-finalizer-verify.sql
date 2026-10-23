-- TASK6-E-A read-only post-migration verification.
-- Returns only catalog state and aggregate counts; no guest, order, or bill data.

with public_schema as (
  select oid from pg_catalog.pg_namespace where nspname = 'public'
), named_functions as (
  select
    proc.oid,
    proc.proowner,
    proc.prosecdef,
    proc.proconfig,
    proc.proacl,
    pg_catalog.pg_get_userbyid(proc.proowner) as owner_name,
    pg_catalog.pg_get_functiondef(proc.oid) as definition,
    pg_catalog.oidvectortypes(proc.proargtypes) as argument_types
  from pg_catalog.pg_proc proc
  join pg_catalog.pg_namespace ns on ns.oid = proc.pronamespace
  where ns.nspname = 'public'
    and proc.proname = 'task6_finalize_order_family'
), finalizer as (
  select * from named_functions
  where oid = to_regprocedure(
    'public.task6_finalize_order_family(text,bigint,text,text,text,timestamptz,text,text,jsonb)'
  )
), routine_acl as (
  select acl.grantee, acl.privilege_type
  from finalizer
  cross join lateral pg_catalog.aclexplode(
    coalesce(finalizer.proacl, pg_catalog.acldefault('f', finalizer.proowner))
  ) acl
), required_relations(relation_name) as (
  values ('hotels'), ('orders'), ('food_order_bill_snapshots'), ('food_order_bill_audit')
), relation_state as (
  select required.relation_name, relation.oid, relation.relrowsecurity, relation.relforcerowsecurity
  from required_relations required
  cross join public_schema
  left join pg_catalog.pg_class relation
    on relation.relnamespace = public_schema.oid
   and relation.relname = required.relation_name
   and relation.relkind in ('r', 'p')
), billing_index as (
  select index_state.indisunique, index_state.indisvalid, index_state.indisready,
         pg_catalog.pg_get_indexdef(index_state.indexrelid) as index_definition
  from pg_catalog.pg_class index_relation
  join pg_catalog.pg_index index_state on index_state.indexrelid = index_relation.oid
  cross join public_schema
  where index_relation.relnamespace = public_schema.oid
    and index_relation.relname = 'task6_orders_billing_idempotency_uq'
), snapshot_trigger as (
  select trigger.tgenabled
  from pg_catalog.pg_trigger trigger
  join pg_catalog.pg_class relation on relation.oid = trigger.tgrelid
  cross join public_schema
  where relation.relnamespace = public_schema.oid
    and relation.relname = 'food_order_bill_snapshots'
    and trigger.tgname = 'food_order_bill_snapshots_protect'
    and not trigger.tgisinternal
), checks(check_name, expected, actual, result) as (
  select 'finalizer_routine_overload_count', '1',
    (select count(*)::text from named_functions),
    case when (select count(*) from named_functions) = 1 then 'PASS' else 'FAIL' end
  union all
  select 'finalizer_exact_signature_present', '1',
    (select count(*)::text from finalizer),
    case when exists (select 1 from finalizer) then 'PASS' else 'FAIL' end
  union all
  select 'finalizer_security_invoker', 'true',
    coalesce((select (not prosecdef)::text from finalizer), 'false'),
    case when coalesce((select not prosecdef from finalizer), false) then 'PASS' else 'FAIL' end
  union all
  select 'finalizer_owner_safe', 'app_tenant_rpc_owner',
    coalesce((select owner_name from finalizer), '<missing>'),
    case when exists (
      select 1 from finalizer
      join pg_catalog.pg_roles owner_role on owner_role.rolname = finalizer.owner_name
      where finalizer.owner_name = 'app_tenant_rpc_owner'
        and not owner_role.rolcanlogin and not owner_role.rolsuper
        and not owner_role.rolcreatedb and not owner_role.rolcreaterole
        and not owner_role.rolinherit and not owner_role.rolreplication and not owner_role.rolbypassrls
    ) then 'PASS' else 'FAIL' end
  union all
  select 'finalizer_search_path_pinned', 'true',
    coalesce((select (array_to_string(proconfig, ',') like '%search_path=pg_catalog, public%')::text from finalizer), 'false'),
    case when exists (
      select 1 from finalizer
      where array_to_string(proconfig, ',') like '%search_path=pg_catalog, public%'
    ) then 'PASS' else 'FAIL' end
  union all
  select 'finalizer_runtime_execute', 'true',
    coalesce((select has_function_privilege('app_tenant_runtime', oid, 'EXECUTE')::text from finalizer), 'false'),
    case when exists (select 1 from finalizer where has_function_privilege('app_tenant_runtime', oid, 'EXECUTE')) then 'PASS' else 'FAIL' end
  union all
  select 'finalizer_service_role_execute', 'true',
    coalesce((select has_function_privilege('service_role', oid, 'EXECUTE')::text from finalizer), 'false'),
    case when exists (select 1 from finalizer where has_function_privilege('service_role', oid, 'EXECUTE')) then 'PASS' else 'FAIL' end
  union all
  select 'finalizer_untrusted_execute_grants', '0',
    (select count(*)::text from routine_acl
      where privilege_type = 'EXECUTE'
        and grantee in (0, coalesce((select oid from pg_catalog.pg_roles where rolname = 'anon'), 0), coalesce((select oid from pg_catalog.pg_roles where rolname = 'authenticated'), 0))),
    case when (select count(*) from routine_acl
      where privilege_type = 'EXECUTE'
        and grantee in (0, coalesce((select oid from pg_catalog.pg_roles where rolname = 'anon'), 0), coalesce((select oid from pg_catalog.pg_roles where rolname = 'authenticated'), 0))) = 0
      then 'PASS' else 'FAIL' end
  union all
  select 'finalizer_checks_digest_conflict', 'true',
    coalesce((select (lower(definition) like '%billing_request_fingerprint is distinct from v_fingerprint%')::text from finalizer), 'false'),
    case when exists (select 1 from finalizer where lower(definition) like '%billing_request_fingerprint is distinct from v_fingerprint%') then 'PASS' else 'FAIL' end
  union all
  select 'finalizer_reads_canonical_hotel', 'true',
    coalesce((select (lower(definition) like '%from public.hotels%' and lower(definition) like '%where slug = v_slug%')::text from finalizer), 'false'),
    case when exists (select 1 from finalizer where lower(definition) like '%from public.hotels%' and lower(definition) like '%where slug = v_slug%') then 'PASS' else 'FAIL' end
  union all
  select 'finalizer_has_idempotency_lock', 'true',
    coalesce((select (lower(definition) like '%pg_advisory_xact_lock%' and lower(definition) like '%task6-order-bill:%')::text from finalizer), 'false'),
    case when exists (select 1 from finalizer where lower(definition) like '%pg_advisory_xact_lock%' and lower(definition) like '%task6-order-bill:%') then 'PASS' else 'FAIL' end
  union all
  select 'finalizer_locks_order_family', 'true',
    coalesce((select (lower(definition) like '%from public.orders target%' and lower(definition) like '%for update%')::text from finalizer), 'false'),
    case when exists (select 1 from finalizer where lower(definition) like '%from public.orders target%' and lower(definition) like '%for update%') then 'PASS' else 'FAIL' end
  union all
  select 'finalizer_uses_exact_versioned_payable', 'true',
    coalesce((select (lower(definition) like '%task6_order_payable_total%')::text from finalizer), 'false'),
    case when exists (select 1 from finalizer where lower(definition) like '%task6_order_payable_total%') then 'PASS' else 'FAIL' end
  union all
  select 'finalizer_writes_order_snapshot_audit_atomically', 'true',
    coalesce((select (
      strpos(lower(definition), 'update public.orders target') > 0
      and strpos(lower(definition), 'insert into public.food_order_bill_snapshots') > strpos(lower(definition), 'update public.orders target')
      and strpos(lower(definition), 'insert into public.food_order_bill_audit') > strpos(lower(definition), 'insert into public.food_order_bill_snapshots')
    )::text from finalizer), 'false'),
    case when exists (select 1 from finalizer where
      strpos(lower(definition), 'update public.orders target') > 0
      and strpos(lower(definition), 'insert into public.food_order_bill_snapshots') > strpos(lower(definition), 'update public.orders target')
      and strpos(lower(definition), 'insert into public.food_order_bill_audit') > strpos(lower(definition), 'insert into public.food_order_bill_snapshots')
    ) then 'PASS' else 'FAIL' end
  union all
  select 'billing_scope_column_present', 'true',
    exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'orders'
        and column_name = 'billing_idempotency_scope'
    )::text,
    case when exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'orders'
        and column_name = 'billing_idempotency_scope'
    ) then 'PASS' else 'FAIL' end
  union all
  select 'billing_scope_constraint_present', 'true',
    exists (
      select 1 from pg_catalog.pg_constraint
      where conrelid = 'public.orders'::regclass
        and conname = 'task6_orders_billing_idempotency_scope_ck'
    )::text,
    case when exists (
      select 1 from pg_catalog.pg_constraint
      where conrelid = 'public.orders'::regclass
        and conname = 'task6_orders_billing_idempotency_scope_ck'
    ) then 'PASS' else 'FAIL' end
  union all
  select 'billing_idempotency_index_valid', 'true',
    coalesce((select (indisunique and indisvalid and indisready and index_definition ilike '%tenant_id, property_id, billing_idempotency_key%')::text from billing_index), 'false'),
    case when exists (select 1 from billing_index
      where indisunique and indisvalid and indisready and index_definition ilike '%tenant_id, property_id, billing_idempotency_key%') then 'PASS' else 'FAIL' end
  union all
  select 'snapshot_protection_trigger_enabled', 'true',
    coalesce((select (tgenabled in ('O', 'A'))::text from snapshot_trigger), 'false'),
    case when exists (select 1 from snapshot_trigger where tgenabled in ('O', 'A')) then 'PASS' else 'FAIL' end
  union all
  select 'required_relations_missing', '0',
    (select count(*)::text from relation_state where oid is null),
    case when (select count(*) from relation_state where oid is null) = 0 then 'PASS' else 'FAIL' end
  union all
  select 'required_force_rls_missing', '0',
    (select count(*)::text from relation_state where oid is null or not relrowsecurity or not relforcerowsecurity),
    case when (select count(*) from relation_state where oid is null or not relrowsecurity or not relforcerowsecurity) = 0 then 'PASS' else 'FAIL' end
  union all
  select 'historical_rows_with_task6_billing_scope', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.orders
  where billing_idempotency_scope is not null
)
select check_name, expected, actual, result
from checks
order by check_name;
