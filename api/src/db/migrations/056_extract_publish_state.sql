-- Drives the on-change SharePoint extract publisher (owner 2026-08-03).
-- One row. `last_change_seen` is the book's newest change timestamp we have
-- already published for; the worker republishes when the book moves past it and
-- the burst has settled. Singleton by CHECK so there is only ever one state row.
CREATE TABLE IF NOT EXISTS extract_publish_state (
  id                SMALLINT PRIMARY KEY DEFAULT 1,
  last_change_seen  TIMESTAMPTZ,
  last_published_at TIMESTAMPTZ,
  CONSTRAINT extract_publish_state_singleton CHECK (id = 1)
);
INSERT INTO extract_publish_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
