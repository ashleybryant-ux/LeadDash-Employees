#!/usr/bin/env bash
# Deploys LeadDash Employees on the EC2 box:
#   cd /home/ssm-user/employees && ./deploy.sh
# Pulls, installs, runs the tests, builds, boot-checks the new build on a
# spare port against a copy of the database, then restarts PM2 and confirms
# the live port answers. Stops at the first failure and leaves the running
# app untouched.
set -euo pipefail
cd "$(dirname "$0")"

PORT_LIVE=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || true)
PORT_LIVE=${PORT_LIVE:-4100}
PORT_CHECK=$((PORT_LIVE + 50))

echo "== git pull"
git pull origin main

echo "== npm ci"
npm ci --no-audit --no-fund

echo "== tests"
nice -n 19 npm test --silent

echo "== memory check"
# The build needs about 1.5 GB. On a small server, building without enough
# memory freezes the whole box, including LeadDash EHR on port 4000.
AVAIL_MB=$(awk '/MemAvailable/ {m=$2} /SwapFree/ {s=$2} END {print int((m+s)/1024)}' /proc/meminfo)
echo "available memory plus swap: ${AVAIL_MB} MB"
if [ "$AVAIL_MB" -lt 1500 ]; then
  echo "NOT ENOUGH MEMORY TO BUILD SAFELY (need 1500 MB). Nothing was changed. Add swap with:"
  echo "sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab && free -h"
  exit 1
fi

echo "== build (low priority, so the EHR keeps answering)"
NODE_OPTIONS=--max-old-space-size=1024 nice -n 19 npm run build

echo "== boot check on port $PORT_CHECK (copy of the database)"
TMP=$(mktemp -d)
[ -f data/employees.db ] && cp data/employees.db "$TMP/employees.db"
set +e
PORT=$PORT_CHECK DATABASE_PATH="$TMP/employees.db" UPLOADS_DIR="$TMP/uploads" NODE_ENV=production node dist/index.js > "$TMP/boot.log" 2>&1 &
PID=$!
OK=0
for i in $(seq 1 20); do
  sleep 0.5
  if curl -fsS "http://127.0.0.1:$PORT_CHECK/api/health" > /dev/null 2>&1; then OK=1; break; fi
done
kill $PID 2>/dev/null; wait $PID 2>/dev/null
set -e
if [ "$OK" != "1" ]; then
  echo "BOOT CHECK FAILED. The live app was not touched. Log:"; cat "$TMP/boot.log"; rm -rf "$TMP"; exit 1
fi
rm -rf "$TMP"
echo "boot check passed"

echo "== restart"
if pm2 describe leaddash-employees > /dev/null 2>&1; then
  pm2 restart leaddash-employees --update-env
else
  pm2 start ecosystem.config.cjs && pm2 save
fi

sleep 2
if curl -fsS "http://127.0.0.1:$PORT_LIVE/api/health"; then
  echo; echo "LIVE on port $PORT_LIVE"
else
  echo "NOT ANSWERING on port $PORT_LIVE. Last log lines:"; pm2 logs leaddash-employees --lines 30 --nostream; exit 1
fi
echo "== checksums"
md5sum server/routers.ts server/db.ts server/employees/apply.ts server/employees/hiring.ts drizzle/schema.ts dist/index.js
