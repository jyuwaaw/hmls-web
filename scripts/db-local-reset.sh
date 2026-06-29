#!/usr/bin/env bash
# Rebuild a Postgres DB from CODE (never a frozen dump), so it always matches
# packages/shared/src/db/schema.ts:
#   1. drop + recreate public schema
#   2. drizzle-kit push      → tables / indexes / FKs / CHECKs (from schema.ts)
#   3. apply local-seed.sql  → extension + functions + triggers + EXCLUDE + refdata
#
# Modes:
#   db-local-reset.sh          rebuild local Supabase (needs `supabase start`)
#   db-local-reset.sh check    CI gate: build into $DATABASE_URL, then assert a
#                              second push reports no changes (schema.ts == DB)
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-reset}"

if [ "$MODE" = "check" ]; then
  : "${DATABASE_URL:?check mode needs DATABASE_URL}"
  DB_URL="$DATABASE_URL"
else
  command -v supabase >/dev/null || { echo "supabase CLI not found" >&2; exit 1; }
  supabase status >/dev/null 2>&1 || { echo "Local Supabase not running — 'supabase start' first" >&2; exit 1; }
  eval "$(supabase status -o env)"   # sets DB_URL
fi

echo "→ reset public schema"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"

echo "→ drizzle push (schema.ts → DB)"
DATABASE_URL="$DB_URL" deno task --cwd apps/agent db:push --force

echo "→ apply local-seed.sql"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f scripts/local-seed.sql

if [ "$MODE" = "check" ]; then
  echo "→ drift check: second push must report no changes"
  out=$(DATABASE_URL="$DB_URL" deno task --cwd apps/agent db:push --force 2>&1 </dev/null || true)
  echo "$out"
  echo "$out" | grep -qiE "No changes detected" \
    || { echo "::error::schema.ts has drifted from the built DB (push wanted to change it)"; exit 1; }
fi

echo "✓ done → $DB_URL"
