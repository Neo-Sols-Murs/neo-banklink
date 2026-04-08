import type { DbTransaction, EBTransaction, EBCreditDebit } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCounterparty(tx: EBTransaction): { name: string | null; iban: string | null } {
  // For debits (outgoing), the counterparty is the creditor.
  // For credits (incoming), the counterparty is the debtor.
  const party = tx.credit_debit_indicator === "DBIT" ? tx.creditor : tx.debtor;
  const account = tx.credit_debit_indicator === "DBIT" ? tx.creditor_account : tx.debtor_account;
  return {
    name: party?.name ?? null,
    iban: account?.iban ?? account?.bban ?? account?.other ?? null,
  };
}

function signedAmount(tx: EBTransaction): string {
  const raw = tx.transaction_amount.amount;
  return tx.credit_debit_indicator === "DBIT" ? `-${raw}` : raw;
}


function txToRow(accountId: string, tx: EBTransaction, id: string): Omit<DbTransaction, "created_at" | "updated_at"> {
  const { name, iban } = parseCounterparty(tx);
  return {
    id,
    account_id: accountId,
    status: tx.status,
    amount: signedAmount(tx),
    currency: tx.transaction_amount.currency,
    credit_debit: tx.credit_debit_indicator as EBCreditDebit,
    booking_date: tx.booking_date ?? null,
    value_date: tx.value_date ?? null,
    description: tx.remittance_information?.join(" / ") ?? null,
    counterparty_name: name,
    counterparty_iban: iban,
    airtable_record_id: null,
    raw_json: JSON.stringify(tx),
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Upsert BOOK transactions only (PDNG have no stable ID and are handled separately).
 * Uses entry_reference as the primary key — it is present and stable for all BOOK transactions.
 */
export async function upsertTransactions(
  db: D1Database,
  accountId: string,
  transactions: EBTransaction[]
): Promise<void> {
  const bookTxs = transactions.filter((t) => t.status === "BOOK" && t.entry_reference !== null);
  if (bookTxs.length === 0) return;

  const statements: D1PreparedStatement[] = [];
  for (const tx of bookTxs) {
    const row = txToRow(accountId, tx, tx.entry_reference as string);
    statements.push(
      db
        .prepare(
          `INSERT INTO transactions
             (id, account_id, status, amount, currency, credit_debit,
              booking_date, value_date, description, counterparty_name,
              counterparty_iban, airtable_record_id, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             status       = excluded.status,
             booking_date = excluded.booking_date,
             value_date   = excluded.value_date,
             description  = excluded.description,
             raw_json     = excluded.raw_json,
             updated_at   = datetime('now')`
        )
        .bind(
          row.id, row.account_id, row.status, row.amount, row.currency,
          row.credit_debit, row.booking_date, row.value_date, row.description,
          row.counterparty_name, row.counterparty_iban, row.airtable_record_id, row.raw_json
        )
    );
  }

  for (let i = 0; i < statements.length; i += 100) {
    await db.batch(statements.slice(i, i + 100));
  }
}

/**
 * Insert fresh PDNG transactions using synthetic UUIDs as IDs.
 * Call this only after deletePendingTransactions().
 */
export async function insertPendingTransactions(
  db: D1Database,
  accountId: string,
  transactions: EBTransaction[]
): Promise<void> {
  const pdngTxs = transactions.filter((t) => t.status === "PDNG");
  if (pdngTxs.length === 0) return;

  const statements: D1PreparedStatement[] = [];
  for (const tx of pdngTxs) {
    const row = txToRow(accountId, tx, crypto.randomUUID());
    statements.push(
      db
        .prepare(
          `INSERT INTO transactions
             (id, account_id, status, amount, currency, credit_debit,
              booking_date, value_date, description, counterparty_name,
              counterparty_iban, airtable_record_id, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          row.id, row.account_id, row.status, row.amount, row.currency,
          row.credit_debit, row.booking_date, row.value_date, row.description,
          row.counterparty_name, row.counterparty_iban, row.airtable_record_id, row.raw_json
        )
    );
  }

  for (let i = 0; i < statements.length; i += 100) {
    await db.batch(statements.slice(i, i + 100));
  }
}

/** Return Airtable record IDs for all PDNG rows that have been pushed. */
export async function getPendingAirtableIds(db: D1Database, accountId: string): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT airtable_record_id FROM transactions
       WHERE account_id = ? AND status = 'PDNG' AND airtable_record_id IS NOT NULL`
    )
    .bind(accountId)
    .all<{ airtable_record_id: string }>();
  return result.results.map((r) => r.airtable_record_id);
}

/** Delete all PDNG rows for an account. */
export async function deletePendingTransactions(db: D1Database, accountId: string): Promise<void> {
  await db
    .prepare(`DELETE FROM transactions WHERE account_id = ? AND status = 'PDNG'`)
    .bind(accountId)
    .run();
}

/**
 * Return all transactions that have not yet been pushed to Airtable,
 * ordered oldest-first so Airtable reflects chronological order.
 */
export async function getUnsynced(db: D1Database, accountId: string, limit: number): Promise<DbTransaction[]> {
  const result = await db
    .prepare(
      `SELECT * FROM transactions
       WHERE account_id = ? AND airtable_record_id IS NULL
       ORDER BY booking_date ASC, created_at ASC
       LIMIT ?`
    )
    .bind(accountId, limit)
    .all<DbTransaction>();
  return result.results;
}

export async function countUnsynced(db: D1Database, accountId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) as n FROM transactions WHERE account_id = ? AND airtable_record_id IS NULL`)
    .bind(accountId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}


/** Store Airtable record IDs for a batch of transactions. */
export async function setAirtableRecordIds(
  db: D1Database,
  pairs: Array<{ txId: string; airtableId: string }>
): Promise<void> {
  for (const { txId, airtableId } of pairs) {
    await db
      .prepare(`UPDATE transactions SET airtable_record_id = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(airtableId, txId)
      .run();
  }
  console.log(`[db] Wrote ${pairs.length} airtable_record_id(s) to D1`);
}


// ---------------------------------------------------------------------------
// Status / aggregate queries
// ---------------------------------------------------------------------------

export interface AccountStats {
  account_id: string;
  total: number;
  booked: number;
  pending: number;
  unsynced: number;
}

/** Return per-account transaction counts from D1. */
export async function getAccountStats(db: D1Database): Promise<AccountStats[]> {
  const result = await db
    .prepare(
      `SELECT account_id,
         COUNT(*) as total,
         SUM(CASE WHEN status='BOOK' THEN 1 ELSE 0 END) as booked,
         SUM(CASE WHEN status='PDNG' THEN 1 ELSE 0 END) as pending,
         SUM(CASE WHEN airtable_record_id IS NULL THEN 1 ELSE 0 END) as unsynced
       FROM transactions
       GROUP BY account_id`
    )
    .all<AccountStats>();
  return result.results;
}

/** Return the latest booking_date among BOOK transactions for an account. */
export async function getLatestBookedDate(
  db: D1Database,
  accountId: string
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT MAX(booking_date) as latest FROM transactions
       WHERE account_id = ? AND status = 'BOOK'`
    )
    .bind(accountId)
    .first<{ latest: string | null }>();
  return row?.latest ?? null;
}
