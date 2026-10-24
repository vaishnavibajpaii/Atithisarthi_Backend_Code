# TASK6-E-B2 rollback notes

This checkpoint adds only one forward-only `BEFORE UPDATE` trigger and its
SECURITY INVOKER trigger function. It never changes business rows.

Do not remove it in normal operation. If an approved emergency rollback is
required, first preserve incident evidence and disable the matching application
release. Then run:

```sql
begin;
drop trigger if exists orders_11_task6_finalized_operational_guard on public.orders;
drop function if exists public.task6_guard_finalized_order_operational_state();
commit;
```

No financial or operational history is deleted by that rollback. The original
Task6-E-B guard remains installed.
