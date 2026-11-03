-- Owner 2026-11-02: the company is "Dhanam Investment and Finance Limited" —
-- it is a PUBLIC limited company and "Private" is not part of its name.
--
-- company_profile.legal_name is NOT NULL and overrides the COMPANY constant in
-- reports/forms/shared.ts, so correcting the constant alone changes nothing on
-- a deployed box: the stored row is what prints on the Subordinate Debt
-- Certificate, the Debenture Certificate, the acknowledgement, the application
-- form, the allotment letter and the locker agreement. This fixes the row.
--
-- Only a row still carrying the incorrect "Private" name is touched, so a name
-- an admin has since set by hand is left alone.
--
-- former_legal_name and tan_holder_name are deliberately NOT touched: both hold
-- "Kiara Microcredit Private Limited", a different company whose own name does
-- contain Private.
--
-- The matching CIN correction (U64920TZ2016PTC031308 -> ...PLC031308) has no
-- column to live in and ships in the same release as a code constant.
UPDATE company_profile
   SET legal_name = 'Dhanam Investment and Finance Limited',
       updated_at = now()
 WHERE id = 1
   AND legal_name = 'Dhanam Investment and Finance Private Limited';
