#!/usr/bin/env bash
# Runs on the deploy host, from the extracted artifact.
#
# Deliberately idempotent and dull: it should behave the same on the first
# deploy and the hundredth, and it should refuse rather than guess.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/revify}"
API_PORT="${API_PORT:-4322}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${API_PORT}/api/health}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# `docker compose` (v2) or `docker-compose` (v1) — hosts differ, and failing
# on the wrong one reads like a broken deploy rather than a missing tool.
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "docker compose bulunamadı." >&2
  exit 1
fi

echo "==> Deploying to $DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR/data"

# The database is the only thing here that cannot be rebuilt from the
# repository, and it is about to have a new binary opened on it.
if [ -f "$DEPLOY_DIR/data/api.db" ]; then
  echo "==> Backing up the database"
  cp "$DEPLOY_DIR/data/api.db" "$DEPLOY_DIR/data/api.db.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  # Keep the last five. A directory of every backup ever is not a backup
  # strategy, it is a disk-full incident waiting to happen.
  ls -1t "$DEPLOY_DIR"/data/api.db.bak-* 2>/dev/null | tail -n +6 | xargs -r rm -f
fi

echo "==> Installing build context"
# `install -D` is GNU-only; plain mkdir + install works on any host, which
# also means this script can be tested somewhere other than the target.
mkdir -p "$DEPLOY_DIR/bin"
install -m 0755 "$here/bin/revify-api"     "$DEPLOY_DIR/bin/revify-api"
install -m 0644 "$here/Dockerfile.runtime" "$DEPLOY_DIR/Dockerfile.runtime"
install -m 0644 "$here/docker-compose.yml" "$DEPLOY_DIR/docker-compose.yml"
[ -f "$here/BUILD_INFO" ] && install -m 0644 "$here/BUILD_INFO" "$DEPLOY_DIR/BUILD_INFO"

cd "$DEPLOY_DIR"
export BUILD_NUMBER="${BUILD_NUMBER:-local}" API_PORT

echo "==> Building image and starting"
$COMPOSE up -d --build --remove-orphans

# The deploy is not finished until the service answers. A container that
# started and then crash-looped looks exactly like one that worked, right
# up until someone tries to sign in.
echo "==> Health check"
for i in $(seq 1 20); do
  if curl -fsS --max-time 5 "$HEALTH_URL" | grep -q '"ok":true'; then
    echo "==> Healthy"
    curl -fsS --max-time 5 "$HEALTH_URL"; echo
    cat "$DEPLOY_DIR/BUILD_INFO" 2>/dev/null || true
    # Images from previous deploys pile up otherwise; the running one is
    # never dangling, so this cannot remove what is in use.
    docker image prune -f >/dev/null 2>&1 || true
    exit 0
  fi
  sleep 3
done

echo "==> Service did not become healthy; last log lines:" >&2
$COMPOSE ps >&2 || true
$COMPOSE logs --tail=50 >&2 || true
exit 1
