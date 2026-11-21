-- 121 — the redemption letters become configurable (owner 2026-11-21:
-- "make these all UI config - this 3 different letter and its dates when from
-- and to all completely make it UI config"; asked, they chose ALL FOUR ranges
-- and everything editable, body text included).
--
-- WHAT WAS HARD-CODED. Which letter a date produces was split across three
-- places that all had to agree: `redemption.letter_dhanam_from` (a setting),
-- COMPANY_RENAMED_ON (a constant in shared.ts, shared with bond certificates)
-- and `redemption.consent_letter_from` (another setting). The company names,
-- the "Formerly" line and both addresses were string literals in
-- redemption-letter-addressee.ts. Moving a boundary meant a release.
--
-- THIS TABLE HOLDS OVERRIDES ONLY, NOT THE LETTERS THEMSELVES. The four
-- built-in blocks stay in code and remain the base; a row here changes one of
-- them, keyed by `slug`. Three reasons that beats seeding four rows:
--
--   · nothing is written by this migration, so deploying it cannot alter a
--     single letter;
--   · the fallback is exercised from the first request rather than being dead
--     code nobody finds out is broken until a row goes missing;
--   · a row that is deleted, or saved with a date that matches nothing, prints
--     the current letter instead of a blank one. A letter must never fail to
--     render because somebody mis-typed a date.
--
-- A slug the code does not know is a NEW range the owner added — the next
-- company rename needs no release.
--
-- NEITHER SETTING HAS A STORED ROW IN PRODUCTION (checked 2026-11-21: only
-- redemption.premature_penalty is stored), so both have always run on their
-- code defaults and there is no configured value to carry over.
CREATE TABLE IF NOT EXISTS letter_templates (
  id                 BIGSERIAL PRIMARY KEY,
  -- Stable identity. 'kiara' | 'dhanam-private' | 'dhanam-limited' |
  -- 'consent' override a built-in; anything else is an owner-added range.
  slug               TEXT NOT NULL UNIQUE,
  -- 'request' = Request for Redemption, addressed to the Board, with a
  -- letterhead block. 'consent' = Consent for Premature Redemption, which is
  -- written BY the holder and so has no addressee block at all.
  kind               TEXT NOT NULL CHECK (kind IN ('request', 'consent')),
  label              TEXT NOT NULL,
  -- Inclusive. NULL from = from the beginning, NULL to = open-ended.
  valid_from         DATE,
  valid_to           DATE,
  legal_name         TEXT,
  formerly           TEXT,
  off_address        JSONB,
  corp_office        JSONB,
  -- The editable wording, by slot. NULL or {} = the built-in text, which is
  -- what every letter uses until somebody deliberately changes one.
  body               JSONB,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by_user_id BIGINT REFERENCES users(id),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE letter_templates IS
  'Overrides for the redemption letters: which date range produces which letter, and what it says. Empty table = the built-in letters, unchanged.';
COMMENT ON COLUMN letter_templates.slug IS
  'kiara | dhanam-private | dhanam-limited | consent override a built-in block; any other slug is an owner-added range.';
COMMENT ON COLUMN letter_templates.body IS
  'Editable wording by slot. NULL or {} means use the built-in text for that letter.';
