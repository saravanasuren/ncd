-- 012: Activation decoupled from allotment.
-- An investment becomes Active on a maker-checker approval AFTER the money is
-- credited (collection confirmed) — not at series allotment. Allotment is now a
-- later, data-neutral series step. See docs + the activations module.

-- e-Sign is no longer on the critical path; record its completion here instead
-- of driving a status transition.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS esigned_at TIMESTAMPTZ;

-- The activation batch a maker submits and a distinct checker approves. Mirrors
-- allotment_batches; on approval the funded (PendingActivation) apps in the
-- series go Active, their schedule is materialised and incentives accrue.
CREATE TABLE IF NOT EXISTS activation_batches (
  id                  BIGSERIAL PRIMARY KEY,
  series_id           BIGINT NOT NULL REFERENCES series(id),
  notes               TEXT,
  approval_request_id BIGINT,
  status              TEXT NOT NULL DEFAULT 'PendingChecker',
  created_by_user_id  BIGINT REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
