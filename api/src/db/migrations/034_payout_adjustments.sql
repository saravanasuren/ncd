-- One-time interest payout adjustments (owner 2026-07-23).
--
-- An NCD Manager (or higher) records an Addition or Deduction against ONE
-- investment's NEXT interest settlement, with a mandatory narration. It sits
-- PendingApproval until an Admin/CXO approves it in the approvals queue, then
-- applies once: the next interest batch that pays this application consumes it
-- (status Consumed, stamped with the batch), and it never applies again. A
-- rejected/cancelled batch releases its adjustments back to Approved.
--
-- The adjustment moves NET only — gross and TDS stay pure interest math:
-- gross 1000, TDS 10, net 990, +100 addition -> the bank pays 1090.
CREATE TABLE IF NOT EXISTS payout_adjustments (
  id                  BIGSERIAL PRIMARY KEY,
  application_id      BIGINT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('Addition','Deduction')),
  amount              NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  narration           TEXT NOT NULL,
  -- PendingApproval -> Approved -> Consumed (by a batch)
  --                 -> Rejected | Cancelled
  status              TEXT NOT NULL DEFAULT 'PendingApproval',
  batch_id            BIGINT REFERENCES payout_batches(id),
  approval_request_id BIGINT,
  created_by_user_id  BIGINT REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_padj_app_status ON payout_adjustments(application_id, status);
CREATE INDEX IF NOT EXISTS idx_padj_batch ON payout_adjustments(batch_id);

-- The settled row carries the applied delta, and the net identity WIDENS to
-- include it instead of being dropped: net_amount stays "what the bank pays"
-- (statement matching, WhatsApp amounts and the batch NEFT file all read it),
-- gross/TDS stay pure interest, and the constraint still proves the three agree.
ALTER TABLE disbursement_schedule ADD COLUMN IF NOT EXISTS adjustment_amount NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE disbursement_schedule DROP CONSTRAINT IF EXISTS chk_ds_net;
ALTER TABLE disbursement_schedule ADD CONSTRAINT chk_ds_net
  CHECK (net_amount = gross_amount - tds_amount + adjustment_amount);

-- The maker permission. The seed map grants it too, but live installs only
-- re-sync role_permissions on a full seed — this reaches them at deploy.
-- (admin/super_admin hold it via ALL in the seed; granted here as well so the
-- live DB agrees without a reseed.)
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'payouts:adjust' FROM roles r WHERE r.name IN ('ncd_manager', 'admin', 'super_admin')
ON CONFLICT DO NOTHING;
