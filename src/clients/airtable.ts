import type { DbTransaction } from "../types";

const BASE_URL = "https://api.airtable.com/v0";
const BATCH_SIZE = 10; // Airtable max records per create request
const RATE_LIMIT_DELAY_MS = 250; // ~4 req/s, safely under the 5 req/s limit

// ---------------------------------------------------------------------------
// Airtable field mapping
// ---------------------------------------------------------------------------

function toAirtableFields(tx: DbTransaction): Record<string, unknown> {
  return {
    "Transaction ID": tx.id,
    Date: tx.booking_date,
    Amount: parseFloat(tx.amount),
    Currency: tx.currency,
    Description: tx.description ?? "",
    "Counterparty Name": tx.counterparty_name ?? "",
    "Counterparty IBAN": tx.counterparty_iban ?? "",
    Status: tx.status,
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class AirtableClient {
  private readonly apiKey: string;
  private readonly baseId: string;
  private readonly tableName: string;

  constructor(apiKey: string, baseId: string, tableName: string) {
    this.apiKey = apiKey;
    this.baseId = baseId;
    this.tableName = tableName;
  }

  private get tableUrl(): string {
    return `${BASE_URL}/${this.baseId}/${encodeURIComponent(this.tableName)}`;
  }

  private authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }

  /**
   * Create records in Airtable for a batch of transactions.
   * Calls `onCreated` with (transactionId, airtableRecordId) for each record
   * immediately after each batch so that D1 is updated before the next batch.
   */
  async createRecords(
    transactions: DbTransaction[],
    onBatchCreated: (pairs: Array<{ txId: string; airtableId: string }>) => Promise<void>
  ): Promise<void> {
    for (let i = 0; i < transactions.length; i += BATCH_SIZE) {
      const chunk = transactions.slice(i, i + BATCH_SIZE);

      const response = await fetch(this.tableUrl, {
        method: "POST",
        headers: this.authHeader(),
        body: JSON.stringify({
          records: chunk.map((tx) => ({ fields: toAirtableFields(tx) })),
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Airtable create error ${response.status}: ${body}`);
      }

      const data = (await response.json()) as { records: { id: string }[] };

      // Persist all Airtable record IDs back to D1 in one batch write.
      const pairs = chunk.flatMap((tx, j) => {
        const record = data.records[j];
        return record ? [{ txId: tx.id, airtableId: record.id }] : [];
      });
      await onBatchCreated(pairs);

      if (i + BATCH_SIZE < transactions.length) {
        await sleep(RATE_LIMIT_DELAY_MS);
      }
    }
  }

  /**
   * Delete Airtable records by record ID (max 10 per request).
   */
  async deleteRecords(recordIds: string[]): Promise<void> {
    for (let i = 0; i < recordIds.length; i += BATCH_SIZE) {
      const chunk = recordIds.slice(i, i + BATCH_SIZE);
      const params = chunk.map((id) => `records[]=${encodeURIComponent(id)}`).join("&");
      const response = await fetch(`${this.tableUrl}?${params}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });

      if (!response.ok) {
        const body = await response.text();
        if (response.status === 404 && chunk.length > 1) {
          // Batch 404: at least one record was manually deleted. Retry one-by-one
          // so the remaining records still get cleaned up.
          console.warn(`[airtable] Batch delete 404 — retrying ${chunk.length} records individually`);
          for (const id of chunk) {
            const r = await fetch(`${this.tableUrl}?records[]=${encodeURIComponent(id)}`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${this.apiKey}` },
            });
            if (!r.ok && r.status !== 404) {
              const rb = await r.text();
              throw new Error(`Airtable delete error ${r.status}: ${rb}`);
            }
            if (r.status === 404) {
              console.warn(`[airtable] Record ${id} not found in Airtable — already deleted manually, skipping`);
            }
          }
        } else if (response.status === 404) {
          console.warn(`[airtable] Record not found in Airtable — already deleted manually, skipping`);
        } else {
          throw new Error(`Airtable delete error ${response.status}: ${body}`);
        }
      }

      if (i + BATCH_SIZE < recordIds.length) {
        await sleep(RATE_LIMIT_DELAY_MS);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
