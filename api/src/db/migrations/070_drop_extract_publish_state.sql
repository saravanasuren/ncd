-- Remove the NOTWO integration (owner 2026-08-12). extract_publish_state was
-- the watermark for the on-change SharePoint dump publisher that fed Notwo
-- (migration 056). The publisher, the dump builder, and the export API are all
-- gone, so this table has no remaining reader — drop it. No other feature uses
-- it (the SharePoint client + backup uploads are untouched and keep working).
DROP TABLE IF EXISTS extract_publish_state;
