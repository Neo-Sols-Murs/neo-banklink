# Changelog

All notable changes to neo-banklink are documented here.

## [0.3.0] — 2026-04-09

### Added
- `loggedFetch` wrapper in `EnableBankingClient`: every outbound request and response body (truncated to 2000 chars) is logged via `console.log` for `wrangler tail` visibility
- `getAspsp()` method: fetches ASPSP details from `GET /aspsps/{name}/{country}` before initiating auth
- `valid_until` is now capped to the ASPSP's `maximum_consent_validity` minus a 1-hour safety margin
- `EBASPSPDetails` and `EBSessionAccess` types added to `types.ts`
- Log of resolved `aspsp_name`, `aspsp_country`, `psu_type` and their source (query param vs. secret) on every `/reauth` request
- KV-based mutex (`sync:lock`, TTL 300s) in `runSync` to prevent concurrent cron + queue invocations from racing and creating duplicate PDNG records

### Changed
- `POST /sync` (requires `ADMIN_SECRET`) replaces the previous catch-all manual sync trigger — any other unknown path now returns `404 Not Found`
- Session `valid_until` now correctly read from `session.access.valid_until` (was incorrectly reading the non-existent top-level `valid_until` field)
- `EBSessionResponse` type updated to reflect the actual Enable Banking API shape: `valid_until` lives inside `access`, accounts contain a nested `account_id.iban` object
- Callback success page now correctly displays IBAN from `account_id.iban`

### Fixed
- `session:valid_until` KV key was being set to `undefined` after `/callback` due to wrong field path
- Duplicate PDNG transactions in Airtable caused by concurrent cron and queue worker runs

## [0.2.2] — 2026-04-09

### Fixed
- `valid_until` sent to Enable Banking `/auth` now includes a timezone offset (`T00:00:00+00:00`) instead of a bare date string, fixing a 422 error from the API

## [0.2.1] — 2026-04-09

### Changed
- Cloudflare observability traces enabled in `wrangler.toml` (`observability.traces.enabled = true`, `persist = true`)

## [0.2.0] — 2026-04-08

### Added
- `GET /reauth` — initiates the Enable Banking OAuth flow; redirects the user to the bank auth URL. CSRF-protected via a KV-stored state token (10-minute TTL). Accepts `aspsp_name`, `aspsp_country`, `psu_type` as query params or falls back to Worker secrets.
- `GET /callback` — exchanges the OAuth code for a session; validates CSRF state; stores `session:id`, `session:valid_until`, `session:account_ids` in KV; renders a success HTML page with linked accounts
- `GET /status` — admin endpoint (requires `Authorization: Bearer <ADMIN_SECRET>`); returns session health, days remaining, per-account D1 stats, sync last-run time, KV cursor values, and account ID source
- Session ID and account ID resolution: KV values (set by `/callback`) take priority over env secrets, enabling seamless re-auth without redeployment
- `sync:last_run` KV key updated at the start of every sync run for observability
- Session expiry warning when fewer than 7 days remain; hard error when already expired
- `src/utils.ts` with `addDays` helper

### Changed
- Sync logging uses consistent `[sync][account:{id}]` prefixes throughout
- Silent failures in sync now emit `console.warn` or `console.error`

### Fixed
- `ScheduledEvent` → `ScheduledController` type error in `src/index.ts`

## [0.1.0] — 2026-04-08

### Added
- Initial Cloudflare Workers project: TypeScript, Wrangler, `jose` for JWT signing
- `src/sync.ts`: core sync engine with 90-day fetch windowing, BOOK upsert via `entry_reference`, PDNG delete-and-reinsert on catch-up, self-chaining via Cloudflare Queue, Airtable push with 50-record cap per invocation
- `src/db.ts`: D1 helpers — `upsertTransactions`, `insertPendingTransactions`, `deletePendingTransactions`, `getPendingAirtableIds`, `getUnsynced`, `countUnsynced`, `setAirtableRecordIds`, `getLatestBookedDate`, `getAccountStats`
- `src/clients/enablebanking.ts`: JWT-authenticated Enable Banking client — `initiateAuth`, `exchangeCode`, `fetchAllTransactions` with pagination
- `src/clients/airtable.ts`: Airtable client — `createRecords` (batched, 10/req, rate-limited), `deleteRecords`
- `src/index.ts`: Worker entrypoint — cron trigger, HTTP fetch handler, queue consumer
- `src/types.ts`: full type definitions for Enable Banking API responses and internal DB rows
- `migrations/0001_init.sql`: `transactions` table with partial indexes on `status='PDNG'`, `airtable_record_id IS NULL`, and `(account_id, booking_date)`
- `wrangler.toml`: D1, KV, Queues, cron (`0 * * * *`) bindings
- `scripts/bootstrap.sh`: interactive setup script for secrets, infrastructure, and migrations
