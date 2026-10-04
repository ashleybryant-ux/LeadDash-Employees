#!/usr/bin/env bash
# Run on the LeadDash Employees server. Safe to run again.
#
# Phones (or phone companies) that still remember employees.leaddash.io's old
# address reach the EHR server and get the portal login. This makes the EHR
# server pass any visit to employees.leaddash.io over to this server, so every
# phone gets LeadDash Employees whichever address it remembers.
#
# The portal is not touched: the forward is its own file on the EHR server,
# nginx tests the whole setup first, and if the test fails the forward is
# taken out again before anything reloads.
#
# To take the forward away later (a few weeks is plenty):
#   . ~/.oldbox && ssh ssm-user@$OLD "sudo rm -f /etc/nginx/conf.d/employees-forward.conf && sudo nginx -t && sudo systemctl reload nginx"
set -euo pipefail

. "$HOME/.oldbox"   # OLD = the EHR server's private address, saved during the move
SSH="ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 ssm-user@$OLD"
CERT=/etc/letsencrypt/live/employees.leaddash.io
TOKEN=$(curl -sX PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
HERE=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)

echo "== reaching the EHR server at $OLD"
if ! $SSH true; then
  echo "CAN'T REACH THE EHR SERVER over SSH. Nothing was changed. Send me this output."
  exit 1
fi
if ! sudo test -f "$CERT/fullchain.pem"; then
  echo "This server has no certificate for employees.leaddash.io. Nothing was changed. Send me this output."
  exit 1
fi

echo "== copying this server's certificate for employees.leaddash.io to the EHR server"
sudo cat "$CERT/fullchain.pem" | $SSH "sudo mkdir -p /etc/nginx/employees-forward && sudo tee /etc/nginx/employees-forward/fullchain.pem > /dev/null"
sudo cat "$CERT/privkey.pem" | $SSH "sudo tee /etc/nginx/employees-forward/privkey.pem > /dev/null && sudo chmod 600 /etc/nginx/employees-forward/privkey.pem"

echo "== adding the forward on the EHR server (to $HERE)"
sed "s/__HERE__/$HERE/" <<'CONF' | $SSH "sudo tee /etc/nginx/conf.d/employees-forward.conf > /dev/null"
# Visits to employees.leaddash.io that land here go to the LeadDash Employees server.
server {
    listen 80;
    server_name employees.leaddash.io;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl;
    server_name employees.leaddash.io;
    ssl_certificate /etc/nginx/employees-forward/fullchain.pem;
    ssl_certificate_key /etc/nginx/employees-forward/privkey.pem;
    client_max_body_size 300m;

    location / {
        proxy_pass https://__HERE__;
        proxy_ssl_server_name on;
        proxy_ssl_name employees.leaddash.io;
        proxy_http_version 1.1;
        proxy_set_header Host employees.leaddash.io;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 300s;
    }
}
CONF

$SSH 'if sudo nginx -t 2>&1; then sudo systemctl reload nginx && echo "forward is on"; else sudo rm -f /etc/nginx/conf.d/employees-forward.conf; echo "NGINX TEST FAILED, so the forward was taken out again. The portal was not touched. Send me this output."; exit 1; fi'

echo "== check: asking the EHR server for LeadDash Employees"
curl -sS -m 15 --resolve "employees.leaddash.io:443:$OLD" https://employees.leaddash.io/api/health && echo && echo "WORKING: phones that remember the old address now get LeadDash Employees."
