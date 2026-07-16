-- 010_lockerhub_intent — funded-subscription + import idempotency key.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS lockerhub_intent_no TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_intent ON applications(lockerhub_intent_no) WHERE lockerhub_intent_no IS NOT NULL;
