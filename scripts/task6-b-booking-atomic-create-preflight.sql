-- TASK6-B preflight: read-only readiness for atomic no-advance booking creation.
-- Returns only aggregate metadata; no guest PII and no writes.

begin transaction read only;
set local search_path = pg_catalog, public;

with checks(check_name, expected, actual, result) as (
  select 'app_tenant_rpc_owner_safe', 'true',
    (exists (
      select 1 from pg_roles
      where rolname = 'app_tenant_rpc_owner'
        and not rolcanlogin and not rolsuper and not rolcreatedb
        and not rolcreaterole and not rolinherit and not rolreplication
        and not rolbypassrls
    ))::text,
    case when exists (
      select 1 from pg_roles
      where rolname = 'app_tenant_rpc_owner'
        and not rolcanlogin and not rolsuper and not rolcreatedb
        and not rolcreaterole and not rolinherit and not rolreplication
        and not rolbypassrls
    ) then 'PASS' else 'FAIL' end
  union all
  select 'app_tenant_runtime_safe', 'true',
    (exists (
      select 1 from pg_roles
      where rolname = 'app_tenant_runtime'
        and rolcanlogin and not rolsuper and not rolcreatedb
        and not rolcreaterole and not rolinherit and not rolreplication
        and not rolbypassrls
    ))::text,
    case when exists (
      select 1 from pg_roles
      where rolname = 'app_tenant_runtime'
        and rolcanlogin and not rolsuper and not rolcreatedb
        and not rolcreaterole and not rolinherit and not rolreplication
        and not rolbypassrls
    ) then 'PASS' else 'FAIL' end
  union all
  select 'required_relations_missing', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from (values ('hotels'), ('rooms'), ('room_bookings'), ('room_maintenance')) expected(name)
  left join pg_class c
    on c.relname = expected.name
   and c.relnamespace = 'public'::regnamespace
   and c.relkind in ('r', 'p')
  where c.oid is null
  union all
  select 'required_relations_force_rls_missing', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from (values ('hotels'), ('rooms'), ('room_bookings'), ('room_maintenance')) expected(name)
  left join pg_class c
    on c.relname = expected.name
   and c.relnamespace = 'public'::regnamespace
   and c.relkind in ('r', 'p')
  where c.oid is null or not c.relrowsecurity or not c.relforcerowsecurity
  union all
  select 'task6_a_booking_fingerprint_check_ready', 'true',
    (exists (
      select 1 from pg_constraint
      where conrelid = 'public.room_bookings'::regclass
        and conname = 'task6_booking_request_fingerprint_ck'
    ))::text,
    case when exists (
      select 1 from pg_constraint
      where conrelid = 'public.room_bookings'::regclass
        and conname = 'task6_booking_request_fingerprint_ck'
    ) then 'PASS' else 'FAIL' end
  union all
  select 'booking_overlap_constraint_valid', 'true',
    coalesce((select convalidated::text from pg_constraint
      where conrelid = 'public.room_bookings'::regclass
        and conname = 'room_bookings_no_active_overlap'), 'false'),
    case when exists (
      select 1 from pg_constraint
      where conrelid = 'public.room_bookings'::regclass
        and conname = 'room_bookings_no_active_overlap'
        and convalidated
    ) then 'PASS' else 'FAIL' end
  union all
  select 'booking_idempotency_index_valid', 'true',
    coalesce((select i.indisvalid::text
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where c.relnamespace = 'public'::regnamespace
        and c.relname = 'room_bookings_scope_idempotency_unique'), 'false'),
    case when exists (
      select 1 from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where c.relnamespace = 'public'::regnamespace
        and c.relname = 'room_bookings_scope_idempotency_unique'
        and i.indisvalid and i.indisunique
    ) then 'PASS' else 'FAIL' end
  union all
  select 'invalid_booking_ranges', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.room_bookings
  where check_out_date <= check_in_date
  union all
  select 'overlapping_blocking_booking_pairs', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from public.room_bookings a
  join public.room_bookings b
    on b.room_id = a.room_id
   and b.id > a.id
   and daterange(a.check_in_date, a.check_out_date, '[)') &&
       daterange(b.check_in_date, b.check_out_date, '[)')
  where a.booking_status in ('pending', 'confirmed', 'checked_in')
    and b.booking_status in ('pending', 'confirmed', 'checked_in')
  union all
  select 'proposed_routine_already_present', '0', count(*)::text,
    case when count(*) = 0 then 'PASS' else 'FAIL' end
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname = 'task6_create_room_booking_atomic'
  union all
  select 'legacy_keyed_bookings_without_digest', 'informational', count(*)::text, 'INFO'
  from public.room_bookings
  where idempotency_key is not null
    and request_fingerprint is null
)
select check_name, expected, actual, result
from checks
order by check_name;

rollback;
