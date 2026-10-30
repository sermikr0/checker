#!/usr/bin/env python3
"""
URL Safety Checker — Fleet management backend (stdlib only, no pip deps).

DISCLOSED inventory + central *configuration* service for the corporate
deployment of the URL Safety Checker extension. Logistics managers are informed
before devices are enrolled; the extension shows a visible "managed" notice.

What this server does:
  * Enrollment:  devices register a random device-id + extension version.
  * Heartbeat:   devices check in periodically; server records last-seen + the
                 public/source IP it observes.
  * Config:      serves DATA-ONLY policy (allowlist, feature toggles). It never
                 serves or executes code. Extension *code* updates are delivered
                 only through the signed-CRX Chrome Enterprise channel (see
                 DEPLOYMENT.md) — NOT through this server.
  * Dashboard:   an admin page (token-gated) listing every enrolled device.

Run:   python3 server.py            # binds 0.0.0.0:8080
Admin token is generated on first run and written to ./admin_token.txt.
"""

import hashlib
import json
import os
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "fleet.db")
TOKEN_PATH = os.path.join(HERE, "admin_token.txt")
COMPANIES_PATH = os.path.join(HERE, "companies.json")
HOST = os.environ.get("FLEET_HOST", "0.0.0.0")
PORT = int(os.environ.get("FLEET_PORT", "8080"))
HEARTBEAT_SEC = 60  # how often devices should check in (fast policy propagation)
DOWNLOAD_DIR = os.path.join(HERE, "downloads")
# Stable extension id derived from signing-key.pem (reused for every release).
APPID = "lddmakdihlenfbmdpggpahjooglgigoi"

# Config is strictly typed DATA. No code, no scripts, nothing executable.
DEFAULT_CONFIG = {
    "allowlist": "",
    "hoverPreview": True,
    "markLinks": True,
    "activeFetch": False,
    # Enforcement (web filtering). enforceMode: off | blacklist | whitelist
    "enforceMode": "off",
    "whitelist": "",   # one domain per line — only these allowed in whitelist mode
    "blacklist": "",   # one domain per line — always blocked
    # VirusTotal reputation lookup (pushed centrally; blank = disabled)
    "vtKey": "",
}
CONFIG_KEYS = set(DEFAULT_CONFIG.keys())
_STRING_CONFIG_KEYS = {"allowlist", "whitelist", "blacklist", "vtKey"}
_ENFORCE_MODES = {"off", "blacklist", "whitelist"}

_db_lock = threading.Lock()


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS devices (
                   device_id   TEXT PRIMARY KEY,
                   label       TEXT DEFAULT '',
                   version     TEXT DEFAULT '',
                   user_agent  TEXT DEFAULT '',
                   first_seen  TEXT,
                   last_seen   TEXT,
                   last_ip     TEXT DEFAULT '',
                   enroll_count INTEGER DEFAULT 0,
                   beats       INTEGER DEFAULT 0
               )"""
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)"
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS requests (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   domain TEXT, url TEXT, device_id TEXT, label TEXT DEFAULT '',
                   ts TEXT, status TEXT DEFAULT 'pending'
               )"""
        )
        cur = conn.execute("SELECT v FROM kv WHERE k='config'")
        if cur.fetchone() is None:
            conn.execute(
                "INSERT INTO kv (k, v) VALUES ('config', ?)",
                (json.dumps(DEFAULT_CONFIG),),
            )
        cur = conn.execute("SELECT v FROM kv WHERE k='release'")
        if cur.fetchone() is None:
            conn.execute(
                "INSERT INTO kv (k, v) VALUES ('release', ?)",
                (json.dumps({"appid": APPID, "version": "", "filename": ""}),),
            )
        conn.commit()
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)


def load_config():
    with db() as conn:
        row = conn.execute("SELECT v FROM kv WHERE k='config'").fetchone()
    try:
        cfg = json.loads(row["v"]) if row else {}
    except (ValueError, TypeError):
        cfg = {}
    return {**DEFAULT_CONFIG, **{k: cfg.get(k) for k in CONFIG_KEYS if k in cfg}}


def save_config(new_cfg):
    """Merge known keys into the current config (partial updates keep the rest)."""
    clean = load_config()
    for k in CONFIG_KEYS:
        if k not in new_cfg:
            continue
        if k in _STRING_CONFIG_KEYS:
            clean[k] = str(new_cfg[k])[:20000]
        elif k == "enforceMode":
            m = str(new_cfg[k])
            clean[k] = m if m in _ENFORCE_MODES else "off"
        else:
            clean[k] = bool(new_cfg[k])
    with db() as conn:
        conn.execute("UPDATE kv SET v=? WHERE k='config'", (json.dumps(clean),))
        conn.commit()
    return clean


def domain_of(url):
    from urllib.parse import urlparse
    try:
        h = urlparse(url if "://" in url else "http://" + url).hostname or ""
        return h.lower().lstrip(".")[:120]
    except Exception:
        return ""


def append_domain_to_list(list_key, domain):
    """Add a domain to the whitelist/blacklist config list (used by approve/reject)."""
    cfg = load_config()
    existing = [d.strip() for d in str(cfg.get(list_key, "")).replace(",", "\n").split("\n") if d.strip()]
    if domain and domain not in existing:
        existing.append(domain)
    cfg[list_key] = "\n".join(existing)
    return save_config(cfg)


def load_release():
    with db() as conn:
        row = conn.execute("SELECT v FROM kv WHERE k='release'").fetchone()
    try:
        rel = json.loads(row["v"]) if row else {}
    except (ValueError, TypeError):
        rel = {}
    rel.setdefault("appid", APPID)
    rel.setdefault("version", "")
    rel.setdefault("filename", "")
    return rel


def save_release(rel):
    with db() as conn:
        conn.execute("UPDATE kv SET v=? WHERE k='release'", (json.dumps(rel),))
        conn.commit()


def load_companies():
    """Load companies from the DB kv store (key='companies').
    Falls back to companies.json file for initial import."""
    with db() as conn:
        row = conn.execute("SELECT v FROM kv WHERE k='companies'").fetchone()
    if row:
        try:
            return json.loads(row["v"])
        except (ValueError, TypeError):
            pass
    # First run: import from companies.json file if it exists
    try:
        with open(COMPANIES_PATH) as f:
            data = json.load(f)
        save_companies(data)
        return data
    except (FileNotFoundError, ValueError):
        return []


def save_companies(companies):
    """Persist companies list to the DB kv store."""
    with db() as conn:
        existing = conn.execute("SELECT k FROM kv WHERE k='companies'").fetchone()
        if existing:
            conn.execute("UPDATE kv SET v=? WHERE k='companies'",
                         (json.dumps(companies, ensure_ascii=False),))
        else:
            conn.execute("INSERT INTO kv (k, v) VALUES ('companies', ?)",
                         (json.dumps(companies, ensure_ascii=False),))
        conn.commit()


def match_device_company(device_ip, companies):
    """Match a device's public IP to a company by nat_ips list,
    or fall back to private-subnet prefix matching."""
    if not device_ip or not companies:
        return None
    for c in companies:
        # Check nat_ips (public/NAT IPs assigned to a company)
        nat_ips = c.get("nat_ips") or []
        if device_ip in nat_ips:
            return c["name"]
    # Fallback: first-two-octet private subnet match
    parts = device_ip.split(".")
    if len(parts) < 2:
        return None
    prefix = parts[0] + "." + parts[1]
    for c in companies:
        if c.get("subnet") == prefix:
            return c["name"]
    return None


def parse_crx_version(crx_bytes):
    """Read manifest.json version from inside a CRX3 package. Returns str or ''."""
    import zipfile
    import io
    if crx_bytes[:4] != b"Cr24":
        return ""
    try:
        (ver,) = struct.unpack("<I", crx_bytes[4:8])
        if ver != 3:
            return ""
        (hlen,) = struct.unpack("<I", crx_bytes[8:12])
        zip_start = 12 + hlen
        with zipfile.ZipFile(io.BytesIO(crx_bytes[zip_start:])) as z:
            with z.open("manifest.json") as mf:
                return str(json.loads(mf.read().decode("utf-8")).get("version", ""))[:32]
    except Exception:
        return ""


import struct  # noqa: E402  (used by parse_crx_version)


def get_admin_token():
    if os.path.exists(TOKEN_PATH):
        with open(TOKEN_PATH, "r") as f:
            tok = f.read().strip()
            if tok:
                return tok
    tok = secrets.token_urlsafe(24)
    with open(TOKEN_PATH, "w") as f:
        f.write(tok + "\n")
    os.chmod(TOKEN_PATH, 0o600)
    return tok


ADMIN_TOKEN = None  # set in main()
ADMIN_USER = None   # set in main()
USER_PATH = os.path.join(HERE, "admin_user.json")


def _hash_pw(pw, salt_hex):
    return hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), bytes.fromhex(salt_hex), 200000).hex()


def get_or_create_user():
    """Admin login credentials. Default user 'admin' with a random password
    generated + printed on first run (stored hashed, never in plain text)."""
    if os.path.exists(USER_PATH):
        try:
            with open(USER_PATH) as f:
                return json.load(f)
        except (OSError, ValueError):
            pass
    username = os.environ.get("FLEET_ADMIN_USER", "admin")
    password = os.environ.get("FLEET_ADMIN_PASS", secrets.token_urlsafe(9))
    salt = secrets.token_hex(16)
    data = {"username": username, "salt": salt, "hash": _hash_pw(password, salt)}
    with open(USER_PATH, "w") as f:
        json.dump(data, f)
    os.chmod(USER_PATH, 0o600)
    data["_plain"] = password
    return data


def set_admin_password(new_pw, username=None):
    """Re-hash and persist the admin password, and update the in-memory
    ADMIN_USER so the change takes effect immediately (no restart)."""
    global ADMIN_USER
    user = username or (ADMIN_USER or {}).get("username") or "admin"
    salt = secrets.token_hex(16)
    data = {"username": user, "salt": salt, "hash": _hash_pw(new_pw, salt)}
    with open(USER_PATH, "w") as f:
        json.dump(data, f)
    os.chmod(USER_PATH, 0o600)
    ADMIN_USER = data
    return data


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Handler(BaseHTTPRequestHandler):
    server_version = "URLFleet/1.0"

    # ── helpers ────────────────────────────────────────────────────────────
    def _cors(self):
        # Extension fetches with its chrome-extension:// origin and sends no
        # cookies, so a wildcard ACAO is safe here (no credentialed requests).
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token")

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _html(self, code, text):
        body = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return {}
        if n <= 0 or n > 256 * 1024:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return {}

    def _is_tls(self):
        try:
            import ssl
            return isinstance(self.connection, ssl.SSLSocket)
        except Exception:
            return False

    def _client_ip(self):
        # Honour a reverse proxy if one is ever put in front; else socket peer.
        xff = self.headers.get("X-Forwarded-For", "")
        if xff:
            return xff.split(",")[0].strip()[:64]
        return self.client_address[0][:64]

    def _is_admin(self):
        return secrets.compare_digest(
            self.headers.get("X-Admin-Token", ""), ADMIN_TOKEN or ""
        )

    def log_message(self, fmt, *args):
        print("%s - %s" % (self._client_ip(), fmt % args))

    # ── routing ────────────────────────────────────────────────────────────
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/" or path == "/dashboard":
            return self._html(200, load_dashboard())
        if path == "/api/config":
            return self._json(200, {"ok": True, "config": load_config()})
        if path == "/api/devices":
            if not self._is_admin():
                return self._json(401, {"ok": False, "error": "unauthorized"})
            with db() as conn:
                rows = [dict(r) for r in conn.execute(
                    "SELECT * FROM devices ORDER BY last_seen DESC"
                ).fetchall()]
            return self._json(200, {"ok": True, "devices": rows, "now": now_iso()})
        if path == "/update_manifest.xml":
            return self._update_manifest()
        if path == "/api/release":
            return self._json(200, {"ok": True, "release": load_release()})
        if path == "/api/requests":
            if not self._is_admin():
                return self._json(401, {"ok": False, "error": "unauthorized"})
            with db() as conn:
                rows = [dict(r) for r in conn.execute(
                    "SELECT * FROM requests WHERE status='pending' ORDER BY ts DESC LIMIT 200"
                ).fetchall()]
            return self._json(200, {"ok": True, "requests": rows})
        if path == "/api/companies":
            if not self._is_admin():
                return self._json(401, {"ok": False, "error": "unauthorized"})
            companies = load_companies()
            # Enrich: match enrolled devices to companies by subnet
            with db() as conn:
                devices = [dict(r) for r in conn.execute(
                    "SELECT * FROM devices ORDER BY last_seen DESC"
                ).fetchall()]
            for comp in companies:
                comp["devices"] = []
            unmatched = []
            for dev in devices:
                matched = False
                for comp in companies:
                    if match_device_company(dev.get("last_ip", ""), [comp]):
                        comp["devices"].append(dev)
                        matched = True
                        break
                if not matched:
                    unmatched.append(dev)
            return self._json(200, {
                "ok": True,
                "companies": companies,
                "unmatched": unmatched,
                "now": now_iso()
            })
        if path.startswith("/downloads/"):
            return self._serve_download(path)
        if path == "/healthz":
            return self._json(200, {"ok": True})
        return self._json(404, {"ok": False, "error": "not found"})

    def _update_manifest(self):
        """Chrome Omaha-style update manifest for self-hosted auto-update."""
        rel = load_release()
        host = self.headers.get("Host") or ("%s:%d" % (
            self.connection.getsockname()[0], PORT))
        # Behind the Cloudflare tunnel the origin connection is plain HTTP;
        # trust X-Forwarded-Proto so the CRX codebase URL comes out https.
        xfp = (self.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
        scheme = "https" if (xfp == "https" or self._is_tls()) else "http"
        if rel.get("version") and rel.get("filename"):
            codebase = "%s://%s/downloads/%s" % (scheme, host, rel["filename"])
            app = ("  <app appid='%s'>\n"
                   "    <updatecheck codebase='%s' version='%s' />\n"
                   "  </app>\n") % (rel["appid"], codebase, rel["version"])
        else:
            app = "  <app appid='%s'><updatecheck status='noupdate'/></app>\n" % rel["appid"]
        xml = ("<?xml version='1.0' encoding='UTF-8'?>\n"
               "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n"
               + app + "</gupdate>\n")
        body = xml.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/xml")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_download(self, path):
        name = os.path.basename(path)  # strips any traversal
        if not name.endswith(".crx"):
            return self._json(404, {"ok": False, "error": "not found"})
        full = os.path.join(DOWNLOAD_DIR, name)
        if not os.path.isfile(full):
            return self._json(404, {"ok": False, "error": "not found"})
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "application/x-chrome-extension")
        self.send_header("Content-Disposition", "attachment; filename=\"%s\"" % name)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/api/login":
            body = self._read_json()
            u = str(body.get("username", ""))
            p = str(body.get("password", ""))
            ok = bool(ADMIN_USER) and secrets.compare_digest(u, ADMIN_USER["username"]) \
                and secrets.compare_digest(_hash_pw(p, ADMIN_USER["salt"]), ADMIN_USER["hash"])
            if not ok:
                time.sleep(0.5)  # throttle brute force
                return self._json(401, {"ok": False, "error": "Invalid username or password"})
            return self._json(200, {"ok": True, "token": ADMIN_TOKEN})
        if path == "/api/enroll":
            return self._enroll()
        if path == "/api/heartbeat":
            return self._heartbeat()
        if path == "/api/config":
            if not self._is_admin():
                return self._json(401, {"ok": False, "error": "unauthorized"})
            body = self._read_json()
            cfg = save_config(body.get("config", body))
            return self._json(200, {"ok": True, "config": cfg})
        if path == "/api/device/label":
            if not self._is_admin():
                return self._json(401, {"ok": False, "error": "unauthorized"})
            body = self._read_json()
            did = str(body.get("deviceId", ""))[:80]
            label = str(body.get("label", ""))[:120]
            with _db_lock, db() as conn:
                conn.execute("UPDATE devices SET label=? WHERE device_id=?", (label, did))
                conn.commit()
            return self._json(200, {"ok": True})
        if path == "/api/device/delete":
            if not self._is_admin():
                return self._json(401, {"ok": False, "error": "unauthorized"})
            did = str(self._read_json().get("deviceId", ""))[:80]
            with _db_lock, db() as conn:
                n = conn.execute("DELETE FROM devices WHERE device_id=?", (did,)).rowcount
                conn.commit()
            return self._json(200, {"ok": True, "deleted": n})
        if path == "/api/devices/prune":
            if not self._is_admin():
                return self._json(401, {"ok": False, "error": "unauthorized"})
            # Delete devices not seen within `olderThanSec` (default 12 min).
            try:
                older = int(self._read_json().get("olderThanSec", 720))
            except (ValueError, TypeError):
                older = 720
            cutoff = datetime.now(timezone.utc).timestamp() - max(60, older)
            removed = 0
            with _db_lock, db() as conn:
                rows = conn.execute("SELECT device_id, last_seen FROM devices").fetchall()
                for r in rows:
                    try:
                        ts = datetime.strptime(r["last_seen"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
                    except (ValueError, TypeError):
                        ts = 0
                    if ts < cutoff:
                        conn.execute("DELETE FROM devices WHERE device_id=?", (r["device_id"],))
                        removed += 1
                conn.commit()
            return self._json(200, {"ok": True, "removed": removed})
        if path == "/api/request-access":
            # Sent by a blocked extension (no admin token). Records a pending request.
            body = self._read_json()
            url = str(body.get("url", ""))[:2000]
            did = str(body.get("deviceId", ""))[:80]
            label = str(body.get("label", ""))[:120]
            domain = domain_of(url)
            if not domain:
                return self._json(400, {"ok": False, "error": "no domain"})
            with _db_lock, db() as conn:
                dup = conn.execute(
                    "SELECT id FROM requests WHERE domain=? AND status='pending'", (domain,)
                ).fetchone()
                if not dup:
                    conn.execute(
                        "INSERT INTO requests (domain, url, device_id, label, ts, status) VALUES (?,?,?,?,?, 'pending')",
                        (domain, url, did, label, now_iso()),
                    )
                    conn.commit()
            return self._json(200, {"ok": True, "domain": domain})
        if path == "/api/request/resolve":
            if not self._is_admin():
                return self._json(401, {"ok": False, "error": "unauthorized"})
            body = self._read_json()
            try:
                rid = int(body.get("id", 0))
            except (ValueError, TypeError):
                rid = 0
            action = str(body.get("action", ""))
            with db() as conn:
                row = conn.execute("SELECT domain FROM requests WHERE id=?", (rid,)).fetchone()
            if not row:
                return self._json(404, {"ok": False, "error": "request not found"})
            domain = row["domain"]
            if action == "approve":
                append_domain_to_list("whitelist", domain)
                new_status = "approved"
            elif action == "reject":
                append_domain_to_list("blacklist", domain)
                new_status = "rejected"
            else:
                return self._json(400, {"ok": False, "error": "action must be approve|reject"})
            with _db_lock, db() as conn:
                conn.execute("UPDATE requests SET status=? WHERE domain=? AND status='pending'",
                             (new_status, domain))
                conn.commit()
            return self._json(200, {"ok": True, "domain": domain, "status": new_status})
        if path == "/api/company/nat-ip":
            if not self._is_admin():
                return self._json(401, {"ok": False, "error": "unauthorized"})
            body = self._read_json()
            company_name = str(body.get("company", "")).strip()
            ip = str(body.get("ip", "")).strip()
            action = str(body.get("action", "add"))  # add | remove
            if not company_name or not ip:
                return self._json(400, {"ok": False, "error": "company and ip required"})
            companies = load_companies()
            found = False
            for c in companies:
                if c["name"] == company_name:
                    found = True
                    nat_ips = c.get("nat_ips") or []
                    if action == "add" and ip not in nat_ips:
                        nat_ips.append(ip)
                    elif action == "remove":
                        nat_ips = [x for x in nat_ips if x != ip]
                    c["nat_ips"] = nat_ips
                    break
            if not found:
                return self._json(404, {"ok": False, "error": "company not found"})
            save_companies(companies)
            return self._json(200, {"ok": True})
        if path == "/api/change-password":
            return self._change_password()
        if path == "/api/upload-crx":
            return self._upload_crx()
        return self._json(404, {"ok": False, "error": "not found"})

    def _change_password(self):
        if not self._is_admin():
            return self._json(401, {"ok": False, "error": "unauthorized"})
        body = self._read_json()
        cur = str(body.get("current_password", ""))
        new = str(body.get("new_password", ""))
        if not ADMIN_USER or not secrets.compare_digest(
                _hash_pw(cur, ADMIN_USER["salt"]), ADMIN_USER["hash"]):
            time.sleep(0.5)  # throttle guessing of the current password
            return self._json(403, {"ok": False, "error": "Current password is incorrect"})
        if len(new) < 6:
            return self._json(400, {"ok": False, "error": "New password must be at least 6 characters"})
        set_admin_password(new)
        return self._json(200, {"ok": True})

    def _upload_crx(self):
        if not self._is_admin():
            return self._json(401, {"ok": False, "error": "unauthorized"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            n = 0
        if n <= 0 or n > 50 * 1024 * 1024:
            return self._json(400, {"ok": False, "error": "bad upload size"})
        data = self.rfile.read(n)
        if data[:4] != b"Cr24":
            return self._json(400, {"ok": False, "error": "not a .crx (CRX3) file"})
        version = parse_crx_version(data)
        if not version:
            return self._json(400, {"ok": False, "error": "could not read version from manifest.json"})
        filename = "url-safety-checker-%s.crx" % version
        safe = os.path.basename(filename)
        with open(os.path.join(DOWNLOAD_DIR, safe), "wb") as f:
            f.write(data)
        save_release({"appid": APPID, "version": version, "filename": safe})
        return self._json(200, {"ok": True, "version": version, "filename": safe})

    def _enroll(self):
        body = self._read_json()
        did = str(body.get("deviceId", ""))[:80]
        if not did:
            return self._json(400, {"ok": False, "error": "deviceId required"})
        ver = str(body.get("version", ""))[:32]
        ua = str(body.get("userAgent", ""))[:300]
        ip = self._client_ip()
        ts = now_iso()
        with _db_lock, db() as conn:
            exists = conn.execute(
                "SELECT device_id FROM devices WHERE device_id=?", (did,)
            ).fetchone()
            if exists:
                conn.execute(
                    """UPDATE devices SET version=?, user_agent=?, last_seen=?,
                           last_ip=?, enroll_count=enroll_count+1 WHERE device_id=?""",
                    (ver, ua, ts, ip, did),
                )
            else:
                conn.execute(
                    """INSERT INTO devices
                       (device_id, version, user_agent, first_seen, last_seen,
                        last_ip, enroll_count, beats)
                       VALUES (?,?,?,?,?,?,1,0)""",
                    (did, ver, ua, ts, ts, ip),
                )
            # De-duplicate: the same browser on the same machine (same source IP
            # + user-agent) reinstalled gets a fresh device-id. Drop the older
            # rows so each browser shows once. Different browsers (different UA)
            # and different machines (different IP) are kept.
            if ua:
                conn.execute(
                    "DELETE FROM devices WHERE last_ip=? AND user_agent=? AND device_id<>?",
                    (ip, ua, did),
                )
            conn.commit()
        return self._json(200, {
            "ok": True, "config": load_config(), "heartbeatSec": HEARTBEAT_SEC,
        })

    def _heartbeat(self):
        body = self._read_json()
        did = str(body.get("deviceId", ""))[:80]
        if not did:
            return self._json(400, {"ok": False, "error": "deviceId required"})
        ver = str(body.get("version", ""))[:32]
        ip = self._client_ip()
        ts = now_iso()
        with _db_lock, db() as conn:
            row = conn.execute(
                "SELECT device_id FROM devices WHERE device_id=?", (did,)
            ).fetchone()
            if row:
                conn.execute(
                    """UPDATE devices SET last_seen=?, last_ip=?, version=?,
                           beats=beats+1 WHERE device_id=?""",
                    (ts, ip, ver, did),
                )
            else:
                conn.execute(
                    """INSERT INTO devices
                       (device_id, version, first_seen, last_seen, last_ip, enroll_count, beats)
                       VALUES (?,?,?,?,?,0,1)""",
                    (did, ver, ts, ts, ip),
                )
            conn.commit()
        return self._json(200, {
            "ok": True, "config": load_config(), "heartbeatSec": HEARTBEAT_SEC,
        })




def load_dashboard():
    """Served at request time so design edits need no restart."""
    try:
        with open(os.path.join(HERE, "dashboard.html"), encoding="utf-8") as f:
            return f.read()
    except OSError:
        return "<!doctype html><title>Fleet</title><p>dashboard.html missing on server.</p>"


def main():
    global ADMIN_TOKEN, ADMIN_USER
    init_db()
    ADMIN_TOKEN = get_admin_token()
    ADMIN_USER = get_or_create_user()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print("=" * 60)
    print("URL Safety Checker — Fleet backend")
    print("Listening on http://%s:%d" % (HOST, PORT))
    print("Dashboard:   http://<server-ip>:%d/" % PORT)
    print("Login user:  %s" % ADMIN_USER["username"])
    if ADMIN_USER.get("_plain"):
        print("Login pass:  %s   <-- shown once; save it" % ADMIN_USER["_plain"])
    else:
        print("Login pass:  (set earlier; see %s or reset by deleting it)" % USER_PATH)
    print("Admin token: %s" % ADMIN_TOKEN)

    # Optional TLS listener (self-signed cert on a LAN IP). Runs alongside the
    # plain HTTP listener so the extension (HTTP) is never broken while the admin
    # dashboard is available over HTTPS.
    tls_srv = None
    cert = os.environ.get("FLEET_TLS_CERT")
    key = os.environ.get("FLEET_TLS_KEY")
    if cert and key and os.path.exists(cert) and os.path.exists(key):
        import ssl
        tls_port = int(os.environ.get("FLEET_TLS_PORT", "8443"))
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        tls_srv = ThreadingHTTPServer((HOST, tls_port), Handler)
        tls_srv.socket = ctx.wrap_socket(tls_srv.socket, server_side=True)
        threading.Thread(target=tls_srv.serve_forever, daemon=True).start()
        print("HTTPS:       https://<server-ip>:%d/" % tls_port)
    print("=" * 60)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()
        if tls_srv:
            tls_srv.shutdown()


if __name__ == "__main__":
    main()
