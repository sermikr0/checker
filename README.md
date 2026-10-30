# URL Safety Checker — Fleet

Disclosed fleet management for the corporate **URL Safety Checker** Chrome
extension: anti-phishing for logistics offices plus central web filtering,
with a separate policy per company.

```
extension/        Chrome MV3 extension (v2.5.0)
server.py         Fleet server — Python 3.11+ standard library only, SQLite
web/              Admin dashboard (no build step, served by server.py)
tests/            End-to-end server tests (python3 -m unittest discover -s tests)
tools/            ad/fleet-ad.ps1 (AD agent for domain controllers); fleet-rdp/ (RDP link
                  handlers for Linux and Windows); i18n_check.py — served by the server under /tools/
pack_crx.py       Packs and signs the extension as CRX3
companies.example.json   Format for importing companies
```

## What it does

**Extension** — checks links for phishing, malware and freight-industry scams
(fake load-board logins, FMCSA/USDOT renewal fraud, rate-con lures). Shows a
hover card, marks risky links, and enforces the web-filtering policy it gets
from the server with `declarativeNetRequest`. Blocked pages show a warning
page with a *request access* button.

**Server** — enrollment and heartbeat (every 60 s), company matching, policy
delivery, access requests, self-hosted Chrome updates, audit log.

**Dashboard** — light and dark theme, Uzbek and English:

| Page | |
|---|---|
| Overview | Who is online, the fleet board (one lane per company), versions, recent activity |
| Companies | Search, filter, sort; an **RDP** button per company connects to its domain controller; link unknown addresses to a company |
| Company | The AD **computer list** (from the AD agent): local IP, turned on / off, extension online / offline / not installed, version, last check-in; details with the DC user name and password (hidden, show/hide) |
| Global policy | Mode and allowed / blocked lists for everyone |
| Access requests | Allow / reject / block (global lists); history |
| Updates | Upload a signed CRX |
| Activity log | Every admin action with who and from where |
| Settings | Password, sessions, theme, language |

## Computers, local IPs and status (AD agent)

Each company's domain controller runs the **AD agent** (`tools/ad/fleet-ad.ps1`,
a scheduled task as SYSTEM). Every 5 minutes it sends the server the domain's
enabled computers with their local IPv4 (AD DNS), OS and whether they answer
right now (ping, or TCP 445/3389/135). New computers joined to the domain show
up on their own. The agent only sends data; nothing is ever run from the server.

Install it from the dashboard: Company → Computers → **Set up AD agent** shows
a one-line PowerShell command with the company's token. Run it as
administrator on the DC. The same command also sets up the domain's
**"URL Fleet - Chrome"** group policy:

* force-install of the extension with the fleet update URL — added to this GPO
  and to every GPO that already sets the force-install list (such lists replace
  each other instead of merging), existing entries for the extension are pointed
  at that URL — so every version uploaded in the dashboard reaches all browsers;
* the extension's `computerName` policy (`%ComputerName%`, Group Policy Preferences).

Statuses on the Company page:

* **Computer status** — *turned on* when the agent reached it in its last run
  (or one of its browsers is checking in), *turned off* otherwise.
* **Extension** — *online* when a browser on that computer checked in during
  the last 3 minutes, *offline* otherwise, *no extension* if none reported its
  name (extension 2.5.0 + the `computerName` policy).
* The computer name also assigns a browser to its company, before NAT and subnet.

Without the agent the server can still look IPs up in the DC's DNS itself
(needs a route/VPN to the office) or take them typed in as `PC-01 10.118.5.20`.

## RDP to a company's domain controller

The RDP button opens a `fleet-rdp://` link that a small helper on the admin's
computer hands to **xfreerdp** (Linux) or **Remote Desktop / mstsc** (Windows),
both with dynamic resolution. Install the helper once — Settings → Remote
desktop shows the commands; the scripts are served by the fleet server:

```bash
curl -fsSL https://fleet.red1.uz/tools/fleet-rdp/install.sh | FLEET_SERVER=https://fleet.red1.uz bash
```
```powershell
powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://fleet.red1.uz/tools/fleet-rdp/install-windows.ps1))) -Server https://fleet.red1.uz"
```

* **Password per company** — Company → Details: *DC user name* and *DC
  password*. The password is stored encrypted (key in `secret.key` next to the
  database, never in it), never appears in lists or exports, and is shown only
  with the eye button. Showing it and every RDP connection go to the activity log.
* With a saved password the button connects at once:
  `xfreerdp /v:<DC> /u:<user> /p:<password> /dynamic-resolution +clipboard /cert:tofu`.
  Without one, the helper uses a user name and password kept only on the admin's
  computer (keyring / DPAPI), asked once.
* The helper only connects to private addresses, and Chrome asks once before
  a site may open it.

## Built-in phishing list

`blocklists/*.txt` (one domain per line, `#` comments) is blocked on every
browser in **every mode** — also when the global mode is *all sites open*,
which is then delivered as blacklist mode with just these domains. Subdomains
are included. The server reloads the files when they change; the Global
policy page lists them. To let a false positive through, add the exact domain
to *Allowed sites*. `blocklists/freight-phishing.txt` holds 154 Highway
look-alike and freight-phishing domains (dnstwist, Diesel Vortex and Proofpoint IOCs).

## Company policy (server)

The dashboard edits the global policy only. Rules a company got earlier are
listed on the Global policy page and can be removed there. The server still
merges them for that company's browsers:

* **Mode** — a company either follows the global mode or sets its own
  (*all sites open*, *blacklist*, *whitelist only*).
* **Lists** — company lists are added to the global lists, and a company entry
  wins over a global one:
  `allowed = (global allowed − company blocked) + company allowed`,
  `blocked = (global blocked − company allowed) + company blocked`.

A browser belongs to a company by, in order: a manual pin → its computer name
in the company's AD list → a NAT address (single IP or CIDR range) → the office subnet. If two companies share a subnet
the device is marked *ambiguous* and gets the global policy until it is pinned
or the NAT address is added.

## Run

```bash
python3 server.py                  # http://0.0.0.0:8080
python3 server.py reset-password   # set a new admin password (signs everyone out, no restart needed)
python3 server.py migrate-check /path/to/fleet.db   # dry-run the v2 → v3 upgrade on a copy
```

On first start the server prints the `admin` password once. Docker and
Cloudflare Tunnel setup: see [DEPLOYMENT.md](DEPLOYMENT.md).

| Variable | Default | Meaning |
|---|---|---|
| `FLEET_HOST` / `FLEET_PORT` | `0.0.0.0` / `8080` | Listen address |
| `FLEET_DATA_DIR` | folder of `server.py` | Where `fleet.db`, `admin_user.json`, `downloads/` live |
| `FLEET_TRUST_PROXY` | `none` | Client IP source: `none` (socket), `cloudflare` (CF-Connecting-IP — only when cloudflared is the sole way in), `xff` (last X-Forwarded-For hop of one trusted proxy) |
| `FLEET_ADMIN_USER` / `FLEET_ADMIN_PASS` | `admin` / random | Initial account (first start only) |
| `FLEET_APPID` | `lddmakdihlenfbmdpggpahjooglgigoi` | Extension ID accepted for CRX uploads |
| `FLEET_TLS_CERT` / `FLEET_TLS_KEY` / `FLEET_TLS_PORT` | — / — / `8443` | Optional extra HTTPS listener |
| `FLEET_LOG_HEARTBEATS` | `0` | `1` logs every heartbeat request |
| `FLEET_DNS_INTERVAL` | `900` | Seconds between AD DNS lookups of computer IPs (`0` = only on *Refresh IPs*) |
| `FLEET_DNS_TIMEOUT` / `FLEET_DNS_PORT` | `1.0` / `53` | DNS query timeout and port |
| `FLEET_BLOCKLIST_DIR` | `blocklists/` next to `server.py` | Folder with the built-in phishing lists |

## Security model

* Dashboard login creates a session: random token in an `HttpOnly`,
  `SameSite=Strict` cookie, 12 h idle / 7 day absolute expiry. Changing the
  password signs out every other session. Writes need the `X-Fleet-CSRF` header.
* Five failed logins from one address lock it out for 15 minutes.
* Request bodies are always read or drained, so a kept-alive connection can
  never be used to smuggle a second request; chunked bodies are refused.
* Editors send the revision they loaded; a save that would overwrite a change
  made elsewhere (e.g. an approved request) is refused with a reload prompt.
* The dashboard is served with a strict Content-Security-Policy and builds the
  page with DOM APIs only (no `innerHTML` with data).
* Public endpoints are limited to what the extension and Chrome's updater need
  (`/api/enroll`, `/api/heartbeat`, `/api/request-access`, `/update_manifest.xml`,
  `/downloads/*.crx`), with rate limits.
* CRX uploads must carry the fleet's extension ID; Chrome verifies the signature.
* The server only ever sends data (mode + domain lists) — never code.

## Tests

```bash
python3 -m unittest discover -s tests -v   # 46 tests: sessions, policy, requests, keep-alive, migration, AD DNS, computers, RDP links
python3 tools/i18n_check.py                # every dashboard string has an Uzbek translation
```

## Licence

Internal use — Innova Networks. Bundled fonts (Big Shoulders, Instrument Sans,
Red Hat Mono) are under the SIL Open Font License; see `web/assets/fonts/`.
