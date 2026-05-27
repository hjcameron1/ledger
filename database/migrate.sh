#!/usr/bin/env bash
# Ledger database migration runner
# Usage: ./database/migrate.sh [DB_PASSWORD]
#
# DB_PASSWORD can also be set via environment variable:
#   export LEDGER_DB_PASSWORD="your-password"
#   ./database/migrate.sh
#
# Find your password in Supabase Dashboard → Project Settings → Database

set -e

PSQL="/opt/homebrew/opt/libpq/bin/psql"
PROJECT_REF="prdnvzwayxjtbktywexq"
DB_HOST="db.${PROJECT_REF}.supabase.co"
DB_PORT="5432"
DB_USER="postgres"
DB_NAME="postgres"
SCHEMA_FILE="$(dirname "$0")/schema.sql"

# Get password from arg or env
DB_PASSWORD="${1:-$LEDGER_DB_PASSWORD}"

if [ -z "$DB_PASSWORD" ]; then
  echo "❌  DB_PASSWORD required."
  echo "   Usage: ./database/migrate.sh <your-db-password>"
  echo "   Find it: Supabase Dashboard → Project Settings → Database → Connection string"
  exit 1
fi

echo "🔌  Connecting to ${DB_HOST}..."
PGPASSWORD="$DB_PASSWORD" "$PSQL" \
  "postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}?sslmode=require" \
  -f "$SCHEMA_FILE" \
  -v ON_ERROR_STOP=0 \
  2>&1

echo ""
echo "✅  Migration complete."
