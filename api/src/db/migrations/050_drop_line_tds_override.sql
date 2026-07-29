-- 050_drop_line_tds_override — reverts 047.
--
-- The ">₹30L for a No-TDS customer → apply TDS?" prompt was first built as a
-- per-INVESTMENT override (047 added application_lines.tds_applicable). The owner
-- decided the answer should mark the WHOLE CUSTOMER as TDS-applicable instead, so
-- the override is now set on customers.tds_applicable and this column is unused.
--
-- Safe to drop: 0 rows ever carried a value (verified on prod before this landed),
-- and computeTds already treats a missing per-line flag as "follow the customer".
ALTER TABLE application_lines DROP COLUMN IF EXISTS tds_applicable;
