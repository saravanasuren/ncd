-- 119 — the consent letter replaces the request letter as the thing a holder
-- signs to release a redemption (owner 2026-11-20).
--
-- Two columns, and both exist because the document asks a question the book
-- cannot answer on its own.
--
-- holding_mode. The consent letter has a "Mode of holding [Demat / Physical]"
-- row. It CANNOT be derived: demat details were only ever synced for about a
-- third of the book (160 of 563 customers, by PAN, in July), so an empty demat
-- record is not evidence of a physical holding — and printing "Physical" on a
-- demat holder's consent would be a false statement on something they sign.
-- The owner's answer, asked directly, was to be prompted at redemption time:
-- "during redemption ask me to fill in if its demat or physical". Required on
-- a new redemption, asked fresh each time (their choice — a second redemption
-- on the same investment asks again rather than carrying an answer forward),
-- and left NULL on everything that already exists.
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS holding_mode TEXT;

-- The 19 redemptions raised since 13 November 2026 are already Approved and in
-- several cases already paid. They get a download button and nothing else —
-- nobody was asked, so their letters print the Mode of holding row blank for
-- whoever collects the signature to tick (owner 2026-11-20). Deliberately not
-- backfilled with a guess.
COMMENT ON COLUMN redemptions.holding_mode IS
  'Demat | Physical — asked at redemption time for the consent letter; NULL on anything raised before 2026-11-20.';

-- WHEN THE CONSENT LETTER STARTS APPLYING is a SETTING, not a column here:
-- 'redemption.consent_letter_from' is declared in packages/shared/src/settings.ts
-- and seeded from there, the same way #530's addressee boundary is. The owner
-- set 13 November 2026 and should be able to move it without a release.
-- Anything raised before it is untouched — no letter, no gate, no download —
-- because those redemptions were settled under the old rules and reopening
-- them would be inventing consent nobody gave.
