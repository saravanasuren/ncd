-- 090_locker_agreement_esign — NCD-run e-sign for the locker agreement.
--
-- The locker agreement can now be e-signed on OUR own copy via OUR Digio
-- (owner 2026-09-10), so the customer signs the agreement that carries the rent,
-- and the company's authorised signatory (the CEO) can counter-sign the SAME
-- document later. Each signature is a digio_signing_sessions row — same table,
-- poller and completion path the authorised-user consent already reuses — tied
-- back to the locker_agreement_signings row it belongs to.
--
-- document_type routes completion: 'locker_agreement' (customer) and
-- 'locker_agreement_ceo' (authorised signatory). application_id is already
-- nullable (072); a locker agreement has none.
ALTER TABLE digio_signing_sessions
  ADD COLUMN IF NOT EXISTS locker_agreement_signing_id BIGINT
  REFERENCES locker_agreement_signings(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_digio_sessions_locker_agreement
  ON digio_signing_sessions (locker_agreement_signing_id);
