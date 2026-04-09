import { getAccountStats } from "./db";
import { runSync } from "./sync";
import type { Env } from "./types";

// ---------------------------------------------------------------------------
// Token auth helper
// ---------------------------------------------------------------------------

function checkToken(request: Request, env: Env): boolean {
  const url = new URL(request.url);
  return url.searchParams.get("token") === env.SYNC_TOKEN;
}

// ---------------------------------------------------------------------------
// GET /ui?token=… — dashboard page
// ---------------------------------------------------------------------------

export async function handleUI(request: Request, env: Env): Promise<Response> {
  if (!checkToken(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const flash = url.searchParams.get("synced");

  // --- Session ---
  const validUntil = await env.KV.get("session:valid_until");
  let daysRemaining: number | null = null;
  let sessionStatus: "ok" | "warn" | "expired" = "ok";
  if (validUntil) {
    const ms = new Date(validUntil).getTime() - Date.now();
    daysRemaining = Math.round((ms / (1000 * 60 * 60 * 24)) * 10) / 10;
    if (daysRemaining <= 0) sessionStatus = "expired";
    else if (daysRemaining <= 7) sessionStatus = "warn";
  }

  // --- Last sync ---
  const lastRun = await env.KV.get("sync:last_run");
  const lastRunLabel = lastRun ? new Date(lastRun).toLocaleString("fr-FR", { timeZone: "Europe/Paris" }) : "never";

  // --- Accounts ---
  const kvAccountIds = await env.KV.get("session:account_ids");
  let accountIds: string[] = [];
  try {
    if (kvAccountIds) accountIds = JSON.parse(kvAccountIds) as string[];
    else if (env.ENABLE_BANKING_ACCOUNT_IDS) accountIds = JSON.parse(env.ENABLE_BANKING_ACCOUNT_IDS) as string[];
  } catch { /* leave empty */ }

  const dbStats = await getAccountStats(env.DB);

  const accountRows = accountIds.map((id) => {
    const stats = dbStats.find((s) => s.account_id === id);
    const booked  = stats?.booked  ?? 0;
    const pending = stats?.pending ?? 0;
    const unsynced = stats?.unsynced ?? 0;
    const shortId = id.slice(0, 8) + "…";
    return `
      <tr>
        <td title="${id}">${shortId}</td>
        <td>${booked}</td>
        <td>${pending}</td>
        <td class="${unsynced > 0 ? "warn-text" : ""}">${unsynced}</td>
      </tr>`;
  }).join("\n");

  // --- Session banner ---
  const sessionColor   = sessionStatus === "ok" ? "#22c55e" : sessionStatus === "warn" ? "#f59e0b" : "#ef4444";
  const sessionLabel   = validUntil
    ? `Valid until ${new Date(validUntil).toLocaleDateString("fr-FR")} (${daysRemaining}d remaining)`
    : "No session — re-authorize required";
  const sessionBannerBg = sessionStatus === "ok" ? "#f0fdf4" : sessionStatus === "warn" ? "#fffbeb" : "#fef2f2";

  // --- Flash message ---
  const flashHtml = flash === "1"
    ? `<div class="flash">Sync triggered. Refresh in a few seconds to see updated stats.</div>`
    : "";

  const token = url.searchParams.get("token") ?? "";
  const formAction = `/ui?token=${encodeURIComponent(token)}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Neo BankLink</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #f8fafc;
      color: #1e293b;
      padding: 2rem 1rem;
      max-width: 640px;
      margin: 0 auto;
    }
    h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: 0.25rem; }
    .subtitle { color: #64748b; font-size: 0.875rem; margin-bottom: 2rem; }
    .card {
      background: white;
      border: 1px solid #e2e8f0;
      border-radius: 0.75rem;
      padding: 1.25rem 1.5rem;
      margin-bottom: 1rem;
    }
    .card-title { font-size: 0.75rem; font-weight: 600; text-transform: uppercase;
                  letter-spacing: 0.05em; color: #94a3b8; margin-bottom: 0.75rem; }
    .session-banner {
      display: flex; align-items: center; gap: 0.5rem;
      padding: 0.625rem 1rem;
      border-radius: 0.5rem;
      background: ${sessionBannerBg};
      border: 1px solid ${sessionColor}33;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: ${sessionColor}; flex-shrink: 0; }
    .session-label { font-size: 0.875rem; color: #1e293b; }
    .meta { font-size: 0.875rem; color: #475569; }
    .meta span { color: #1e293b; font-weight: 500; }
    table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    th { text-align: left; color: #94a3b8; font-weight: 600; font-size: 0.75rem;
         text-transform: uppercase; letter-spacing: 0.04em;
         padding: 0 0 0.5rem; border-bottom: 1px solid #e2e8f0; }
    td { padding: 0.625rem 0; border-bottom: 1px solid #f1f5f9; color: #475569; }
    td:first-child { font-family: monospace; font-size: 0.8rem; color: #1e293b; }
    td:not(:first-child) { text-align: right; }
    th:not(:first-child) { text-align: right; }
    .warn-text { color: #f59e0b; font-weight: 600; }
    button {
      width: 100%;
      padding: 0.75rem;
      background: #2563eb;
      color: white;
      border: none;
      border-radius: 0.5rem;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    button:hover { background: #1d4ed8; }
    button:active { background: #1e40af; }
    .flash {
      background: #f0fdf4;
      border: 1px solid #bbf7d0;
      color: #15803d;
      border-radius: 0.5rem;
      padding: 0.75rem 1rem;
      font-size: 0.875rem;
      margin-bottom: 1rem;
    }
    .reauth-link { display: block; text-align: center; font-size: 0.8rem; color: #94a3b8;
                   margin-top: 0.75rem; text-decoration: none; }
    .reauth-link:hover { color: #64748b; }
  </style>
</head>
<body>
  <h1>Neo BankLink</h1>
  <p class="subtitle">Bank transaction sync dashboard</p>

  ${flashHtml}

  <div class="card">
    <div class="card-title">Session</div>
    <div class="session-banner">
      <div class="dot"></div>
      <div class="session-label">${sessionLabel}</div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Last sync</div>
    <p class="meta">Ran at <span>${lastRunLabel}</span></p>
  </div>

  <div class="card">
    <div class="card-title">Accounts</div>
    ${accountIds.length > 0 ? `
    <table>
      <thead>
        <tr>
          <th>Account</th>
          <th>Booked</th>
          <th>Pending</th>
          <th>Unsynced</th>
        </tr>
      </thead>
      <tbody>
        ${accountRows}
      </tbody>
    </table>` : `<p class="meta">No accounts configured.</p>`}
  </div>

  <form method="POST" action="${formAction}">
    <button type="submit">Trigger Sync</button>
  </form>
  <a class="reauth-link" href="/reauth">Re-authorize bank session →</a>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}

// ---------------------------------------------------------------------------
// POST /ui?token=… — trigger sync, redirect back with flash
// ---------------------------------------------------------------------------

export async function handleUISync(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!checkToken(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";

  ctx.waitUntil(runSync(env));

  return Response.redirect(`/ui?token=${encodeURIComponent(token)}&synced=1`, 303);
}
