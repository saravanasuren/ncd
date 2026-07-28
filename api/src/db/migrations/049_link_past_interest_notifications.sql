-- 049_link_past_interest_notifications — repair the messages already queued.
--
-- 048 added customer_id / ref_kind / ref_id, but every interest message sent
-- before it has them NULL. Without this the new delivery panel would report
-- batch NEFT-2026-000131 as "384 never sent" — and pressing Notify would
-- message the 92 people who DID get theirs a second time, since the
-- skip-anyone-already-done check is keyed on exactly these columns.
--
-- Matching is deliberately exact, not fuzzy: a row is linked only when the
-- recipient's number AND the name written into the message body both identify
-- one customer the batch actually paid. Two things make that safe:
--   · payload->>'date' IS the batch's payout_date, rendered — so no timezone
--     guessing about when the row happened to be created;
--   · payload->>'name' disambiguates families who share one phone number,
--     which phone-only matching cannot do.
-- Anything that does not match cleanly is left alone rather than guessed at.
--
-- Idempotent: only rows still missing ref_id are touched. Postgres + PGlite.

UPDATE notifications_queue nq
   SET customer_id = m.customer_id,
       ref_kind    = 'payout_batch',
       ref_id      = m.batch_id
  FROM (
    SELECT DISTINCT ON (n.id)
           n.id AS nq_id, c.id AS customer_id, pb.id AS batch_id
      FROM notifications_queue n
      JOIN payout_batches pb
        ON pb.status = 'Paid'
       AND to_char(pb.payout_date, 'DD-Mon-YYYY') = n.payload->>'date'
      JOIN disbursement_schedule ds ON ds.batch_id = pb.id AND ds.status = 'Paid'
      JOIN applications a ON a.id = ds.application_id
      JOIN customers   c ON c.id = a.customer_id
     WHERE n.template = 'interest_paid'
       AND n.ref_id IS NULL
       AND btrim(COALESCE(c.phone, '')) = btrim(n.to_address)
       AND c.full_name = n.payload->>'name'
     ORDER BY n.id, c.id
  ) m
 WHERE nq.id = m.nq_id;
