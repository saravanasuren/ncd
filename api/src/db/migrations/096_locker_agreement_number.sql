-- A human-readable agreement number for the locker agreement.
--
-- The Schedule printed the raw LockerHub application id — "mu57ytsh53ldvkg" —
-- which the owner rightly called junk on a document a customer signs. Their own
-- template reads "Agreement No :- DIF0000", so this is DIF + a running number.
--
-- Stored, not derived. The agreement is rendered again at every signing stage
-- (hirer 1, each joint hirer, then the authorised signatory) and each stage
-- signs the file the one before it produced. A number computed per render could
-- differ between those renders, which on a signed contract is indefensible.
--
-- Allocated lazily on first render, the same way the bond certificate number is.
ALTER TABLE locker_applications
  ADD COLUMN IF NOT EXISTS agreement_no TEXT;

-- One number, one agreement. A retry that races another render must collide
-- here rather than mint a second number for the same locker.
CREATE UNIQUE INDEX IF NOT EXISTS uq_locker_applications_agreement_no
  ON locker_applications (agreement_no) WHERE agreement_no IS NOT NULL;
