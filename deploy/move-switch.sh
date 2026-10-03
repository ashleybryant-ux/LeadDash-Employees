#!/usr/bin/env bash
# MOVE STEP 7. Run on the NEW server. Stops the app on the old server, copies
# the final data, restarts here, and prints the address to point DNS at.
# The app is down from here until DNS points at this server.
set -euo pipefail
. "$HOME/.oldbox"
SSH="ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
cd "$HOME/employees"
echo "== stopping the app on the old server ($OLD)"
$SSH "ssm-user@$OLD" "pm2 stop leaddash-employees && pm2 save"
echo "== final copy"
pm2 stop leaddash-employees
rsync -a --delete -e "$SSH" "ssm-user@$OLD:/home/ssm-user/employees/data/" ./data/
rsync -a -e "$SSH" "ssm-user@$OLD:/home/ssm-user/employees/.env" ./.env
chmod 600 .env
pm2 restart leaddash-employees --update-env
sleep 4
curl -fsS http://127.0.0.1:4100/api/health && echo
TOKEN=$(curl -sX PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
PUBLIC=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)
echo
echo "================ STEP 8: DNS ================"
echo "In the place that manages leaddash.io's DNS, set the A record for 'employees' to: $PUBLIC"
echo "That DNS is managed at: $(dig +short NS leaddash.io | head -2 | tr '\n' ' ')"
echo "Then run on THIS server: bash /home/ssm-user/employees/deploy/move-https.sh"
echo "============================================="
