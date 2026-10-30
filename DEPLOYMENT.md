# URL Safety Checker — Fleet deployment

Centralized **inventory + configuration** for the corporate build of the
extension, with a disclosed management model (logistics managers are informed
before enrollment; the extension shows a visible "managed by your organization"
notice in Settings).

## Pieces

| Piece | Where | What it does |
|---|---|---|
| `server.py` | `10.252.13.126:/home/ext/url-fleet/` | Backend: enroll, heartbeat, device list, config. Pure Python stdlib, no pip deps. |
| `url-fleet.service` | systemd (installed) | Keeps the backend running + auto-starts on boot. |
| Dashboard | `http://10.252.13.126:8080/` | Admin page: device inventory + central config. Token-gated. |
| `url-safety-checker-2.1.0.zip` | this folder | The updated extension (v2.1.0) with enrollment + heartbeat. |

**Admin token:** stored in `/home/ext/url-fleet/admin_token.txt` on the server
(`CvmaacMco9lUCKYHy3a1cNrPeToIZZd3`). Open the dashboard and paste it to sign in.

## What the extension sends (and does not)

Sends on install + every 5 min: a random **device ID**, the **extension
version**, and the **user-agent**. The server additionally records the **source
IP** it sees (unavoidable for any network call).

Does **not** send: browsing history, page contents, URLs the user checks, or any
API keys. Does **not** download or run code from the server — the config it
pulls is strictly data (allowlist + feature toggles) and is type-checked.

## Server management

```bash
sudo systemctl status url-fleet      # state
sudo systemctl restart url-fleet     # restart
sudo journalctl -u url-fleet -f      # live logs
```

Data lives in `/home/ext/url-fleet/fleet.db` (SQLite).

## Updating the extension across the fleet — the signed-CRX way

This is the correct "update once, everyone gets it" mechanism. It ships
**signed** packages through Chrome's own update channel — no custom code push,
no runtime code execution (which MV3 forbids and which would make the extension
look like malware).

**Option A — Google Admin console (managed Chrome):**
1. Package + upload the extension privately to the Chrome Web Store.
2. Admin console → Devices → Chrome → Apps & extensions → **Force install** for
   your org units.
3. To update: upload the new version to the Web Store, bump `version` in
   `manifest.json`. Every managed browser auto-updates within hours.

**Option B — self-hosted update (GPO / registry, Windows domain):**
1. Host the `.crx` + an `update_manifest.xml` on an internal web server.
2. Group Policy: `ExtensionInstallForcelist` =
   `<extension-id>;http://your-server/update_manifest.xml`.
3. To update: publish the new `.crx`, bump the `version` in both `manifest.json`
   and `update_manifest.xml`. Chrome polls and auto-updates.

Either way the fleet dashboard shows which version each device is actually
running, so you can watch an update roll out.

## Hardening before leaving the LAN

- Put the backend behind **TLS** (reverse proxy) and replace the single admin
  token with real accounts.
- Restrict `/api/devices` and `/api/config` to the admin network.
- The backend currently binds `0.0.0.0:8080` on an internal IP with the firewall
  inactive; fine for a trusted LAN, not for internet exposure.
