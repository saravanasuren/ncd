# New Wealth — deployment runbook (EC2 co-tenant #5)

Deploys alongside the four existing apps on `3.110.0.79`. **Co-tenant rule:
only ADD files — never edit dashboard/lockers/odpulse/wealth nginx blocks.**
The owner runs these (they hold the SSH key + AWS admin).
Host: **ncd.dhanamfinance.com**, port **3020**, repo **github.com/saravanasuren/ncd** (private).

## 0. One-time decisions
- Point DNS (GoDaddy): `ncd.dhanamfinance.com` → `3.110.0.79` (A record, TTL 600).
- New Postgres DB + user on the box's Postgres 16: `dhanam_newwealth`.

## 1. SSM secrets (from AWS CloudShell, admin creds)
```bash
R="--region ap-south-1 --overwrite"
aws ssm put-parameter $R --type SecureString --name /dhanam/newwealth/DATABASE_URL     --value "postgres://dhanam_newwealth:<pw>@localhost:5432/dhanam_newwealth"
aws ssm put-parameter $R --type SecureString --name /dhanam/newwealth/JWT_ACCESS_SECRET  --value "$(openssl rand -hex 32)"
aws ssm put-parameter $R --type SecureString --name /dhanam/newwealth/JWT_REFRESH_SECRET --value "$(openssl rand -hex 32)"
aws ssm put-parameter $R --type SecureString --name /dhanam/newwealth/SEED_ADMIN_PASSWORD --value "<strong pw>"
aws ssm put-parameter $R --type String       --name /dhanam/newwealth/SEED_ADMIN_EMAIL    --value "tech@dhanam.finance"
aws ssm put-parameter $R --type String       --name /dhanam/newwealth/WEB_ORIGIN           --value "https://ncd.dhanamfinance.com"
aws ssm put-parameter $R --type SecureString --name /dhanam/newwealth/LOCKERHUB_INTEGRATION_KEY --value "$(openssl rand -hex 32)"
# When live provider keys arrive: DECENTRO_*, DIGIO_*, WAPPCLOUD_*, SES/NOTIFICATIONS_*.
```
Extend the instance role's SSM read policy to `/dhanam/newwealth/*` (additive).

## 2. First deploy (on the box)
```bash
# clone (own repo + read-only deploy key)
git clone git@github.com:saravanasuren/ncd.git /home/ubuntu/new-wealth
cd /home/ubuntu/new-wealth
cp ops/env.production.example api/.env       # 4 lines, no secrets
sudo mkdir -p /var/lib/dhanam-newwealth && sudo chown ubuntu /var/lib/dhanam-newwealth

# Postgres DB
sudo -u postgres psql -c "CREATE USER dhanam_newwealth WITH PASSWORD '<pw>';"
sudo -u postgres psql -c "CREATE DATABASE dhanam_newwealth OWNER dhanam_newwealth;"

npm ci && npm run build                       # builds shared + api + web
SSM_PARAMETERS_PATH=/dhanam/newwealth/ SSM_REGION=ap-south-1 npm run migrate -w @new-wealth/api
SSM_PARAMETERS_PATH=/dhanam/newwealth/ SSM_REGION=ap-south-1 node api/dist/db/seed-cli.js  # seeds roles/permissions/settings/admin

# systemd
sudo cp ops/dhanam-newwealth.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now dhanam-newwealth

# nginx (host ncd.dhanamfinance.com is already baked into the file)
sudo cp ops/nginx-dhanam-newwealth.conf /etc/nginx/sites-available/dhanam-newwealth
sudo ln -s /etc/nginx/sites-available/dhanam-newwealth /etc/nginx/sites-enabled/
sudo certbot --nginx -d ncd.dhanamfinance.com            # issues the cert + reloads nginx
sudo nginx -t && sudo systemctl reload nginx

# backups
sudo cp ops/backup.sh /usr/local/bin/dhanam-newwealth-backup.sh && sudo chmod +x $_
( sudo crontab -l 2>/dev/null; echo "0 21 * * * /usr/local/bin/dhanam-newwealth-backup.sh" ) | sudo crontab -
```

## 3. Subsequent deploys
```bash
cd /home/ubuntu/new-wealth && bash ops/deploy.sh   # pull → build → migrate → restart → health + rollback
```

## 4. Verify (five sites still up)
```bash
for s in dashboard lockers odpulse wealth ncd; do
  echo -n "$s: "; curl -sI https://$s.dhanamfinance.com/ | head -1; done
curl -sI https://ncd.dhanamfinance.com/api/health   # 200
```

## Notes
- Build needs dev deps (tsc/vite) → use `npm ci` (full), not `--omit=dev`.
- HTML/JS/CSS are served by nginx from `web/dist` — a web-only change needs a
  rebuild but no service restart; API changes need `systemctl restart`.
- Rollback: `deploy.sh` auto-reverts on a failed health check; manual =
  `git reset --hard <sha> && npm ci && npm run build && sudo systemctl restart dhanam-newwealth`.
