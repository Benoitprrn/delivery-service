#!/usr/bin/env bash
# Base JETABLE `invoices_r47` pour l'Étape 4 / migration 0047 (D-R) : jamais la base de dev partagée.
# Usage :  source docs/work/r47-testdb.sh reset   -> drop + create + migrations 0001+ dans l'ordre + seed, puis exporte DATABASE_URL
#          source docs/work/r47-testdb.sh drop    -> supprime la base entière (fin de run)
#          source docs/work/r47-testdb.sh          -> exporte seulement DATABASE_URL
# Ne lit .env que pour dériver l'URL ; n'affiche jamais de secret. Ne pas utiliser dans un pipe (l'environnement serait perdu).
_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
_base="$(grep -E '^DATABASE_URL=' "$_root/.env" | head -1 | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$//')"
_base="${_base%\"}"; _base="${_base#\"}"
_admin="$_base"
_target="${_base%/*}/invoices_r47"
_opts="-c client_min_messages=error"
case "${1:-}" in
  reset)
    PGOPTIONS="$_opts" psql "$_admin" -q -c "drop database if exists invoices_r47 with (force)" -c "create database invoices_r47" || return 1
    PGOPTIONS="$_opts" psql "$_target" -q -c "create schema if not exists extensions" -c "create extension if not exists pgcrypto with schema extensions" || return 1
    for f in "$_root"/supabase/migrations/*.sql; do
      PGOPTIONS="$_opts" psql "$_target" -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null || { echo "MIGRATION FAILED: $f"; return 1; }
    done
    PGOPTIONS="$_opts" psql "$_target" -q -v ON_ERROR_STOP=1 -f "$_root/supabase/seed.sql" >/dev/null || { echo "SEED FAILED"; return 1; }
    echo "invoices_r47 recréée (migrations + seed)."
    ;;
  upto-0046)
    PGOPTIONS="$_opts" psql "$_admin" -q -c "drop database if exists invoices_r47 with (force)" -c "create database invoices_r47" || return 1
    PGOPTIONS="$_opts" psql "$_target" -q -c "create schema if not exists extensions" -c "create extension if not exists pgcrypto with schema extensions" || return 1
    for f in "$_root"/supabase/migrations/*.sql; do
      base="$(basename "$f")"
      num="${base%%_*}"
      if [ "$num" -gt 46 ] 2>/dev/null; then continue; fi
      PGOPTIONS="$_opts" psql "$_target" -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null || { echo "MIGRATION FAILED: $f"; return 1; }
    done
    PGOPTIONS="$_opts" psql "$_target" -q -v ON_ERROR_STOP=1 -f "$_root/supabase/seed.sql" >/dev/null || { echo "SEED FAILED"; return 1; }
    echo "invoices_r47 recréée jusqu'à 0046 (migrations + seed)."
    ;;
  apply-0047)
    PGOPTIONS="$_opts" psql "$_target" -q -v ON_ERROR_STOP=1 -f "$_root/supabase/migrations/0047_invoice_engine.sql" >/dev/null || { echo "MIGRATION 0047 FAILED"; return 1; }
    echo "0047 appliquée sur invoices_r47."
    ;;
  drop)
    PGOPTIONS="$_opts" psql "$_admin" -q -c "drop database if exists invoices_r47 with (force)" || return 1
    echo "invoices_r47 supprimée."
    ;;
esac
export DATABASE_URL="$_target"
unset _root _base _admin _target _opts
