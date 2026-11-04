-- Owner 2026-11-03: "u should not assign a customer code whose code is already
-- with a staff and the existing one change the customers code."
--
-- Staff carry codes in users.code and customers in customers.customer_code,
-- both DHN####, and the two sequences count independently — so one code can
-- name two different people. Seven were already doubly held when this was
-- written. One of them surfaced because 26 customers name that staff member as
-- their referrer and all 26 began displaying an unrelated customer instead.
--
-- The CUSTOMER moves, never the staff member. Nothing keys on a customer code
-- (no foreign key references it; identity is the row id), while 142 customers
-- name a staff code as their referrer, so staff codes have to stay put.
--
-- Prevention lives in lib/sequences.ts, which now steps the customer run past
-- anything staff hold. This migration only clears what is already collided.
--
-- Checked before writing: none of the seven has a locker (so none of this has
-- been published to LockerHub), none has a bond certificate, and the bond
-- certificate does not print a customer code in any case. Two have had an
-- ACKNOWLEDGEMENT issued, which does print it — those two are reported by the
-- post-check so the acknowledgement can be regenerated afterwards.

DO $$
DECLARE
  r          record;
  fmt        text;
  width      int;
  candidate  text;
  seq        bigint;
  moved      int := 0;
BEGIN
  SELECT COALESCE((SELECT value #>> '{}' FROM app_settings WHERE key = 'numbering.customer_format'), 'DHN{seq:4}')
    INTO fmt;
  -- Pull the zero-pad width out of the configured format, e.g. DHN{seq:4} -> 4.
  width := COALESCE(NULLIF((regexp_match(fmt, '\{seq:(\d+)\}'))[1], '')::int, 4);

  FOR r IN
    SELECT c.id, c.customer_code, c.full_name
      FROM users u JOIN roles rr ON rr.id = u.role_id
      JOIN customers c ON upper(c.customer_code) = upper(u.code)
     WHERE rr.name <> 'customer' AND u.code IS NOT NULL
     ORDER BY c.customer_code
  LOOP
    -- Walk forward from the current high-water mark until a code is free of
    -- BOTH tables. Deliberately not MAX()+1 in a single shot: the next number
    -- may itself be a staff code, and several of them sit close together.
    candidate := NULL;
    SELECT COALESCE(max(NULLIF(regexp_replace(customer_code, '^DHN', ''), '')::bigint), 0)
      INTO seq FROM customers WHERE customer_code ~ '^DHN[0-9]+$';
    LOOP
      seq := seq + 1;
      candidate := 'DHN' || lpad(seq::text, width, '0');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM customers x WHERE upper(x.customer_code) = candidate)
            AND NOT EXISTS (SELECT 1 FROM users u2 JOIN roles r2 ON r2.id = u2.role_id
                             WHERE r2.name <> 'customer' AND upper(COALESCE(u2.code,'')) = candidate);
    END LOOP;

    INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_data, after_data, created_at)
    VALUES (NULL, 'customer.code_reassigned', 'customers', r.id::text,
            jsonb_build_object('customer_code', r.customer_code),
            jsonb_build_object('customer_code', candidate,
              'note', 'Owner 2026-11-03: a customer must not hold a code a staff member already has. The customer moves; the staff code stays, because 142 customers name staff codes as their referrer.'),
            now());

    UPDATE customers SET customer_code = candidate, updated_at = now() WHERE id = r.id;
    moved := moved + 1;
  END LOOP;

  -- ── Post-checks ─────────────────────────────────────────────────────────
  IF EXISTS (
    SELECT 1 FROM users u JOIN roles rr ON rr.id = u.role_id
      JOIN customers c ON upper(c.customer_code) = upper(u.code)
     WHERE rr.name <> 'customer' AND u.code IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'post-check: a customer still holds a staff code';
  END IF;

  IF EXISTS (SELECT customer_code FROM customers GROUP BY customer_code HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'post-check: customer codes are no longer unique';
  END IF;

  RAISE NOTICE 'migration 110: reassigned % customer code(s) clear of staff codes', moved;
END $$;

-- Anyone whose acknowledgement already carries the old code. The
-- acknowledgement prints "Customer Code", so these need regenerating:
--   node dist/scripts/regenerate-acknowledgements.js --application <no> --commit
SELECT c.customer_code AS new_code, c.full_name, a.application_no
  FROM customers c JOIN applications a ON a.customer_id = c.id
  JOIN audit_log al ON al.entity_type = 'customers' AND al.entity_id = c.id::text
                   AND al.action = 'customer.code_reassigned'
 WHERE a.acknowledgment_generated_at IS NOT NULL
 ORDER BY c.customer_code;
