#!/usr/bin/env python3
"""
URL Safety Checker — Fleet server v3 (Python stdlib only, no pip dependencies).

Disclosed inventory + central web-filtering policy for the corporate build of
the URL Safety Checker Chrome extension.

  * Devices      enroll / heartbeat with a random device id; the server records
                 version, user-agent, last-seen and source IP.
  * Companies    devices are matched to a company by NAT IP, by subnet, or by a
                 manual pin set in the dashboard.
  * Policy       a global policy (off / blacklist / whitelist + domain lists)
                 plus optional per-company overrides. Every device receives the
                 EFFECTIVE policy of its company. Data only — never code.
  * Requests     employees can ask for a blocked site; admins approve for one
                 company or globally, reject, or block.
  * Updates      self-hosted Chrome update channel (update_manifest.xml + signed
                 CRX). Chrome verifies the signature; the server checks that the
                 package carries the fleet's extension id.
  * Dashboard    single-page admin app in ./web, protected by login sessions
                 (HttpOnly cookie, idle + absolute expiry, CSRF header).

Run:
    python3 server.py                    # serve (FLEET_HOST / FLEET_PORT)
    python3 server.py reset-password     # set a new admin password, revoke sessions
    python3 server.py migrate-check [fleet.db]   # dry-run the upgrade on a copy of the database
"""

import getpass
import hashlib
import io
import ipaddress
import json
import random
import socket
import os
import re
import secrets
import sqlite3
import struct
import sys
import threading
import time
import traceback
import zipfile
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timezone
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# ── Paths & settings ─────────────────────────────────────────────────────────

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("FLEET_DATA_DIR", HERE)
WEB_DIR = os.path.join(HERE, "web")
DB_PATH = os.path.join(DATA_DIR, "fleet.db")
USER_PATH = os.path.join(DATA_DIR, "admin_user.json")
LEGACY_TOKEN_PATH = os.path.join(DATA_DIR, "admin_token.txt")
DOWNLOAD_DIR = os.path.join(DATA_DIR, "downloads")
COMPANIES_SEED = [os.path.join(DATA_DIR, "companies.json"), os.path.join(HERE, "companies.json")]

HOST = os.environ.get("FLEET_HOST", "0.0.0.0")
PORT = int(os.environ.get("FLEET_PORT", "8080"))
# How the client IP is determined:
#   none (default) — socket peer only (server reachable directly, e.g. on a LAN)
#   cloudflare     — CF-Connecting-IP (set by Cloudflare / cloudflared). Only safe when
#                    cloudflared is the sole way in — otherwise clients can fake the header.
#   xff            — right-most X-Forwarded-For entry (exactly one trusted reverse proxy)
TRUST_PROXY = os.environ.get("FLEET_TRUST_PROXY", "none").strip().lower()
LOG_HEARTBEATS = os.environ.get("FLEET_LOG_HEARTBEATS", "0") == "1"

APP_VERSION = "3.0.0"
# Stable extension id derived from signing-key.pem (reused for every release).
APPID = os.environ.get("FLEET_APPID", "lddmakdihlenfbmdpggpahjooglgigoi")

HEARTBEAT_SEC = 60          # devices check in this often
# Local IPs of AD computers are looked up in each company's AD DNS (its DC).
DNS_INTERVAL = int(os.environ.get("FLEET_DNS_INTERVAL", "900"))   # seconds; 0 = only on demand
DNS_PORT = int(os.environ.get("FLEET_DNS_PORT", "53"))
DNS_TIMEOUT = float(os.environ.get("FLEET_DNS_TIMEOUT", "1.0"))
ONLINE_SEC = 180            # no check-in for longer than this = offline
SESSION_IDLE_SEC = 12 * 3600
SESSION_MAX_SEC = 7 * 24 * 3600
SESSION_COOKIE = "usc_session"
CSRF_HEADER = "X-Fleet-CSRF"

MODES = ("off", "blacklist", "whitelist")
COMPANY_MODES = ("inherit",) + MODES
GLOBAL_LIST_MAX_CHARS = 10000   # the extension accepts up to 20000 chars per list;
COMPANY_LIST_MAX_CHARS = 9000   # global + company must stay below that
DELIVERY_MAX_CHARS = 19500      # hard cap per list sent to a device (cut on a domain boundary)
MAX_PENDING_REQUESTS = 20000      # hard safety cap for the whole queue
MAX_PENDING_PER_IP = 300
MAX_PENDING_PER_DEVICE = 20
MAX_BODY = 51 * 1024 * 1024       # largest accepted request (CRX upload)
MAX_DRAIN = 4 * 1024 * 1024       # unread bodies bigger than this close the connection instead
AUDIT_KEEP = 5000


# ── Small utilities ──────────────────────────────────────────────────────────

def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def iso_to_ts(s):
    try:
        return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
    except (TypeError, ValueError):
        return 0.0


def version_key(v):
    parts = []
    for p in str(v or "").split("."):
        parts.append(int(p) if p.isdigit() else -1)
    return tuple(parts)


_DOMAIN_CHARS = re.compile(r"^[a-z0-9.-]+$")


def normalize_domain(item):
    """Same rules as USC.parseAllowlist() in the extension. Returns '' if invalid."""
    item = str(item or "").strip().lower()
    item = re.sub(r"^[a-z]+://", "", item)
    item = re.sub(r"[/?#].*$", "", item)
    item = re.sub(r"^www\.", "", item)
    item = re.sub(r"^\*\.", "", item)
    item = re.sub(r":\d+$", "", item)
    item = item.strip(".")
    if not item or len(item) > 253 or not _DOMAIN_CHARS.match(item) or ".." in item:
        return ""
    return item


def parse_domains(value):
    """Text (newline/comma/space separated) or list -> (ordered unique valid list, invalid list)."""
    if isinstance(value, (list, tuple)):
        raw = [str(x) for x in value]
    else:
        raw = re.split(r"[\s,;]+", str(value or ""))
    valid, invalid, seen = [], [], set()
    for item in raw:
        if not item.strip():
            continue
        d = normalize_domain(item)
        if not d:
            invalid.append(item.strip()[:100])
        elif d not in seen:
            seen.add(d)
            valid.append(d)
    return valid, invalid


def domains_text(lst):
    return "\n".join(lst)


def text_domains(text):
    return parse_domains(text)[0]


def domain_of(url):
    try:
        u = str(url or "")
        host = urlparse(u if "://" in u else "http://" + u).hostname or ""
    except ValueError:
        return ""
    return normalize_domain(host)


def subnet_to_network(s):
    """'10.118' -> 10.118.0.0/16, '10.118.4' -> /24, CIDR passes through."""
    s = str(s or "").strip()
    if not s:
        return None
    try:
        if "/" in s:
            return ipaddress.ip_network(s, strict=False)
        parts = [p for p in s.split(".") if p != ""]
        if parts and len(parts) <= 4 and all(p.isdigit() and 0 <= int(p) <= 255 for p in parts):
            addr = ".".join(parts + ["0"] * (4 - len(parts)))
            return ipaddress.ip_network("%s/%d" % (addr, 8 * len(parts)), strict=False)
        return ipaddress.ip_network(s, strict=False)
    except ValueError:
        return None


def ip_entry_to_network(s):
    try:
        return ipaddress.ip_network(str(s).strip(), strict=False)
    except ValueError:
        return None


def ext_id_from_crx_id(crx_id):
    return "".join(chr(ord("a") + (b >> 4)) + chr(ord("a") + (b & 0xF)) for b in crx_id)


def _read_varint(buf, pos):
    shift = result = 0
    while True:
        if pos >= len(buf):
            raise ValueError("truncated varint")
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, pos
        shift += 7
        if shift > 63:
            raise ValueError("varint too long")


def _proto_fields(buf):
    """Yield (field_number, wire_type, value) for a protobuf message (types 0 and 2 only)."""
    pos = 0
    while pos < len(buf):
        key, pos = _read_varint(buf, pos)
        field, wire = key >> 3, key & 7
        if wire == 0:
            val, pos = _read_varint(buf, pos)
        elif wire == 2:
            ln, pos = _read_varint(buf, pos)
            val = buf[pos:pos + ln]
            if len(val) != ln:
                raise ValueError("truncated field")
            pos += ln
        elif wire == 5:
            val, pos = buf[pos:pos + 4], pos + 4
        elif wire == 1:
            val, pos = buf[pos:pos + 8], pos + 8
        else:
            raise ValueError("unsupported wire type")
        yield field, wire, val


def parse_crx(data):
    """Validate a CRX3 package. Returns {'version', 'appid', 'name'} or raises ValueError."""
    if data[:4] != b"Cr24":
        raise ValueError("not a .crx file")
    if len(data) < 12:
        raise ValueError("truncated CRX header")
    (ver,) = struct.unpack("<I", data[4:8])
    if ver != 3:
        raise ValueError("only CRX3 packages are supported")
    (hlen,) = struct.unpack("<I", data[8:12])
    header = data[12:12 + hlen]
    if len(header) != hlen:
        raise ValueError("truncated CRX header")
    appid = ""
    for field, wire, val in _proto_fields(header):
        if field == 10000 and wire == 2:
            for f2, w2, v2 in _proto_fields(val):
                if f2 == 1 and w2 == 2 and len(v2) == 16:
                    appid = ext_id_from_crx_id(v2)
    if not appid:
        raise ValueError("CRX header has no extension id")
    try:
        with zipfile.ZipFile(io.BytesIO(data[12 + hlen:])) as z:
            with z.open("manifest.json") as mf:
                manifest = json.loads(mf.read().decode("utf-8-sig"))
    except (KeyError, zipfile.BadZipFile, ValueError, UnicodeDecodeError):
        raise ValueError("could not read manifest.json from the package")
    version = str(manifest.get("version", ""))[:32]
    if not re.match(r"^\d+(\.\d+){0,3}$", version):
        raise ValueError("manifest.json has no valid version")
    return {"version": version, "appid": appid, "name": str(manifest.get("name", ""))[:80]}


class RateLimiter:
    """Sliding-window counter per key (in memory)."""

    def __init__(self, limit, window_sec):
        self.limit, self.window = limit, window_sec
        self._hits = {}
        self._lock = threading.Lock()

    def _prune(self, key, now):
        q = [t for t in self._hits.get(key, []) if now - t < self.window]
        if q:
            self._hits[key] = q
        else:
            self._hits.pop(key, None)
        return q

    def retry_after(self, key):
        """Seconds until the key may try again (0 = allowed)."""
        now = time.time()
        with self._lock:
            q = self._prune(key, now)
            if len(q) < self.limit:
                return 0
            return int(self.window - (now - q[0])) + 1

    def hit(self, key):
        now = time.time()
        with self._lock:
            q = self._prune(key, now)
            q.append(now)
            self._hits[key] = q
            if len(self._hits) > 20000:      # memory guard
                for k in list(self._hits)[:5000]:
                    self._hits.pop(k, None)
            return len(q) <= self.limit

    def reset(self, key):
        with self._lock:
            self._hits.pop(key, None)


LOGIN_FAILS = RateLimiter(5, 15 * 60)
REQUEST_PER_DEVICE = RateLimiter(20, 10 * 60)
REQUEST_PER_IP = RateLimiter(200, 10 * 60)
NEW_DEVICES_PER_IP = RateLimiter(300, 60 * 60)


# ── Database ─────────────────────────────────────────────────────────────────

_write_lock = threading.RLock()


def _connect():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    return conn


@contextmanager
def read_db():
    conn = _connect()
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def write_db():
    with _write_lock:
        conn = _connect()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def _columns(conn, table):
    return {r["name"] for r in conn.execute("PRAGMA table_info(%s)" % table)}


def _ensure_columns(conn, table, cols):
    have = _columns(conn, table)
    for name, decl in cols.items():
        if name not in have:
            conn.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, name, decl))


def kv_get(conn, key, default=None):
    row = conn.execute("SELECT v FROM kv WHERE k=?", (key,)).fetchone()
    if not row:
        return default
    try:
        return json.loads(row["v"])
    except (TypeError, ValueError):
        return default


def kv_set(conn, key, value):
    conn.execute(
        "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
        (key, json.dumps(value, ensure_ascii=False)),
    )


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)
    conn = _connect()
    try:
        conn.execute("PRAGMA journal_mode=WAL")
    finally:
        conn.close()
    with write_db() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS devices (
                       device_id    TEXT PRIMARY KEY,
                       label        TEXT DEFAULT '',
                       version      TEXT DEFAULT '',
                       user_agent   TEXT DEFAULT '',
                       first_seen   TEXT,
                       last_seen    TEXT,
                       last_ip      TEXT DEFAULT '',
                       enroll_count INTEGER DEFAULT 0,
                       beats        INTEGER DEFAULT 0)""")
        _ensure_columns(c, "devices", {"company_id": "INTEGER", "computer_name": "TEXT DEFAULT ''"})
        c.execute("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)")
        c.execute("""CREATE TABLE IF NOT EXISTS requests (
                       id INTEGER PRIMARY KEY AUTOINCREMENT,
                       domain TEXT, url TEXT, device_id TEXT, label TEXT DEFAULT '',
                       ts TEXT, status TEXT DEFAULT 'pending')""")
        _ensure_columns(c, "requests", {
            "company_id": "INTEGER", "hits": "INTEGER DEFAULT 1", "last_ts": "TEXT",
            "resolved_at": "TEXT", "resolved_by": "TEXT DEFAULT ''", "scope": "TEXT DEFAULT ''",
            "ip": "TEXT DEFAULT ''",
        })
        c.execute("""CREATE TABLE IF NOT EXISTS companies (
                       id          INTEGER PRIMARY KEY AUTOINCREMENT,
                       name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
                       domain      TEXT DEFAULT '',
                       dc_ip       TEXT DEFAULT '',
                       subnet      TEXT DEFAULT '',
                       nat_ips     TEXT DEFAULT '[]',
                       computers   TEXT DEFAULT '[]',
                       notes       TEXT DEFAULT '',
                       policy_mode TEXT DEFAULT 'inherit',
                       whitelist   TEXT DEFAULT '',
                       blacklist   TEXT DEFAULT '',
                       created_at  TEXT,
                       updated_at  TEXT)""")
        _ensure_columns(c, "companies", {"rev": "INTEGER DEFAULT 0", "dns_status": "TEXT DEFAULT ''",
                                         "dns_checked_at": "TEXT DEFAULT ''", "dns_found": "INTEGER DEFAULT 0"})
        c.execute("""CREATE TABLE IF NOT EXISTS computer_ips (
                       company_id INTEGER NOT NULL,
                       name       TEXT NOT NULL COLLATE NOCASE,
                       manual_ip  TEXT DEFAULT '',
                       dns_ip     TEXT DEFAULT '',
                       dns_at     TEXT DEFAULT '',
                       PRIMARY KEY (company_id, name))""")
        c.execute("""CREATE TABLE IF NOT EXISTS sessions (
                       token_hash TEXT PRIMARY KEY,
                       username   TEXT,
                       created_at REAL,
                       last_used  REAL,
                       expires_at REAL,
                       ip         TEXT,
                       user_agent TEXT)""")
        c.execute("""CREATE TABLE IF NOT EXISTS audit (
                       id     INTEGER PRIMARY KEY AUTOINCREMENT,
                       ts     TEXT,
                       actor  TEXT,
                       action TEXT,
                       target TEXT,
                       detail TEXT,
                       ip     TEXT)""")
        c.execute("CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(id)")

        # Global policy (v2 stored extra client toggles here; only the policy keys survive).
        cfg = kv_get(c, "config", None)
        if not isinstance(cfg, dict):
            cfg = {}
        policy = {
            "enforceMode": cfg.get("enforceMode") if cfg.get("enforceMode") in MODES else "off",
            "whitelist": domains_text(text_domains(cfg.get("whitelist", ""))),
            "blacklist": domains_text(text_domains(cfg.get("blacklist", ""))),
            "rev": int(cfg.get("rev") or 0),
        }
        kv_set(c, "config", policy)
        if kv_get(c, "release") is None:
            kv_set(c, "release", {"appid": APPID, "version": "", "filename": ""})
        if kv_get(c, "releases") is None:
            rel = kv_get(c, "release", {})
            kv_set(c, "releases", [dict(rel, uploaded_at="")] if rel.get("version") else [])

        # Companies: one-time migration from the v2 kv blob or companies.json.
        # Guarded by a flag (not by "table is empty"), so companies deleted later
        # never come back, and lenient, so one bad value never drops a company.
        if not kv_get(c, "companies_migrated", False):
            if c.execute("SELECT COUNT(*) FROM companies").fetchone()[0] == 0:
                seed = kv_get(c, "companies", None)
                source = "database (v2)"
                if not isinstance(seed, list) or not seed:
                    seed, source = None, ""
                    for path in COMPANIES_SEED:
                        try:
                            with open(path, encoding="utf-8-sig") as f:
                                seed = json.load(f)
                            source = os.path.basename(path)
                            break
                        except (OSError, ValueError):
                            continue
                if isinstance(seed, list) and seed:
                    n, notes = migrate_companies(c, seed)
                    print("Imported %d companies from %s" % (n, source))
                    for line in notes:
                        print("  note: " + line)
                    audit(c, "system", "company.import", "", {"created": n, "updated": 0, "source": source,
                                                              "notes": notes[:20]})
            kv_set(c, "companies_migrated", True)

        for key in ("whitelist", "blacklist"):
            if len(policy[key]) > GLOBAL_LIST_MAX_CHARS:
                print("NOTE: the global %s has %d characters (limit %d for new entries). It still works, "
                      "but shorten it before adding more." % (key, len(policy[key]), GLOBAL_LIST_MAX_CHARS))
        kv_set(c, "schema_version", 3)


# ── Companies ────────────────────────────────────────────────────────────────

def _str_list(value, max_items, max_len):
    if value is None:
        return []
    if isinstance(value, str):
        value = re.split(r"[\n,;]+", value)
    if not isinstance(value, (list, tuple)):
        raise ValueError("must be a list")
    out, seen = [], set()
    for v in value:
        s = str(v).strip()[:max_len]
        if s and s.lower() not in seen:
            seen.add(s.lower())
            out.append(s)
    if len(out) > max_items:
        raise ValueError("too many items (max %d)" % max_items)
    return out


def parse_computers(value):
    """AD computer list: "NAME" or "NAME 10.1.2.3" lines, or {"name", "ip"} objects.
    -> (names, {lower name: manual ip}, invalid entries)"""
    if value is None:
        return [], {}, []
    if isinstance(value, str):
        value = re.split(r"[\n,;]+", value)
    if not isinstance(value, (list, tuple)):
        return [], {}, ["not a list"]
    names, ips, bad, seen = [], {}, [], set()
    for item in value:
        if isinstance(item, dict):
            name, ip = str(item.get("name") or "").strip(), str(item.get("ip") or "").strip()
        else:
            parts = str(item).split()
            name, ip = (parts[0] if parts else ""), (parts[1] if len(parts) > 1 else "")
        name = name[:64]
        if not name:
            continue
        if ip:
            try:
                ip = str(ipaddress.ip_address(ip))
            except ValueError:
                bad.append("%s %s" % (name, ip[:40]))
                continue
        if name.lower() in seen:
            continue
        seen.add(name.lower())
        names.append(name)
        if ip:
            ips[name.lower()] = ip
    return names, ips, bad


def store_computer_ips(conn, cid, names, manual):
    """Keep one computer_ips row per AD computer; manual IPs come from the company form."""
    wanted = {n.lower(): n for n in names}
    for n in names:
        conn.execute("""INSERT INTO computer_ips (company_id, name, manual_ip) VALUES (?,?,?)
                        ON CONFLICT(company_id, name) DO UPDATE SET manual_ip=excluded.manual_ip""",
                     (cid, n, manual.get(n.lower(), "")))
    for r in conn.execute("SELECT name FROM computer_ips WHERE company_id=?", (cid,)).fetchall():
        if r["name"].lower() not in wanted:
            conn.execute("DELETE FROM computer_ips WHERE company_id=? AND name=?", (cid, r["name"]))


def validate_company(data, partial=True):
    """Return (clean dict, errors dict). With partial=True only present keys are validated."""
    if not isinstance(data, dict):
        return {}, {"_": "expected an object"}
    clean, errors = {}, {}

    def has(k):
        return (k in data) or not partial

    if has("name"):
        name = str(data.get("name") or "").strip()
        if not name:
            errors["name"] = "required"
        elif len(name) > 80:
            errors["name"] = "too long"
        clean["name"] = name[:80]
    if has("domain"):
        clean["domain"] = str(data.get("domain") or "").strip()[:120]
    if has("dc_ip"):
        dc = str(data.get("dc_ip") or "").strip()
        if dc:
            try:
                ipaddress.ip_address(dc)
            except ValueError:
                errors["dc_ip"] = "not an IP address"
        clean["dc_ip"] = dc
    if has("subnet"):
        sn = str(data.get("subnet") or "").strip()
        if sn and subnet_to_network(sn) is None:
            errors["subnet"] = "use 10.118 or 10.118.0.0/16"
        clean["subnet"] = sn[:64]
    if has("nat_ips"):
        try:
            ips = _str_list(data.get("nat_ips"), 64, 64)
            bad = [x for x in ips if ip_entry_to_network(x) is None]
            if bad:
                errors["nat_ips"] = "invalid: " + ", ".join(bad[:3])
            clean["nat_ips"] = ips
        except ValueError as e:
            errors["nat_ips"] = str(e)
    if has("computers"):
        names, ips, bad = parse_computers(data.get("computers"))
        if bad:
            errors["computers"] = "invalid: " + ", ".join(bad[:3])
        elif len(names) > 5000:
            errors["computers"] = "too many items (max 5000)"
        clean["computers"] = names
        clean["computer_ips"] = ips
    if has("notes"):
        clean["notes"] = str(data.get("notes") or "").strip()[:1000]
    if has("policy_mode") and ("policy_mode" in data):
        m = str(data.get("policy_mode") or "inherit")
        if m not in COMPANY_MODES:
            errors["policy_mode"] = "must be one of " + ", ".join(COMPANY_MODES)
        clean["policy_mode"] = m
    for key in ("whitelist", "blacklist"):
        if key in data:
            valid, invalid = parse_domains(data.get(key))
            if invalid:
                errors[key] = "invalid domains: " + ", ".join(invalid[:5])
            text = domains_text(valid)
            if len(text) > COMPANY_LIST_MAX_CHARS:
                errors[key] = "list too long (max %d characters)" % COMPANY_LIST_MAX_CHARS
            clean[key] = text
    return clean, errors


def _insert_company(conn, clean, ts):
    clean = dict(clean)
    manual = clean.pop("computer_ips", {})
    cur = conn.execute(
        """INSERT INTO companies (name, domain, dc_ip, subnet, nat_ips, computers, notes,
                                  policy_mode, whitelist, blacklist, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (clean.get("name"), clean.get("domain", ""), clean.get("dc_ip", ""), clean.get("subnet", ""),
         json.dumps(clean.get("nat_ips", [])), json.dumps(clean.get("computers", []), ensure_ascii=False),
         clean.get("notes", ""), clean.get("policy_mode", "inherit"),
         clean.get("whitelist", ""), clean.get("blacklist", ""), ts, ts),
    )
    store_computer_ips(conn, cur.lastrowid, clean.get("computers", []), manual)
    return cur.lastrowid


def _update_company(conn, cid, clean, ts):
    clean = dict(clean)
    manual = clean.pop("computer_ips", None)
    if "computers" in clean:
        store_computer_ips(conn, cid, clean["computers"], manual or {})
    sets, vals = [], []
    for k, v in clean.items():
        if k in ("nat_ips", "computers"):
            v = json.dumps(v, ensure_ascii=False)
        sets.append("%s=?" % k)
        vals.append(v)
    if not sets:
        return
    sets.append("updated_at=?")
    sets.append("rev=IFNULL(rev,0)+1")
    vals.append(ts)
    vals.append(cid)
    conn.execute("UPDATE companies SET %s WHERE id=?" % ", ".join(sets), vals)


def migrate_companies(conn, items):
    """Import company dicts from v2 data, keeping every company: invalid values
    are dropped and written into the company's notes instead of failing it."""
    created, notes = 0, []
    taken = {r["name"].lower() for r in conn.execute("SELECT name FROM companies")}
    ts = now_iso()
    for item in items:
        if not isinstance(item, dict):
            continue
        name = re.sub(r"\s+", " ", str(item.get("name") or "").strip())[:80]
        if not name:
            notes.append("skipped an entry without a name")
            continue
        base, k = name, 2
        while name.lower() in taken:
            name = ("%s (%d)" % (base[:74], k))
            k += 1
        if name != base:
            notes.append("%r renamed to %r (duplicate name)" % (base, name))
        dropped = []
        clean = {"name": name}
        clean["domain"] = str(item.get("domain") or "").strip()[:120]
        dc = str(item.get("dc_ip") or "").strip()
        try:
            ipaddress.ip_address(dc)
            clean["dc_ip"] = dc
        except ValueError:
            clean["dc_ip"] = ""
            if dc:
                dropped.append("DC IP %s" % dc[:60])
        sn = str(item.get("subnet") or "").strip()
        if sn and subnet_to_network(sn) is None:
            dropped.append("subnet %s" % sn[:60])
            sn = ""
        clean["subnet"] = sn[:64]
        raw_ips = item.get("nat_ips") or []
        if isinstance(raw_ips, str):
            raw_ips = [raw_ips]
        ips = []
        for entry in raw_ips if isinstance(raw_ips, list) else []:
            for part in re.split(r"[\s,;]+", str(entry)):
                if not part:
                    continue
                if ip_entry_to_network(part) is None:
                    dropped.append("NAT %s" % part[:60])
                elif part not in ips:
                    ips.append(part)
        clean["nat_ips"] = ips[:64]
        pcs, pc_ips, pc_bad = parse_computers(item.get("computers") or [])
        dropped += ["computer %s" % b for b in pc_bad[:5]]
        clean["computers"] = pcs[:5000]
        clean["computer_ips"] = pc_ips
        note = str(item.get("notes") or "").strip()
        if dropped:
            note = (note + "\n" if note else "") + "Ignored during import: " + ", ".join(dropped)
            notes.append("%s: ignored %s" % (name, ", ".join(dropped)))
        clean["notes"] = note[:1000]
        mode = item.get("policy_mode")
        clean["policy_mode"] = mode if mode in COMPANY_MODES else "inherit"
        for key in ("whitelist", "blacklist"):
            clean[key] = domains_text(parse_domains(item.get(key) or "")[0])
        _insert_company(conn, clean, ts)
        taken.add(name.lower())
        created += 1
    return created, notes


def company_row_to_dict(r):
    d = dict(r)
    for k in ("nat_ips", "computers"):
        try:
            d[k] = json.loads(d.get(k) or "[]")
        except ValueError:
            d[k] = []
    d["whitelist"] = text_domains(d.get("whitelist", ""))
    d["blacklist"] = text_domains(d.get("blacklist", ""))
    return d


class Snapshot:
    """Immutable, cached view of companies + global policy used on every check-in."""

    def __init__(self, companies, policy):
        self.companies = companies
        self.by_id = {c["id"]: c for c in companies}
        self.policy = policy
        self._index = []
        self.by_computer = {}
        for c in companies:
            nets_nat = [n for n in (ip_entry_to_network(x) for x in c["nat_ips"]) if n is not None]
            sn = subnet_to_network(c.get("subnet"))
            self._index.append((c, nets_nat, [sn] if sn is not None else []))
            for pc in c["computers"]:
                lst = self.by_computer.setdefault(pc.lower(), [])
                if c not in lst:
                    lst.append(c)
        self._effective = {}

    def match(self, ip, pinned_id=None, computer=None):
        """-> (company or None, how, candidates).
        how: pinned | computer | nat | subnet | ambiguous | none"""
        if pinned_id and pinned_id in self.by_id:
            return self.by_id[pinned_id], "pinned", []
        named = self.by_computer.get(str(computer or "").lower(), []) if computer else []
        if len(named) == 1:
            return named[0], "computer", []
        comp, how, cands = self._match_ip(ip)
        if named:
            if comp in named:
                return comp, "computer", []
            if comp is None:
                return None, "ambiguous", [c["name"] for c in named]
        return comp, how, cands

    def _match_ip(self, ip):
        try:
            addr = ipaddress.ip_address(str(ip or "").strip())
        except ValueError:
            return None, "none", []
        for kind, pos in (("nat", 1), ("subnet", 2)):
            best, hits = -1, []
            for entry in self._index:
                for net in entry[pos]:
                    if net.version == addr.version and addr in net:
                        if net.prefixlen > best:
                            best, hits = net.prefixlen, [entry[0]]
                        elif net.prefixlen == best and entry[0] not in hits:
                            hits.append(entry[0])
            if len(hits) == 1:
                return hits[0], kind, []
            if len(hits) > 1:
                return None, "ambiguous", [h["name"] for h in hits]
        return None, "none", []

    def effective(self, company):
        """Effective policy for a company (or the global policy for None).

        Company lists override the global lists:
          whitelist = (global whitelist - company blacklist) + company whitelist
          blacklist = (global blacklist - company whitelist) + company blacklist
        """
        key = company["id"] if company else None
        if key in self._effective:
            return self._effective[key]
        g = self.policy
        gwl, gbl = text_domains(g["whitelist"]), text_domains(g["blacklist"])
        if company is None:
            res = {"enforceMode": g["enforceMode"], "whitelist": gwl, "blacklist": gbl,
                   "modeSource": "global", "company": None, "companyId": None}
        else:
            cwl, cbl = company["whitelist"], company["blacklist"]
            cwl_set, cbl_set = set(cwl), set(cbl)
            # Company entries first: if a list ever has to be cut to fit the
            # extension's limit, the company's own entries are kept.
            wl = list(cwl) + [d for d in gwl if d not in cbl_set and d not in cwl_set]
            bl = list(cbl) + [d for d in gbl if d not in cwl_set and d not in cbl_set]
            mode = company["policy_mode"] if company["policy_mode"] in MODES else g["enforceMode"]
            res = {"enforceMode": mode, "whitelist": wl, "blacklist": bl,
                   "modeSource": "company" if company["policy_mode"] in MODES else "global",
                   "company": company["name"], "companyId": company["id"]}
        res["deliverWhitelist"], t1 = cap_domains(res["whitelist"])
        res["deliverBlacklist"], t2 = cap_domains(res["blacklist"])
        res["truncated"] = t1 or t2
        self._effective[key] = res
        return res


_snapshot = None
_snapshot_lock = threading.Lock()


def invalidate():
    global _snapshot
    with _snapshot_lock:
        _snapshot = None


def snapshot():
    global _snapshot
    with _snapshot_lock:
        if _snapshot is None:
            with read_db() as c:
                rows = [company_row_to_dict(r) for r in c.execute("SELECT * FROM companies ORDER BY name COLLATE NOCASE")]
                policy = load_policy(c)
            _snapshot = Snapshot(rows, policy)
        return _snapshot


def load_policy(conn):
    cfg = kv_get(conn, "config", {}) or {}
    return {
        "enforceMode": cfg.get("enforceMode") if cfg.get("enforceMode") in MODES else "off",
        "whitelist": cfg.get("whitelist", "") or "",
        "blacklist": cfg.get("blacklist", "") or "",
        "rev": int(cfg.get("rev") or 0),
    }


def save_policy(conn, pol):
    """Persist the global policy and bump its revision (used for edit conflicts)."""
    pol = dict(pol)
    pol["rev"] = int(pol.get("rev") or 0) + 1
    kv_set(conn, "config", pol)
    return pol


def check_rev(body, current):
    """Optimistic concurrency: an editor sends the revision it loaded."""
    if "rev" in body and body["rev"] is not None:
        try:
            ok = int(body["rev"]) == int(current or 0)
        except (TypeError, ValueError):
            ok = False
        if not ok:
            raise HTTPError(409, "changed elsewhere since you opened it — reload to see the latest version",
                            {"stale": True})


def cap_domains(lst, limit=DELIVERY_MAX_CHARS):
    """Join domains with newlines without exceeding the extension's per-list limit."""
    out, size = [], 0
    for d in lst:
        add = len(d) + (1 if out else 0)
        if size + add > limit:
            return "\n".join(out), True
        out.append(d)
        size += add
    return "\n".join(out), False


def blocking_parent(domain, mode, blacklist):
    """In blacklist mode a listed parent domain (facebook.com) also blocks its
    subdomains (m.facebook.com); allowing the subdomain alone cannot work."""
    if mode != "blacklist":
        return None
    for p in blacklist:
        if p != domain and domain.endswith("." + p):
            return p
    return None


def list_edit(text, add=None, remove=None):
    lst = text_domains(text)
    if remove:
        lst = [d for d in lst if d != remove]
    if add and add not in lst:
        lst.append(add)
    return domains_text(lst)


# ── Local IPs of AD computers (DNS on the company's domain controller) ──────

def _dns_name(name):
    out = b""
    for label in name.strip(".").split("."):
        raw = (label.encode("ascii") if label.isascii() else label.encode("idna")) if label else b""
        if not raw or len(raw) > 63:
            raise ValueError("bad DNS label")
        out += bytes([len(raw)]) + raw
    return out + b"\x00"


def _dns_skip_name(buf, pos):
    while True:
        if pos >= len(buf):
            raise ValueError("truncated")
        ln = buf[pos]
        if ln == 0:
            return pos + 1
        if ln & 0xC0 == 0xC0:
            return pos + 2
        pos += 1 + ln


def dns_query_a(server, name, timeout=None, port=None):
    """Ask `server` for the A record of `name`. -> (ip or "", status)
    status: ok | nxdomain | noanswer | timeout | error"""
    timeout = DNS_TIMEOUT if timeout is None else timeout
    port = DNS_PORT if port is None else port
    try:
        qname = _dns_name(name)
    except (ValueError, UnicodeError):
        return "", "error"
    tid = random.randint(0, 0xFFFF)
    packet = struct.pack(">HHHHHH", tid, 0x0100, 1, 0, 0, 0) + qname + struct.pack(">HH", 1, 1)
    try:
        family = socket.AF_INET6 if ":" in server else socket.AF_INET
        with socket.socket(family, socket.SOCK_DGRAM) as sock:
            sock.settimeout(timeout)
            for _attempt in range(2):
                sock.sendto(packet, (server, port))
                try:
                    while True:
                        data, _ = sock.recvfrom(1500)
                        if len(data) >= 12 and struct.unpack(">H", data[:2])[0] == tid:
                            break
                    break
                except socket.timeout:
                    data = None
            if data is None:
                return "", "timeout"
    except OSError:
        return "", "error"
    try:
        _, flags, qd, an, _, _ = struct.unpack(">HHHHHH", data[:12])
        rcode = flags & 0x0F
        if rcode == 3:
            return "", "nxdomain"
        if rcode != 0:
            return "", "error"
        pos = 12
        for _ in range(qd):
            pos = _dns_skip_name(data, pos) + 4
        for _ in range(an):
            pos = _dns_skip_name(data, pos)
            rtype, _, _, rdlen = struct.unpack(">HHIH", data[pos:pos + 10])
            pos += 10
            if rtype == 1 and rdlen == 4:
                return socket.inet_ntoa(data[pos:pos + 4]), "ok"
            pos += rdlen
        return "", "noanswer"
    except (ValueError, struct.error, OSError):
        return "", "error"


def computer_fqdn(name, domain):
    name = name.strip().lower()
    return name if "." in name else "%s.%s" % (name, domain.strip(".").lower())


def resolve_company(cid):
    """Look up every AD computer of a company in its own DNS (the DC). Returns a summary."""
    from concurrent.futures import ThreadPoolExecutor
    comp = snapshot().by_id.get(int(cid))
    if not comp:
        return None
    dc, domain, names = comp.get("dc_ip") or "", comp.get("domain") or "", list(comp["computers"])
    ts = now_iso()
    if not dc or not domain:
        status, found, results = "not_configured", 0, []
    else:
        _, probe = dns_query_a(dc, domain)
        if probe in ("timeout", "error"):
            status, found, results = "unreachable", 0, []
        else:
            with ThreadPoolExecutor(max_workers=16) as ex:
                results = list(ex.map(lambda n: (n, dns_query_a(dc, computer_fqdn(n, domain))[0]), names))
            found = sum(1 for _, ip in results if ip)
            status = "ok"
    with write_db() as c:
        for n, ip in results:
            c.execute("""INSERT INTO computer_ips (company_id, name, dns_ip, dns_at) VALUES (?,?,?,?)
                         ON CONFLICT(company_id, name) DO UPDATE SET dns_ip=excluded.dns_ip, dns_at=excluded.dns_at""",
                      (comp["id"], n, ip, ts))
        # status columns only: does not bump the edit revision
        c.execute("UPDATE companies SET dns_status=?, dns_checked_at=?, dns_found=? WHERE id=?",
                  (status, ts, found, comp["id"]))
    return {"status": status, "checkedAt": ts, "found": found, "total": len(names), "dc": dc}


def dns_loop():
    time.sleep(5)
    while True:
        for comp in list(snapshot().companies):
            if comp.get("dc_ip") and comp.get("domain") and comp["computers"]:
                try:
                    resolve_company(comp["id"])
                except Exception:
                    traceback.print_exc()
        time.sleep(max(60, DNS_INTERVAL))


# ── Admin account & sessions ─────────────────────────────────────────────────

def _hash_pw(pw, salt_hex):
    return hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), bytes.fromhex(salt_hex), 200000).hex()


def _write_user(data):
    tmp = USER_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, USER_PATH)


def get_or_create_user():
    if os.path.exists(USER_PATH):
        try:
            with open(USER_PATH) as f:
                data = json.load(f)
            if data.get("username") and data.get("salt") and data.get("hash"):
                return data
        except (OSError, ValueError):
            pass
    username = os.environ.get("FLEET_ADMIN_USER", "admin")
    password = os.environ.get("FLEET_ADMIN_PASS") or secrets.token_urlsafe(12)
    salt = secrets.token_hex(16)
    data = {"username": username, "salt": salt, "hash": _hash_pw(password, salt)}
    _write_user(data)
    data = dict(data)
    data["_plain"] = None if os.environ.get("FLEET_ADMIN_PASS") else password
    return data


ADMIN_USER = None


def set_admin_password(new_pw):
    global ADMIN_USER
    user = current_user().get("username") or "admin"
    salt = secrets.token_hex(16)
    data = {"username": user, "salt": salt, "hash": _hash_pw(new_pw, salt)}
    _write_user(data)
    ADMIN_USER = data
    return data


_user_mtime = {"v": None}


def current_user():
    """The admin account, re-read when admin_user.json changes on disk
    (so `server.py reset-password` takes effect without a restart)."""
    global ADMIN_USER
    try:
        mtime = os.stat(USER_PATH).st_mtime_ns
    except OSError:
        return ADMIN_USER or {}
    if mtime != _user_mtime["v"]:
        try:
            with open(USER_PATH) as f:
                data = json.load(f)
            if data.get("username") and data.get("salt") and data.get("hash"):
                ADMIN_USER = data
                _user_mtime["v"] = mtime
        except (OSError, ValueError):
            pass
    return ADMIN_USER or {}


def check_password(username, password):
    u = current_user()
    if not u.get("hash"):
        return False
    ok_user = secrets.compare_digest(str(username).encode("utf-8"), u["username"].encode("utf-8"))
    try:
        ok_pw = secrets.compare_digest(_hash_pw(str(password), u["salt"]).encode(), u["hash"].encode())
    except (ValueError, TypeError):
        return False
    return ok_user and ok_pw


def _token_hash(tok):
    return hashlib.sha256(tok.encode("utf-8")).hexdigest()


def create_session(username, ip, ua):
    tok = secrets.token_urlsafe(32)
    now = time.time()
    with write_db() as c:
        c.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
        c.execute("INSERT INTO sessions VALUES (?,?,?,?,?,?,?)",
                  (_token_hash(tok), username, now, now, min(now + SESSION_IDLE_SEC, now + SESSION_MAX_SEC),
                   ip, (ua or "")[:200]))
    return tok


def lookup_session(tok):
    if not tok or len(tok) > 200:
        return None
    h = _token_hash(tok)
    now = time.time()
    with read_db() as c:
        row = c.execute("SELECT * FROM sessions WHERE token_hash=?", (h,)).fetchone()
    if not row or row["expires_at"] < now:
        return None
    if now - row["last_used"] > 60:      # sliding expiry, written at most once a minute
        new_exp = min(now + SESSION_IDLE_SEC, row["created_at"] + SESSION_MAX_SEC)
        with write_db() as c:
            c.execute("UPDATE sessions SET last_used=?, expires_at=? WHERE token_hash=?", (now, new_exp, h))
    return {"username": row["username"], "token_hash": h, "created_at": row["created_at"]}


def revoke_sessions(except_hash=None):
    with write_db() as c:
        if except_hash:
            return c.execute("DELETE FROM sessions WHERE token_hash<>?", (except_hash,)).rowcount
        return c.execute("DELETE FROM sessions").rowcount


def audit(conn, actor, action, target="", detail=None, ip=""):
    conn.execute("INSERT INTO audit (ts, actor, action, target, detail, ip) VALUES (?,?,?,?,?,?)",
                 (now_iso(), actor or "", action, str(target or "")[:200],
                  json.dumps(detail, ensure_ascii=False)[:2000] if detail is not None else "", ip or ""))
    last = conn.execute("SELECT MAX(id) FROM audit").fetchone()[0] or 0
    if last % 200 == 0:
        conn.execute("DELETE FROM audit WHERE id <= ?", (last - AUDIT_KEEP,))


# ── HTTP layer ───────────────────────────────────────────────────────────────

_proxy_mismatch = {"seen": False}


def note_proxy_mismatch():
    """Requests carry CF-Connecting-IP but the server is not told to trust it:
    every browser would look like it comes from cloudflared's address."""
    if not _proxy_mismatch["seen"]:
        _proxy_mismatch["seen"] = True
        print("WARNING: requests arrive through Cloudflare but FLEET_TRUST_PROXY is '%s'. "
              "Set FLEET_TRUST_PROXY=cloudflare so devices are matched to companies by their real address."
              % TRUST_PROXY)
        sys.stdout.flush()


class HTTPError(Exception):
    def __init__(self, code, message, extra=None):
        super().__init__(message)
        self.code, self.message, self.extra = code, message, extra or {}


ROUTES = []


def route(method, pattern, auth=True):
    rx = re.compile("^" + pattern + "$")

    def deco(fn):
        ROUTES.append((method, rx, auth, fn))
        return fn
    return deco


PUBLIC_CORS_PATHS = ("/api/enroll", "/api/heartbeat", "/api/request-access", "/update_manifest.xml", "/healthz")

STATIC_TYPES = {
    ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff",
    ".ico": "image/x-icon", ".json": "application/json",
}

CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
       "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")


class Handler(BaseHTTPRequestHandler):
    server_version = "URLFleet/" + APP_VERSION
    sys_version = ""
    protocol_version = "HTTP/1.1"

    # ── plumbing ──
    def log_message(self, fmt, *args):
        if not LOG_HEARTBEATS and getattr(self, "_quiet", False):
            return
        sys.stdout.write("%s - %s\n" % (self.client_ip(), fmt % args))

    def client_ip(self):
        peer = self.client_address[0] if self.client_address else ""
        headers = getattr(self, "headers", None)
        if headers is None:          # malformed request line: no headers parsed
            return peer[:64]
        cf = (headers.get("CF-Connecting-IP") or "").strip()
        if TRUST_PROXY == "cloudflare":
            if cf:
                return cf[:64]
        elif TRUST_PROXY == "xff":
            xff = [p.strip() for p in (headers.get("X-Forwarded-For") or "").split(",") if p.strip()]
            if xff:
                return xff[-1][:64]
        elif cf:
            note_proxy_mismatch()
        return peer[:64]

    def is_https(self):
        xfp = (self.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
        if xfp == "https":
            return True
        try:
            import ssl
            return isinstance(self.connection, ssl.SSLSocket)
        except Exception:
            return False

    def send(self, code, body, ctype, headers=None, cors=False):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if self.close_connection:
            self.send_header("Connection", "close")
        if cors:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
        for k, v in (headers or {}).items():
            if isinstance(v, list):
                for item in v:
                    self.send_header(k, item)
            else:
                self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def json(self, code, obj, headers=None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        h = {"Cache-Control": "no-store"}
        h.update(headers or {})
        self.send(code, body, "application/json; charset=utf-8", h, cors=self.path_only in PUBLIC_CORS_PATHS)

    # Request bodies: the declared Content-Length is checked before routing and
    # whatever a handler does not read is drained afterwards, so the next
    # request on a kept-alive connection always starts at a request line.
    def _prepare_body(self):
        self._body_pending = 0
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            raise HTTPError(411, "send a Content-Length; chunked bodies are not supported")
        raw = self.headers.get("Content-Length")
        try:
            n = int(raw) if raw not in (None, "") else 0
        except ValueError:
            self.close_connection = True
            raise HTTPError(400, "bad Content-Length") from None
        if n < 0 or n > MAX_BODY:
            self.close_connection = True
            raise HTTPError(413, "request body too large")
        self._body_pending = n

    def _drain(self):
        n = getattr(self, "_body_pending", 0)
        self._body_pending = 0
        try:
            while n > 0:
                chunk = self.rfile.read(min(n, 65536))
                if not chunk:
                    self.close_connection = True
                    return
                n -= len(chunk)
        except OSError:
            self.close_connection = True

    def read_body(self, limit):
        n = self._body_pending
        if n > limit:
            self._drain()
            raise HTTPError(413, "request body too large")
        self._body_pending = 0
        data = self.rfile.read(n) if n else b""
        if len(data) != n:
            self.close_connection = True
            raise HTTPError(400, "incomplete request body")
        return data

    def body_json(self, limit=1024 * 1024):
        raw = self.read_body(limit)
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise HTTPError(400, "invalid JSON") from None
        if not isinstance(data, dict):
            raise HTTPError(400, "expected a JSON object")
        return data

    def cookie(self, name):
        # Parsed by hand: http.cookies gives up on the whole header when any
        # other cookie on the domain contains characters it dislikes.
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, sep, v = part.strip().partition("=")
            if sep and k == name:
                return v.strip().strip('"')
        return None

    def session_cookie(self, token, max_age):
        parts = ["%s=%s" % (SESSION_COOKIE, token), "Path=/", "HttpOnly", "SameSite=Strict",
                 "Max-Age=%d" % max_age]
        if self.is_https():
            parts.append("Secure")
        return "; ".join(parts)

    # ── dispatch ──
    def do_OPTIONS(self):
        self.path_only = urlparse(self.path).path
        try:
            self._prepare_body()
        except HTTPError as e:
            return self.json(e.code, {"ok": False, "error": e.message})
        finally:
            self._drain()
        self.send(204, b"", "text/plain", cors=self.path_only in PUBLIC_CORS_PATHS)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def _dispatch(self, method):
        parsed = urlparse(self.path)
        self.path_only = parsed.path
        self.query = {k: v[-1] for k, v in parse_qs(parsed.query).items()}
        self.user = None
        self._body_pending = 0
        self._quiet = self.path_only in ("/api/heartbeat", "/healthz")
        try:
            self._prepare_body()
            for m, rx, auth, fn in ROUTES:
                if m != method and not (method == "HEAD" and m == "GET"):
                    continue
                match = rx.match(self.path_only)
                if not match:
                    continue
                if auth:
                    self.user = lookup_session(self.cookie(SESSION_COOKIE))
                    if not self.user:
                        raise HTTPError(401, "unauthorized")
                    if method == "POST" and self.headers.get(CSRF_HEADER) != "1":
                        raise HTTPError(403, "missing CSRF header")
                return fn(self, *match.groups())
            if method in ("GET", "HEAD") and not self.path_only.startswith("/api/"):
                return self.static()
            raise HTTPError(404, "not found")
        except HTTPError as e:
            if self._body_pending > MAX_DRAIN:
                self.close_connection = True
            out = {"ok": False, "error": e.message}
            out.update(e.extra)
            headers = {}
            if e.code == 429 and "retryAfter" in e.extra:
                headers["Retry-After"] = str(e.extra["retryAfter"])
            self.json(e.code, out, headers)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception:
            traceback.print_exc()
            self.close_connection = True
            try:
                self.json(500, {"ok": False, "error": "internal error"})
            except Exception:
                pass
        finally:
            if self.close_connection:
                self._body_pending = 0
            else:
                self._drain()

    # ── static dashboard ──
    def static(self):
        rel = self.path_only.lstrip("/") or "index.html"
        if rel in ("index.html", "dashboard"):
            rel = "index.html"
        full = os.path.realpath(os.path.join(WEB_DIR, rel))
        root = os.path.realpath(WEB_DIR)
        ext = os.path.splitext(full)[1].lower()
        if not full.startswith(root + os.sep) or not os.path.isfile(full):
            # unknown paths fall back to the app shell (client-side routing)
            if "." in os.path.basename(rel):
                raise HTTPError(404, "not found")
            full, ext = os.path.join(WEB_DIR, "index.html"), ".html"
            if not os.path.isfile(full):
                return self.send(503, b"Dashboard files (web/) are missing on the server.", "text/plain; charset=utf-8")
        if ext == ".html":
            with open(full, "rb") as f:
                body = f.read()
            return self.send(200, body, "text/html; charset=utf-8", {
                "Content-Security-Policy": CSP, "X-Frame-Options": "DENY", "Cache-Control": "no-cache"})
        if ext not in STATIC_TYPES:
            raise HTTPError(404, "not found")
        with open(full, "rb") as f:
            body = f.read()
        self.send(200, body, STATIC_TYPES[ext], {"Cache-Control": "no-cache"})


# ── Public endpoints (extension + Chrome updater) ────────────────────────────

_DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{4,80}$")
_COMPUTER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_VERSION_RE = re.compile(r"^\d{1,5}(\.\d{1,5}){0,3}$")


@route("GET", "/healthz", auth=False)
def r_health(h):
    h.json(200, {"ok": True, "version": APP_VERSION})


def _checkin(h, kind):
    body = h.body_json(64 * 1024)
    did = str(body.get("deviceId", "")).strip()
    if not _DEVICE_ID_RE.match(did):
        raise HTTPError(400, "deviceId required")
    ver = str(body.get("version", ""))[:32]
    if not _VERSION_RE.match(ver):
        ver = ""
    ua = str(body.get("userAgent", ""))[:300]
    # Windows computer name, set by IT through Chrome's extension policy (2.4.0+).
    computer = str(body.get("computerName", "")).strip()[:64]
    if not _COMPUTER_RE.match(computer):
        computer = ""
    ip = h.client_ip()
    ts = now_iso()
    with write_db() as c:
        row = c.execute("SELECT device_id, company_id, computer_name FROM devices WHERE device_id=?", (did,)).fetchone()
        if row:
            counter = "enroll_count=enroll_count+1" if kind == "enroll" else "beats=beats+1"
            c.execute("""UPDATE devices SET version=?, user_agent=COALESCE(NULLIF(?, ''), user_agent),
                             computer_name=COALESCE(NULLIF(?, ''), computer_name),
                             last_seen=?, last_ip=?, %s WHERE device_id=?""" % counter,
                      (ver, ua, computer, ts, ip, did))
            pinned = row["company_id"]
            computer = computer or row["computer_name"] or ""
        else:
            if not NEW_DEVICES_PER_IP.hit(ip):
                raise HTTPError(429, "too many new devices from this address", {"retryAfter": 600})
            c.execute("""INSERT INTO devices (device_id, version, user_agent, first_seen, last_seen, last_ip,
                                              enroll_count, beats, computer_name) VALUES (?,?,?,?,?,?,?,?,?)""",
                      (did, ver, ua, ts, ts, ip, 1 if kind == "enroll" else 0, 0 if kind == "enroll" else 1, computer))
            pinned = None
    snap = snapshot()
    company, how, _ = snap.match(ip, pinned, computer)
    eff = snap.effective(company)
    h.json(200, {
        "ok": True,
        "heartbeatSec": HEARTBEAT_SEC,
        "config": {"enforceMode": eff["enforceMode"], "whitelist": eff["deliverWhitelist"],
                   "blacklist": eff["deliverBlacklist"]},
        "policy": {"company": eff["company"], "scope": "company" if company else "global",
                   "mode": eff["enforceMode"], "match": how},
    })


@route("POST", "/api/enroll", auth=False)
def r_enroll(h):
    _checkin(h, "enroll")


@route("POST", "/api/heartbeat", auth=False)
def r_heartbeat(h):
    _checkin(h, "heartbeat")


@route("POST", "/api/request-access", auth=False)
def r_request_access(h):
    body = h.body_json(64 * 1024)
    url = str(body.get("url", ""))[:2000]
    did = str(body.get("deviceId", ""))[:80]
    domain = domain_of(url)
    if not domain:
        raise HTTPError(400, "no domain")
    ip = h.client_ip()
    if not REQUEST_PER_IP.hit(ip) or (did and not REQUEST_PER_DEVICE.hit(did)):
        raise HTTPError(429, "too many requests", {"retryAfter": 600})
    with read_db() as c:
        dev = c.execute("SELECT company_id, label, computer_name FROM devices WHERE device_id=?", (did,)).fetchone()
    if not dev:
        # Only enrolled browsers may file requests; the extension enrolls on install.
        raise HTTPError(403, "unknown device")
    snap = snapshot()
    company, _, _ = snap.match(ip, dev["company_id"], dev["computer_name"])
    cid = company["id"] if company else None
    ts = now_iso()
    with write_db() as c:
        dup = c.execute("""SELECT id FROM requests WHERE domain=? AND status='pending'
                           AND IFNULL(company_id, -1)=IFNULL(?, -1)""", (domain, cid)).fetchone()
        if dup:
            c.execute("UPDATE requests SET hits=IFNULL(hits,1)+1, last_ts=?, url=? WHERE id=?", (ts, url, dup["id"]))
        else:
            per_dev = c.execute("SELECT COUNT(*) FROM requests WHERE status='pending' AND device_id=?", (did,)).fetchone()[0]
            per_ip = c.execute("SELECT COUNT(*) FROM requests WHERE status='pending' AND ip=?", (ip,)).fetchone()[0]
            total = c.execute("SELECT COUNT(*) FROM requests WHERE status='pending'").fetchone()[0]
            if per_dev >= MAX_PENDING_PER_DEVICE or per_ip >= MAX_PENDING_PER_IP or total >= MAX_PENDING_REQUESTS:
                raise HTTPError(429, "request queue is full", {"retryAfter": 3600})
            c.execute("""INSERT INTO requests (domain, url, device_id, label, ts, status, company_id, hits, last_ts, ip)
                         VALUES (?,?,?,?,?, 'pending', ?, 1, ?, ?)""",
                      (domain, url, did, dev["label"] or dev["computer_name"] or "", ts, cid, ts, ip))
    h.json(200, {"ok": True, "domain": domain})


@route("GET", "/update_manifest.xml", auth=False)
def r_update_manifest(h):
    with read_db() as c:
        rel = kv_get(c, "release", {}) or {}
    host = h.headers.get("Host") or "%s:%d" % (h.connection.getsockname()[0], PORT)
    host = re.sub(r"[^A-Za-z0-9.:\-\[\]]", "", host)
    scheme = "https" if h.is_https() else "http"
    appid = rel.get("appid") or APPID
    if rel.get("version") and rel.get("filename"):
        app = ("  <app appid='%s'>\n    <updatecheck codebase='%s://%s/downloads/%s' version='%s' />\n  </app>\n"
               % (appid, scheme, host, rel["filename"], rel["version"]))
    else:
        app = "  <app appid='%s'><updatecheck status='noupdate'/></app>\n" % appid
    xml = ("<?xml version='1.0' encoding='UTF-8'?>\n"
           "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n" + app + "</gupdate>\n")
    h.send(200, xml.encode("utf-8"), "application/xml", {"Cache-Control": "no-cache"}, cors=True)


@route("GET", r"/downloads/([A-Za-z0-9._-]+\.crx)", auth=False)
def r_download(h, name):
    full = os.path.join(DOWNLOAD_DIR, os.path.basename(name))
    if not os.path.isfile(full):
        raise HTTPError(404, "not found")
    with open(full, "rb") as f:
        data = f.read()
    h.send(200, data, "application/x-chrome-extension",
           {"Content-Disposition": 'attachment; filename="%s"' % os.path.basename(name)})


# ── Auth endpoints ───────────────────────────────────────────────────────────

@route("POST", "/api/login", auth=False)
def r_login(h):
    ip = h.client_ip()
    wait = LOGIN_FAILS.retry_after(ip)
    if wait:
        raise HTTPError(429, "too many failed attempts — try again later", {"retryAfter": wait})
    body = h.body_json(8 * 1024)
    if not check_password(body.get("username", ""), body.get("password", "")):
        LOGIN_FAILS.hit(ip)
        time.sleep(0.4)
        with write_db() as c:
            audit(c, str(body.get("username", ""))[:40], "login.failed", ip=ip)
        raise HTTPError(401, "invalid username or password")
    LOGIN_FAILS.reset(ip)
    user = current_user()["username"]
    tok = create_session(user, ip, h.headers.get("User-Agent"))
    with write_db() as c:
        audit(c, user, "login", ip=ip)
    h.json(200, {"ok": True, "user": user},
           {"Set-Cookie": h.session_cookie(tok, SESSION_MAX_SEC)})


@route("POST", "/api/logout", auth=False)
def r_logout(h):
    tok = h.cookie(SESSION_COOKIE)
    if tok:
        with write_db() as c:
            c.execute("DELETE FROM sessions WHERE token_hash=?", (_token_hash(tok),))
    h.json(200, {"ok": True}, {"Set-Cookie": h.session_cookie("", 0)})


@route("GET", "/api/me")
def r_me(h):
    with read_db() as c:
        n = c.execute("SELECT COUNT(*) FROM sessions WHERE expires_at > ?", (time.time(),)).fetchone()[0]
    h.json(200, {"ok": True, "user": h.user["username"], "sessions": n, "serverVersion": APP_VERSION,
                 "appid": APPID, "onlineSec": ONLINE_SEC, "heartbeatSec": HEARTBEAT_SEC,
                 "trustProxy": TRUST_PROXY, "proxyMismatch": _proxy_mismatch["seen"]})


@route("POST", "/api/change-password")
def r_change_password(h):
    body = h.body_json(8 * 1024)
    cur, new = str(body.get("current_password", "")), str(body.get("new_password", ""))
    if not check_password(h.user["username"], cur):
        time.sleep(0.4)
        raise HTTPError(403, "current password is incorrect")
    if len(new) < 10:
        raise HTTPError(400, "new password must be at least 10 characters")
    set_admin_password(new)
    n = revoke_sessions(except_hash=h.user["token_hash"])
    with write_db() as c:
        audit(c, h.user["username"], "password.changed", detail={"revokedSessions": n}, ip=h.client_ip())
    h.json(200, {"ok": True, "revokedSessions": n})


@route("POST", "/api/logout-all")
def r_logout_all(h):
    n = revoke_sessions(except_hash=h.user["token_hash"])
    with write_db() as c:
        audit(c, h.user["username"], "sessions.revoked", detail={"count": n}, ip=h.client_ip())
    h.json(200, {"ok": True, "revoked": n})


# ── Admin: overview & devices ────────────────────────────────────────────────

def _all_devices(c):
    return [dict(r) for r in c.execute("SELECT * FROM devices ORDER BY last_seen DESC")]


def _decorate_devices(devs, snap, now_ts):
    for d in devs:
        comp, how, cands = snap.match(d.get("last_ip"), d.get("company_id"), d.get("computer_name"))
        d["company"] = comp["name"] if comp else None
        d["company_id_effective"] = comp["id"] if comp else None
        d["match"] = how
        d["candidates"] = cands
        d["online"] = (now_ts - iso_to_ts(d.get("last_seen"))) < ONLINE_SEC
    return devs


@route("GET", "/api/overview")
def r_overview(h):
    snap = snapshot()
    now_ts = time.time()
    with read_db() as c:
        devs = _decorate_devices(_all_devices(c), snap, now_ts)
        pending = c.execute("SELECT COUNT(*) FROM requests WHERE status='pending'").fetchone()[0]
        top_req = [dict(r) for r in c.execute(
            """SELECT domain, SUM(IFNULL(hits,1)) AS hits, COUNT(*) AS n FROM requests
               WHERE status='pending' GROUP BY domain ORDER BY hits DESC LIMIT 5""")]
        rel = kv_get(c, "release", {}) or {}
        recent = [dict(r) for r in c.execute("SELECT * FROM audit ORDER BY id DESC LIMIT 8")]
    online = sum(1 for d in devs if d["online"])
    versions = Counter(d.get("version") or "unknown" for d in devs)
    per_company = {}
    for comp in snap.companies:
        per_company[comp["id"]] = {"id": comp["id"], "name": comp["name"], "devices": 0, "online": 0,
                                   "adComputers": len(comp["computers"]),
                                   "mode": snap.effective(comp)["enforceMode"],
                                   "override": comp["policy_mode"] in MODES or bool(comp["whitelist"] or comp["blacklist"])}
    unmatched = ambiguous = 0
    named = {}
    for d in devs:
        cid = d["company_id_effective"]
        if cid in per_company:
            per_company[cid]["devices"] += 1
            per_company[cid]["online"] += 1 if d["online"] else 0
            if d.get("computer_name"):
                named.setdefault(cid, set()).add(d["computer_name"].lower())
            else:
                per_company[cid]["unnamed"] = per_company[cid].get("unnamed", 0) + 1
        else:
            unmatched += 1
            ambiguous += 1 if d["match"] == "ambiguous" else 0
    for comp in snap.companies:
        pc = per_company[comp["id"]]
        listed = {n.lower() for n in comp["computers"]}
        pc["covered"] = min(len(listed), len(named.get(comp["id"], set()) & listed) + pc.pop("unnamed", 0))
    seen_24h = sum(1 for d in devs if now_ts - iso_to_ts(d.get("first_seen")) < 86400)
    h.json(200, {
        "ok": True, "now": now_iso(),
        "devices": {"total": len(devs), "online": online, "offline": len(devs) - online,
                    "unmatched": unmatched, "ambiguous": ambiguous, "new24h": seen_24h},
        "versions": sorted(([v, n] for v, n in versions.items()), key=lambda x: version_key(x[0]), reverse=True),
        "release": rel,
        "companies": sorted(per_company.values(), key=lambda x: (-x["devices"], x["name"].lower())),
        "policy": {"mode": snap.policy["enforceMode"],
                   "whitelist": len(text_domains(snap.policy["whitelist"])),
                   "blacklist": len(text_domains(snap.policy["blacklist"])),
                   "overrides": sum(1 for v in per_company.values() if v["override"])},
        "requests": {"pending": pending, "top": top_req},
        "activity": recent,
    })


@route("GET", "/api/devices")
def r_devices(h):
    snap = snapshot()
    with read_db() as c:
        devs = _decorate_devices(_all_devices(c), snap, time.time())
    h.json(200, {"ok": True, "devices": devs, "now": now_iso(), "onlineSec": ONLINE_SEC})


@route("POST", "/api/devices/update")
def r_device_update(h):
    body = h.body_json(64 * 1024)
    ids = body.get("deviceIds") or ([body.get("deviceId")] if body.get("deviceId") else [])
    ids = [str(x)[:80] for x in ids if x][:1000]
    if not ids:
        raise HTTPError(400, "deviceIds required")
    sets, vals, detail = [], [], {}
    if "label" in body:
        sets.append("label=?")
        vals.append(str(body.get("label") or "").strip()[:120])
        detail["label"] = vals[-1]
    if "companyId" in body:
        cid = body.get("companyId")
        if cid in (None, "", 0, "0"):
            cid = None
        else:
            try:
                cid = int(cid)
            except (TypeError, ValueError):
                raise HTTPError(400, "bad companyId")
            if cid not in snapshot().by_id:
                raise HTTPError(404, "company not found")
        sets.append("company_id=?")
        vals.append(cid)
        detail["companyId"] = cid
        detail["company"] = snapshot().by_id[cid]["name"] if cid else None
    if not sets:
        raise HTTPError(400, "nothing to update")
    with write_db() as c:
        q = "UPDATE devices SET %s WHERE device_id IN (%s)" % (", ".join(sets), ",".join("?" * len(ids)))
        n = c.execute(q, vals + ids).rowcount
        audit(c, h.user["username"], "device.update", "", dict(detail, count=n), h.client_ip())
    h.json(200, {"ok": True, "updated": n})


@route("POST", "/api/devices/delete")
def r_device_delete(h):
    body = h.body_json(256 * 1024)
    ids = [str(x)[:80] for x in (body.get("deviceIds") or []) if x][:5000]
    if not ids:
        raise HTTPError(400, "deviceIds required")
    with write_db() as c:
        n = c.execute("DELETE FROM devices WHERE device_id IN (%s)" % ",".join("?" * len(ids)), ids).rowcount
        audit(c, h.user["username"], "device.delete", "", {"count": n}, h.client_ip())
    h.json(200, {"ok": True, "deleted": n})


@route("POST", "/api/devices/prune")
def r_device_prune(h):
    body = h.body_json(8 * 1024)
    try:
        older = max(ONLINE_SEC, int(body.get("olderThanSec", 7 * 86400)))
    except (TypeError, ValueError):
        raise HTTPError(400, "bad olderThanSec")
    cutoff = time.time() - older
    with write_db() as c:
        rows = c.execute("SELECT device_id, last_seen FROM devices").fetchall()
        victims = [r["device_id"] for r in rows if iso_to_ts(r["last_seen"]) < cutoff]
        for i in range(0, len(victims), 500):
            chunk = victims[i:i + 500]
            c.execute("DELETE FROM devices WHERE device_id IN (%s)" % ",".join("?" * len(chunk)), chunk)
        audit(c, h.user["username"], "device.prune", "", {"count": len(victims), "olderThanSec": older}, h.client_ip())
    h.json(200, {"ok": True, "removed": len(victims)})


# ── Admin: companies ─────────────────────────────────────────────────────────

def _company_or_404(cid):
    comp = snapshot().by_id.get(int(cid))
    if not comp:
        raise HTTPError(404, "company not found")
    return comp


def _company_summary(comp, snap, devs):
    eff = snap.effective(comp)
    mine = [d for d in devs if d["company_id_effective"] == comp["id"]]
    on = sum(1 for d in mine if d["online"])
    last = max((d.get("last_seen") or "" for d in mine), default="")
    versions = Counter(d.get("version") or "unknown" for d in mine)
    # Coverage: AD computers that run the extension. Exact when browsers report
    # their computer name (2.4.0 + policy); otherwise estimated from the browser count.
    listed = {n.lower() for n in comp["computers"]}
    named = {d["computer_name"].lower() for d in mine if d.get("computer_name")} & listed
    unnamed = sum(1 for d in mine if not d.get("computer_name"))
    covered = min(len(listed), len(named) + unnamed)
    return {
        "id": comp["id"], "name": comp["name"], "domain": comp["domain"], "dc_ip": comp["dc_ip"],
        "subnet": comp["subnet"], "nat_ips": comp["nat_ips"], "notes": comp["notes"],
        "adComputers": len(comp["computers"]), "devices": len(mine), "online": on, "lastSeen": last,
        "covered": covered,
        "versions": sorted(([v, n] for v, n in versions.items()), key=lambda x: version_key(x[0]), reverse=True),
        "policy": {"mode": comp["policy_mode"], "whitelist": len(comp["whitelist"]),
                   "blacklist": len(comp["blacklist"]), "effectiveMode": eff["enforceMode"],
                   "modeSource": eff["modeSource"]},
        "updated_at": comp.get("updated_at"),
        "rev": comp.get("rev") or 0,
    }


@route("GET", "/api/companies")
def r_companies(h):
    snap = snapshot()
    with read_db() as c:
        devs = _decorate_devices(_all_devices(c), snap, time.time())
        pend = {r["company_id"]: r["n"] for r in c.execute(
            "SELECT company_id, COUNT(*) AS n FROM requests WHERE status='pending' GROUP BY company_id")}
    out = []
    for comp in snap.companies:
        s = _company_summary(comp, snap, devs)
        s["pendingRequests"] = pend.get(comp["id"], 0)
        out.append(s)
    unmatched = [d for d in devs if d["company_id_effective"] is None]
    h.json(200, {"ok": True, "companies": out, "unmatched": unmatched, "now": now_iso(),
                 "globalPolicy": {"mode": snap.policy["enforceMode"]}})


@route("GET", r"/api/companies/(\d+)")
def r_company(h, cid):
    comp = _company_or_404(cid)
    snap = snapshot()
    with read_db() as c:
        devs = _decorate_devices(_all_devices(c), snap, time.time())
        ips = {r["name"].lower(): dict(r) for r in c.execute("SELECT * FROM computer_ips WHERE company_id=?", (comp["id"],))}
        row = c.execute("SELECT dns_status, dns_checked_at, dns_found FROM companies WHERE id=?", (comp["id"],)).fetchone()
    s = _company_summary(comp, snap, devs)
    mine = [d for d in devs if d["company_id_effective"] == comp["id"]]
    by_pc = {}
    for d in mine:
        if d.get("computer_name"):
            by_pc.setdefault(d["computer_name"].lower(), []).append(d)

    def entry(name, listed):
        rec = ips.get(name.lower(), {})
        browsers = by_pc.get(name.lower(), [])
        ip = rec.get("dns_ip") or rec.get("manual_ip") or ""
        return {
            "name": name, "listed": listed,
            "ip": ip, "ipSource": "dns" if rec.get("dns_ip") else ("manual" if ip else ""),
            "manualIp": rec.get("manual_ip") or "",
            "status": ("online" if any(b["online"] for b in browsers) else "offline") if browsers else "none",
            "browsers": len(browsers),
            "version": max((b.get("version") or "" for b in browsers), key=version_key, default=""),
            "lastSeen": max((b.get("last_seen") or "" for b in browsers), default=""),
        }

    listed = [entry(n, True) for n in comp["computers"]]
    known = {n.lower() for n in comp["computers"]}
    extra = [entry(by_pc[k][0]["computer_name"], False) for k in by_pc if k not in known]
    s.update({
        "computers": comp["computers"],
        "computerList": listed + extra,
        "unnamedBrowsers": sum(1 for d in mine if not d.get("computer_name")),
        "dns": {"status": row["dns_status"] or "", "checkedAt": row["dns_checked_at"] or "",
                "found": row["dns_found"] or 0, "total": len(comp["computers"]),
                "configured": bool(comp["dc_ip"] and comp["domain"])},
        "manualIps": {k: v["manual_ip"] for k, v in ips.items() if v.get("manual_ip")},
    })
    h.json(200, {"ok": True, "company": s, "globalPolicy": {"mode": snap.policy["enforceMode"]}})


@route("POST", r"/api/companies/(\d+)/resolve")
def r_company_resolve(h, cid):
    _company_or_404(cid)
    res = resolve_company(cid)
    h.json(200, {"ok": True, "dns": res})


@route("POST", "/api/companies")
def r_company_create(h):
    clean, errors = validate_company(h.body_json(2 * 1024 * 1024), partial=False)
    if errors:
        raise HTTPError(400, "validation failed", {"fields": errors})
    try:
        with write_db() as c:
            cid = _insert_company(c, clean, now_iso())
            audit(c, h.user["username"], "company.create", clean["name"], None, h.client_ip())
    except sqlite3.IntegrityError:
        raise HTTPError(409, "a company with this name already exists", {"fields": {"name": "already exists"}})
    invalidate()
    if clean.get("computers") and clean.get("dc_ip") and clean.get("domain"):
        threading.Thread(target=resolve_company, args=(cid,), daemon=True).start()
    h.json(200, {"ok": True, "id": cid})


@route("POST", r"/api/companies/(\d+)")
def r_company_update(h, cid):
    comp = _company_or_404(cid)
    body = h.body_json(2 * 1024 * 1024)
    clean, errors = validate_company(body, partial=True)
    if errors:
        raise HTTPError(400, "validation failed", {"fields": errors})
    changed = sorted(k for k in clean if k not in ("whitelist", "blacklist", "policy_mode"))
    try:
        with write_db() as c:
            row = c.execute("SELECT rev FROM companies WHERE id=?", (comp["id"],)).fetchone()
            if not row:
                raise HTTPError(404, "company not found")
            check_rev(body, row["rev"])
            _update_company(c, comp["id"], clean, now_iso())
            audit(c, h.user["username"], "company.update", clean.get("name", comp["name"]), {"fields": changed}, h.client_ip())
    except sqlite3.IntegrityError:
        raise HTTPError(409, "a company with this name already exists", {"fields": {"name": "already exists"}}) from None
    invalidate()
    if any(k in clean for k in ("computers", "dc_ip", "domain")):
        threading.Thread(target=resolve_company, args=(comp["id"],), daemon=True).start()
    h.json(200, {"ok": True})


@route("POST", r"/api/companies/(\d+)/policy")
def r_company_policy(h, cid):
    comp = _company_or_404(cid)
    body = h.body_json(256 * 1024)
    data = {k: body[k] for k in ("policy_mode", "whitelist", "blacklist") if k in body}
    if "mode" in body:
        data["policy_mode"] = body["mode"]
    clean, errors = validate_company(data, partial=True)
    if errors:
        raise HTTPError(400, "validation failed", {"fields": errors})
    with write_db() as c:
        row = c.execute("SELECT * FROM companies WHERE id=?", (comp["id"],)).fetchone()
        if not row:
            raise HTTPError(404, "company not found")
        check_rev(body, row["rev"])
        _update_company(c, comp["id"], clean, now_iso())
        audit(c, h.user["username"], "company.policy", comp["name"], {
            "mode": clean.get("policy_mode", row["policy_mode"]),
            "whitelist": len(text_domains(clean.get("whitelist", row["whitelist"]))),
            "blacklist": len(text_domains(clean.get("blacklist", row["blacklist"]))),
        }, h.client_ip())
    invalidate()
    h.json(200, {"ok": True})


@route("POST", r"/api/companies/(\d+)/delete")
def r_company_delete(h, cid):
    comp = _company_or_404(cid)
    with write_db() as c:
        c.execute("DELETE FROM companies WHERE id=?", (comp["id"],))
        c.execute("DELETE FROM computer_ips WHERE company_id=?", (comp["id"],))
        c.execute("UPDATE devices SET company_id=NULL WHERE company_id=?", (comp["id"],))
        c.execute("UPDATE requests SET company_id=NULL WHERE company_id=? AND status='pending'", (comp["id"],))
        audit(c, h.user["username"], "company.delete", comp["name"], None, h.client_ip())
    invalidate()
    h.json(200, {"ok": True})


@route("POST", r"/api/companies/(\d+)/nat-ip")
def r_company_nat(h, cid):
    comp = _company_or_404(cid)
    body = h.body_json(8 * 1024)
    ip = str(body.get("ip", "")).strip()
    action = str(body.get("action", "add"))
    if ip_entry_to_network(ip) is None:
        raise HTTPError(400, "not a valid IP or CIDR range")
    if action not in ("add", "remove"):
        raise HTTPError(400, "action must be add or remove")
    with write_db() as c:
        row = c.execute("SELECT nat_ips FROM companies WHERE id=?", (comp["id"],)).fetchone()
        if not row:
            raise HTTPError(404, "company not found")
        ips = json.loads(row["nat_ips"] or "[]")
        if action == "add" and ip not in ips:
            if len(ips) >= 64:
                raise HTTPError(400, "too many items (max 64)")
            ips.append(ip)
        elif action == "remove":
            ips = [x for x in ips if x != ip]
        _update_company(c, comp["id"], {"nat_ips": ips}, now_iso())
        audit(c, h.user["username"], "company.nat_" + action, comp["name"], {"ip": ip}, h.client_ip())
    invalidate()
    h.json(200, {"ok": True, "nat_ips": ips})


@route("POST", "/api/companies/import")
def r_company_import(h):
    raw = h.read_body(4 * 1024 * 1024)
    try:
        data = json.loads(raw.decode("utf-8-sig"))
    except (ValueError, UnicodeDecodeError):
        raise HTTPError(400, "invalid JSON")
    if isinstance(data, dict):
        data = data.get("companies", [])
    if not isinstance(data, list):
        raise HTTPError(400, "expected a list of companies")
    created = updated = 0
    skipped = []
    ts = now_iso()
    with write_db() as c:
        existing = {r["name"].lower(): r["id"] for r in c.execute("SELECT id, name FROM companies")}
        for item in data[:500]:
            if not isinstance(item, dict):
                continue
            item = {k: v for k, v in item.items() if k in ("name", "domain", "dc_ip", "subnet", "nat_ips",
                                                           "computers", "notes", "policy_mode", "whitelist", "blacklist")}
            name = str(item.get("name") or "").strip()
            if name.lower() in existing:
                clean, errors = validate_company(item, partial=True)
                if errors:
                    skipped.append({"name": name, "errors": errors})
                    continue
                _update_company(c, existing[name.lower()], clean, ts)
                updated += 1
            else:
                clean, errors = validate_company(item, partial=False)
                if errors:
                    skipped.append({"name": name, "errors": errors})
                    continue
                existing[name.lower()] = _insert_company(c, clean, ts)
                created += 1
        audit(c, h.user["username"], "company.import", "", {"created": created, "updated": updated}, h.client_ip())
    invalidate()
    h.json(200, {"ok": True, "created": created, "updated": updated, "skipped": skipped})


@route("GET", "/api/companies/export")
def r_company_export(h):
    with read_db() as c:
        manual = {(r["company_id"], r["name"].lower()): r["manual_ip"]
                  for r in c.execute("SELECT company_id, name, manual_ip FROM computer_ips WHERE manual_ip<>''")}
    out = []
    for comp in snapshot().companies:
        pcs = [("%s %s" % (n, manual[(comp["id"], n.lower())])) if (comp["id"], n.lower()) in manual else n
               for n in comp["computers"]]
        out.append({"name": comp["name"], "domain": comp["domain"], "dc_ip": comp["dc_ip"],
                    "subnet": comp["subnet"], "nat_ips": comp["nat_ips"], "computers": pcs,
                    "notes": comp["notes"], "policy_mode": comp["policy_mode"],
                    "whitelist": comp["whitelist"], "blacklist": comp["blacklist"]})
    body = json.dumps(out, ensure_ascii=False, indent=2).encode("utf-8")
    h.send(200, body, "application/json; charset=utf-8",
           {"Content-Disposition": 'attachment; filename="companies-%s.json"' % now_iso()[:10],
            "Cache-Control": "no-store"})


# ── Admin: global policy ─────────────────────────────────────────────────────

@route("GET", "/api/policy")
def r_policy(h):
    snap = snapshot()
    overrides = []
    for comp in snap.companies:
        if comp["policy_mode"] in MODES or comp["whitelist"] or comp["blacklist"]:
            overrides.append({"id": comp["id"], "name": comp["name"], "mode": comp["policy_mode"],
                              "whitelist": len(comp["whitelist"]), "blacklist": len(comp["blacklist"]),
                              "effectiveMode": snap.effective(comp)["enforceMode"]})
    p = snap.policy
    h.json(200, {"ok": True, "policy": {"enforceMode": p["enforceMode"], "whitelist": text_domains(p["whitelist"]),
                                        "blacklist": text_domains(p["blacklist"]), "rev": p.get("rev", 0)},
                 "overrides": overrides, "limits": {"globalChars": GLOBAL_LIST_MAX_CHARS,
                                                    "companyChars": COMPANY_LIST_MAX_CHARS}})


@route("POST", "/api/policy")
def r_policy_save(h):
    body = h.body_json(256 * 1024)
    with write_db() as c:
        cur = load_policy(c)
        check_rev(body, cur["rev"])
        new = dict(cur)
        errors = {}
        if "enforceMode" in body:
            if body["enforceMode"] not in MODES:
                errors["enforceMode"] = "must be off, blacklist or whitelist"
            new["enforceMode"] = body["enforceMode"]
        for key in ("whitelist", "blacklist"):
            if key in body:
                valid, invalid = parse_domains(body[key])
                if invalid:
                    errors[key] = "invalid domains: " + ", ".join(invalid[:5])
                text = domains_text(valid)
                # Lists that were already longer (from v2) can be saved or shortened, never grown.
                if len(text) > GLOBAL_LIST_MAX_CHARS and len(text) > len(cur[key]):
                    errors[key] = "list too long (max %d characters)" % GLOBAL_LIST_MAX_CHARS
                new[key] = text
        if errors:
            raise HTTPError(400, "validation failed", {"fields": errors})
        if new["enforceMode"] == "whitelist" and not text_domains(new["whitelist"]) and not body.get("confirmEmpty"):
            raise HTTPError(409, "the whitelist is empty — whitelist mode would block every site", {"needsConfirm": True})
        saved = save_policy(c, new)
        audit(c, h.user["username"], "policy.global", "", {
            "mode": new["enforceMode"], "whitelist": len(text_domains(new["whitelist"])),
            "blacklist": len(text_domains(new["blacklist"]))}, h.client_ip())
    invalidate()
    h.json(200, {"ok": True, "rev": saved["rev"]})


# ── Admin: access requests ───────────────────────────────────────────────────

@route("GET", "/api/requests")
def r_requests(h):
    status = h.query.get("status", "pending")
    snap = snapshot()
    with read_db() as c:
        if status == "pending":
            rows = c.execute("SELECT * FROM requests WHERE status='pending' ORDER BY IFNULL(last_ts, ts) DESC LIMIT 500")
        else:
            rows = c.execute("SELECT * FROM requests WHERE status<>'pending' ORDER BY IFNULL(resolved_at, ts) DESC LIMIT 300")
        out = [dict(r) for r in rows]
    for r in out:
        comp = snap.by_id.get(r.get("company_id"))
        r["company"] = comp["name"] if comp else None
    h.json(200, {"ok": True, "requests": out})


@route("POST", "/api/requests/resolve")
def r_request_resolve(h):
    body = h.body_json(16 * 1024)
    ids = body.get("ids") or ([body.get("id")] if body.get("id") is not None else [])
    try:
        ids = [int(x) for x in ids][:200]
    except (TypeError, ValueError):
        raise HTTPError(400, "bad id") from None
    action = str(body.get("action", ""))
    if action not in ("approve", "reject", "block"):
        raise HTTPError(400, "action must be approve, reject or block")
    want_scope = str(body.get("scope", "company"))
    if want_scope not in ("company", "global"):
        raise HTTPError(400, "scope must be company or global")
    status = {"approve": "approved", "reject": "rejected", "block": "blocked"}[action]
    results = []
    with write_db() as c:
        for rid in ids:
            row = c.execute("SELECT * FROM requests WHERE id=?", (rid,)).fetchone()
            if not row or row["status"] != "pending":
                continue
            domain, cid = row["domain"], row["company_id"]
            comp = None
            if cid is not None:
                comp_row = c.execute("SELECT * FROM companies WHERE id=?", (cid,)).fetchone()
                comp = company_row_to_dict(comp_row) if comp_row else None
            ts = now_iso()
            if action == "reject":
                # Rejecting changes no list, so it only closes the request that was chosen.
                c.execute("""UPDATE requests SET status=?, resolved_at=?, resolved_by=?, scope=?
                             WHERE id=?""", (status, ts, h.user["username"], "company" if comp else "global", rid))
                audit(c, h.user["username"], "request.reject", domain,
                      {"scope": "company" if comp else "global", "company": comp["name"] if comp else None}, h.client_ip())
                results.append({"id": rid, "domain": domain, "status": status})
                continue
            if want_scope == "company" and comp is None:
                # Never widen a decision silently: the browser has no company yet.
                results.append({"id": rid, "domain": domain, "skipped": "no_company"})
                continue
            scope = want_scope
            gpol = load_policy(c)
            add_to, remove_from = ("whitelist", "blacklist") if action == "approve" else ("blacklist", "whitelist")
            if scope == "company":
                cwl = [d for d in comp["whitelist"] if d != domain]
                cbl = [d for d in comp["blacklist"] if d != domain]
                if action == "approve":
                    cwl.append(domain)
                else:
                    cbl.append(domain)
                if action == "approve":
                    mode = comp["policy_mode"] if comp["policy_mode"] in MODES else gpol["enforceMode"]
                    eff_bl = [d for d in text_domains(gpol["blacklist"]) if d not in set(cwl)] + cbl
                    parent = blocking_parent(domain, mode, eff_bl)
                    if parent:
                        results.append({"id": rid, "domain": domain, "skipped": "parent_blocked", "parent": parent})
                        continue
                upd = {"whitelist": domains_text(cwl), "blacklist": domains_text(cbl)}
                if len(upd[add_to]) > COMPANY_LIST_MAX_CHARS:
                    raise HTTPError(400, "company list is full")
                _update_company(c, comp["id"], upd, ts)
            else:
                new = {"whitelist": list_edit(gpol["whitelist"], remove=domain),
                       "blacklist": list_edit(gpol["blacklist"], remove=domain)}
                new[add_to] = list_edit(new[add_to], add=domain)
                if action == "approve":
                    parent = blocking_parent(domain, gpol["enforceMode"], text_domains(new["blacklist"]))
                    if parent:
                        results.append({"id": rid, "domain": domain, "skipped": "parent_blocked", "parent": parent})
                        continue
                if len(new[add_to]) > GLOBAL_LIST_MAX_CHARS and len(new[add_to]) > len(gpol[add_to]):
                    raise HTTPError(400, "global list is full")
                gpol.update(new)
                save_policy(c, gpol)
            if scope == "global":
                c.execute("""UPDATE requests SET status=?, resolved_at=?, resolved_by=?, scope=?
                             WHERE status='pending' AND domain=?""",
                          (status, ts, h.user["username"], scope, domain))
            else:
                c.execute("""UPDATE requests SET status=?, resolved_at=?, resolved_by=?, scope=?
                             WHERE status='pending' AND domain=? AND company_id=?""",
                          (status, ts, h.user["username"], scope, domain, cid))
            audit(c, h.user["username"], "request." + action, domain,
                  {"scope": scope, "company": comp["name"] if comp and scope == "company" else None}, h.client_ip())
            results.append({"id": rid, "domain": domain, "status": status, "scope": scope})
    invalidate()
    h.json(200, {"ok": True, "results": results})


# ── Admin: releases ──────────────────────────────────────────────────────────

@route("GET", "/api/releases")
def r_releases(h):
    snap = snapshot()
    with read_db() as c:
        rel = kv_get(c, "release", {}) or {}
        hist = kv_get(c, "releases", []) or []
        devs = _decorate_devices(_all_devices(c), snap, time.time())
    versions = Counter(d.get("version") or "unknown" for d in devs)
    on_latest = versions.get(rel.get("version"), 0) if rel.get("version") else 0
    h.json(200, {"ok": True, "release": rel, "history": hist[::-1][:30], "appid": APPID,
                 "versions": sorted(([v, n] for v, n in versions.items()), key=lambda x: version_key(x[0]), reverse=True),
                 "adoption": {"latest": on_latest, "total": len(devs)}})


@route("POST", "/api/releases/upload")
def r_release_upload(h):
    data = h.read_body(50 * 1024 * 1024)
    if not data:
        raise HTTPError(400, "empty upload")
    try:
        info = parse_crx(data)
    except ValueError as e:
        raise HTTPError(400, str(e))
    if info["appid"] != APPID:
        raise HTTPError(400, "this package is signed with a different key (extension id %s, expected %s)"
                        % (info["appid"], APPID))
    with read_db() as c:
        cur = kv_get(c, "release", {}) or {}
    if cur.get("version") and version_key(info["version"]) <= version_key(cur["version"]) and not h.query.get("force"):
        raise HTTPError(409, "version %s is not newer than the published %s — Chrome would ignore it"
                        % (info["version"], cur["version"]), {"needsConfirm": True})
    filename = "url-safety-checker-%s.crx" % info["version"]
    path = os.path.join(DOWNLOAD_DIR, filename)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
    entry = {"appid": APPID, "version": info["version"], "filename": filename, "size": len(data),
             "sha256": hashlib.sha256(data).hexdigest(), "uploaded_at": now_iso(), "by": h.user["username"]}
    with write_db() as c:
        kv_set(c, "release", entry)
        hist = [x for x in (kv_get(c, "releases", []) or []) if x.get("version") != info["version"]]
        hist.append(entry)
        kv_set(c, "releases", hist[-50:])
        audit(c, h.user["username"], "release.publish", info["version"], {"size": len(data)}, h.client_ip())
    h.json(200, {"ok": True, "version": info["version"], "filename": filename})


@route("GET", "/api/audit")
def r_audit(h):
    try:
        limit = max(1, min(1000, int(h.query.get("limit", 300))))
    except ValueError:
        limit = 300
    with read_db() as c:
        rows = [dict(r) for r in c.execute("SELECT * FROM audit ORDER BY id DESC LIMIT ?", (limit,))]
    h.json(200, {"ok": True, "events": rows})


# ── Entry points ─────────────────────────────────────────────────────────────

def cmd_reset_password():
    global ADMIN_USER
    init_db()
    ADMIN_USER = get_or_create_user()
    pw = os.environ.get("FLEET_NEW_PASS") or getpass.getpass("New admin password (min 10 chars): ")
    if len(pw) < 10:
        print("Password too short.")
        return 1
    if not os.environ.get("FLEET_NEW_PASS") and getpass.getpass("Repeat: ") != pw:
        print("Passwords do not match.")
        return 1
    set_admin_password(pw)
    n = revoke_sessions()
    print("Password for '%s' updated; %d session(s) signed out." % (ADMIN_USER["username"], n))
    return 0


def cmd_migrate_check(src):
    """Dry run of the v2 → v3 upgrade on a COPY of fleet.db. Never touches the original."""
    global DATA_DIR, DB_PATH, USER_PATH, DOWNLOAD_DIR, COMPANIES_SEED
    import shutil
    import tempfile
    if not os.path.isfile(src):
        print("No database at %s" % src)
        return 1
    tmp = tempfile.mkdtemp(prefix="fleet-dryrun-")
    try:
        shutil.copy2(src, os.path.join(tmp, "fleet.db"))
        seed = os.path.join(os.path.dirname(os.path.abspath(src)), "companies.json")
        DATA_DIR, DB_PATH = tmp, os.path.join(tmp, "fleet.db")
        USER_PATH, DOWNLOAD_DIR = os.path.join(tmp, "admin_user.json"), os.path.join(tmp, "downloads")
        COMPANIES_SEED = [seed]
        init_db()
        invalidate()
        snap = snapshot()
        with read_db() as c:
            devs = _all_devices(c)
            pending = c.execute("SELECT COUNT(*) FROM requests WHERE status='pending'").fetchone()[0]
        counts = Counter()
        for d in devs:
            comp, how, _ = snap.match(d.get("last_ip"), d.get("company_id"), d.get("computer_name"))
            counts[how] += 1
        print("Companies after upgrade: %d" % len(snap.companies))
        print("Devices: %d (matched by NAT %d, subnet %d, pinned %d, ambiguous %d, no company %d)"
              % (len(devs), counts["nat"], counts["subnet"], counts["pinned"], counts["ambiguous"], counts["none"]))
        print("Pending requests: %d" % pending)
        print("Global policy: %s, %d allowed (%d chars), %d blocked (%d chars)" % (
            snap.policy["enforceMode"], len(text_domains(snap.policy["whitelist"])), len(snap.policy["whitelist"]),
            len(text_domains(snap.policy["blacklist"])), len(snap.policy["blacklist"])))
        print("Dry run only — %s was not modified." % src)
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main(argv):
    global ADMIN_USER
    if len(argv) > 1 and argv[1] == "reset-password":
        return cmd_reset_password()
    if len(argv) > 1 and argv[1] == "migrate-check":
        return cmd_migrate_check(argv[2] if len(argv) > 2 else DB_PATH)
    if len(argv) > 1 and argv[1] in ("-h", "--help", "help"):
        print(__doc__)
        return 0
    init_db()
    ADMIN_USER = get_or_create_user()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.daemon_threads = True
    line = "=" * 64
    print(line)
    print("URL Safety Checker — Fleet server v%s" % APP_VERSION)
    print("Listening:  http://%s:%d   (client IP mode: %s)" % (HOST, PORT, TRUST_PROXY))
    print("Login user: %s" % ADMIN_USER["username"])
    if ADMIN_USER.get("_plain"):
        print("Login pass: %s   <-- shown once, save it now" % ADMIN_USER["_plain"])
    else:
        print("Login pass: (unchanged — reset with: python3 server.py reset-password)")
    if os.path.exists(LEGACY_TOKEN_PATH):
        print("NOTE: admin_token.txt is no longer used (replaced by login sessions) — you can delete it.")
    if not os.path.isfile(os.path.join(WEB_DIR, "index.html")):
        print("WARNING: web/index.html not found — the dashboard will not load.")

    tls_srv = None
    cert, key = os.environ.get("FLEET_TLS_CERT"), os.environ.get("FLEET_TLS_KEY")
    if cert and key and os.path.exists(cert) and os.path.exists(key):
        import ssl
        tls_port = int(os.environ.get("FLEET_TLS_PORT", "8443"))
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        tls_srv = ThreadingHTTPServer((HOST, tls_port), Handler)
        tls_srv.daemon_threads = True
        tls_srv.socket = ctx.wrap_socket(tls_srv.socket, server_side=True)
        threading.Thread(target=tls_srv.serve_forever, daemon=True).start()
        print("HTTPS:      https://%s:%d" % (HOST, tls_port))
    if DNS_INTERVAL > 0:
        threading.Thread(target=dns_loop, daemon=True).start()
        print("AD DNS:     computer IPs refreshed every %d s from each company's DC" % max(60, DNS_INTERVAL))
    print(line)
    sys.stdout.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()
        if tls_srv:
            tls_srv.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
