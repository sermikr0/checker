# URL Safety Checker — Fleet

Disclosed fleet management for the corporate **URL Safety Checker** Chrome
extension: anti-phishing for logistics offices plus central web filtering,
with a separate policy per company.

```
extension/        Chrome MV3 extension (v2.4.0)
server.py         Fleet server — Python 3.11+ standard library only, SQLite
web/              Admin dashboard (no build step, served by server.py)
tests/            End-to-end server tests (python3 -m unittest discover -s tests)
tools/            i18n_check.py; fleet-rdp/ (xfreerdp link handler for the RDP buttons)
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
| Companies | Search, filter, sort; an **RDP** button per company opens xfreerdp to its domain controller; link unknown addresses to a company |
| Company | The AD **computer list**: local IP (from the company's AD DNS), extension status online / offline / not installed, version, last check-in; details |
| Global policy | Mode and allowed / blocked lists for everyone |
| Access requests | Allow / reject / block (global lists); history |
| Updates | Upload a signed CRX |
| Activity log | Every admin action with who and from where |
| Settings | Password, sessions, theme, language |

## Computers, local IPs and status

* **Local IP** — the server looks every AD computer up in the company's own DNS
  (`<name>.<AD domain>` asked from the DC IP) every 15 minutes and on
  *Refresh IPs*. The fleet server needs a route to the offices' DCs (VPN). If a
  DC cannot be reached, IPs can be typed in the company details as
  `PC-01 10.118.5.20`.
* **Status** — extension 2.4.0 reports the Windows computer name that IT sets
  through Chrome policy (`computerName`, see DEPLOYMENT.md). A computer is
  *online* when one of its browsers checked in during the last 3 minutes,
  *offline* otherwise, and *no extension* if no browser reported its name.
* The computer name also assigns the browser to its company, before NAT and subnet.

## RDP to a company's domain controller

The RDP button opens `fleet-rdp://connect?host=<DC IP>&domain=<AD domain>&user=<name>`.
Install the handler once per Linux admin computer:

```bash
bash tools/fleet-rdp/install.sh      # needs xfreerdp (freerdp3-x11 or freerdp2-x11)
```

It opens a terminal, shows the target, and runs
`xfreerdp /v:<DC> /d:<domain> /u:<user> /dynamic-resolution +clipboard /cert:tofu`.
Only private addresses are accepted. The user name is set per browser in
Settings → Remote desktop.

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
