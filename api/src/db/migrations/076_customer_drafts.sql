-- 076 — server-persisted "draft customer": a half-finished New-Customer
-- enrolment (owner 2026-08-22). It used to autosave only to the enroller's
-- browser (localStorage), so nobody else — not even a super-admin — could see a
-- user's in-progress enrolment, and it was lost if they switched machines.
-- Persist it here, one live draft per user, so it survives and a super-admin can
-- see everyone's. `draft` is the wizard's text state (no files); display_name /
-- display_phone are pulled out for the list.
CREATE TABLE IF NOT EXISTS customer_drafts (
  owner_user_id  BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  draft          JSONB NOT NULL,
  display_name   TEXT,
  display_phone  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
