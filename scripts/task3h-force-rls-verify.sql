-- Task 3H final FORCE RLS read-only verification.
with
target(name) as (select unnest(array[
  'hotels','gallery_items','hotel_popup_notifications','login_page_branding','menu_categories','menu_combo_items','menu_combo_settings','menu_items','notification_events','room_booking_payments','room_bookings','room_images','testimonials','contact_submissions','food_order_bill_formats','food_order_bill_snapshots','guest_stays','hotel_feature_settings','hotel_floors','hotel_guest_profiles','hotel_notification_settings','hotel_ordering_settings','hotel_payment_route_settings','hotel_profiles','hotel_room_advance_policies','hotel_room_amenities','hotel_room_tax_settings','hotel_staff_access','inquiries','kds_settings','kitchen_stations','notification_card_acknowledgements','order_rounds','order_support_requests','orders','payment_intents','qr_customer_sessions','qr_event_outbox','qr_idempotency_records','qr_order_submissions','qr_staff_idempotency_records','reservations','restaurant_table_qr_tokens','restaurant_tables','room_checkout_bill_formats','room_checkout_bill_snapshots','room_housekeeping_tasks','room_maintenance','room_negotiated_rate_approvals','room_rate_plans','room_tax_rules','room_types','rooms','food_order_bill_audit','hotel_feature_setting_audit','hotel_ordering_settings_audit','kds_status_history','login_page_branding_audit','menu_category_audit','payment_attempts','payment_webhook_inbox','qr_security_events','room_booking_refunds','room_checkout_bill_audit','room_checkout_receipts','room_operation_audit','room_shifts','room_stay_rate_adjustments'
]::text[])),
runtime_role as (select * from pg_roles where rolname='app_tenant_runtime'),
rpc_owner as (select * from pg_roles where rolname='app_tenant_rpc_owner'),
relations as (
  select c.oid,c.relname,c.relowner,c.relrowsecurity,c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid=c.relnamespace join target t on t.name=c.relname
  where n.nspname='public' and c.relkind in ('r','p')
),
policies as (select p.* from pg_policy p join relations r on r.oid=p.polrelid),
tenant_rpc(name) as (select unnest(array['acknowledge_notification_card','activate_room_tax_rule','add_staff_items_to_active_order','correct_secure_qr_submission_staff','create_room_booking_with_advance','create_staff_table_order_if_available','delete_room_image','edit_secure_qr_submission','extend_room_booking','get_staff_active_table_order','is_dine_in_order_open','record_room_booking_payment','record_room_booking_refund','reorder_room_images','room_negotiated_rate_ready','settle_room_combined_checkout','shift_room_booking','submit_secure_qr_table_order']::text[])),
payment_rpc(name) as (select unnest(array['attach_payment_intent_provider_order','claim_payment_intent_provider_creation','claim_payment_webhook','complete_payment_webhook','finalize_captured_payment']::text[])),
functions as (
  select p.oid,p.proname,p.prosecdef,o.rolname owner_name,o.rolbypassrls owner_bypassrls
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles o on o.oid=p.proowner
  where n.nspname='public' and p.prokind in ('f','p') and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')
),
checks as (
  select 'database_name'::text check_name,'postgres'::text expected,current_database()::text actual,'INFO'::text mode
  union all select 'target_manifest_count','68',(select count(*)::text from target),'EQUAL'
  union all select 'target_tables_missing','0',(select count(*)::text from target t where to_regclass(format('public.%I',t.name)) is null),'EQUAL'
  union all select 'target_tables_rls_disabled','0',(select count(*)::text from relations where not relrowsecurity),'EQUAL'
  union all select 'target_tables_force_rls_enabled','68',(select count(*)::text from relations where relforcerowsecurity),'EQUAL'
  union all select 'target_tables_force_rls_missing','0',(select count(*)::text from relations where not relforcerowsecurity),'EQUAL'
  union all select 'unexpected_public_force_rls','0',(select count(*)::text from pg_class c join pg_namespace n on n.oid=c.relnamespace left join target t on t.name=c.relname where n.nspname='public' and c.relkind in ('r','p') and c.relforcerowsecurity and t.name is null),'EQUAL'
  union all select 'runtime_role_attributes_safe','true',coalesce((select (rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole and not rolinherit and not rolreplication and not rolbypassrls)::text from runtime_role),'false'),'EQUAL'
  union all select 'runtime_role_unexpected_memberships','0',(select count(*)::text from pg_auth_members m cross join runtime_role r left join pg_roles member_role on member_role.oid=m.member left join pg_roles grantor_role on grantor_role.oid=m.grantor where (m.roleid=r.oid or m.member=r.oid) and not (m.roleid=r.oid and member_role.rolname='postgres' and m.admin_option and not m.inherit_option and not m.set_option and (m.grantor=10 or coalesce(grantor_role.rolsuper,false)))),'EQUAL'
  union all select 'runtime_owned_target_tables','0',(select count(*)::text from relations r cross join runtime_role rr where r.relowner=rr.oid),'EQUAL'
  union all select 'rpc_owner_attributes_safe','true',coalesce((select (not rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole and not rolinherit and not rolreplication and not rolbypassrls)::text from rpc_owner),'false'),'EQUAL'
  union all select 'rpc_owner_effective_memberships','0',(select count(*)::text from pg_auth_members m where m.roleid=(select oid from rpc_owner) and (m.inherit_option or m.set_option)),'EQUAL'
  union all select 'service_role_bypass_preserved','true',coalesce((select rolbypassrls::text from pg_roles where rolname='service_role'),'false'),'EQUAL'
  union all select 'runtime_policy_count_preserved','199',(select count(*)::text from policies p where (select oid from runtime_role)=any(p.polroles)),'EQUAL'
  union all select 'rpc_owner_policy_count_preserved','199',(select count(*)::text from policies p where (select oid from rpc_owner)=any(p.polroles)),'EQUAL'
  union all select 'policy_role_scope_mismatch','0',(select count(*)::text from policies p where cardinality(p.polroles)<>2 or not ((select oid from runtime_role)=any(p.polroles)) or not ((select oid from rpc_owner)=any(p.polroles))),'EQUAL'
  union all select 'anon_authenticated_effective_table_privileges','0',(select count(*)::text from relations r cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) v(privilege) where has_table_privilege('anon',r.oid,v.privilege) or has_table_privilege('authenticated',r.oid,v.privilege)),'EQUAL'
  union all select 'tenant_rpc_runtime_execute_missing','0',(select count(*)::text from functions f join tenant_rpc n on n.name=f.proname where not has_function_privilege('app_tenant_runtime',f.oid,'EXECUTE')),'EQUAL'
  union all select 'tenant_security_definer_owner_unsafe','0',(select count(*)::text from functions f join tenant_rpc n on n.name=f.proname where f.prosecdef and (f.owner_name<>'app_tenant_rpc_owner' or f.owner_bypassrls)),'EQUAL'
  union all select 'privileged_payment_rpc_runtime_execute','0',(select count(*)::text from functions f join payment_rpc n on n.name=f.proname where has_function_privilege('app_tenant_runtime',f.oid,'EXECUTE')),'EQUAL'
)
select check_name,expected,actual,case when mode='INFO' then 'INFO' when expected=actual then 'PASS' else 'FAIL' end result from checks order by check_name;
