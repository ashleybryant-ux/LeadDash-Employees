#!/usr/bin/env bash
# MOVE STEP 4. Run on the NEW server as ssm-user:
#   curl -fsSL https://raw.githubusercontent.com/ashleybryant-ux/LeadDash-Employees/main/deploy/move-setup.sh | bash
# Installs Node 22, PM2, nginx, certbot and Chromium's libraries, clones the app,
# and prints the exact line to paste on the OLD server next.
set -euo pipefail
cd "$HOME"
echo "== packages"
sudo apt-get update -y
sudo apt-get install -y nginx certbot python3-certbot-nginx git rsync curl ca-certificates dnsutils
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
command -v pm2 >/dev/null || sudo npm install -g pm2
sudo apt-get install -y --no-install-recommends libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libatspi2.0-0t64 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libasound2t64
sudo apt-get clean
echo "== app"
[ -d "$HOME/employees/.git" ] || git clone https://github.com/ashleybryant-ux/LeadDash-Employees.git "$HOME/employees"
echo "== key for copying from the old server"
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
[ -f "$HOME/.ssh/id_ed25519" ] || ssh-keygen -t ed25519 -N "" -f "$HOME/.ssh/id_ed25519" -q -C "leaddash-employees-move"
KEY=$(cat "$HOME/.ssh/id_ed25519.pub")
echo
echo "================ STEP 5: copy the next line and paste it on the OLD server ================"
echo "cd /home/ssm-user/employees && git pull origin main && bash deploy/move-authorize.sh \"$KEY\""
echo "============================================================================================"
