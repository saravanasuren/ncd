-- Segregation of duties (review 2026-07-21): an external agent must not be able
-- to APPROVE KYC on customers they enrolled. Revoke kyc:verify / kyc:reject from
-- the agent role. (The seed map DEFAULT_ROLE_PERMISSIONS is also updated, but
-- that only re-syncs on a full seed — this migration fixes already-live installs.)
DELETE FROM role_permissions
 WHERE permission IN ('kyc:verify', 'kyc:reject')
   AND role_id = (SELECT id FROM roles WHERE name = 'agent');
