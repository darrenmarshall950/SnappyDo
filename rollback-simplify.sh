#!/bin/bash
# Roll SnappyDo back to the state before the editor simplification (Option D).
#
# Usage:  sudo /home/darren/snappydo/rollback-simplify.sh
#
# This restores:
#   - the source tree from the git tag  pre-simplify-2026-11-23-simplify
#   - the Docker image from the tag     snappydo:pre-simplify
#   - the database from the backup      /app/data/snappydo.db.bak-2026-11-23-simplify
#
# It does NOT delete anything: the current commits stay in the repo and can be
# restored with `git checkout -f <sha>` plus a rebuild. The DB backup is copied
# over the live DB, so take a fresh copy first if you have newer edits you care
# about (see "make a fresh backup" below).
set -euo pipefail

STAMP="2026-11-23-simplify"
TAG="pre-simplify-$STAMP"
REPO="/home/darren/snappydo"
cd "$REPO"

echo "==> Current state"
git log --oneline -3
sudo docker ps --filter name=snappydo-app --format '{{.Names}} {{.Status}}'

echo
echo "==> Taking a fresh DB backup so this rollback is itself reversible"
sudo docker exec snappydo-app sh -lc 'cp /app/data/snappydo.db /app/data/snappydo.db.bak-$(date +%Y%m%d-%H%M%S)'
sudo docker exec snappydo-app sh -lc 'ls -la /app/data/*.bak* | tail -5'

echo
echo "==> Restoring source from git tag $TAG"
git checkout -f "$TAG"
git status --short
git log --oneline -1

echo
echo "==> Restoring the pre-simplify Docker image"
sudo docker tag "snappydo:pre-simplify" snappydo:latest

echo
echo "==> Restoring the database"
# Stop the app first so the DB is not open for write during the copy.
sudo docker stop snappydo-app
sudo docker run --rm -v snappydo_snappydo_data:/data alpine \
  sh -lc 'cp /data/snappydo.db.bak-'"$STAMP"' /data/snappydo.db && ls -la /data/snappydo.db*'
sudo docker start snappydo-app

echo
echo "==> Recreating the container"
sudo docker compose --profile prod up -d snappydo
sleep 14

echo
echo "==> Health check"
curl -s --max-time 20 http://192.168.0.2:3010/api/health && echo

echo
echo "==> Container status"
sudo docker ps --filter name=snappydo-app --format '{{.Names}} {{.Status}}'

echo
echo "Rollback complete. To roll forward again:"
echo "  cd $REPO && git checkout -f <sha> && npm run build && sudo docker compose --profile prod build snappydo && sudo docker compose --profile prod up -d snappydo"
