#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
osrm_route_url='http://localhost:5000/route/v1/bicycle/5.2255,46.2058;5.23,46.21'
api_pid=''
web_pid=''

cleanup() {
  local exit_status=$?
  trap - EXIT INT TERM

  if [[ -n "$api_pid" ]] && kill -0 "$api_pid" 2>/dev/null; then
    echo "Arrêt du serveur API (PID $api_pid)…"
    kill -TERM "-$api_pid" 2>/dev/null || true
    wait "$api_pid" 2>/dev/null || true
  fi

  if [[ -n "$web_pid" ]] && kill -0 "$web_pid" 2>/dev/null; then
    echo "Arrêt du serveur web (PID $web_pid)…"
    kill -TERM "-$web_pid" 2>/dev/null || true
    wait "$web_pid" 2>/dev/null || true
  fi

  exit "$exit_status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$repo_root"

if ! command -v setsid >/dev/null 2>&1; then
  echo "Erreur : la commande setsid est requise pour arrêter proprement les serveurs." >&2
  exit 1
fi

echo "[1/4] Démarrage de Supabase…"
if ! command -v timeout >/dev/null 2>&1; then
  echo "Erreur : la commande timeout est requise pour borner le démarrage de Supabase." >&2
  exit 1
fi
if command -v supabase >/dev/null 2>&1; then
  supabase_command=(supabase)
elif [[ -x "$repo_root/node_modules/.bin/supabase" ]]; then
  supabase_command=("$repo_root/node_modules/.bin/supabase")
else
  echo "Erreur : la CLI Supabase est introuvable. Exécutez npm install puis réessayez." >&2
  exit 1
fi
if ! timeout 120s "${supabase_command[@]}" start; then
  echo "Erreur : Supabase n’a pas démarré ou n’est pas devenu prêt dans les 120 secondes." >&2
  exit 1
fi

echo "[2/4] Vérification d’OSRM…"
if ! command -v curl >/dev/null 2>&1; then
  echo "Erreur : curl est requis pour vérifier OSRM." >&2
  exit 1
fi
if ! curl --fail --silent --show-error --max-time 3 "$osrm_route_url" -o /dev/null; then
  echo "Erreur : OSRM ne répond pas sur http://localhost:5000." >&2
  echo "Démarrez-le manuellement depuis ce dépôt, par exemple :" >&2
  printf '  docker run --rm -p 5000:5000 -v "%s/infra/osrm/data:/data" ghcr.io/project-osrm/osrm-backend:latest osrm-routed --algorithm mld /data/bourg-en-bresse.osrm\n' "$repo_root" >&2
  exit 1
fi

echo "[3/4] Démarrage de l’API Fastify…"
pushd "$repo_root/apps/api" >/dev/null
setsid npm run dev &
api_pid=$!
popd >/dev/null

api_ready=false
api_wait_start=$SECONDS
for attempt in {1..30}; do
  if curl --fail --silent --show-error --max-time 1 http://localhost:3000/health -o /dev/null; then
    api_ready=true
    break
  fi
  if ! kill -0 "$api_pid" 2>/dev/null; then
    echo "Erreur : l’API s’est arrêtée avant de répondre sur /health." >&2
    exit 1
  fi
  for _ in {1..2}; do
    sleep 1
    api_wait_elapsed=$((SECONDS - api_wait_start))
    if (( api_wait_elapsed > 0 && api_wait_elapsed % 5 == 0 )); then
      echo "En attente de l’API... (${api_wait_elapsed}s)"
    fi
  done
done

if [[ "$api_ready" != true ]]; then
  echo "Erreur : l’API n’a pas répondu sur http://localhost:3000/health après 60 secondes." >&2
  exit 1
fi

echo "[4/4] Démarrage de Next.js (web)…"
setsid npm run dev -w apps/web &
web_pid=$!

web_ready=false
for attempt in {1..60}; do
  if curl --fail --silent --show-error --max-time 2 http://localhost:4000/login -o /dev/null; then
    web_ready=true
    break
  fi
  if ! kill -0 "$web_pid" 2>/dev/null; then
    echo "Erreur : le serveur web s’est arrêté avant de répondre sur /login." >&2
    exit 1
  fi
  sleep 1
done

if [[ "$web_ready" != true ]]; then
  echo "Erreur : le serveur web n’a pas répondu sur http://localhost:4000/login après 180 secondes." >&2
  exit 1
fi

echo "API prête sur http://localhost:3000 et web prêt sur http://localhost:4000. Ctrl+C arrête tout proprement."
wait
