import { getAccountStats } from "./db";
import type { Env } from "./types";

// Auth check is performed in src/index.ts before calling this function.

export async function handleStatus(_request: Request, env: Env): Promise<Response> {
  // --- Session info ---
  const kvSessionId   = await env.KV.get("session:id");
  const kvValidUntil  = await env.KV.get("session:valid_until");

  let daysRemaining: number | null = null;
  if (kvValidUntil) {
    const ms = new Date(kvValidUntil).getTime() - Date.now();
    daysRemaining = Math.round((ms / (1000 * 60 * 60 * 24)) * 10) / 10;
  }

  // --- Account IDs: KV first, fall back to env secret ---
  const kvAccountIds    = await env.KV.get("session:account_ids");
  const accountIdsSource: "kv" | "secret" = kvAccountIds ? "kv" : "secret";
  let accountIds: string[];
  try {
    accountIds = kvAccountIds
      ? (JSON.parse(kvAccountIds) as string[])
      : (JSON.parse(env.ENABLE_BANKING_ACCOUNT_IDS) as string[]);
  } catch {
    accountIds = [];
  }

  // --- D1 stats ---
  const dbStats = await getAccountStats(env.DB);

  // Per-account rows: merge D1 stats with KV cursors (run in parallel)
  const configuredAccounts = await Promise.all(
    accountIds.map(async (accountId) => {
      const [cursor, fetchCursor] = await Promise.all([
        env.KV.get(`cursor:${accountId}`),
        env.KV.get(`fetch-cursor:${accountId}`),
      ]);
      const stats = dbStats.find((s) => s.account_id === accountId);
      return {
        account_id:    accountId,
        cursor,
        fetch_cursor:  fetchCursor,
        total_booked:  stats?.booked  ?? 0,
        total_pending: stats?.pending ?? 0,
        unsynced_count: stats?.unsynced ?? 0,
      };
    })
  );

  // Include orphaned accounts found in DB but not in current config
  const orphanAccounts = dbStats
    .filter((s) => !accountIds.includes(s.account_id))
    .map((s) => ({
      account_id:    s.account_id,
      cursor:        null,
      fetch_cursor:  null,
      total_booked:  s.booked,
      total_pending: s.pending,
      unsynced_count: s.unsynced,
    }));

  // --- Sync info ---
  const lastRunAt = await env.KV.get("sync:last_run");

  // --- KV keys dump ---
  const perAccountKv = await Promise.all(
    accountIds.flatMap((id) => [
      env.KV.get(`cursor:${id}`).then((v) => [`cursor:${id}`, v] as const),
      env.KV.get(`fetch-cursor:${id}`).then((v) => [`fetch-cursor:${id}`, v] as const),
    ])
  );
  const kvKeys: Record<string, string | null> = {
    "session:id":          kvSessionId ? "[set]" : null, // never leak session token
    "session:valid_until": kvValidUntil,
    "session:account_ids": kvAccountIds,
    "sync:last_run":       lastRunAt,
  };
  for (const [key, value] of perAccountKv) {
    kvKeys[key] = value;
  }

  const body = {
    session: {
      valid_until:      kvValidUntil,
      days_remaining:   daysRemaining,
      has_kv_session_id: kvSessionId !== null,
    },
    accounts: [...configuredAccounts, ...orphanAccounts],
    sync: {
      last_run_at:        lastRunAt,
      account_ids_source: accountIdsSource,
      account_ids:        accountIds,
    },
    kv_keys: kvKeys,
  };

  return new Response(JSON.stringify(body, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}
