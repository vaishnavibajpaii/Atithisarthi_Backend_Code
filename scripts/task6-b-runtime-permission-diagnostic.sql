-- TASK6-B runtime permission diagnostic (READ ONLY, one result set).
-- No tenant, property, guest, booking, order, or payment rows are returned.

set statement_timeout = '30s';
set lock_timeout = '5s';
set search_path = pg_catalog, public;

with checks as (
  select 'runtime_hotels_select'::text as check_name, 'true'::text as expected,
    has_table_privilege('app_tenant_runtime', 'public.hotels', 'SELECT')::text as actual
  union all select 'runtime_hotels_update', 'false',
    has_table_privilege('app_tenant_runtime', 'public.hotels', 'UPDATE')::text
  union all select 'runtime_rooms_select', 'true',
    has_table_privilege('app_tenant_runtime', 'public.rooms', 'SELECT')::text
  union all select 'runtime_rooms_update', 'true',
    has_table_privilege('app_tenant_runtime', 'public.rooms', 'UPDATE')::text
  union all select 'runtime_room_bookings_select', 'true',
    has_table_privilege('app_tenant_runtime', 'public.room_bookings', 'SELECT')::text
  union all select 'runtime_room_bookings_insert', 'true',
    has_table_privilege('app_tenant_runtime', 'public.room_bookings', 'INSERT')::text
  union all select 'runtime_room_bookings_update', 'true',
    has_table_privilege('app_tenant_runtime', 'public.room_bookings', 'UPDATE')::text
  union all select 'runtime_room_maintenance_select', 'true',
    has_table_privilege('app_tenant_runtime', 'public.room_maintenance', 'SELECT')::text
  union all select 'required_force_rls_missing', '0', count(*)::text
    from (values ('hotels'), ('rooms'), ('room_bookings'), ('room_maintenance')) required(name)
    where not exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = required.name
        and c.relrowsecurity and c.relforcerowsecurity
    )
  union all select 'required_runtime_select_policies_missing', '0', count(*)::text
    from (values ('hotels'), ('rooms'), ('room_bookings'), ('room_maintenance')) required(name)
    where not exists (
      select 1
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = required.name
        and p.polcmd in ('r', '*')
        and (select oid from pg_roles where rolname = 'app_tenant_runtime') = any(p.polroles)
    )
  union all select 'room_bookings_runtime_insert_policy', 'true', exists (
      select 1 from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'room_bookings'
        and p.polcmd in ('a', '*')
        and (select oid from pg_roles where rolname = 'app_tenant_runtime') = any(p.polroles)
    )::text
  union all select 'rpc_present', '1', count(*)::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'task6_create_room_booking_atomic'
  union all select 'rpc_security_invoker', 'true', (not p.prosecdef)::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'task6_create_room_booking_atomic'
  union all select 'rpc_runtime_execute', 'true',
    has_function_privilege('app_tenant_runtime', p.oid, 'EXECUTE')::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'task6_create_room_booking_atomic'
  union all select 'rpc_locks_hotel_key_share', 'true',
    (position('for key share' in lower(pg_get_functiondef(p.oid))) > 0)::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'task6_create_room_booking_atomic'
  union all select 'rpc_reads_hotels', 'true',
    (position('from public.hotels' in lower(pg_get_functiondef(p.oid))) > 0)::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'task6_create_room_booking_atomic'
  union all select 'booking_sequence_runtime_usage', 'true',
    has_sequence_privilege(
      'app_tenant_runtime',
      pg_get_serial_sequence('public.room_bookings', 'id'),
      'USAGE'
    )::text
)
select
  check_name,
  expected,
  actual,
  case when actual = expected then 'PASS' else 'FAIL' end as result
from checks
order by check_name;
