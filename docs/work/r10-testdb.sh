#!/usr/bin/env bash
# Base ISOLÉE `settlements_r10` pour R10 : jamais la base de dev partagée.
# Usage :  source docs/work/r10-testdb.sh          -> exporte DATABASE_URL vers settlements_r10
#          source docs/work/r10-testdb.sh reset    -> recrée la base (migrations 0001+ dans l'ordre + seed) puis exporte
# Ne lit .env que pour dériver l'URL ; n'affiche jamais de secret.
_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
_base="$(grep -E '^DATABASE_URL=' "$_root/.env" | head -1 | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$//')"
_base="${_base%\"}"; _base="${_base#\"}"
_admin="$_base"
_target="${_base%/*}/settlements_r10"
if [ "${1:-}" = "reset" ]; then
  local_opts="-c client_min_messages=error"
  PGOPTIONS="$local_opts" psql "$_admin" -q -c "drop database if exists settlements_r10" -c "create database settlements_r10" || return 1
  PGOPTIONS="$local_opts" psql "$_target" -q -c "create schema if not exists extensions" -c "create extension if not exists postgis with schema extensions" || return 1
  for f in "$_root"/supabase/migrations/*.sql; do
    PGOPTIONS="$local_opts" psql "$_target" -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null || { echo "MIGRATION FAILED: $f"; return 1; }
  done
  PGOPTIONS="$local_opts" psql "$_target" -q -v ON_ERROR_STOP=1 -f "$_root/supabase/seed.sql" >/dev/null || { echo "SEED FAILED"; return 1; }
  echo "settlements_r10 recréée (migrations + seed)."
fi
export DATABASE_URL="$_target"
unset _root _base _admin _target local_opts
