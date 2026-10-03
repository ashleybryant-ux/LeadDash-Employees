#!/usr/bin/env bash
# MOVE STEP 6. Run on the NEW server with the old server's private IP.
# A trial copy: the old server keeps running. Copies .env and data/, sets up
# nginx, builds and starts the app, and checks it answers. Safe to run again.
set -euo pipefail
OLD="$1"
echo "OLD=$OLD" > "$HOME/.oldbox"
SSH="ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
cd "$HOME/employees"
echo "== reaching the old server at $OLD"
if ! $SSH "ssm-user@$OLD" true; then
  echo "CAN'T REACH THE OLD SERVER. In AWS, add an inbound rule to the OLD server's security group: type SSH, port 22, source = the new server's security group. Then run this line again."
  exit 1
fi
echo "== copying .env and data/"
rsync -a -e "$SSH" "ssm-user@$OLD:/home/ssm-user/employees/.env" ./.env
chmod 600 .env
mkdir -p data
rsync -a -e "$SSH" "ssm-user@$OLD:/home/ssm-user/employees/data/" ./data/
echo "== nginx"
sudo cp deploy/nginx-employees.conf /etc/nginx/sites-available/leaddash-employees
sudo ln -sf /etc/nginx/sites-available/leaddash-employees /etc/nginx/sites-enabled/leaddash-employees
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
echo "== build and start"
./deploy.sh
sudo env PATH="$PATH" pm2 startup systemd -u ssm-user --hp /home/ssm-user >/dev/null
pm2 save
echo "== check through nginx"
if curl -fsS -H "Host: employees.leaddash.io" http://127.0.0.1/api/health >/dev/null; then
  echo "TRIAL COPY READY. The old server is still the live one. When you're ready to switch, run on THIS server:"
  echo "bash /home/ssm-user/employees/deploy/move-switch.sh"
else
  echo "nginx is not passing requests to the app yet. Send me this output."
fi
