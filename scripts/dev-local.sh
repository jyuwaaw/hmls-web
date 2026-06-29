#!/usr/bin/env bash
# Run a dev server against the LOCAL Supabase stack (`supabase start`) instead of
# the prod Supabase — so testing never touches prod data.
#
# DB + auth point at local (keys pulled live from `supabase status`, always
# current). Non-DB secrets (Stripe / Google / DeepSeek / Resend) still come from
# Infisical, so the app is otherwise fully wired.
#
# Prereq: Docker running + `supabase start`.
# Usage: scripts/dev-local.sh [api|web]   (default: api)
set -euo pipefail
cd "$(dirname "$0")/.."

if ! supabase status >/dev/null 2>&1; then
  echo "Local Supabase isn't running. Start it first:  supabase start" >&2
  exit 1
fi

# Sets DB_URL, API_URL, ANON_KEY, SERVICE_ROLE_KEY, JWT_SECRET, ...
eval "$(supabase status -o env)"

LOCAL_ENV=(
  "DATABASE_URL=$DB_URL"
  "SUPABASE_URL=$API_URL"
  "SUPABASE_ANON_KEY=$ANON_KEY"
  "SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY"
  "SUPABASE_JWT_SECRET=$JWT_SECRET"
)

case "${1:-api}" in
  api)
    echo "API → local Supabase ($DB_URL)"
    infisical run --env=dev -- env "${LOCAL_ENV[@]}" deno task dev:api
    ;;
  web)
    echo "web → local Supabase ($API_URL), API at localhost:8080"
    cd apps/hmls-web
    infisical run --env=dev -- env \
      GATEWAY_URL=http://localhost:8080 \
      NEXT_PUBLIC_SUPABASE_URL="$API_URL" \
      NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY" \
      "${LOCAL_ENV[@]}" \
      bun run dev
    ;;
  *)
    echo "usage: scripts/dev-local.sh [api|web]" >&2
    exit 2
    ;;
esac
