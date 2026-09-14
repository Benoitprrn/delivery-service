#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail_http() {
  local step=$1
  local status_code=$2
  local response_body=$3
  local reason=$4

  echo "Erreur à l’étape $step : $reason" >&2
  echo "Code HTTP reçu : $status_code" >&2
  echo "Corps de la réponse : $response_body" >&2
  exit 1
}

request() {
  local step=$1
  local method=$2
  local url=$3
  local payload=${4:-}
  local response

  if [[ -n "$payload" ]]; then
    if ! response="$(curl --silent --show-error --max-time 10 --request "$method" \
      --header "apikey: $service_role_key" \
      --header "Authorization: Bearer $service_role_key" \
      --header 'Content-Type: application/json' \
      --data "$payload" \
      --write-out $'\n%{http_code}' \
      "$url")"; then
      fail_http "$step" 000 "${response:-}" 'La requête curl a échoué.'
    fi
  elif ! response="$(curl --silent --show-error --max-time 10 --request "$method" \
    --header "apikey: $service_role_key" \
    --header "Authorization: Bearer $service_role_key" \
    --write-out $'\n%{http_code}' \
    "$url")"; then
    fail_http "$step" 000 "${response:-}" 'La requête curl a échoué.'
  fi

  response_status="${response##*$'\n'}"
  response_body="${response%$'\n'*}"
}

parse_status_value() {
  local key=$1
  local status_env=$2
  local line

  while IFS= read -r line; do
    if [[ "$line" =~ ^${key}=\"([^\"]*)\"$ ]]; then
      printf '%s\n' "${BASH_REMATCH[1]}"
      return 0
    fi
  done <<<"$status_env"

  return 1
}

seed_account() {
  local step_check=$1
  local step_create=$2
  local label=$3
  local email=$4
  local password=$5
  local id=$6
  local role=$7
  local app_metadata
  local create_payload
  local account_status

  echo "[$step_check/6] Vérification de l’existence du compte $label de test…"
  request "$step_check" GET "$api_url/auth/v1/admin/users/$id"
  case "$response_status" in
    200)
      account_status='déjà existant'
      ;;
    404)
      account_status='à créer'
      ;;
    *)
      fail_http "$step_check" "$response_status" "$response_body" 'La vérification du compte a échoué.'
      ;;
  esac

  if [[ "$account_status" == 'à créer' ]]; then
    echo "[$step_create/6] Création du compte $label de test…"
    if [[ "$role" == 'merchant' ]]; then
      app_metadata="$(jq -n --arg id "$id" '{role: "merchant", merchant_id: $id}')"
    else
      app_metadata="$(jq -n --arg role "$role" '{role: $role}')"
    fi
    create_payload="$(jq -n \
      --arg id "$id" \
      --arg email "$email" \
      --arg password "$password" \
      --argjson app_metadata "$app_metadata" \
      '{id: $id, email: $email, password: $password, email_confirm: true, app_metadata: $app_metadata}')"
    request "$step_create" POST "$api_url/auth/v1/admin/users" "$create_payload"
    if [[ "$response_status" != 200 && "$response_status" != 201 ]]; then
      fail_http "$step_create" "$response_status" "$response_body" 'La création du compte a échoué.'
    fi
    account_status='créé'
  else
    echo "[$step_create/6] Compte déjà présent : aucune création nécessaire."
  fi

  account_summaries+=(
    "✓ Compte $label : $account_status"
    "✓ Email : $email"
    "✓ ID : $id"
    "✓ Rôle : $role"
  )
}

cd "$repo_root"

account_summaries=()

echo '[1/6] Vérification des dépendances et de la CLI Supabase…'
for required_command in curl jq; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Erreur : la commande $required_command est requise." >&2
    exit 1
  fi
done

if command -v supabase >/dev/null 2>&1; then
  supabase_command=(supabase)
elif [[ -x "$repo_root/node_modules/.bin/supabase" ]]; then
  supabase_command=("$repo_root/node_modules/.bin/supabase")
else
  echo 'Erreur : la CLI Supabase est introuvable. Exécutez npm install puis réessayez.' >&2
  exit 1
fi

echo '[2/6] Vérification de l’instance Supabase locale et récupération de sa configuration…'
if ! status_env="$("${supabase_command[@]}" status -o env)"; then
  echo 'Erreur à l’étape 2 : Supabase local ne répond pas.' >&2
  echo 'Lance d’abord scripts/dev.sh ou supabase start.' >&2
  exit 1
fi
if ! api_url="$(parse_status_value API_URL "$status_env")" || [[ -z "$api_url" ]]; then
  echo 'Erreur à l’étape 2 : API_URL est absent de supabase status -o env.' >&2
  exit 1
fi
if ! service_role_key="$(parse_status_value SERVICE_ROLE_KEY "$status_env")" || [[ -z "$service_role_key" ]]; then
  echo 'Erreur à l’étape 2 : SERVICE_ROLE_KEY est absent de supabase status -o env.' >&2
  exit 1
fi

seed_account 3 4 'commerçant' 'merchant@test.fr' 'test1234' '22222222-2222-2222-2222-222222222222' 'merchant'
seed_account 5 6 'livreur' 'driver@test.fr' 'test1234' '33333333-3333-3333-3333-333333333333' 'driver'

echo 'Résumé :'
printf '%s\n' "${account_summaries[@]}"
