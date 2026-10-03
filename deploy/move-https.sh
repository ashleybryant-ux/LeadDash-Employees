#!/usr/bin/env bash
# MOVE STEP 9. Run on the NEW server after the DNS change. Waits until
# employees.leaddash.io points here, then adds the HTTPS certificate.
set -euo pipefail
TOKEN=$(curl -sX PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
PUBLIC=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)
for i in $(seq 1 30); do
  NOW=$(dig +short employees.leaddash.io @1.1.1.1 | tail -1)
  if [ "$NOW" = "$PUBLIC" ]; then break; fi
  echo "employees.leaddash.io still points to ${NOW:-nothing}, waiting for $PUBLIC ($i/30)..."
  sleep 20
done
if [ "$NOW" != "$PUBLIC" ]; then echo "DNS hasn't switched yet. Check the A record says $PUBLIC, then run this line again."; exit 1; fi
sudo certbot --nginx -d employees.leaddash.io --non-interactive --agree-tos --register-unsafely-without-email --redirect
curl -fsS https://employees.leaddash.io/api/health && echo && echo "MOVED. LeadDash Employees is live on its own server."
