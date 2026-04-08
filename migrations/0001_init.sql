CREATE TABLE transactions (
  id                  TEXT PRIMARY KEY,  -- Enable Banking transaction_id
  account_id          TEXT NOT NULL,
  status              TEXT NOT NULL,     -- 'BOOK' | 'PDNG'
  amount              TEXT NOT NULL,     -- stored as string to preserve precision
  currency            TEXT NOT NULL,
  credit_debit        TEXT NOT NULL,     -- 'CRDT' | 'DBIT'
  booking_date        TEXT,              -- ISO date YYYY-MM-DD (NULL for pending)
  value_date          TEXT,
  description         TEXT,              -- remittance_information joined with ' / '
  counterparty_name   TEXT,
  counterparty_iban   TEXT,
  airtable_record_id  TEXT,              -- NULL until pushed to Airtable
  raw_json            TEXT NOT NULL,     -- full API response for future use
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_tx_pending  ON transactions(status) WHERE status = 'PDNG';
CREATE INDEX idx_tx_unsync   ON transactions(airtable_record_id) WHERE airtable_record_id IS NULL;
CREATE INDEX idx_tx_account  ON transactions(account_id, booking_date);
