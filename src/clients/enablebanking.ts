import { importPKCS8, SignJWT } from "jose";
import type { EBTransaction, EBTransactionsResponse, EBAuthResponse, EBSessionResponse } from "../types";

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

  /**
   * Initiate the Enable Banking OAuth flow for a given bank (ASPSP).
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
    const auth = await this.authHeader();
    const response = await fetch(`${BASE_URL}/auth`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        aspsp: { name: aspspName, country: aspspCountry },
        access: { valid_until: validUntil },
        redirect_url: redirectUrl,
        psu_type: psuType,
        state,
      }),
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
    const response = await fetch(`${BASE_URL}/sessions`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
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

      const response = await fetch(url.toString(), {
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
