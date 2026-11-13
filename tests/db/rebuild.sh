#!/bin/bash
# Rebuilds a disposable local database from the repo migrations, in order, on the Supabase stand-in (tests/db/shim.sql).
# Usage: tests/db/rebuild.sh <database-name>   (run as a user that can administer local PostgreSQL)
# STOP_BEFORE=0008_information.sql builds the database only up to that migration (used by the backfill test).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
DB=$1
su postgres -c "psql -q -c 'drop database if exists $DB'" 2>/dev/null
su postgres -c "psql -q -c 'create database $DB'"
su postgres -c "psql -q -d $DB -f $DIR/shim.sql" >/dev/null 2>&1
for f in $(ls "$DIR/../../supabase/migrations/"*.sql | sort); do
  if [ -n "$STOP_BEFORE" ] && [[ "$(basename "$f")" > "$STOP_BEFORE" ]]; then break; fi
  su postgres -c "psql -q -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>/tmp/rb_err.log || { echo "migration failed: $f"; cat /tmp/rb_err.log; exit 1; }
done
echo "database $DB built"
