import { importPKCS8, SignJWT } from "jose";
import type { EBTransaction, EBTransactionsResponse, EBAuthResponse, EBASPSPDetails, EBSessionResponse } from "../types";

export class SessionExpiredError extends Error {
  constructor() {
    super("Enable Banking session has expired");
    this.name = "SessionExpiredError";
  }
}

const BASE_URL = "https://api.enablebanking.com";
const JWT_TTL_SECONDS = 3600; // 1 hour (max allowed is 86400)

// ---------------------------------------------------------------------------
// JWT generation
// ---------------------------------------------------------------------------

async function generateJwt(appId: string, privateKeyPem: string): Promise<string> {
  const privateKey = await importPKCS8(privateKeyPem, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: appId, typ: "JWT" })
    .setIssuer("enablebanking.com")
    .setAudience("api.enablebanking.com")
    .setIssuedAt(now)
    .setExpirationTime(now + JWT_TTL_SECONDS)
    .sign(privateKey);
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

export class EnableBankingClient {
  private readonly appId: string;
  private readonly privateKeyPem: string;
  private readonly sessionId: string;

  constructor(appId: string, privateKeyPem: string, sessionId: string) {
    this.appId = appId;
    this.privateKeyPem = privateKeyPem;
    this.sessionId = sessionId;
  }

  private async authHeader(): Promise<string> {
    const jwt = await generateJwt(this.appId, this.privateKeyPem);
    return `Bearer ${jwt}`;
  }

  private async loggedFetch(label: string, url: string, init: RequestInit): Promise<Response> {
    const bodyPreview = init.body ? String(init.body).slice(0, 2000) : "(none)";
    console.log(`[eb] → ${init.method ?? "GET"} ${url}  body=${bodyPreview}`);

    const response = await fetch(url, init);
    const clone = response.clone();
    const bodyText = await clone.text();
    const preview = bodyText.slice(0, 2000) + (bodyText.length > 2000 ? "…" : "");
    console.log(`[eb] ← ${label} ${response.status}  body=${preview}`);

    return response;
  }

  /**
   * Fetch ASPSP details, including maximum_consent_validity (days).
   */
  async getAspsp(name: string, country: string): Promise<EBASPSPDetails> {
    const auth = await this.authHeader();
    const url = `${BASE_URL}/aspsps/${encodeURIComponent(name)}/${encodeURIComponent(country)}`;
    const response = await this.loggedFetch("getAspsp", url, {
      method: "GET",
      headers: { Authorization: auth },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Enable Banking /aspsps error ${response.status}: ${body}`);
    }

    return (await response.json()) as EBASPSPDetails;
  }

  /**
   * Initiate the Enable Banking OAuth flow for a given bank (ASPSP).
   * Fetches the ASPSP's maximum_consent_validity and caps validUntil accordingly.
   * Returns the URL to redirect the user to for authentication.
   */
  async initiateAuth(
    aspspName: string,
    aspspCountry: string,
    psuType: string,
    redirectUrl: string,
    state: string,
    validUntil: string
  ): Promise<string> {
    // Cap valid_until to the ASPSP's maximum_consent_validity
    let cappedValidUntil = validUntil;
    try {
      const aspsp = await this.getAspsp(aspspName, aspspCountry);
      const maxDays = aspsp.maximum_consent_validity;
      if (maxDays !== undefined) {
        const maxDate = new Date();
        maxDate.setDate(maxDate.getDate() + maxDays);
        maxDate.setHours(0, 0, 0, 0);
        maxDate.setTime(maxDate.getTime() - 60 * 60 * 1000); // 1h safety margin
        const requestedDate = new Date(validUntil);
        if (requestedDate > maxDate) {
          cappedValidUntil = maxDate.toISOString().replace("Z", "+00:00");
          console.log(`[eb] valid_until capped: requested=${validUntil} max=${cappedValidUntil} (${maxDays}d)`);
        } else {
          console.log(`[eb] valid_until ok: ${validUntil} (max=${maxDays}d)`);
        }
      } else {
        console.log(`[eb] ASPSP has no maximum_consent_validity, using ${validUntil}`);
      }
    } catch (err) {
      console.warn(`[eb] Could not fetch ASPSP details, proceeding with original valid_until=${validUntil}:`, err);
    }

    const auth = await this.authHeader();
    const requestBody = JSON.stringify({
      aspsp: { name: aspspName, country: aspspCountry },
      access: { valid_until: cappedValidUntil },
      redirect_url: redirectUrl,
      psu_type: psuType,
      state,
    });
    const response = await this.loggedFetch("initiateAuth", `${BASE_URL}/auth`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: requestBody,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Enable Banking /auth error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as EBAuthResponse;
    return data.url;
  }

  /**
   * Exchange an OAuth authorization code for a session.
   * Returns the full session response including session_id, valid_until, and accounts.
   */
  async exchangeCode(code: string): Promise<EBSessionResponse> {
    const auth = await this.authHeader();
    const requestBody = JSON.stringify({ code });
    const response = await this.loggedFetch("exchangeCode", `${BASE_URL}/sessions`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: requestBody,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Enable Banking /sessions error ${response.status}: ${body}`);
    }

    return (await response.json()) as EBSessionResponse;
  }

  /**
   * Fetch all transactions for an account since `dateFrom`, following
   * pagination via `continuation_key`. Returns a flat array of all
   * transactions across all pages.
   */
  async fetchAllTransactions(accountId: string, dateFrom: string, dateTo?: string): Promise<EBTransaction[]> {
    const auth = await this.authHeader();
    const all: EBTransaction[] = [];
    let continuationKey: string | undefined;

    do {
      const url = new URL(`${BASE_URL}/accounts/${accountId}/transactions`);
      url.searchParams.set("date_from", dateFrom);
      if (dateTo) url.searchParams.set("date_to", dateTo);
      if (continuationKey) {
        url.searchParams.set("continuation_key", continuationKey);
      }

      const response = await this.loggedFetch(`fetchTransactions[${accountId}]`, url.toString(), {
        method: "GET",
        headers: {
          Authorization: auth,
          "X-Session-Id": this.sessionId,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const body = await response.text();
        if (response.status === 401 || response.status === 403) {
          throw new SessionExpiredError();
        }
        throw new Error(
          `Enable Banking API error ${response.status} for account ${accountId}: ${body}`
        );
      }

      const data = (await response.json()) as EBTransactionsResponse;
      all.push(...data.transactions);
      continuationKey = data.continuation_key;
    } while (continuationKey);

    return all;
  }
}
