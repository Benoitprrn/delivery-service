#!/usr/bin/env bash
# Base JETABLE `driver_signup_r54` pour l'inscription livreur / migration 0054 (D-R) :
# driver_terms_acceptances est append-only (trigger) et drivers.id lui est référencé
# sans cascade une fois une inscription finalisée — un livreur inscrit avec succès
# devient donc réellement indélébile, comme un vrai compte. Jamais la base de dev partagée.
# Usage :  source docs/work/r54-testdb.sh reset   -> drop + create + migrations 0001+ dans l'ordre, exporte DATABASE_URL
#          source docs/work/r54-testdb.sh drop    -> supprime la base entière (fin de run)
# Ne lit .env que pour dériver l'URL ; n'affiche jamais de secret. Ne pas utiliser dans un pipe (l'environnement serait perdu).
_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
_base="$(grep -E '^DATABASE_URL=' "$_root/.env" | head -1 | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$//')"
_base="${_base%\"}"; _base="${_base#\"}"
_admin="$_base"
_target="${_base%/*}/driver_signup_r54"
_opts="-c client_min_messages=error"
case "${1:-}" in
  reset)
    PGOPTIONS="$_opts" psql "$_admin" -q -c "drop database if exists driver_signup_r54 with (force)" -c "create database driver_signup_r54" || return 1
    PGOPTIONS="$_opts" psql "$_target" -q -c "create schema if not exists extensions" -c "create extension if not exists pgcrypto with schema extensions" || return 1
    for f in "$_root"/supabase/migrations/*.sql; do
      PGOPTIONS="$_opts" psql "$_target" -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null || { echo "MIGRATION FAILED: $f"; return 1; }
    done
    PGOPTIONS="$_opts" psql "$_target" -q -v ON_ERROR_STOP=1 -f "$_root/supabase/seed.sql" >/dev/null || { echo "SEED FAILED"; return 1; }
    echo "driver_signup_r54 recréée (migrations + seed)."
    ;;
  drop)
    PGOPTIONS="$_opts" psql "$_admin" -q -c "drop database if exists driver_signup_r54 with (force)" || return 1
    echo "driver_signup_r54 supprimée."
    ;;
esac
export DATABASE_URL="$_target"
unset _root _base _admin _target _opts
