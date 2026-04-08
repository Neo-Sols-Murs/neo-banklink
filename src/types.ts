// ---------------------------------------------------------------------------
// Enable Banking API types
// ---------------------------------------------------------------------------

export interface EBTransactionAmount {
  amount: string;
  currency: string;
}

export interface EBParty {
  name?: string;
}

export interface EBAccount {
  iban?: string;
  bban?: string;
  other?: string;
}

export type EBTransactionStatus = "BOOK" | "PDNG";
export type EBCreditDebit = "CRDT" | "DBIT";

export interface EBTransaction {
  transaction_id: string | null;
  entry_reference: string | null;  // stable ID for BOOK; null for PDNG
  transaction_amount: EBTransactionAmount;
  credit_debit_indicator: EBCreditDebit;
  status: EBTransactionStatus;
  booking_date?: string;
  value_date?: string;
  transaction_date?: string;
  remittance_information?: string[];
  creditor?: EBParty;
  debtor?: EBParty;
  creditor_account?: EBAccount;
  debtor_account?: EBAccount;
  reference_number?: string;
}

export interface EBTransactionsResponse {
  transactions: EBTransaction[];
  continuation_key?: string;
}

// ---------------------------------------------------------------------------
// Internal DB row type
// ---------------------------------------------------------------------------

export interface DbTransaction {
  id: string;
  account_id: string;
  status: EBTransactionStatus;
  amount: string;
  currency: string;
  credit_debit: EBCreditDebit;
  booking_date: string | null;
  value_date: string | null;
  description: string | null;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  airtable_record_id: string | null;
  raw_json: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Cloudflare Worker environment bindings
// ---------------------------------------------------------------------------

export interface Env {
  DB: D1Database;
  KV: KVNamespace;

  ENABLE_BANKING_APP_ID: string;
  ENABLE_BANKING_PRIVATE_KEY: string;  // PEM-encoded RSA private key
  ENABLE_BANKING_SESSION_ID: string;
  ENABLE_BANKING_ACCOUNT_IDS: string;  // JSON array: string[]

  AIRTABLE_API_KEY: string;
  AIRTABLE_BASE_ID: string;
  AIRTABLE_TABLE_NAME: string;

  ADMIN_SECRET: string;

  SYNC_QUEUE: Queue;
}
