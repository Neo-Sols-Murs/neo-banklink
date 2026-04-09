# neo-banklink

A Cloudflare Workers service that syncs bank transactions from [Enable Banking](https://enablebanking.com) into an Airtable base. It runs on a hourly cron, self-chains via Cloudflare Queues for backfill, and exposes a small HTTP API for auth management and observability.

**Deployed at:** `https://banklink.interne.neosolsetmurs.fr`

---

## Overview

```
Enable Banking API
       │
       │  OAuth (ASPSP redirect)
       ▼
  /reauth → /callback ──► KV (session_id, valid_until, account_ids)
                                │
                          Hourly cron
                                │
                          sync engine
                          ├── fetch transactions (90-day window)
                          ├── upsert BOOK txs → D1
                          ├── reset PDNG txs → D1
                          └── push unsynced → Airtable
```

Transactions are fetched from Enable Banking, stored in a Cloudflare D1 database, and pushed to Airtable. The D1 database is the source of truth; Airtable is the destination. The sync is idempotent for booked transactions (upsert by stable ID) and fully-replaced for pending ones (no stable ID exists).

---

## Architecture

### Storage

| Store | Purpose |
|---|---|
| **D1** | Persistent transaction storage. Primary key is `entry_reference` for BOOK, random UUID for PDNG. |
| **KV** | Ephemeral state: session ID, session expiry, fetch/book cursors, sync lock, last-run timestamp. |

### Sync engine

The sync runs per-account in sequence. For each account:

1. **Backlog check** — if there are transactions not yet pushed to Airtable, drain them before fetching new data.
2. **Fetch window** — fetches up to 90 days of transactions at a time. A `fetch-cursor` KV key tracks the next window start. When backfilling, advances window-by-window. When caught up, always re-fetches from 2 days ago (Enable Banking requires a minimum window).
3. **BOOK upsert** — inserted/updated in D1 using `entry_reference` as the stable primary key.
4. **PDNG reset** (caught-up only) — existing PDNG records are deleted from Airtable and D1, then fresh ones are inserted. PDNG transactions have no stable ID from the bank, so they must be fully replaced every cycle.
5. **Airtable push** — up to 50 unsynced transactions are pushed per invocation. After each batch, Airtable record IDs are written back to D1.

If more work remains (backlog not drained, or still backfilling), the worker enqueues itself via Cloudflare Queues for an immediate follow-up run.

A KV mutex (`sync:lock`, 5-minute TTL) prevents concurrent cron and queue runs from racing.

### HTTP endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/reauth` | none | Starts OAuth flow; redirects to bank login page |
| `GET` | `/callback` | none (CSRF via state token) | Exchanges OAuth code; stores session in KV |
| `GET` | `/status` | Bearer `ADMIN_SECRET` | Session health, account stats, cursor values |
| `POST` | `/sync` | Bearer `ADMIN_SECRET` | Manually triggers a sync run |

### Enable Banking OAuth flow

```
Browser → GET /reauth
        → Worker generates state token (KV, 10min TTL)
        → Fetches ASPSP details to determine max consent duration
        → POSTs to Enable Banking /auth
        → 302 redirect to bank login page
Bank login → GET /callback?code=…&state=…
           → Worker validates state (CSRF check)
           → POSTs to Enable Banking /sessions to exchange code
           → Stores session_id, valid_until, account_ids in KV
           → Renders success HTML
```

---

## Setup

### Prerequisites

- Node.js + npm
- Wrangler CLI authenticated (`wrangler login`)
- Enable Banking account with an app (RSA key pair)
- Airtable base with a transactions table

### First-time setup

```bash
# 1. Create Cloudflare infrastructure and note the IDs
npx wrangler d1 create neo-banklink
npx wrangler kv:namespace create neo-banklink
# → update wrangler.toml with the returned database_id and KV id

# 2. Apply DB migrations
npm run db:migrate:remote

# 3. Set secrets interactively
./scripts/bootstrap.sh
```

### Required secrets

| Secret | Description |
|---|---|
| `ENABLE_BANKING_APP_ID` | Enable Banking application UUID |
| `ENABLE_BANKING_PRIVATE_KEY` | RSA private key (PEM) for JWT signing |
| `ENABLE_BANKING_SESSION_ID` | Initial session ID (replaced after first /reauth) |
| `ENABLE_BANKING_ACCOUNT_IDS` | JSON array of account UIDs (replaced after /reauth) |
| `AIRTABLE_API_KEY` | Airtable personal access token |
| `AIRTABLE_BASE_ID` | Airtable base ID (starts with `app`) |
| `AIRTABLE_TABLE_NAME` | Name of the target Airtable table |
| `ADMIN_SECRET` | Bearer token for `/status` and `/sync` |

### Optional secrets (ASPSP defaults for /reauth)

| Secret | Description |
|---|---|
| `ENABLE_BANKING_ASPSP_NAME` | Bank name (e.g. `Société Générale Professionnels`) |
| `ENABLE_BANKING_ASPSP_COUNTRY` | ISO country code (e.g. `FR`) |
| `ENABLE_BANKING_PSU_TYPE` | `personal` or `business` (default: `personal`) |

### Deploy

```bash
npm run deploy
```

---

## Operations

### Re-authorize (when session expires)

Open `/reauth` in a browser. No query params needed if ASPSP secrets are configured.

```
https://banklink.interne.neosolsetmurs.fr/reauth
```

### Check status

```bash
curl https://banklink.interne.neosolsetmurs.fr/status \
  -H "Authorization: Bearer <ADMIN_SECRET>"
```

### Trigger a manual sync

```bash
curl -X POST https://banklink.interne.neosolsetmurs.fr/sync \
  -H "Authorization: Bearer <ADMIN_SECRET>"
```

### Tail logs

```bash
npx wrangler tail
```

---

## Local development

```bash
npm run dev
# applies local D1 migrations automatically via wrangler dev
```

---

## Project structure

```
src/
  index.ts              Worker entrypoint (cron, fetch, queue handlers)
  auth.ts               /reauth and /callback handlers
  sync.ts               Sync engine (per-account orchestration)
  db.ts                 D1 query helpers
  status.ts             /status handler
  types.ts              TypeScript types
  utils.ts              addDays helper
  clients/
    enablebanking.ts    Enable Banking API client (JWT auth, logged fetch)
    airtable.ts         Airtable API client (batched create/delete)
migrations/
  0001_init.sql         transactions table schema
scripts/
  bootstrap.sh          Interactive first-time setup
wrangler.toml           Cloudflare bindings (D1, KV, Queue, cron)
```
