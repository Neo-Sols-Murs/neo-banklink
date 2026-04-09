# CLAUDE.md — neo-banklink agent context

This file is for AI agents working on this codebase. It covers the architecture, every non-obvious decision, known pitfalls, and the reasoning behind them.

---

## What this is

A Cloudflare Workers service that:
1. Authenticates with Enable Banking (Open Banking aggregator) via OAuth
2. Fetches bank transactions from the Enable Banking API
3. Stores them in Cloudflare D1 (SQLite)
4. Pushes them to Airtable

It runs on a hourly cron. It self-chains via Cloudflare Queues when more work remains (backfill). It has a small HTTP API for re-auth and admin operations.

**Live URL:** `https://banklink.interne.neosolsetmurs.fr`

---

## Commit procedure

When the user asks to commit, before creating the commit:

1. **Update `CHANGELOG.md`** — add an entry under the appropriate version (or create a new version block if the changes warrant a version bump). Follow the existing format: version header, date, and grouped `### Added / Changed / Fixed` sections.
2. **Update `README.md`** — if the HTTP API surface, setup steps, secrets, or project structure changed, reflect that.
3. **Update `CLAUDE.md`** — if architecture, KV keys, DB schema, API shapes, known issues, or agent guidance changed, update the relevant section.

Then commit all changed files together (docs + code in one commit, or docs as a follow-up if the code was already committed).

---

## Versioning

This project follows [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`):

- **PATCH** — bug fixes, log improvements, non-breaking internal changes
- **MINOR** — new features, new endpoints, new integrations, non-breaking API changes
- **MAJOR** — breaking changes to the HTTP API, DB schema migrations that require manual steps, or changes requiring re-auth or secret updates

The current version is declared in `package.json`. All notable changes are documented in `CHANGELOG.md`. When making a significant change, update both files.

---

## File map

```
src/index.ts              Entrypoint. Routes fetch handler, cron, queue consumer.
src/auth.ts               /reauth (OAuth initiation) and /callback (code exchange).
src/sync.ts               Core sync engine. Per-account orchestration. KV mutex.
src/db.ts                 All D1 queries. No raw SQL outside this file.
src/status.ts             /status handler. Reads KV + D1, returns JSON.
src/ui.ts                 /ui employee dashboard. Server-rendered HTML. Token-auth.
src/types.ts              All TypeScript interfaces. Source of truth for API shapes.
src/utils.ts              addDays(dateStr, n): string — the only utility.
src/clients/
  enablebanking.ts        Enable Banking API client. JWT auth. loggedFetch wrapper.
  airtable.ts             Airtable client. Batched create/delete. Rate-limited.
migrations/0001_init.sql  D1 schema.
scripts/bootstrap.sh      Interactive first-time setup script.
wrangler.toml             Cloudflare config. D1, KV, Queue, cron bindings.
```

---

## Runtime environment

- **Platform:** Cloudflare Workers (V8 isolate, not Node.js)
- **Compatibility flags:** `nodejs_compat` (allows `crypto`, `Buffer`, etc.)
- **Build:** Wrangler bundles TypeScript directly — no separate build step
- **Key constraint:** Workers have a 30-second CPU time limit per invocation. This is why sync is chunked and self-chained via Queue rather than running in one shot.

---

## Cloudflare bindings

All bindings are declared in `wrangler.toml` and typed in `src/types.ts` as the `Env` interface.

| Binding | Type | Name | Purpose |
|---|---|---|---|
| `DB` | D1Database | `neo-banklink` | Transaction storage |
| `KV` | KVNamespace | `neo-banklink` | State, cursors, session, lock |
| `SYNC_QUEUE` | Queue | `neo-banklink-sync` | Self-chaining for backfill |

---

## KV key schema

All KV keys used by the worker — know these before touching sync or auth code:

| Key | Value | Set by |
|---|---|---|
| `session:id` | Enable Banking session UUID | `/callback` |
| `session:valid_until` | ISO datetime from `session.access.valid_until` | `/callback` |
| `session:account_ids` | JSON array of account UID strings | `/callback` |
| `cursor:{accountId}` | Latest booked date (YYYY-MM-DD) — used for Airtable date display | sync |
| `fetch-cursor:{accountId}` | Window start date for next EB fetch | sync |
| `sync:last_run` | ISO datetime of last sync invocation start | sync |
| `sync:lock` | `"1"` with 300s TTL — mutex to prevent concurrent runs | sync |
| `auth:state:{uuid}` | `"1"` with 600s TTL — CSRF token for OAuth flow | `/reauth` |

---

## D1 schema

Single table: `transactions`

```sql
id                  TEXT PRIMARY KEY   -- entry_reference for BOOK; random UUID for PDNG
account_id          TEXT NOT NULL
status              TEXT NOT NULL      -- 'BOOK' | 'PDNG'
amount              TEXT NOT NULL      -- signed string: "-12.50" for debits, "12.50" for credits
currency            TEXT NOT NULL
credit_debit        TEXT NOT NULL      -- 'CRDT' | 'DBIT'
booking_date        TEXT               -- YYYY-MM-DD; NULL for PDNG
value_date          TEXT
description         TEXT               -- remittance_information joined with ' / '
counterparty_name   TEXT
counterparty_iban   TEXT
airtable_record_id  TEXT               -- NULL until pushed; set after Airtable create
raw_json            TEXT NOT NULL      -- full EB API response object
created_at          TEXT NOT NULL DEFAULT (datetime('now'))
updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
```

**Indexes:**
- `idx_tx_pending` — partial on `status = 'PDNG'`
- `idx_tx_unsync` — partial on `airtable_record_id IS NULL`
- `idx_tx_account` — on `(account_id, booking_date)`

**Why amount is TEXT:** Floating point cannot represent monetary values exactly. The Enable Banking API returns amounts as strings. We preserve that string as-is and only parse to float at the Airtable boundary (`parseFloat` in `toAirtableFields`).

---

## Enable Banking API client

**File:** `src/clients/enablebanking.ts`

### Authentication
Every request is authenticated with a short-lived JWT (1-hour TTL, RS256). The JWT is signed using the app's RSA private key via `jose`. The `kid` header is the app UUID. Audience is `api.enablebanking.com`.

### loggedFetch
All outbound requests go through `loggedFetch(label, url, init)`. It logs the method, URL, and request body before the request, then clones the response to log the status and body after. The clone is consumed for logging; the original response is returned to the caller for normal consumption. This is important: never consume the original response body in `loggedFetch`, or callers will get an empty body.

### getAspsp
Calls `GET /aspsps/{name}/{country}` to retrieve ASPSP details, specifically `maximum_consent_validity` (in days). Called by `initiateAuth` before the `/auth` POST.

### initiateAuth — valid_until capping
The Enable Banking `/auth` endpoint rejects `valid_until` values that exceed the ASPSP's `maximum_consent_validity`. The worker:
1. Fetches ASPSP details
2. Computes `maxDate = now + maxDays` at UTC midnight
3. Subtracts 1 hour as a safety margin (so the timestamp becomes `23:00:00+00:00` the day before the hard limit)
4. If the requested `valid_until` exceeds this, it is capped

If the ASPSP lookup fails (network error, unknown ASPSP), the original `valid_until` is used with a warning log — the `/auth` call may then fail, but the error will be visible in logs.

### Session response shape
The Enable Banking `/sessions` response does NOT have a top-level `valid_until`. It is nested at `session.access.valid_until`. The types reflect this:
```typescript
session.access.valid_until  // correct
session.valid_until          // WRONG — field does not exist
```

Account IBAN is nested: `account.account_id.iban`, not `account.iban`.

---

## Sync engine

**File:** `src/sync.ts`

### Mutex
`runSync` acquires a KV lock before doing any work. If the lock is already held, it logs a warning and returns `false`. The lock has a 5-minute TTL so a crashed worker doesn't hold it forever. The lock is released in a `finally` block. The actual work is in `_runSync`.

**Known limitation:** KV `get` + `put` is not atomic. There is a small race window where two concurrent workers could both see no lock and both acquire it. In practice this is negligible for a cron-fired worker. A truly atomic solution would require Durable Objects.

### Fetch windowing
- The `fetch-cursor` KV key holds the start of the next window to fetch
- Windows are 90 days (`FETCH_WINDOW_DAYS = 90`)
- When `windowEnd >= today`, the worker is "caught up"
- When caught up, it always fetches from `today - 2` (Enable Banking requires at least a 2-day window to return results)
- When caught up, `dateTo` is `today + 1` to include transactions with a future booking date (banks often set booking dates to the next business day)

### BOOK vs PDNG handling

**BOOK transactions** have a stable `entry_reference` field. This is used as the D1 primary key. Upserts are safe and idempotent.

**PDNG (pending) transactions** have no stable ID from the bank. The same pending transaction may appear with a different `transaction_id` across fetches, or disappear when booked. Therefore:
- PDNG are only processed when the worker is "caught up" (otherwise we don't have the full current picture)
- On every caught-up run: delete all existing PDNG records from Airtable (using stored `airtable_record_id`), delete from D1, then insert fresh ones with new random UUIDs
- This means PDNG records in Airtable are ephemeral and will be replaced every sync cycle

**Why this causes duplicate PDNGs without the mutex:** If two workers run simultaneously, both see `backlog = 0`, both fetch, both do the delete-insert cycle. The second insert races with the first, creating double records. The KV mutex prevents this.

### Airtable push cap
Only 50 transactions are pushed per invocation (`AIRTABLE_PUSH_LIMIT = 50`). This is to stay within the Worker CPU time limit. If there are more, the worker returns `moreWork = true` and the queue consumer fires another run immediately.

### Self-chaining
When `runSync` returns `true`, the caller (`startSync` in `index.ts`) enqueues an empty message on `SYNC_QUEUE`. The queue consumer calls `startSync` again. This continues until all work is drained. The KV mutex ensures only one chain is active at a time.

---

## OAuth flow

**File:** `src/auth.ts`

### CSRF protection
1. `/reauth` generates a UUID state token, stores it in KV with a 10-minute TTL (`auth:state:{uuid}`)
2. The state is passed to Enable Banking as part of the auth request
3. Enable Banking echoes it back in the `/callback` query params
4. `/callback` looks up the state in KV — if missing or expired, rejects with 400
5. After validation, the state key is deleted from KV

### Session storage after /callback
Three KV keys are set:
- `session:id` — the new session ID (replaces the env secret fallback)
- `session:valid_until` — from `session.access.valid_until` (ISO datetime)
- `session:account_ids` — JSON array of account UIDs

The sync engine reads KV first, falls back to env secrets. This means re-auth via `/callback` takes effect immediately without redeployment.

### Callback URL
The callback URL passed to Enable Banking is computed from the incoming request: `new URL("/callback", request.url)`. This means it works in both prod and local dev without hardcoding.

---

## HTTP routing

**File:** `src/index.ts`

Routes are matched by exact `pathname` and method. There is no router library.

- `GET /reauth` and `GET /callback` — no auth (must be reachable from a browser)
- `GET /ui?token=…` and `POST /ui?token=…` — token-auth via `SYNC_TOKEN` query param (checked before the `ADMIN_SECRET` gate)
- All other routes — require `Authorization: Bearer <ADMIN_SECRET>` header
- `GET /status` — returns JSON status
- `POST /sync` — triggers a sync run via `ctx.waitUntil`
- Everything else — `404 Not Found`

**Important:** `ctx.waitUntil` is used for sync and queue processing. This allows the HTTP response to return immediately while the sync continues in the background. Do not `await` sync in the response path.

---

## Airtable client

**File:** `src/clients/airtable.ts`

- Creates records in batches of 10 (Airtable API maximum)
- Rate-limited to ~4 requests/second (250ms delay between batches)
- After each create batch, Airtable record IDs are written back to D1 immediately (`onBatchCreated` callback). This makes the ID persistence durable even if the worker is killed mid-push.
- Deletes also use 10-record batches

### Field mapping
```
"Transaction ID" → tx.id
"Date"           → tx.booking_date
"Amount"         → parseFloat(tx.amount)
"Currency"       → tx.currency
"Description"    → tx.description
"Counterparty Name" → tx.counterparty_name
"Counterparty IBAN" → tx.counterparty_iban
"Status"         → tx.status ('BOOK' | 'PDNG')
```

If the Airtable table schema changes, update `toAirtableFields` in `airtable.ts`.

---

## Secrets and environment

Secrets are set via `wrangler secret put` and never appear in `wrangler.toml`. The `Env` interface in `types.ts` declares all bindings and secrets. Optional secrets (`ENABLE_BANKING_ASPSP_NAME`, etc.) are typed as `string | undefined`.

`SYNC_TOKEN` is a separate, lower-privilege secret for the `/ui` dashboard. It is intended to be shared with employees who need to trigger resyncs. It does not grant access to `/status` or `/sync` (those require `ADMIN_SECRET`).

Session ID and account IDs have a dual-source pattern: KV takes precedence over env secrets. This allows the system to operate before re-auth (using bootstrap secrets) and after re-auth (using KV-stored values from `/callback`).

---

## Known issues and limitations

### KV mutex is not atomic
Two workers starting within microseconds of each other could both pass the lock check. Acceptable for hourly cron, but worth knowing.

### PDNG transactions are always replaced
Every caught-up sync cycle deletes and recreates all PDNG records in Airtable. This means PDNG records lose any manual edits made in Airtable between syncs.

### Manually deleted Airtable records
If a PDNG record is manually deleted from Airtable, the next sync's batch delete will receive a 404 for the entire batch. The client retries each record in the batch individually — per-record 404s are warned and skipped, others still throw. This means manual deletions are safe and the PDNG reset will complete normally.

### No retry logic for Airtable failures
If Airtable create fails mid-batch, the successfully created records in that batch won't have their IDs written back to D1. On the next run, those transactions will appear as unsynced again and be re-created in Airtable (duplicates). This is acceptable given current volume but would need a fix at scale.

### Single account architecture
The sync loop iterates accounts sequentially. If there are many accounts and a backfill is in progress, the self-chaining queue approach means accounts are processed round-robin across invocations rather than in parallel. This is fine for the current single-account setup.

### Enable Banking session renewal
The worker warns when session expires in <7 days but cannot renew it automatically (requires user browser interaction). Someone must visit `/reauth` before expiry. The session duration is capped to the ASPSP's `maximum_consent_validity` minus 1 hour.

---

## Deployment

Deployed via Cloudflare Workers (assumed to be linked to the GitHub repo via Workers CI or manual `wrangler deploy`). The `compatibility_date` in `wrangler.toml` should be kept up to date when upgrading Wrangler.

```bash
npm run deploy          # wrangler deploy
npx wrangler tail       # stream live logs
```

---

## Adding a new bank account

1. Run `/reauth` — it will ask the user to authenticate with the bank
2. After `/callback`, `session:account_ids` in KV will contain the new account UIDs
3. The next sync run will pick them up automatically
4. No code changes or redeployment needed

---

## Adding a new sync step

The sync pipeline is in `syncAccount` in `sync.ts`. Steps are sequential and numbered in comments. New steps go between the fetch/upsert phase and the Airtable push phase. Keep each step's side effects documented in comments — the ordering matters.

---

## Things NOT to do

- Do not read `session.valid_until` — it does not exist. Use `session.access.valid_until`.
- Do not use `account.iban` directly — the IBAN is at `account.account_id.iban` in EB API responses.
- Do not store amounts as numbers — use strings to preserve precision.
- Do not put raw SQL outside `db.ts`.
- Do not add routes that trigger syncs on GET requests — sync is destructive (deletes PDNG) and must be explicitly invoked.
- Do not skip the KV mutex or move it inside `_runSync` — it must wrap the entire operation including the `releaseLock` in `finally`.
