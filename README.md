# URL Safety Checker — Fleet

Disclosed fleet management for the corporate **URL Safety Checker** Chrome
extension: anti-phishing for logistics offices plus central web filtering,
with a separate policy per company.

```
extension/        Chrome MV3 extension (v2.3.0)
server.py         Fleet server — Python 3.11+ standard library only, SQLite
web/              Admin dashboard (no build step, served by server.py)
tests/            End-to-end server tests (python3 -m unittest discover -s tests)
tools/            Helper scripts (i18n_check.py)
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
| Companies | Search, filter (with browsers, offline, own policy, pending requests, empty), sort; link unknown addresses to a company |
| Company | Browsers, **own policy** (mode + allowed/blocked lists with a live preview of what browsers receive), AD computers, details |
| Devices | Filter by status, company, version; rename, pin to a company, bulk delete, CSV export |
| Global policy | Default mode and lists for everyone |
| Access requests | Allow / reject / block, for the requester's company or for everyone; history |
| Updates | Upload a signed CRX, rollout progress, install snippets |
| Activity log | Every admin action with who and from where |
| Settings | Password, sessions, theme, language |

## Per-company policy

Every browser receives the **effective** policy of its company:

* **Mode** — a company either follows the global mode or sets its own
  (*all sites open*, *blacklist*, *whitelist only*).
* **Lists** — company lists are added to the global lists, and a company entry
  wins over a global one:
  `allowed = (global allowed − company blocked) + company allowed`,
  `blocked = (global blocked − company allowed) + company blocked`.

A browser belongs to a company by, in order: a manual pin → a NAT address
(single IP or CIDR range) → the office subnet. If two companies share a subnet
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
python3 -m unittest discover -s tests -v   # 36 tests: sessions, policy merge, requests, keep-alive, v2 → v3 migration
python3 tools/i18n_check.py                # every dashboard string has an Uzbek translation
```

## Licence

Internal use — Innova Networks. Bundled fonts (Big Shoulders, Instrument Sans,
Red Hat Mono) are under the SIL Open Font License; see `web/assets/fonts/`.
