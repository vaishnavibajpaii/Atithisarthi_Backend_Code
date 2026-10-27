# TASK6-F rollback notes

This checkpoint changes function privileges and the body of the secure QR
submit routine. It does not create, update, or delete business or financial
rows during activation.

Do not revoke the two helper grants while secure QR ordering remains enabled:
that would restore the observed `permission denied for function
merge_qr_order_totals` production failure.

If activation fails, PostgreSQL rolls back the whole transaction. Run the
read-only preflight again and retain its output with the failed migration log.

If a tested post-activation regression requires rollback, stop QR ordering,
preserve any already-created QR order, KOT, outbox, and audit evidence, then
restore the prior reviewed `submit_secure_qr_table_order` definition in a
separate approved migration. Do not delete QR records or financial evidence.
