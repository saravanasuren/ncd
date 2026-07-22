-- 031_locker_deposit_links — an NCD investment can back one or more LOCKER
-- deposits (owner spec 2026-07-22).
--
-- The investment is NEVER split: a ₹25L NCD linked to a ₹3L XL locker stays ONE
-- ₹25L investment. Each link is a CLAIM of `linked_amount` against it, so:
--   locker portion = SUM(active links)          (₹3L  — what the locker agreement shows)
--   free NCD       = outstanding − linked       (₹22L — redeemable)
-- The outstanding book still counts the investment once (₹25L).
--
-- Multiple lockers per investment are allowed; the service enforces
-- SUM(active linked_amount) <= the investment's outstanding.

CREATE TABLE IF NOT EXISTS locker_deposit_links (
  id                        BIGSERIAL PRIMARY KEY,
  application_id            BIGINT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  lockerhub_application_id  TEXT NOT NULL,           -- LockerHub's locker application id
  locker_no                 TEXT,
  locker_size               TEXT,
  linked_amount             NUMERIC(14,2) NOT NULL CHECK (linked_amount > 0),
  status                    TEXT NOT NULL DEFAULT 'active',  -- active | released
  linked_by_user_id         BIGINT REFERENCES users(id),
  linked_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_by_user_id       BIGINT REFERENCES users(id),
  released_at               TIMESTAMPTZ,
  released_reason           TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_locker_links_app
  ON locker_deposit_links (application_id) WHERE status = 'active';

-- A given locker can be backed by only ONE live link at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_locker_links_locker_active
  ON locker_deposit_links (lockerhub_application_id) WHERE status = 'active';
