#!/usr/bin/env bash
# Apply ONE SQL migration to a target database, safely.
#
# Replaces ad-hoc `psql -f` against prod (the thing that's bitten us): it makes
# the target environment EXPLICIT, shows which DB host you're about to touch
# (no creds), and requires confirmation — typing "prod" for production.
#
# The repo's drizzle journal only tracks ~2 of the ~35 migrations; the rest are
# hand-written SQL applied out-of-band. This is the sanctioned way to apply one.
# Migrations should be idempotent (CREATE OR REPLACE / IF NOT EXISTS / guarded).
#
# Usage:
#   scripts/db-apply.sh <dev|staging|prod> apps/agent/migrations/0036_xyz.sql
#
# Process for a new migration: apply to staging, verify, THEN prod.
set -euo pipefail

ENV="${1:-}"
FILE="${2:-}"
if [ -z "$ENV" ] || [ -z "$FILE" ]; then
  echo "usage: scripts/db-apply.sh <dev|staging|prod> <path/to/migration.sql>" >&2
  exit 2
fi
case "$ENV" in
  dev | staging | prod) ;;
  *) echo "env must be dev | staging | prod (got '$ENV')" >&2; exit 2 ;;
esac
if [ ! -f "$FILE" ]; then
  echo "no such file: $FILE" >&2
  exit 1
fi

echo "About to apply:"
echo "  file: $FILE"
echo "  env:  $ENV"
# Show the DB host/name only (strip user:pass before the @).
infisical run --env="$ENV" -- bash -c 'echo "  db:   ${DATABASE_URL##*@}"' 2>/dev/null || true

if [ "$ENV" = "prod" ]; then
  read -r -p 'This is PRODUCTION. Type "prod" to proceed: ' CONFIRM
  [ "$CONFIRM" = "prod" ] || { echo "aborted."; exit 1; }
else
  read -r -p "Apply to $ENV? [y/N] " CONFIRM
  case "$CONFIRM" in y | Y | yes) ;; *) echo "aborted."; exit 1 ;; esac
fi

infisical run --env="$ENV" -- bash -c 'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f "'"$FILE"'"'
echo "✓ applied $(basename "$FILE") to $ENV"
