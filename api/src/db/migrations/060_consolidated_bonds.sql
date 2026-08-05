-- One consolidated debenture certificate per (customer, series): the single
-- "filing bond" covering ALL of a customer's issued investments in a series
-- (owner 2026-08-05: multiple subscriptions to a series → one bond, N units).
--
-- Document-only. Each investment keeps its OWN application_lines, interest
-- schedule, redemption and outstanding exactly as before — the interest math is
-- untouched. This table only holds the group's bond serial, assigned lazily on
-- first generation (mirrors applications.bond_serial_no for the per-app bond).
CREATE TABLE IF NOT EXISTS consolidated_bonds (
  id             BIGSERIAL PRIMARY KEY,
  customer_id    BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  series_id      BIGINT NOT NULL REFERENCES series(id),
  bond_serial_no TEXT NOT NULL,
  generated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, series_id)
);
