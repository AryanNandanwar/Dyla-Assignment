-- Ticket Stampede schema
-- Correctness lives in two uniqueness constraints plus a claim that is
-- atomic in PostgreSQL. Application servers are stateless.

CREATE TABLE IF NOT EXISTS sales (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  total_tickets   INTEGER NOT NULL CHECK (total_tickets > 0),
  mode            TEXT NOT NULL CHECK (mode IN ('naive', 'correct')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per ticket number for a sale. Unsold rows have NULL user_id.
-- Reset pre-inserts total_tickets rows so claim is an UPDATE, not an INSERT
-- of a computed next-number (the classic race).
CREATE TABLE IF NOT EXISTS tickets (
  sale_id         UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  ticket_number   INTEGER NOT NULL,
  user_id         TEXT,
  request_id      TEXT,
  purchased_at    TIMESTAMPTZ,
  PRIMARY KEY (sale_id, ticket_number)
);

-- A request id can hold at most one ticket in a sale.
-- Partial: unsold rows all have NULL request_id, which Postgres would
-- otherwise treat as distinct under a plain UNIQUE constraint anyway.
CREATE UNIQUE INDEX IF NOT EXISTS tickets_sale_request_uidx
  ON tickets (sale_id, request_id)
  WHERE request_id IS NOT NULL;

-- Singleton pointer at the active sale. All seller instances read this.
CREATE TABLE IF NOT EXISTS current_sale (
  lock      CHAR(1) PRIMARY KEY DEFAULT 'X' CHECK (lock = 'X'),
  sale_id   UUID REFERENCES sales(id) ON DELETE SET NULL
);

INSERT INTO current_sale (lock) VALUES ('X') ON CONFLICT DO NOTHING;

-- Shared fault-injection switch so a slow-DB experiment hits every instance.
CREATE TABLE IF NOT EXISTS faults (
  lock         CHAR(1) PRIMARY KEY DEFAULT 'X' CHECK (lock = 'X'),
  db_delay_ms  INTEGER NOT NULL DEFAULT 0 CHECK (db_delay_ms >= 0),
  until_ts     TIMESTAMPTZ
);

INSERT INTO faults (lock) VALUES ('X') ON CONFLICT DO NOTHING;
