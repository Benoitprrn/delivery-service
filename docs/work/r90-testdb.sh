#!/usr/bin/env bash
# Base JETABLE `settlements_r90` pour R90 (D-R) : jamais la base de dev partagée.
# Usage :  source docs/work/r90-testdb.sh reset    -> drop + create + migrations 0001+ dans l'ordre + seed, puis exporte DATABASE_URL
#          source docs/work/r90-testdb.sh go-live  -> pose `go_live_at` de TEST UNE fois (refuse si déjà posé ; aucun trigger touché)
#          source docs/work/r90-testdb.sh drop     -> supprime la base entière (fin de run)
#          source docs/work/r90-testdb.sh          -> exporte seulement DATABASE_URL
# `pgcrypto` est créée dans le schéma `extensions` comme sur Supabase (la migration 0001 devient alors un no-op, comme en dev) ; PostGIS n'est utilisée par aucune migration.
# Ne lit .env que pour dériver l'URL ; n'affiche jamais de secret. Ne pas utiliser dans un pipe (l'environnement serait perdu).
_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
_base="$(grep -E '^DATABASE_URL=' "$_root/.env" | head -1 | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$//')"
_base="${_base%\"}"; _base="${_base#\"}"
_admin="$_base"
_target="${_base%/*}/settlements_r90"
_opts="-c client_min_messages=error"
# Lundi 2026-08-24 00:00 Europe/Paris = 2026-08-23T22:00:00Z (début de la semaine simulée). Le calendrier simulé DOIT rester dans le passé réel : les gardes PostgreSQL
# (pré-notification 2 jours, date de prélèvement, `payrun_at`) comparent aux `now()` réels de la base et ne sont jamais contournées.
R90_GO_LIVE_AT="${R90_GO_LIVE_AT:-2026-08-23T22:00:00Z}"
case "${1:-}" in
  reset)
    PGOPTIONS="$_opts" psql "$_admin" -q -c "drop database if exists settlements_r90 with (force)" -c "create database settlements_r90" || return 1
    PGOPTIONS="$_opts" psql "$_target" -q -c "create schema if not exists extensions" -c "create extension if not exists pgcrypto with schema extensions" || return 1
    for f in "$_root"/supabase/migrations/*.sql; do
      PGOPTIONS="$_opts" psql "$_target" -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null || { echo "MIGRATION FAILED: $f"; return 1; }
    done
    PGOPTIONS="$_opts" psql "$_target" -q -v ON_ERROR_STOP=1 -f "$_root/supabase/seed.sql" >/dev/null || { echo "SEED FAILED"; return 1; }
    echo "settlements_r90 recréée (migrations + seed)."
    ;;
  go-live)
    PGOPTIONS="$_opts" psql "$_target" -q -At -v ON_ERROR_STOP=1 -v gl="$R90_GO_LIVE_AT" <<'SQL' || return 1
update public.settlement_settings set go_live_at = :'gl'::timestamptz where id = true and go_live_at is null;
select 'go_live_at = ' || go_live_at from public.settlement_settings;
SQL
    ;;
  drop)
    PGOPTIONS="$_opts" psql "$_admin" -q -c "drop database if exists settlements_r90 with (force)" || return 1
    echo "settlements_r90 supprimée."
    ;;
esac
export DATABASE_URL="$_target"
unset _root _base _admin _target _opts
