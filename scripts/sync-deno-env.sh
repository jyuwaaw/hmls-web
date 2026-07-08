#!/usr/bin/env bash
# Push the API's secrets from Infisical (the single source of truth) to the
# Deno Deploy app, so you change a secret in ONE place instead of three.
#
# Web secrets (NEXT_PUBLIC_*, Vercel-side) are NOT synced here — those flow
# Infisical -> Vercel via Infisical's Vercel integration. This script only
# covers the Deno Deploy API.
#
# Usage:
#   scripts/sync-deno-env.sh <dev|staging|prod>
set -euo pipefail

ENV="${1:-}"
APP="hmls-api"
ORG="spinsirr"
if [ -z "$ENV" ]; then
  echo "usage: scripts/sync-deno-env.sh <dev|staging|prod>" >&2
  exit 2
fi

# The secrets the API actually needs. Add new API secrets here.
KEYS="DATABASE_URL TENANT_DATABASE_URL GOOGLE_API_KEY DEEPSEEK_API_KEY HMLS_AGENT_MODEL AGENT_MODEL \
STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET SUPABASE_URL SUPABASE_ANON_KEY \
SUPABASE_SERVICE_ROLE_KEY SUPABASE_JWT_SECRET RESEND_API_KEY OLP_WORKER_URL \
NOTIFY_FROM_EMAIL"

echo "Syncing API secrets: Infisical/$ENV -> Deno Deploy $APP ($ORG)"
DOTENV="$(infisical export --env="$ENV" --format=dotenv 2>/dev/null || true)"
if [ -z "$DOTENV" ]; then
  echo "could not read Infisical env '$ENV' (logged in?)" >&2
  exit 1
fi

for k in $KEYS; do
  # Pull the value, strip surrounding quotes if any.
  v="$(printf '%s\n' "$DOTENV" | sed -n "s/^${k}=//p" | head -1 | sed -e 's/^"//' -e 's/"$//')"
  if [ -n "$v" ]; then
    deno deploy env add "$k" "$v" --app "$APP" --org "$ORG" --secret >/dev/null 2>&1 &&
      echo "  ✓ $k" || echo "  ! $k (deno deploy env add failed)"
  else
    echo "  - $k (absent in Infisical/$ENV, skipped)"
  fi
done
echo "Done. (Web secrets sync via Infisical's Vercel integration, not this script.)"
