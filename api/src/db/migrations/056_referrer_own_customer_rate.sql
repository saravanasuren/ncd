-- Restate referrer incentives that were dropped to the repeat rate on an
-- agent's OWN customer (owner rule 2026-08-03).
--
-- The engine decided "new vs repeat" from `customer_was_new_at_creation`, which
-- records whether the customer already had an application ROW when this one was
-- keyed in. That is a question about row order, and it produced two wrong
-- answers on the live book:
--
--   * Same-day splits. A customer putting money into several debentures on one
--     day paid the full rate on the first leg and the repeat rate on the rest —
--     J SINDHU, 30 Jul, Rs 35L + Rs 35L through the same referrer, Rs 70,000
--     and Rs 8,750.
--   * The go-live tail. Applications keyed in after the wealth import found the
--     customer already loaded minutes earlier by that same agent's own
--     business, and dropped to the repeat rate.
--
-- The repeat rate is for exactly one case: somebody ELSE'S customer, brought
-- back by a different referrer. An agent's own customer reinvesting is still
-- their money.
--
-- Bounded on purpose: referrer rows only, UNPAID only, and only where the
-- referrer on the application is the one who introduced the customer. Paid
-- history is never rewritten. On the book at the time of writing this is 36
-- rows, Rs 56,875 -> Rs 4,55,000; one row (K.Devika, APP-2026-001057) is a
-- genuinely different referrer and is deliberately left alone.
--
-- Matching is on the normalised name, the same comparison
-- incentives/referrer.ts makes first. That module also falls back to resolving
-- both spellings to a payee, which SQL here does not attempt — anything only
-- that fallback would catch keeps its current value and is correct from the
-- next accrual onwards.
WITH rate AS (
  SELECT
    coalesce((SELECT value->>'mode' FROM app_settings
               WHERE key = 'incentive.referrer_new_with_referrer'), 'pct') AS mode,
    coalesce((SELECT (value->>'value')::numeric FROM app_settings
               WHERE key = 'incentive.referrer_new_with_referrer'), 2.0) AS value
),
origin AS (
  SELECT a.id AS application_id, a.total_amount,
         nullif(btrim(a.referred_by_text), '') AS app_ref,
         coalesce(
           (SELECT nullif(btrim(x.referred_by_text), '') FROM applications x
             WHERE x.customer_id = a.customer_id
               AND nullif(btrim(x.referred_by_text), '') IS NOT NULL
             ORDER BY x.created_at, x.id LIMIT 1),
           (SELECT nullif(btrim(c.referred_by_text), '') FROM customers c
             WHERE c.id = a.customer_id)
         ) AS origin_ref
    FROM applications a
)
UPDATE incentive_accruals ia
   SET rate_mode  = rate.mode,
       rate_value = rate.value,
       amount     = round(CASE WHEN rate.mode = 'flat' THEN rate.value
                               ELSE o.total_amount * rate.value / 100 END, 2)
  FROM origin o, rate
 WHERE ia.application_id = o.application_id
   AND ia.matrix_cell    = 'referrer'
   AND ia.paid_at IS NULL
   AND o.app_ref    IS NOT NULL
   AND o.origin_ref IS NOT NULL
   AND upper(regexp_replace(o.app_ref,    '[^a-zA-Z0-9]', '', 'g'))
     = upper(regexp_replace(o.origin_ref, '[^a-zA-Z0-9]', '', 'g'))
   AND (ia.rate_mode <> rate.mode OR ia.rate_value <> rate.value);
