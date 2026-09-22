#!/usr/bin/env bash
# 2ᵉ instance de l'API dédiée à R90 (D-R) : port 3100, base `settlements_r90` UNIQUEMENT (données + pg-boss), Valkey base n°1.
# Les variables d'environnement priment sur .env (dotenv n'écrase pas l'environnement réel). Aucun secret affiché.
# Usage : bash docs/work/r90-api.sh            (premier plan)      SETTLEMENT_*_WORKER_ENABLED=true bash docs/work/r90-api.sh
_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
_base="$(grep -E '^DATABASE_URL=' "$_root/.env" | head -1 | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$//')"
_base="${_base%\"}"; _base="${_base#\"}"
export DATABASE_URL="${_base%/*}/settlements_r90"
export PGBOSS_DATABASE_URL="$DATABASE_URL"
export VALKEY_URL="redis://localhost:6379/1"
export PORT="${R90_API_PORT:-3100}"
cd "$_root/apps/api" && exec npx tsx src/server.ts
