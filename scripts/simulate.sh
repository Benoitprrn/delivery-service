#!/usr/bin/env bash
set -euo pipefail

api_url='http://localhost:3000'
database_url='postgresql://postgres:postgres@localhost:54322/postgres'
zone_id='11111111-1111-1111-1111-111111111111'
merchant_id='22222222-2222-2222-2222-222222222222'
driver_id='33333333-3333-3333-3333-333333333333'

for required_command in curl jq psql; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Erreur : la commande $required_command est requise." >&2
    exit 1
  fi
done

fail_http() {
  local step=$1
  local status_code=$2
  local response_body=$3
  local reason=${4:-}

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
    if ! response="$(curl --silent --show-error --max-time 10 --request "$method" --header 'Content-Type: application/json' --data "$payload" --write-out $'\n%{http_code}' "$url")"; then
      response_status="${response##*$'\n'}"
      response_body="${response%$'\n'*}"
      fail_http "$step" "${response_status:-000}" "$response_body" 'La requête curl a échoué.'
    fi
  elif ! response="$(curl --silent --show-error --max-time 10 --request "$method" --write-out $'\n%{http_code}' "$url")"; then
    response_status="${response##*$'\n'}"
    response_body="${response%$'\n'*}"
    fail_http "$step" "${response_status:-000}" "$response_body" 'La requête curl a échoué.'
  fi

  response_status="${response##*$'\n'}"
  response_body="${response%$'\n'*}"
}

echo '[1/9] Vérification de l’API Fastify…'
if ! curl --fail --silent --show-error --max-time 3 "$api_url/health" -o /dev/null; then
  echo "Erreur à l’étape 1 : l’API ne répond pas sur $api_url/health." >&2
  echo "Lance d'abord scripts/dev.sh" >&2
  exit 1
fi

echo '[2/9] Création d’une commande…'
create_payload="$(jq -n \
  --arg merchant_id "$merchant_id" \
  '{merchantId: $merchant_id, deliveryAddress: "12 rue de la République, Bourg-en-Bresse", deliveryLat: 46.21, deliveryLng: 5.23}')"
request 2 POST "$api_url/api/v1/orders" "$create_payload"
if [[ "$response_status" != 201 ]]; then
  fail_http 2 "$response_status" "$response_body" 'La création de la commande a échoué.'
fi
if ! order_id="$(jq -er '.id' <<<"$response_body")"; then
  fail_http 2 "$response_status" "$response_body" 'La réponse ne contient pas un identifiant de commande valide.'
fi

echo '[3/9] Attente de la disponibilité de la commande…'
sleep 3

echo '[4/9] Vérification de la commande disponible dans sa zone…'
request 4 GET "$api_url/api/v1/orders/available?zoneId=$zone_id"
if [[ "$response_status" != 200 ]]; then
  fail_http 4 "$response_status" "$response_body" 'La récupération des commandes disponibles a échoué.'
fi
if ! available="$(jq -er --arg id "$order_id" 'any(.[]; .id == $id)' <<<"$response_body")"; then
  fail_http 4 "$response_status" "$response_body" 'La réponse des commandes disponibles est invalide.'
fi
if [[ "$available" != true ]]; then
  fail_http 4 "$response_status" "$response_body" "La commande $order_id n’est pas disponible."
fi

echo '[5/9] Attribution de la commande au livreur…'
assign_payload="$(jq -n --arg driver_id "$driver_id" '{driverId: $driver_id, expectedVersion: 1}')"
request 5 POST "$api_url/api/v1/orders/$order_id/assign" "$assign_payload"
if [[ "$response_status" != 200 ]]; then
  fail_http 5 "$response_status" "$response_body" 'L’attribution de la commande a échoué.'
fi
if ! version="$(jq -er '.version | select(type == "number" and floor == . and . >= 1)' <<<"$response_body")"; then
  fail_http 5 "$response_status" "$response_body" 'La réponse ne contient pas une version valide.'
fi

echo '[6/9] Confirmation de la collecte…'
collect_payload="$(jq -n --arg driver_id "$driver_id" --argjson expected_version "$version" '{driverId: $driver_id, expectedVersion: $expected_version}')"
request 6 POST "$api_url/api/v1/orders/$order_id/collect" "$collect_payload"
if [[ "$response_status" != 200 ]]; then
  fail_http 6 "$response_status" "$response_body" 'La collecte de la commande a échoué.'
fi
if ! version="$(jq -er '.version | select(type == "number" and floor == . and . >= 1)' <<<"$response_body")"; then
  fail_http 6 "$response_status" "$response_body" 'La réponse ne contient pas une version valide.'
fi

echo '[7/9] Confirmation de la livraison…'
complete_payload="$(jq -n --arg driver_id "$driver_id" --argjson expected_version "$version" '{driverId: $driver_id, expectedVersion: $expected_version}')"
request 7 POST "$api_url/api/v1/orders/$order_id/complete" "$complete_payload"
if [[ "$response_status" != 200 ]]; then
  fail_http 7 "$response_status" "$response_body" 'La livraison de la commande a échoué.'
fi

echo '[8/9] Vérification du statut dans Postgres…'
if ! database_row="$(psql "$database_url" -t -A -c "SELECT status, completed_at FROM orders WHERE id='$order_id'")"; then
  echo 'Erreur à l’étape 8 : la requête Postgres a échoué.' >&2
  exit 1
fi
IFS='|' read -r database_status database_completed_at <<<"$database_row"
if [[ "$database_status" != COMPLETED || -z "$database_completed_at" ]]; then
  echo "Erreur à l’étape 8 : statut ou date de livraison invalide (status=${database_status:-absent}, completed_at=${database_completed_at:-absent})." >&2
  exit 1
fi

echo '[9/9] Résumé de la simulation…'
echo "✓ Commande créée : $order_id"
echo '✓ Visible dans /available'
echo '✓ Assignée au livreur'
echo '✓ Collectée'
echo '✓ Livrée'
echo '✓ Statut en base : COMPLETED'
echo '✓ Phase 1 validée'
