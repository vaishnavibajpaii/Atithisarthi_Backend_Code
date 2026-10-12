-- Task 4 follow-up: automatic session invalidation for security-critical
-- principal changes. Additive only; execute once in Supabase SQL Editor.

begin;

do $task4_invalidation_prerequisites$
begin
  if to_regprocedure('public.task4_revoke_principal_sessions(text,bigint,text,text)') is null then
    raise exception 'TASK4_REVOCATION_ROUTINE_MISSING';
  end if;
  if to_regprocedure('public.task4_invalidate_principal_sessions_on_change()') is not null
     or exists (
       select 1 from pg_trigger
       where tgname in (
         'task4_admin_security_change_revoke_sessions',
         'task4_staff_security_change_revoke_sessions'
       ) and not tgisinternal
     ) then
    raise exception 'TASK4_INVALIDATION_HOOKS_ALREADY_EXIST';
  end if;
end;
$task4_invalidation_prerequisites$;

-- The original Task 4 migration deliberately removed all effective
-- memberships after creating the RPC owner. Restore SET-only membership for
-- this transaction so PostgreSQL permits the ownership transfer below.
do $task4_invalidation_membership$
begin
  execute format(
    'grant app_auth_rpc_owner to %I with admin false, inherit false, set true granted by %I',
    current_user,
    current_user
  );
end;
$task4_invalidation_membership$;

grant create on schema public to app_auth_rpc_owner;
grant trigger on public.admin_users, public.hotel_staff_access
  to app_auth_rpc_owner;
set local role app_auth_rpc_owner;

create function public.task4_invalidate_principal_sessions_on_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $task4$
declare
  principal_type text;
  principal_id bigint;
  revoke_reason text;
begin
  principal_type := case tg_table_name
    when 'admin_users' then 'platform_admin'
    when 'hotel_staff_access' then 'hotel_staff'
    else null
  end;
  principal_id := old.id;

  if principal_type is null then
    raise exception 'TASK4_INVALIDATION_TRIGGER_TABLE_INVALID';
  end if;

  if tg_op = 'DELETE' then
    revoke_reason := 'account_deleted';
  elsif old.is_active is true and new.is_active is false then
    revoke_reason := 'principal_inactive';
  elsif tg_table_name = 'admin_users'
        and old.password_hash is distinct from new.password_hash then
    revoke_reason := 'credential_changed';
  elsif tg_table_name = 'hotel_staff_access'
        and old.pin_hash is distinct from new.pin_hash then
    revoke_reason := 'credential_changed';
  elsif tg_table_name = 'hotel_staff_access'
        and (
          old.tenant_id is distinct from new.tenant_id
          or old.property_id is distinct from new.property_id
          or old.hotel_slug is distinct from new.hotel_slug
        ) then
    revoke_reason := 'tenant_context_changed';
  elsif tg_table_name = 'hotel_staff_access'
        and old.role is distinct from new.role then
    revoke_reason := 'role_changed';
  elsif tg_table_name = 'hotel_staff_access'
        and old.kds_role is distinct from new.kds_role then
    revoke_reason := 'kds_role_changed';
  end if;

  if revoke_reason is not null then
    perform public.task4_revoke_principal_sessions(
      principal_type,
      principal_id,
      revoke_reason,
      null
    );
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$task4$;

revoke all privileges on function public.task4_invalidate_principal_sessions_on_change()
  from public, anon, authenticated, service_role, app_tenant_runtime,
    app_tenant_rpc_owner;

create trigger task4_admin_security_change_revoke_sessions
before update of password_hash, is_active or delete
on public.admin_users
for each row
execute function public.task4_invalidate_principal_sessions_on_change();

create trigger task4_staff_security_change_revoke_sessions
before update of pin_hash, is_active, role, kds_role, tenant_id, property_id,
  hotel_slug or delete
on public.hotel_staff_access
for each row
execute function public.task4_invalidate_principal_sessions_on_change();

reset role;
revoke trigger on public.admin_users, public.hotel_staff_access
  from app_auth_rpc_owner;
revoke create on schema public from app_auth_rpc_owner;

-- Leave the owner role isolated exactly as the base migration verified it.
do $task4_invalidation_membership_cleanup$
begin
  execute format(
    'revoke app_auth_rpc_owner from %I granted by %I restrict',
    current_user,
    current_user
  );
end;
$task4_invalidation_membership_cleanup$;

commit;
