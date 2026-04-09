import { EnableBankingClient, SessionExpiredError } from "./clients/enablebanking";
import { AirtableClient } from "./clients/airtable";
import {
  upsertTransactions,
  insertPendingTransactions,
  getPendingAirtableIds,
  deletePendingTransactions,
  getUnsynced,
  countUnsynced,
  setAirtableRecordIds,
  getLatestBookedDate,
} from "./db";
import { addDays } from "./utils";
import type { Env } from "./types";

// Fallback start date for the very first sync (fetches full history).
const EPOCH_DATE = "2000-01-01";
// How many days of transactions to fetch from Enable Banking per invocation.
const FETCH_WINDOW_DAYS = 90;
// Max records pushed to Airtable per invocation.
const AIRTABLE_PUSH_LIMIT = 50;
const SESSION_EXPIRY_WARN_DAYS = 7;

// ---------------------------------------------------------------------------
// Session expiry check
// ---------------------------------------------------------------------------

const REAUTH_INSTRUCTIONS =
  "Re-authorize by visiting https://banklink.interne.neosolsetmurs.fr/reauth in a browser, " +
  "or pass aspsp_name/aspsp_country as query params if not pre-configured.";

async function checkSessionExpiry(env: Env): Promise<void> {
  const validUntil = await env.KV.get("session:valid_until");

  if (!validUntil) {
    console.warn(
      "[sync] WARNING: session:valid_until not set in KV. " +
      "This is set automatically after completing /reauth + /callback. " +
      "To set manually: npx wrangler kv:key put --binding=KV session:valid_until <YYYY-MM-DD>"
    );
    return;
  }

  const expiryMs = new Date(validUntil).getTime();
  const nowMs = Date.now();
  const daysLeft = (expiryMs - nowMs) / (1000 * 60 * 60 * 24);

  if (daysLeft <= 0) {
    throw new Error(
      `[sync] Enable Banking session expired on ${validUntil}. ${REAUTH_INSTRUCTIONS}`
    );
  }

  if (daysLeft <= SESSION_EXPIRY_WARN_DAYS) {
    console.warn(
      `[sync] WARNING: Enable Banking session expires on ${validUntil} ` +
      `(${Math.ceil(daysLeft)} day(s) left). ${REAUTH_INSTRUCTIONS}`
    );
  }
}

// ---------------------------------------------------------------------------
// Per-account sync — returns true if more work remains
// ---------------------------------------------------------------------------

async function syncAccount(
  accountId: string,
  eb: EnableBankingClient,
  at: AirtableClient,
  env: Env
): Promise<boolean> {
  console.log(`[sync][account:${accountId}] Starting`);

  const cursorKey = `cursor:${accountId}`;
  const fetchCursorKey = `fetch-cursor:${accountId}`;

  // 1. If there's an Airtable backlog, drain it before fetching new data.
  const backlog = await countUnsynced(env.DB, accountId);
  let caughtUp = false;

  if (backlog > 0) {
    console.warn(`[sync][account:${accountId}] Airtable backlog: ${backlog} unsynced — skipping EB fetch this run`);
  } else {
    // 2. No backlog — fetch the next window from Enable Banking.
    const fetchCursor = await env.KV.get(fetchCursorKey);
    const cursor = await env.KV.get(cursorKey);
    const windowStart = fetchCursor ?? EPOCH_DATE;
    const windowEnd = addDays(windowStart, FETCH_WINDOW_DAYS);
    const today = new Date().toISOString().slice(0, 10);
    caughtUp = windowEnd >= today;
    // When caught up, fetch through tomorrow so PDNG transactions with a future
    // booking_date (set by the bank for the next business day) are included.
    // When backfilling, cap at windowEnd to limit volume per invocation.
    const dateTo = caughtUp ? addDays(today, 1) : windowEnd;

    console.log(`[sync][account:${accountId}] Fetching ${windowStart} → ${dateTo} (cursor=${cursor}, fetchCursor=${fetchCursor}, caughtUp=${caughtUp})`);

    const transactions = await eb.fetchAllTransactions(accountId, windowStart, dateTo);
    const bookCount = transactions.filter((t) => t.status === "BOOK").length;
    const pdngCount = transactions.filter((t) => t.status === "PDNG").length;
    console.log(`[sync][account:${accountId}] Fetched ${transactions.length} transactions (BOOK: ${bookCount}, PDNG: ${pdngCount})`);

    // Warn about BOOK transactions with no stable ID (they cannot be stored)
    const nullRefCount = transactions.filter((t) => t.status === "BOOK" && t.entry_reference === null).length;
    if (nullRefCount > 0) {
      console.warn(`[sync][account:${accountId}] Skipping ${nullRefCount} BOOK transaction(s) with null entry_reference — no stable ID available`);
    }

    // 3a. Upsert BOOK transactions into D1.
    await upsertTransactions(env.DB, accountId, transactions);

    // 3b. When caught up, reset PDNG: delete stale records from Airtable and D1,
    //     then insert fresh ones (PDNG have no stable ID — must be fully replaced).
    if (caughtUp) {
      const pdngAirtableIds = await getPendingAirtableIds(env.DB, accountId);
      if (pdngAirtableIds.length > 0) {
        console.log(`[sync][account:${accountId}] Deleting ${pdngAirtableIds.length} stale PDNG records from Airtable`);
        await at.deleteRecords(pdngAirtableIds);
      }
      await deletePendingTransactions(env.DB, accountId);

      const pdngTxs = transactions.filter((t) => t.status === "PDNG");
      if (pdngTxs.length > 0) {
        console.log(`[sync][account:${accountId}] Inserting ${pdngTxs.length} fresh PDNG transactions`);
        await insertPendingTransactions(env.DB, accountId, transactions);
      }
    } else {
      console.log(`[sync][account:${accountId}] Backfill in progress — PDNG reset deferred until caught up`);
    }

    // 4. Advance the fetch cursor.
    // When caught up, store 2 days ago — the bank requires at least a 2-day
    // window to return results, so we always re-fetch from 2 days ago → tomorrow.
    const nextFetchFrom = caughtUp ? addDays(today, -2) : dateTo;
    await env.KV.put(fetchCursorKey, nextFetchFrom);

    if (caughtUp) {
      const latestBooked = await getLatestBookedDate(env.DB, accountId);
      if (latestBooked) {
        await env.KV.put(cursorKey, latestBooked);
        console.log(`[sync][account:${accountId}] BOOK cursor advanced to ${latestBooked}`);
      } else {
        console.warn(`[sync][account:${accountId}] No BOOK transactions found — cursor not updated`);
      }
    } else {
      console.log(`[sync][account:${accountId}] Backfill in progress — next window starts at ${dateTo}`);
    }
  }

  // 5. Push unsynced transactions to Airtable (capped per invocation).
  const totalUnsynced = await countUnsynced(env.DB, accountId);
  const unsynced = await getUnsynced(env.DB, accountId, AIRTABLE_PUSH_LIMIT);
  const remainingAfter = totalUnsynced - unsynced.length;

  if (unsynced.length === 0) {
    console.log(`[sync][account:${accountId}] No unsynced transactions to push to Airtable`);
  } else {
    console.log(`[sync][account:${accountId}] Pushing ${unsynced.length} to Airtable (${remainingAfter} remaining after this run)`);
    await at.createRecords(unsynced, (pairs) => setAirtableRecordIds(env.DB, pairs));
  }

  console.log(`[sync][account:${accountId}] Done`);

  // More work remains if: backlog not fully drained, OR still in backfill mode.
  return remainingAfter > 0 || !caughtUp;
}

// ---------------------------------------------------------------------------
// Main entry — returns true if more work remains (for self-chaining)
// ---------------------------------------------------------------------------

// KV-based mutex: prevents concurrent cron + queue invocations from racing.
// TTL is generous (5 min) — a hung worker releases the lock automatically.
const LOCK_KEY = "sync:lock";
const LOCK_TTL_SECONDS = 300;

async function acquireLock(env: Env): Promise<boolean> {
  const existing = await env.KV.get(LOCK_KEY);
  if (existing) return false;
  await env.KV.put(LOCK_KEY, "1", { expirationTtl: LOCK_TTL_SECONDS });
  return true;
}

async function releaseLock(env: Env): Promise<void> {
  await env.KV.delete(LOCK_KEY);
}

export async function runSync(env: Env): Promise<boolean> {
  const acquired = await acquireLock(env);
  if (!acquired) {
    console.warn("[sync] Another sync is already running — skipping this invocation");
    return false;
  }

  try {
    return await _runSync(env);
  } finally {
    await releaseLock(env);
  }
}

async function _runSync(env: Env): Promise<boolean> {
  // Record the start time for /status observability
  await env.KV.put("sync:last_run", new Date().toISOString());

  // Resolve session ID: prefer KV (set by /callback OAuth flow) over env secret
  const kvSessionId = await env.KV.get("session:id");
  const sessionId = kvSessionId ?? env.ENABLE_BANKING_SESSION_ID;

  // Resolve account IDs: prefer KV (set by /callback) over env secret
  const kvAccountIds = await env.KV.get("session:account_ids");
  let accountIds: string[];
  try {
    accountIds = kvAccountIds
      ? (JSON.parse(kvAccountIds) as string[])
      : (JSON.parse(env.ENABLE_BANKING_ACCOUNT_IDS) as string[]);
  } catch {
    console.error("[sync] Failed to parse account IDs — check ENABLE_BANKING_ACCOUNT_IDS secret or session:account_ids KV value");
    return false;
  }

  if (accountIds.length === 0) {
    console.warn("[sync] No account IDs configured — nothing to do");
    return false;
  }

  await checkSessionExpiry(env);

  const eb = new EnableBankingClient(
    env.ENABLE_BANKING_APP_ID,
    env.ENABLE_BANKING_PRIVATE_KEY,
    sessionId,
  );
  const at = new AirtableClient(
    env.AIRTABLE_API_KEY,
    env.AIRTABLE_BASE_ID,
    env.AIRTABLE_TABLE_NAME
  );

  let moreWork = false;
  for (const accountId of accountIds) {
    try {
      const accountMoreWork = await syncAccount(accountId, eb, at, env);
      if (accountMoreWork) moreWork = true;
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        console.error(`[sync] Enable Banking session has expired. ${REAUTH_INSTRUCTIONS}`);
        return false;
      }
      throw err;
    }
  }

  return moreWork;
}
