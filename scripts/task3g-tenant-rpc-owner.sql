-- Task 3 / TASK3-G: non-BYPASSRLS owner for tenant-facing SECURITY DEFINER RPCs.
-- Authorized pre-production database only. Run manually in Supabase SQL Editor.
-- This stage does NOT enable FORCE RLS and does not delete application data.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '10min';
set local search_path = pg_catalog, public;

do $task3g_role$
declare
  target pg_roles%rowtype;
begin
  select * into target from pg_roles where rolname = 'app_tenant_rpc_owner';
  if target.oid is null then
    create role app_tenant_rpc_owner
      nologin nosuperuser nocreatedb nocreaterole noinherit
      noreplication nobypassrls;
    select * into target from pg_roles where rolname = 'app_tenant_rpc_owner';
  end if;
  if target.rolcanlogin or target.rolsuper or target.rolcreatedb
     or target.rolcreaterole or target.rolinherit or target.rolreplication
     or target.rolbypassrls then
    raise exception 'TASK3G_RPC_OWNER_ATTRIBUTES_UNSAFE';
  end if;
end;
$task3g_role$;

revoke create on schema public from app_tenant_rpc_owner;
grant usage on schema public to app_tenant_rpc_owner;

-- Reset and copy the already-reviewed least-privilege table/sequence manifest
-- from app_tenant_runtime. This avoids creating a second drifting manifest.
do $task3g_privileges$
declare
  target record;
  privilege_name text;
begin
  for target in
    select c.oid, c.oid::regclass as object_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')
  loop
    execute format(
      'revoke all privileges on table %s from app_tenant_rpc_owner',
      target.object_name
    );
    foreach privilege_name in array array[
      'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'
    ]
    loop
      if has_table_privilege('app_tenant_runtime', target.oid, privilege_name) then
        execute format(
          'grant %s on table %s to app_tenant_rpc_owner',
          privilege_name,
          target.object_name
        );
      end if;
    end loop;
  end loop;

  for target in
    select c.oid, c.oid::regclass as object_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S'
  loop
    execute format(
      'revoke all privileges on sequence %s from app_tenant_rpc_owner',
      target.object_name
    );
    foreach privilege_name in array array['USAGE','SELECT','UPDATE']
    loop
      if has_sequence_privilege('app_tenant_runtime', target.oid, privilege_name) then
        execute format(
          'grant %s on sequence %s to app_tenant_rpc_owner',
          privilege_name,
          target.object_name
        );
      end if;
    end loop;
  end loop;
end;
$task3g_privileges$;

-- The RPC owner receives the same row-level policy boundary as the normal
-- runtime. The existing app_tenant_runtime role remains present on every policy.
do $task3g_policies$
declare
  target record;
  runtime_oid oid := (select oid from pg_roles where rolname='app_tenant_runtime');
begin
  if runtime_oid is null then
    raise exception 'TASK3G_RUNTIME_ROLE_MISSING';
  end if;
  for target in
    select n.nspname, c.relname, p.polname
    from pg_policy p
    join pg_class c on c.oid=p.polrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and runtime_oid=any(p.polroles)
  loop
    execute format(
      'alter policy %I on %I.%I to app_tenant_runtime, app_tenant_rpc_owner',
      target.polname,
      target.nspname,
      target.relname
    );
  end loop;
end;
$task3g_policies$;

do $task3g_routines$
declare
  tenant_rpcs constant text[] := array[
    'acknowledge_notification_card',
    'activate_room_tax_rule',
    'add_staff_items_to_active_order',
    'correct_secure_qr_submission_staff',
    'create_room_booking_with_advance',
    'create_staff_table_order_if_available',
    'delete_room_image',
    'edit_secure_qr_submission',
    'extend_room_booking',
    'get_staff_active_table_order',
    'is_dine_in_order_open',
    'record_room_booking_payment',
    'record_room_booking_refund',
    'reorder_room_images',
    'room_negotiated_rate_ready',
    'settle_room_combined_checkout',
    'shift_room_booking',
    'submit_secure_qr_table_order'
  ];
  privileged_payment_rpcs constant text[] := array[
    'attach_payment_intent_provider_order',
    'claim_payment_intent_provider_creation',
    'claim_payment_webhook',
    'complete_payment_webhook',
    'finalize_captured_payment'
  ];
  missing text[];
  target record;
begin
  select array_agg(name order by name) into missing
  from unnest(tenant_rpcs) name
  where not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=name and p.prokind in ('f','p')
  );
  if missing is not null then
    raise exception 'TASK3G_REQUIRED_TENANT_RPCS_MISSING %', missing;
  end if;

  -- SECURITY DEFINER functions must stop executing as the postgres/table-owner
  -- role. PostgreSQL requires the caller to be able to SET ROLE to a new owner
  -- and the new owner to have CREATE temporarily; both capabilities are removed
  -- before commit. PostgreSQL 16+ automatically gives a CREATEROLE creator an
  -- ADMIN-only membership (SET FALSE). We add a separate, non-ADMIN temporary
  -- SET membership granted by the current user, then revoke only that grant.
  execute format(
    'grant app_tenant_rpc_owner to %I with admin false, inherit false, set true granted by %I',
    current_user,
    current_user
  );
  grant create on schema public to app_tenant_rpc_owner;

  for target in
    select p.oid, p.oid::regprocedure as routine_name, p.prosecdef,
      owner_role.rolname as owner_name
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    join pg_roles owner_role on owner_role.oid=p.proowner
    where n.nspname='public'
      and p.prokind in ('f','p')
      and p.proname=any(tenant_rpcs)
  loop
    -- Grant while the migration role still owns the routine. SECURITY DEFINER
    -- routines already moved by an earlier run are granted again below while
    -- explicitly SET ROLE'd to their safe owner.
    if not target.prosecdef or target.owner_name <> 'app_tenant_rpc_owner' then
      execute format(
        'grant execute on routine %s to app_tenant_runtime, service_role',
        target.routine_name
      );
    end if;
    if target.prosecdef and target.owner_name <> 'app_tenant_rpc_owner' then
      execute format(
        'alter routine %s owner to app_tenant_rpc_owner',
        target.routine_name
      );
    end if;
  end loop;

  -- Helper routines called inside reviewed tenant RPCs remain unreachable from
  -- normal tenants unless separately granted to app_tenant_runtime.
  for target in
    select p.oid::regprocedure as routine_name
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
      and p.prokind in ('f','p')
      and not p.prosecdef
      and not exists (
        select 1 from pg_depend d
        where d.classid='pg_proc'::regclass
          and d.objid=p.oid
          and d.deptype='e'
      )
  loop
    execute format(
      'grant execute on routine %s to app_tenant_rpc_owner',
      target.routine_name
    );
  end loop;

  for target in
    select p.oid::regprocedure as routine_name
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
      and p.prokind in ('f','p')
      and p.proname=any(privileged_payment_rpcs)
  loop
    execute format(
      'revoke execute on routine %s from app_tenant_runtime, app_tenant_rpc_owner',
      target.routine_name
    );
    execute format(
      'grant execute on routine %s to service_role',
      target.routine_name
    );
  end loop;
end;
$task3g_routines$;

-- Ownership grants must be issued as the new non-BYPASSRLS owner. SET LOCAL
-- is transaction-scoped and the temporary membership is removed immediately
-- afterward. These exact signatures are the reviewed SECURITY DEFINER surface.
set local role app_tenant_rpc_owner;

grant execute on function public.acknowledge_notification_card(text,text,text,bigint)
  to app_tenant_runtime, service_role;
grant execute on function public.activate_room_tax_rule(text,bigint,integer,text)
  to app_tenant_runtime, service_role;
grant execute on function public.create_room_booking_with_advance(text,jsonb,jsonb,text,text,text)
  to app_tenant_runtime, service_role;
grant execute on function public.delete_room_image(text,bigint,text,text)
  to app_tenant_runtime, service_role;
grant execute on function public.extend_room_booking(text,bigint,date,text,text,text)
  to app_tenant_runtime, service_role;
grant execute on function public.record_room_booking_payment(text,bigint,numeric,text,text,text,text,text,text)
  to app_tenant_runtime, service_role;
grant execute on function public.record_room_booking_refund(text,bigint,numeric,text,text,text,text,text)
  to app_tenant_runtime, service_role;
grant execute on function public.reorder_room_images(text,text,bigint,bigint[],text,text)
  to app_tenant_runtime, service_role;
grant execute on function public.room_negotiated_rate_ready()
  to app_tenant_runtime, service_role;
grant execute on function public.shift_room_booking(text,bigint,bigint,text,text,text,timestamptz)
  to app_tenant_runtime, service_role;

reset role;

revoke create on schema public from app_tenant_rpc_owner;
do $task3g_membership_cleanup$
begin
  execute format(
    'revoke app_tenant_rpc_owner from %I granted by %I restrict',
    current_user,
    current_user
  );
end;
$task3g_membership_cleanup$;

-- Fail closed inside the same transaction.
do $task3g_guard$
declare
  bad_count bigint;
begin
  select count(*) into bad_count
  from pg_roles
  where rolname='app_tenant_rpc_owner'
    and (rolcanlogin or rolsuper or rolcreatedb or rolcreaterole
      or rolinherit or rolreplication or rolbypassrls);
  if bad_count<>0 then raise exception 'TASK3G_RPC_OWNER_UNSAFE'; end if;

  select count(*) into bad_count
  from pg_auth_members m
  where m.roleid=(select oid from pg_roles where rolname='app_tenant_rpc_owner')
    and (m.inherit_option or m.set_option);
  if bad_count<>0 then
    raise exception 'TASK3G_RPC_OWNER_EFFECTIVE_MEMBERSHIP count=%',bad_count;
  end if;

  select count(*) into bad_count
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  join pg_roles owner_role on owner_role.oid=p.proowner
  where n.nspname='public'
    and p.prosecdef
    and p.proname=any(array[
      'acknowledge_notification_card','activate_room_tax_rule',
      'add_staff_items_to_active_order','correct_secure_qr_submission_staff',
      'create_room_booking_with_advance','create_staff_table_order_if_available',
      'delete_room_image','edit_secure_qr_submission','extend_room_booking',
      'get_staff_active_table_order','is_dine_in_order_open',
      'record_room_booking_payment','record_room_booking_refund',
      'reorder_room_images','room_negotiated_rate_ready',
      'settle_room_combined_checkout','shift_room_booking',
      'submit_secure_qr_table_order'
    ])
    and (owner_role.rolname<>'app_tenant_rpc_owner' or owner_role.rolbypassrls);
  if bad_count<>0 then
    raise exception 'TASK3G_TENANT_SECURITY_DEFINER_OWNER_UNSAFE count=%',bad_count;
  end if;

  select count(*) into bad_count
  from pg_policy p
  join pg_class c on c.oid=p.polrelid
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public'
    and (select oid from pg_roles where rolname='app_tenant_runtime')=any(p.polroles)
    and not ((select oid from pg_roles where rolname='app_tenant_rpc_owner')=any(p.polroles));
  if bad_count<>0 then
    raise exception 'TASK3G_RPC_OWNER_POLICY_GAP count=%',bad_count;
  end if;
end;
$task3g_guard$;

commit;

-- Rollback notes (do not run as routine rollback):
-- Reassign only the listed tenant SECURITY DEFINER functions to the prior owner,
-- remove app_tenant_rpc_owner from policy role lists, and revoke its grants.
-- Never drop payment, booking, audit, webhook, or notification evidence.
