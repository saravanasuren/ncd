-- 062_locker_pricing — NCD-owned locker deposit + rent, per size.
--
-- Owner 2026-08-07: locker deposit/rent are no longer hardcoded (or left to
-- LockerHub) — NCD owns them and they are UI-configurable per size in Masters.
-- Deposit values seeded from the owner (XL 60k / L 40k / M 20k); rent is left
-- NULL to be set in the UI. NCD sends these on locker-application create;
-- LockerHub honouring them is a separate contract change (LOCKERHUB-CR).
-- Idempotent; Postgres + PGlite.

CREATE TABLE IF NOT EXISTS locker_pricing (
  size            TEXT PRIMARY KEY,
  deposit_amount  NUMERIC(14,2),
  annual_rent     NUMERIC(14,2),
  updated_by_user_id BIGINT REFERENCES users(id),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO locker_pricing (size, deposit_amount) VALUES
  ('XL', 60000),
  ('L',  40000),
  ('M',  20000)
ON CONFLICT (size) DO NOTHING;
