#!/usr/bin/env bash
# Extraction OSRM — Bourg-en-Bresse + ~20 km, profil vélo.
# Ne télécharge PAS un extrait régional entier : interroge Overpass API
# directement sur le bbox, ce qui suffit pour un service confiné à 10 km
# autour du point de collecte (cf. ADR sur le dimensionnement OSRM).
set -euo pipefail

# Bourg-en-Bresse (46.2058, 5.2255) + ~22 km de marge de sécurité
BBOX_SOUTH=46.00
BBOX_WEST=4.95
BBOX_NORTH=46.40
BBOX_EAST=5.50

OSRM_IMAGE="ghcr.io/project-osrm/osrm-backend:latest"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$DIR/data"
mkdir -p "$DATA_DIR"

echo "[1/4] Récupération des données OSM (bbox $BBOX_SOUTH,$BBOX_WEST,$BBOX_NORTH,$BBOX_EAST) via Overpass..."
curl --fail --silent --show-error --max-time 300 \
  -o "$DATA_DIR/bourg-en-bresse.osm" \
  --data-urlencode "data=[out:xml][timeout:180];(node($BBOX_SOUTH,$BBOX_WEST,$BBOX_NORTH,$BBOX_EAST);way($BBOX_SOUTH,$BBOX_WEST,$BBOX_NORTH,$BBOX_EAST);relation($BBOX_SOUTH,$BBOX_WEST,$BBOX_NORTH,$BBOX_EAST););out body;>;out skel qt;" \
  https://overpass-api.de/api/interpreter

ls -lh "$DATA_DIR/bourg-en-bresse.osm"

echo "[2/4] Conversion .osm -> .osm.pbf (osmium, conteneur jetable)..."
docker run --rm -v "$DATA_DIR:/data" ubuntu:24.04 bash -c "
  apt-get update -qq && apt-get install -y -qq osmium-tool >/dev/null &&
  osmium cat /data/bourg-en-bresse.osm -o /data/bourg-en-bresse.osm.pbf --overwrite
"
ls -lh "$DATA_DIR/bourg-en-bresse.osm.pbf"

echo "[3/4] osrm-extract (profil vélo)..."
docker run --rm -v "$DATA_DIR:/data" -v "$DIR/bicycle.lua:/data/bicycle.lua:ro" "$OSRM_IMAGE" \
  osrm-extract -p /data/bicycle.lua /data/bourg-en-bresse.osm.pbf

echo "[3b/4] osrm-partition + osrm-customize (pipeline MLD)..."
docker run --rm -v "$DATA_DIR:/data" "$OSRM_IMAGE" \
  osrm-partition /data/bourg-en-bresse.osrm
docker run --rm -v "$DATA_DIR:/data" "$OSRM_IMAGE" \
  osrm-customize /data/bourg-en-bresse.osrm

echo "[4/4] Terminé. Fichiers générés :"
ls -lh "$DATA_DIR"/bourg-en-bresse.osrm* 2>/dev/null

echo
echo "Pour servir OSRM localement (étape 6, pas maintenant) :"
echo "  docker run --rm -p 5000:5000 -v \"$DATA_DIR:/data\" $OSRM_IMAGE osrm-routed --algorithm mld /data/bourg-en-bresse.osrm"
