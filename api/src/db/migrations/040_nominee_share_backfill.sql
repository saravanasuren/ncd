-- A nominee with no stated share means "everything goes to them", not 0%
-- (owner 2026-07-24, seeing "RUPA BLESSINA KUMAR — 0%" on a sole nominee).
--
-- setNominees now fills unstated shares in — this repairs the rows written
-- before that. Live count at time of writing: 4, every one a sole nominee.
-- Anything with a real share already set is left exactly as it is.

-- Sole nominee, no share stated → the whole holding.
UPDATE nominees nm
   SET share_pct = 100
 WHERE COALESCE(nm.share_pct, 0) = 0
   AND (SELECT count(*) FROM nominees n2 WHERE n2.customer_id = nm.customer_id) = 1;

-- Several nominees and NONE of them stated → split equally. (A group where
-- someone did state a share is left alone: guessing the rest could contradict
-- a deliberate split.)
WITH unstated AS (
  SELECT customer_id, count(*)::numeric AS n
    FROM nominees
   GROUP BY customer_id
  HAVING count(*) > 1 AND bool_and(COALESCE(share_pct, 0) = 0)
)
UPDATE nominees nm
   SET share_pct = round(100.0 / u.n, 2)
  FROM unstated u
 WHERE u.customer_id = nm.customer_id;
