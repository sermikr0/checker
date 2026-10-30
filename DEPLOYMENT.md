# Deployment

The server is one Python file plus the `web/` folder. It needs no packages.

## Docker + Cloudflare Tunnel (current setup)

```
/opt/url-fleet/
  docker-compose.yml
  cloudflared.env          # TUNNEL_TOKEN=…   (never commit)
  app/
    server.py
    web/                   # dashboard
    fleet.db               # created on first start
    admin_user.json        # created on first start (hashed password)
    downloads/             # published .crx files
```

```bash
cd /opt/url-fleet
docker compose up -d
docker compose logs server | head -20     # first start prints the admin password once
```

The server listens on `127.0.0.1:8080` only; `cloudflared` is the single way
in, so Cloudflare provides TLS. `FLEET_TRUST_PROXY=cloudflare` (set in
`docker-compose.yml`) makes the server read the visitor address from
`CF-Connecting-IP`. Without it every browser looks like it comes from the
Docker gateway and cannot be matched to its company — the dashboard shows a
warning when that happens.

## Upgrading from v2 (dashboard.html + admin token)

1. Back up the data:
   ```bash
   cd /opt/url-fleet/app && cp fleet.db fleet.db.bak-$(date +%F)
   ```
2. Copy the new `server.py` and the whole `web/` folder into `app/`.
   `dashboard.html` is no longer used and can be deleted.
3. Dry-run the upgrade on a copy of the database (the original is not touched):
   ```bash
   docker compose exec server python server.py migrate-check /app/fleet.db
   ```
   It prints how many companies will exist, how devices will be matched and
   any values it had to ignore. Every company is kept; an invalid NAT address
   or DC IP is dropped and written into that company's notes.
4. Add `FLEET_TRUST_PROXY: "cloudflare"` to the `server` environment in
   `/opt/url-fleet/docker-compose.yml` (see the one in this repo).
5. Restart: `docker compose up -d`.
6. Sign in with the **same admin password** as before.

What happens on the first start of v3:

* Companies (including NAT addresses added in the old dashboard) move from the
  old storage to a proper table. Devices, requests and the release stay as they are.
* The global policy keeps its mode and lists. Lists longer than the new
  10 000-character limit keep working and can still be saved or shortened,
  but not grown; each browser receives at most 19 500 characters per list,
  cut on a domain boundary with the company's own entries first.
* `admin_token.txt` **stops working** — the dashboard now uses login sessions.
  Any copy of the old token is useless. Delete the file.
* Extensions already installed (v2.2.x) keep working unchanged and start
  receiving their company's policy. Publish v2.3.0 to get the new popup and a
  block page that names the company.

Forgot the password?

```bash
docker compose exec server python server.py reset-password
```

The running server picks up the new password immediately and every session
is signed out.

## Without Docker (systemd)

```ini
# /etc/systemd/system/url-fleet.service
[Service]
WorkingDirectory=/home/ext/url-fleet
ExecStart=/usr/bin/python3 server.py
Environment=FLEET_HOST=127.0.0.1 FLEET_TRUST_PROXY=none
Restart=always
User=ext
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now url-fleet
sudo journalctl -u url-fleet -f
```

Put a TLS reverse proxy in front before exposing it beyond the LAN. With
nginx use `FLEET_TRUST_PROXY=xff`; with direct LAN access use `none`.

## Companies

Add companies in the dashboard, or import a JSON file (Companies → Import) in
the format of `companies.example.json`. A `companies.json` placed next to
`server.py` is imported automatically on the very first start only. The real
file contains internal AD names and addresses — keep it out of git
(`.gitignore` already excludes it).

## Backups

Everything lives in `fleet.db` (SQLite, WAL mode), `admin_user.json` and
`downloads/`. A safe online copy:

```bash
sqlite3 app/fleet.db ".backup app/fleet-$(date +%F).db"
```

Keep `signing-key.pem` (used by `pack_crx.py`) backed up offline — without it
you cannot ship updates the fleet will accept.
