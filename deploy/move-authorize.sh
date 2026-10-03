#!/usr/bin/env bash
# MOVE STEP 5. Run on the OLD server (the line printed by move-setup.sh).
# Lets the new server copy the app's files over the private network, then
# prints the exact line to paste on the NEW server next.
set -euo pipefail
KEY="$1"
case "$KEY" in ssh-ed25519\ *) ;; *) echo "That doesn't look like the key line from the new server. Nothing was changed."; exit 1 ;; esac
command -v rsync >/dev/null || sudo apt-get install -y rsync
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys" && chmod 600 "$HOME/.ssh/authorized_keys"
grep -qF "$KEY" "$HOME/.ssh/authorized_keys" || echo "$KEY" >> "$HOME/.ssh/authorized_keys"
IP=$(hostname -I | awk '{print $1}')
echo
echo "================ STEP 6: copy the next line and paste it on the NEW server ================"
echo "bash /home/ssm-user/employees/deploy/move-copy.sh $IP"
echo "============================================================================================"
