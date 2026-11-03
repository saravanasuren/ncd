-- Owner 2026-11-02: "rejecting should vanish it and pending approval shall
-- remain pending and wait until it gets approved."
--
-- Rejecting a subscription approval used to be emit-only, so the investment kept
-- the status PendingApproval for ever. With no Pending request left it appeared
-- in nobody's approval queue, yet every count of PendingApproval still included
-- it — the owner found one of their own investments missing from the queue and
-- asked why. The code path is fixed alongside this migration; this cleans up the
-- records already stranded.
--
-- Caught ONLY where every approval request for the investment is terminal and at
-- least one was Rejected. An investment with a still-Pending request is left
-- exactly as it is: those are the ones that must keep waiting.
--
-- Status only — nothing is deleted, and 'Rejected' is a terminal application
-- status that OUTSTANDING_APPLICATION_STATUSES already excludes, so the money
-- stops counting while the record and its audit trail stay.

INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_data, after_data, created_at)
SELECT NULL, 'application.rejected', 'applications', a.id::text,
       jsonb_build_object('status', a.status),
       jsonb_build_object('status', 'Rejected', 'via', 'migration 105 — approval was rejected but the investment was left pending',
                          'rejected_requests', (SELECT jsonb_agg(ar.request_no ORDER BY ar.request_no)
                                                  FROM approval_requests ar
                                                 WHERE ar.entity_type = 'applications' AND ar.entity_id = a.id::text
                                                   AND ar.status = 'Rejected')),
       now()
  FROM applications a
 WHERE a.status = 'PendingApproval'
   AND EXISTS (SELECT 1 FROM approval_requests ar
                WHERE ar.entity_type = 'applications' AND ar.entity_id = a.id::text
                  AND ar.request_type = 'subscription' AND ar.status = 'Rejected')
   AND NOT EXISTS (SELECT 1 FROM approval_requests ar
                    WHERE ar.entity_type = 'applications' AND ar.entity_id = a.id::text
                      AND ar.status = 'Pending');

UPDATE applications a
   SET status = 'Rejected', updated_at = now()
 WHERE a.status = 'PendingApproval'
   AND EXISTS (SELECT 1 FROM approval_requests ar
                WHERE ar.entity_type = 'applications' AND ar.entity_id = a.id::text
                  AND ar.request_type = 'subscription' AND ar.status = 'Rejected')
   AND NOT EXISTS (SELECT 1 FROM approval_requests ar
                    WHERE ar.entity_type = 'applications' AND ar.entity_id = a.id::text
                      AND ar.status = 'Pending');
