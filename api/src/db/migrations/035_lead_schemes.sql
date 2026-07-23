-- Lead "Interested scheme" options become payout styles, not product names
-- (owner 2026-07-23): Monthly / Cumulative / Double / Annual.
--
-- The settings seed only INSERTs on conflict-nothing, so live installs keep
-- whatever value they hold — this migration is what actually changes prod.
-- Historical leads keep their stored text (NCD / Fixed Deposit / …); only the
-- dropdown options change. The list stays admin-editable in Settings.
UPDATE app_settings
   SET value = '["Monthly","Cumulative","Double","Annual"]'::jsonb,
       updated_at = now()
 WHERE key = 'customers.lead_interested_schemes';
