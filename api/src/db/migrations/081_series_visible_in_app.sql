-- 081_series_visible_in_app — which series the customer-facing apps may offer
-- (owner 2026-08-29: "there are 2 series actively opened. I need only NCD 29 to
-- be visible to dhanamfin application").
--
-- /integration/series/active returned EVERY series with status = 'Open', so
-- opening a series published it to customers as a side effect. NCD BOND was
-- opened on 28 Aug and was immediately on offer in the app, which nobody
-- decided.
--
-- Opt-IN by design (owner's choice): a new series is invisible until someone
-- deliberately publishes it, and publishing goes through Admin/CXO approval.
-- Forgetting to publish costs a delay; publishing by accident puts a product in
-- front of customers.
ALTER TABLE series ADD COLUMN IF NOT EXISTS visible_in_app BOOLEAN NOT NULL DEFAULT FALSE;

-- The starting state the owner asked for, stated outright rather than derived.
-- The obvious rule — "a series already taking money stays visible" — was checked
-- against production first and is WRONG here: NCD BOND already holds 9
-- investments, so that rule would have kept publishing exactly the series this
-- change exists to hide. NCD_29 is live and selling, so it must not go dark
-- while an approval round-trips; everything else starts hidden by the default
-- above, including the 23 Allotted series, which /series/active never returned
-- anyway because it filters on status.
UPDATE series SET visible_in_app = TRUE WHERE code = 'NCD_29' AND status = 'Open';
