#!/usr/bin/env bash
# bootstrap.sh — One-time setup for neo-banklink secrets and infrastructure.
#
# Prerequisites:
#   - wrangler installed and authenticated (`wrangler login`)
#   - wrangler.toml updated with correct D1 database_id and KV namespace id
#
# Usage:
#   chmod +x scripts/bootstrap.sh
#   ./scripts/bootstrap.sh

set -euo pipefail

echo "=== neo-banklink bootstrap ==="
echo ""

# ---------------------------------------------------------------------------
# 1. Create Cloudflare infrastructure (skip if already exists)
# ---------------------------------------------------------------------------

echo "--- Creating D1 database ---"
echo "Run the following and copy the database_id into wrangler.toml:"
echo "  npx wrangler d1 create neo-banklink"
echo ""

echo "--- Creating KV namespace ---"
echo "Run the following and copy the id into wrangler.toml:"
echo "  npx wrangler kv:namespace create neo-banklink"
echo ""

# ---------------------------------------------------------------------------
# 2. Apply D1 migrations
# ---------------------------------------------------------------------------

echo "--- Applying D1 migrations (local) ---"
npx wrangler d1 migrations apply neo-banklink --local

echo ""
echo "--- Applying D1 migrations (remote) ---"
echo "Run when ready to deploy:"
echo "  npx wrangler d1 migrations apply neo-banklink"
echo ""

# ---------------------------------------------------------------------------
# 3. Set secrets
# ---------------------------------------------------------------------------

echo "--- Setting Cloudflare Worker secrets ---"
echo "You will be prompted for each value."
echo ""

echo "[1/8] Enable Banking App ID"
npx wrangler secret put ENABLE_BANKING_APP_ID

echo ""
echo "[2/8] Enable Banking RSA Private Key (paste PEM, then Ctrl+D)"
npx wrangler secret put ENABLE_BANKING_PRIVATE_KEY

echo ""
echo "[3/8] Enable Banking Session ID (initial session — will be replaced after /reauth)"
npx wrangler secret put ENABLE_BANKING_SESSION_ID

echo ""
echo "[3b] Enable Banking Session valid_until (ISO date from the session response, e.g. 2025-12-31)"
echo "     Note: this is auto-populated after completing /reauth + /callback. Only needed for initial setup."
read -r -p "valid_until: " VALID_UNTIL
npx wrangler kv:key put --binding=KV "session:valid_until" "$VALID_UNTIL"

echo ""
echo "[4/8] Enable Banking Account IDs (JSON array, e.g. [\"acc_abc123\"])"
echo "      Note: auto-populated after /reauth + /callback with the accounts from the new session."
npx wrangler secret put ENABLE_BANKING_ACCOUNT_IDS

echo ""
echo "[5/8] Airtable API Key"
npx wrangler secret put AIRTABLE_API_KEY

echo ""
echo "[6/8] Airtable Base ID (starts with 'app')"
npx wrangler secret put AIRTABLE_BASE_ID

echo ""
echo "[7/8] Airtable Table Name"
npx wrangler secret put AIRTABLE_TABLE_NAME

echo ""
echo "[8/8] Admin Secret (random string for manual HTTP trigger auth)"
npx wrangler secret put ADMIN_SECRET

# ---------------------------------------------------------------------------
# 4. Optional: ASPSP defaults for /reauth endpoint
# ---------------------------------------------------------------------------

echo ""
echo "--- Optional: Enable Banking ASPSP defaults for /reauth endpoint ---"
echo "These can also be passed as query params to /reauth, so they are optional."
echo ""

echo "[opt-1/3] ASPSP name (e.g. 'Nordea' — leave blank to skip)"
read -r -p "ASPSP name: " ASPSP_NAME
if [ -n "$ASPSP_NAME" ]; then
  echo "$ASPSP_NAME" | npx wrangler secret put ENABLE_BANKING_ASPSP_NAME
fi

echo ""
echo "[opt-2/3] ASPSP country code (e.g. 'FI' — leave blank to skip)"
read -r -p "ASPSP country: " ASPSP_COUNTRY
if [ -n "$ASPSP_COUNTRY" ]; then
  echo "$ASPSP_COUNTRY" | npx wrangler secret put ENABLE_BANKING_ASPSP_COUNTRY
fi

echo ""
echo "[opt-3/3] PSU type ('personal' or 'business' — leave blank to use default 'personal')"
read -r -p "PSU type: " PSU_TYPE
if [ -n "$PSU_TYPE" ]; then
  echo "$PSU_TYPE" | npx wrangler secret put ENABLE_BANKING_PSU_TYPE
fi

echo ""
echo "=== Bootstrap complete ==="
echo "Deploy with: git push  (Cloudflare Workers is linked to the GitHub repo)"
echo ""
echo "Manual sync:    curl -X POST https://banklink.interne.neosolsetmurs.fr -H 'Authorization: Bearer <ADMIN_SECRET>'"
echo "Status:         curl https://banklink.interne.neosolsetmurs.fr/status -H 'Authorization: Bearer <ADMIN_SECRET>'"
echo "Re-authorize:   open https://banklink.interne.neosolsetmurs.fr/reauth in a browser"
echo "Tail logs:      npx wrangler tail"
