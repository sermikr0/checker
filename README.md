# URL Safety Checker — Fleet Management

Centralized **disclosed** management system for the corporate "URL Safety Checker" Chrome extension. Built for logistics anti-phishing + web filtering across multiple company offices.

## Components

### 🖥️ Server (`server.py`)
Pure Python 3.13+ stdlib backend (no pip dependencies):
- **Device inventory** — enrollment, heartbeat, online/offline tracking
- **Web filtering** — whitelist/blacklist enforcement with full-screen SCAM interstitial
- **Company management** — group devices by company (NAT IP matching from AD)
- **Admin dashboard** — single-page HTML admin panel
- **Self-hosted Chrome update** — Omaha-style `update_manifest.xml`

### 🧩 Extension (`extension/`)
Chrome MV3 extension:
- Link safety analysis (phishing, malware, freight-industry scams)
- declarativeNetRequest-based web filtering (server-pushed policy)
- Full-screen interstitial for blocked sites
- Periodic heartbeat to fleet server
- Force-installable via Chrome Enterprise GPO

### 📊 Dashboard (`dashboard.html`)
Admin panel features:
- **Overview** — device count, online/offline stats, master switch
- **Companies** — devices grouped by company with AD computer inventory
- **Devices** — full device table with labels, versions, IPs
- **Configuration** — web filtering mode (off/blacklist/whitelist)
- **Requests** — approve/reject blocked-site access requests
- **Updates** — upload signed CRX for fleet auto-update
- **Settings** — change admin password

## Deployment

### Docker (recommended)
```bash
docker compose up -d
```

The `docker-compose.yml` runs:
- `urlfleet-server` — Python app on `127.0.0.1:8080`
- `urlfleet-cloudflared` — Cloudflare Tunnel (host network)

### Manual
```bash
python3 server.py
# Binds 0.0.0.0:8080
# Admin token generated on first run → admin_token.txt
```

### Environment Variables
| Variable | Default | Description |
|----------|---------|-------------|
| `FLEET_HOST` | `0.0.0.0` | Bind address |
| `FLEET_PORT` | `8080` | Listen port |
| `TZ` | system | Timezone |

## Extension Build
```bash
python3 pack_crx.py extension signing-key.pem output.crx
```

## Security Notes
- Admin access is token-gated (pbkdf2_hmac SHA-256, 200k iterations)
- Extension updates are **signed CRX only** — the server never serves executable code
- Management is **disclosed** — Chrome shows "managed by your organization"
- Web filtering is **data-only** (domain lists, feature toggles)

## License
Internal use — Innova Networks
