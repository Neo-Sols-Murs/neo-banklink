import { EnableBankingClient } from "./clients/enablebanking";
import { addDays } from "./utils";
import type { Env } from "./types";

const CSRF_TTL_SECONDS = 600; // 10 minutes
const CONSENT_DAYS = 180;     // maximum consent duration

// ---------------------------------------------------------------------------
// GET /reauth — initiates the OAuth flow, redirects to bank auth URL
// ---------------------------------------------------------------------------

export async function handleReauth(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  const aspspName    = url.searchParams.get("aspsp_name")    ?? env.ENABLE_BANKING_ASPSP_NAME;
  const aspspCountry = url.searchParams.get("aspsp_country") ?? env.ENABLE_BANKING_ASPSP_COUNTRY;
  const psuType      = url.searchParams.get("psu_type")      ?? env.ENABLE_BANKING_PSU_TYPE ?? "personal";

  if (!aspspName || !aspspCountry) {
    return new Response(
      JSON.stringify({
        error: "Missing required parameters",
        details: "Provide 'aspsp_name' and 'aspsp_country' as query params, " +
          "or set ENABLE_BANKING_ASPSP_NAME and ENABLE_BANKING_ASPSP_COUNTRY secrets.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const validUntil = addDays(today, CONSENT_DAYS);
  const state = crypto.randomUUID();

  await env.KV.put(`auth:state:${state}`, "1", { expirationTtl: CSRF_TTL_SECONDS });

  const callbackUrl = new URL("/callback", request.url).toString();

  const eb = new EnableBankingClient(
    env.ENABLE_BANKING_APP_ID,
    env.ENABLE_BANKING_PRIVATE_KEY,
    "" // session ID not used for /auth
  );

  let bankAuthUrl: string;
  try {
    bankAuthUrl = await eb.initiateAuth(aspspName, aspspCountry, psuType, callbackUrl, state, validUntil);
  } catch (err) {
    console.error("[auth] Failed to initiate OAuth:", err);
    return new Response(
      JSON.stringify({ error: "Failed to initiate OAuth", details: String(err) }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  console.log(`[auth] Initiating OAuth for ASPSP: ${aspspName} (${aspspCountry}), valid_until: ${validUntil}`);
  return Response.redirect(bankAuthUrl, 302);
}

// ---------------------------------------------------------------------------
// GET /callback — exchanges OAuth code for session, stores in KV
// ---------------------------------------------------------------------------

export async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code  = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return new Response(
      JSON.stringify({ error: "Missing 'code' or 'state' query parameter" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // CSRF validation
  const storedState = await env.KV.get(`auth:state:${state}`);
  if (!storedState) {
    console.warn("[auth] /callback received invalid or expired state:", state);
    return new Response(
      JSON.stringify({ error: "Invalid or expired state parameter. Please restart the auth flow via /reauth." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  await env.KV.delete(`auth:state:${state}`);

  const eb = new EnableBankingClient(
    env.ENABLE_BANKING_APP_ID,
    env.ENABLE_BANKING_PRIVATE_KEY,
    "" // session ID not used for /sessions
  );

  let session;
  try {
    session = await eb.exchangeCode(code);
  } catch (err) {
    console.error("[auth] Failed to exchange code for session:", err);
    return new Response(
      JSON.stringify({ error: "Failed to exchange authorization code", details: String(err) }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  const accountIds = session.accounts.map((a) => a.uid);

  await env.KV.put("session:id", session.session_id);
  await env.KV.put("session:valid_until", session.valid_until);
  await env.KV.put("session:account_ids", JSON.stringify(accountIds));

  console.log(
    `[auth] New session stored. Accounts: ${accountIds.length}, valid_until: ${session.valid_until}`
  );

  const accountRows = session.accounts
    .map((a) => `<li><code>${a.uid}</code>${a.iban ? ` — ${a.iban}` : ""}</li>`)
    .join("\n");

  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Authorization successful — neo-banklink</title></head>
<body>
  <h1>Authorization successful</h1>
  <p><strong>Session valid until:</strong> ${session.valid_until}</p>
  <p><strong>Accounts linked (${accountIds.length}):</strong></p>
  <ul>${accountRows}</ul>
  <p>The next sync will use this session automatically.</p>
</body>
</html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}
