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
    blocklists/            # built-in phishing lists (*.txt)
    tools/                 # AD agent + RDP helpers, served under /tools/
    fleet.db               # created on first start
    secret.key             # created on first start: encrypts the DC passwords (back it up with fleet.db)
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

## Updating the server

Copy the code over the app folder; data files (`fleet.db`, `secret.key`,
`admin_user.json`, `downloads/`, `companies.json`) are not in the archive and stay:

```bash
tar czf /tmp/fleet-deploy.tar.gz server.py web/ blocklists/ tools/
scp /tmp/fleet-deploy.tar.gz root@<vps>:/tmp/
ssh root@<vps> 'cd /opt/url-fleet/app && tar xzf /tmp/fleet-deploy.tar.gz && cd .. && docker compose restart server'
```

## AD agent on each domain controller

Company → Computers → **Set up AD agent** creates a token for that company and
shows the install command. On the DC, in PowerShell as administrator:

```powershell
[Net.ServicePointManager]::SecurityProtocol='Tls12'; & ([scriptblock]::Create((irm https://fleet.red1.uz/tools/ad/fleet-ad.ps1))) -Install -Server https://fleet.red1.uz -Token fa_...
```

It installs `C:\ProgramData\URLFleet\` (script, `agent.json` with the token,
`agent.log`; SYSTEM and Administrators only), the scheduled task
**URL Fleet AD agent** (every 5 minutes and at startup, as SYSTEM), sends the
first report, and sets up the **URL Fleet - Chrome** GPO linked to the domain:

* `ExtensionInstallForcelist`: `lddmakdihlenfbmdpggpahjooglgigoi;https://fleet.red1.uz/update_manifest.xml`
  (an existing entry for this extension in any GPO is corrected instead of duplicated);
* Preferences → Registry: `HKLM\Software\Policies\Google\Chrome\3rdparty\extensions\lddmakdihlenfbmdpggpahjooglgigoi\policy`,
  `computerName` = `%ComputerName%`.

Computers apply the GPO within ~90 minutes (`gpupdate /force` for one now).
Add `-NoGpo` to skip the policy part, `-Uninstall` to remove the agent. A new
token from the dashboard retires the old one (run the command again).
The DC needs outbound HTTPS to the fleet server; nothing connects to the DC.

## Computer names without the agent

The `computerName` policy can also be set by hand on one computer (cmd as administrator):

```
reg add "HKLM\Software\Policies\Google\Chrome\3rdparty\extensions\lddmakdihlenfbmdpggpahjooglgigoi\policy" /v computerName /t REG_SZ /d "%COMPUTERNAME%" /f
```

Chrome picks the policy up within minutes (or at once from `chrome://policy` →
*Reload policies*). The popup's Settings tab shows the computer name it sends.

## Local IPs from AD DNS (fallback)

Without the agent, every 15 minutes the server asks each company's DC
(`dc_ip`, port 53) for `<computer>.<AD domain>` — only if the container can
reach the DCs (VPN). Otherwise IPs can be typed into the computer list as
`PC-01 10.111.5.20`.

## Companies

Add companies in the dashboard, or import a JSON file (Companies → Import) in
the format of `companies.example.json`. A `companies.json` placed next to
`server.py` is imported automatically on the very first start only. The real
file contains internal AD names and addresses — keep it out of git
(`.gitignore` already excludes it).

## Backups

Everything lives in `fleet.db` (SQLite, WAL mode), `secret.key` (without it
the saved DC passwords cannot be read), `admin_user.json` and `downloads/`. A safe online copy:

```bash
sqlite3 app/fleet.db ".backup app/fleet-$(date +%F).db"
```

Keep `signing-key.pem` (used by `pack_crx.py`) backed up offline — without it
you cannot ship updates the fleet will accept.
