-- Owner 2026-10-27: money received on the 25th is paid in that month's batch;
-- only money from the 26th onwards waits for the next month's batch.
-- Moves the stored setting from the 25 shipped on 2026-10-26 (#485) to 26.
-- Only a value still at 25 is changed, so a value an admin chose is kept.
UPDATE app_settings
   SET value = '26'::jsonb,
       updated_at = now()
 WHERE key = 'interest.next_batch_from_day'
   AND value::jsonb = '25'::jsonb;
