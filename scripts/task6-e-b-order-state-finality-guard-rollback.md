# TASK6-E-B rollback notes

This checkpoint does not write or migrate historical order, payment, invoice,
bill-snapshot, or audit data. Its only durable objects are the trigger
`orders_10_task6_state_finality_guard` and the SECURITY INVOKER trigger
function `public.task6_guard_order_state_and_finality()`.

Do not remove the guard as an ordinary application rollback. First disable the
matching TEST application release or route that depends on it, preserve any
failed-operation evidence, and record the incident/change reason.

If an approved rollback is required, in one explicit transaction execute:

```sql
begin;
drop trigger if exists orders_10_task6_state_finality_guard on public.orders;
drop function if exists public.task6_guard_order_state_and_finality();
commit;
```

This rollback does not delete or change business records. Re-run the prior
Task6-E-B preflight afterwards. It intentionally restores the former weaker
write protection, so it must be followed by an approved corrective plan.
