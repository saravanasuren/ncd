-- 089 — joint hirers on a locker (owner 2026-09-09: "yes build it").
--
-- The approved agreement (08-Sep revision) has THREE hirer blocks and THREE
-- signature columns. NCD has only ever recorded one holder, so a jointly-held
-- locker existed on paper and nowhere else: the second and third holders were
-- written in by hand at the branch and were invisible to every screen, report
-- and roster we have.
--
-- PER APPLICATION, NOT PER CUSTOMER. The same person can hold one locker
-- jointly and another alone, so this cannot hang off the customer. (There IS a
-- `joint_holders` table from the legacy import — one row, one customer, no
-- locker — and it belongs to the NCD investment form. Reusing it here would
-- have tied two unrelated things together.)
--
-- POSITIONS 2 AND 3 ONLY. Hirer 1 is the applicant and is never stored here:
-- two answers to "who is the primary holder" is worse than one. The agreement
-- has three blocks and three signature columns, so a fourth could be captured
-- but never printed or signed — the CHECK refuses it rather than letting it be
-- silently dropped at the edge.
--
-- Keyed on (application, position) so a re-send CORRECTS a hirer rather than
-- duplicating them, which is LockerHub's upsert rule for the same array.
--
-- Idempotent; Postgres + PGlite.

CREATE TABLE IF NOT EXISTS locker_application_hirers (
  lockerhub_application_id  TEXT     NOT NULL,
  position                  SMALLINT NOT NULL,

  full_name                 TEXT     NOT NULL,
  phone                     TEXT,
  email                     TEXT,
  dob                       DATE,
  pan                       TEXT,
  -- LAST FOUR ONLY, and the CHECK is the guard rather than a convention: a
  -- full Aadhaar must never be stored here or pushed onward (Aadhaar Act 2016
  -- s.29). LockerHub refuses twelve digits outright and so do we.
  aadhaar_last4             TEXT,
  -- One free-text line, exactly as customers.address and nominees.address are.
  -- Splitting it into their four parts would invent structure we do not have.
  address                   TEXT,

  created_by_user_id        BIGINT REFERENCES users(id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (lockerhub_application_id, position),
  CONSTRAINT locker_hirer_position_ck    CHECK (position IN (2, 3)),
  CONSTRAINT locker_hirer_aadhaar4_ck    CHECK (aadhaar_last4 IS NULL OR aadhaar_last4 ~ '^[0-9]{4}$')
);

CREATE INDEX IF NOT EXISTS idx_locker_hirers_app ON locker_application_hirers (lockerhub_application_id);
