"""
End-to-end tests for server.py (stdlib unittest, no dependencies).

    python3 -m unittest discover -s tests -v

Each test class starts a real server on a free port with its own temporary
data directory, so nothing touches a real fleet.db.
"""
import http.client
import http.cookiejar
import json
import socket
import os
import shutil
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import server  # noqa: E402


def use_data_dir(path):
    server.DATA_DIR = path
    server.DB_PATH = os.path.join(path, "fleet.db")
    server.USER_PATH = os.path.join(path, "admin_user.json")
    server.LEGACY_TOKEN_PATH = os.path.join(path, "admin_token.txt")
    server.DOWNLOAD_DIR = os.path.join(path, "downloads")
    server.COMPANIES_SEED = [os.path.join(path, "companies.json")]
    server.BLOCKLIST_DIR = os.path.join(path, "blocklists")      # empty unless a test writes one
    server.invalidate()


class Client:
    def __init__(self, base):
        self.base = base
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def call(self, method, path, body=None, headers=None, csrf=True, raw=False):
        data = None
        h = dict(headers or {})
        if body is not None:
            if isinstance(body, (bytes, bytearray)):
                data = bytes(body)
                h.setdefault("Content-Type", "application/octet-stream")
            else:
                data = json.dumps(body).encode()
                h.setdefault("Content-Type", "application/json")
        if csrf and method == "POST":
            h.setdefault("X-Fleet-CSRF", "1")
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with self.opener.open(req, timeout=10) as r:
                payload = r.read()
                status, hdrs = r.status, r.headers
        except urllib.error.HTTPError as e:
            payload, status, hdrs = e.read(), e.code, e.headers
        if raw:
            return status, payload, hdrs
        try:
            return status, json.loads(payload.decode() or "{}")
        except ValueError:
            return status, {"_raw": payload.decode(errors="replace")}

    def get(self, path, **kw):
        return self.call("GET", path, **kw)

    def post(self, path, body=None, **kw):
        return self.call("POST", path, body if body is not None else {}, **kw)


class ServerCase(unittest.TestCase):
    PASSWORD = "correct-horse-battery"

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="fleet-test-")
        use_data_dir(cls.tmp)
        cls.seed(cls.tmp)
        os.environ["FLEET_ADMIN_PASS"] = cls.PASSWORD
        server.TRUST_PROXY = "cloudflare"   # as in docker-compose.yml (cloudflared in front)
        server.init_db()
        server.ADMIN_USER = server.get_or_create_user()
        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.httpd.daemon_threads = True
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:%d" % cls.httpd.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)
        server.LOGIN_FAILS._hits.clear()

    @classmethod
    def seed(cls, path):
        with open(os.path.join(path, "companies.json"), "w") as f:
            json.dump([
                {"name": "Alpha", "domain": "alpha.local", "dc_ip": "10.1.0.10", "subnet": "10.1",
                 "computers": ["A-1", "A-2", "A-3"], "count": 3},
                {"name": "Beta", "domain": "beta.local", "dc_ip": "10.2.0.10", "subnet": "10.2",
                 "computers": ["B-1"], "count": 1},
                {"name": "Twin1", "subnet": "10.9", "computers": []},
                {"name": "Twin2", "subnet": "10.9", "computers": []},
            ], f)

    def admin(self):
        c = Client(self.base)
        st, j = c.post("/api/login", {"username": "admin", "password": self.PASSWORD}, csrf=False)
        self.assertEqual(st, 200, j)
        return c

    def checkin(self, device_id, ip, kind="heartbeat", ua="Mozilla/5.0 Chrome/130", version="2.2.9"):
        c = Client(self.base)
        return c.post("/api/" + kind, {"deviceId": device_id, "version": version, "userAgent": ua},
                      headers={"CF-Connecting-IP": ip}, csrf=False)


class AuthTests(ServerCase):
    def test_admin_api_requires_session(self):
        c = Client(self.base)
        for path in ("/api/devices", "/api/companies", "/api/policy", "/api/overview", "/api/audit"):
            st, _ = c.get(path)
            self.assertEqual(st, 401, path)

    def test_old_public_config_endpoint_is_gone(self):
        st, _ = Client(self.base).get("/api/config")
        self.assertEqual(st, 404)

    def test_login_logout_and_csrf(self):
        c = self.admin()
        st, me = c.get("/api/me")
        self.assertEqual(st, 200)
        self.assertEqual(me["user"], "admin")
        st, _ = c.post("/api/policy", {"enforceMode": "off"}, csrf=False)
        self.assertEqual(st, 403, "POST without CSRF header must be refused")
        st, _ = c.post("/api/logout", csrf=False)
        self.assertEqual(st, 200)
        st, _ = c.get("/api/me")
        self.assertEqual(st, 401)

    def test_cookie_flags(self):
        c = Client(self.base)
        st, body, hdrs = c.call("POST", "/api/login", {"username": "admin", "password": self.PASSWORD},
                                csrf=False, raw=True)
        self.assertEqual(st, 200)
        cookie = hdrs.get("Set-Cookie")
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)
        self.assertNotIn("token", json.loads(body))

    def test_bruteforce_lockout(self):
        server.LOGIN_FAILS._hits.clear()
        c = Client(self.base)
        hdr = {"CF-Connecting-IP": "203.0.113.99"}
        codes = [c.post("/api/login", {"username": "admin", "password": "nope"}, headers=hdr, csrf=False)[0]
                 for _ in range(6)]
        self.assertEqual(codes[:5], [401] * 5)
        self.assertEqual(codes[5], 429)
        # even the right password is refused while locked out
        st, _ = c.post("/api/login", {"username": "admin", "password": self.PASSWORD}, headers=hdr, csrf=False)
        self.assertEqual(st, 429)
        server.LOGIN_FAILS._hits.clear()

    def test_password_change_revokes_other_sessions(self):
        a, b = self.admin(), self.admin()
        st, j = a.post("/api/change-password", {"current_password": self.PASSWORD, "new_password": "short"})
        self.assertEqual(st, 400)
        new_pw = "a-much-better-password"
        st, j = a.post("/api/change-password", {"current_password": self.PASSWORD, "new_password": new_pw})
        self.assertEqual(st, 200, j)
        self.assertGreaterEqual(j["revokedSessions"], 1)
        self.assertEqual(a.get("/api/me")[0], 200)
        self.assertEqual(b.get("/api/me")[0], 401)
        # restore for the other tests
        st, _ = a.post("/api/change-password", {"current_password": new_pw, "new_password": self.PASSWORD})
        self.assertEqual(st, 200)

    def test_static_dashboard_headers_and_traversal(self):
        c = Client(self.base)
        st, body, hdrs = c.call("GET", "/", raw=True)
        self.assertEqual(st, 200)
        self.assertIn("default-src 'self'", hdrs.get("Content-Security-Policy", ""))
        self.assertEqual(hdrs.get("X-Frame-Options"), "DENY")
        st, _, _ = c.call("GET", "/assets/../server.py", raw=True)
        self.assertEqual(st, 404)
        st, _, _ = c.call("GET", "/fleet.db", raw=True)
        self.assertEqual(st, 404)


class FleetTests(ServerCase):
    def test_company_matching_and_effective_policy(self):
        a = self.admin()
        comps = {c["name"]: c for c in a.get("/api/companies")[1]["companies"]}
        alpha = comps["Alpha"]["id"]
        st, j = a.post("/api/companies/%d/nat-ip" % alpha, {"ip": "198.51.100.7", "action": "add"})
        self.assertEqual(st, 200, j)
        st, j = a.post("/api/policy", {"enforceMode": "blacklist", "whitelist": "google.com\nslack.com",
                                       "blacklist": "evil.com\nhttps://www.bad.net/path"})
        self.assertEqual(st, 200, j)
        st, j = a.post("/api/companies/%d/policy" % alpha,
                       {"mode": "whitelist", "whitelist": ["dat.com", "evil.com"], "blacklist": ["slack.com"]})
        self.assertEqual(st, 200, j)

        st, j = self.checkin("dev-alpha-0001", "198.51.100.7", "enroll")
        self.assertEqual(st, 200, j)
        self.assertEqual(j["policy"]["company"], "Alpha")
        self.assertEqual(j["config"]["enforceMode"], "whitelist")
        wl = j["config"]["whitelist"].split("\n")
        bl = j["config"]["blacklist"].split("\n")
        self.assertIn("google.com", wl)
        self.assertIn("dat.com", wl)
        self.assertNotIn("slack.com", wl, "company blacklist must override global whitelist")
        self.assertNotIn("evil.com", bl, "company whitelist must override global blacklist")
        self.assertIn("bad.net", bl, "URLs are normalized to bare domains")

        # a device in Beta's private subnet gets the global policy
        st, j = self.checkin("dev-beta-0001", "10.2.33.4")
        self.assertEqual(j["policy"]["company"], "Beta")
        self.assertEqual(j["config"]["enforceMode"], "blacklist")
        self.assertIn("evil.com", j["config"]["blacklist"])

        # an unknown public address gets the global policy, company None
        st, j = self.checkin("dev-nowhere-01", "192.0.2.50")
        self.assertIsNone(j["policy"]["company"])

        # ambiguous subnet (two companies share 10.9) is not guessed
        st, j = self.checkin("dev-twin-0001", "10.9.1.1")
        self.assertIsNone(j["policy"]["company"])
        devs = {d["device_id"]: d for d in a.get("/api/devices")[1]["devices"]}
        self.assertEqual(devs["dev-twin-0001"]["match"], "ambiguous")
        self.assertEqual(sorted(devs["dev-twin-0001"]["candidates"]), ["Twin1", "Twin2"])

        # pin it manually
        twin2 = comps["Twin2"]["id"]
        st, j = a.post("/api/devices/update", {"deviceIds": ["dev-twin-0001"], "companyId": twin2})
        self.assertEqual(st, 200, j)
        st, j = self.checkin("dev-twin-0001", "10.9.1.1")
        self.assertEqual(j["policy"]["company"], "Twin2")

        # reset
        a.post("/api/policy", {"enforceMode": "off", "whitelist": "", "blacklist": ""})
        a.post("/api/companies/%d/policy" % alpha, {"mode": "inherit", "whitelist": [], "blacklist": []})

    def test_same_nat_same_browser_devices_are_not_deleted(self):
        """v2 deleted every other device with the same IP + user-agent on enroll (one office = one NAT)."""
        for i in range(5):
            st, _ = self.checkin("dev-office-%04d" % i, "198.51.100.200", "enroll", ua="Mozilla/5.0 SameUA")
            self.assertEqual(st, 200)
        a = self.admin()
        ids = {d["device_id"] for d in a.get("/api/devices")[1]["devices"]}
        for i in range(5):
            self.assertIn("dev-office-%04d" % i, ids)

    def test_bad_device_id_rejected(self):
        st, _ = Client(self.base).post("/api/heartbeat", {"deviceId": "<script>"}, csrf=False)
        self.assertEqual(st, 400)

    def test_access_request_flow_company_scope(self):
        a = self.admin()
        comps = {c["name"]: c for c in a.get("/api/companies")[1]["companies"]}
        beta = comps["Beta"]["id"]
        self.checkin("dev-beta-req01", "10.2.1.1", "enroll")
        c = Client(self.base)
        for _ in range(3):
            st, j = c.post("/api/request-access", {"deviceId": "dev-beta-req01", "url": "https://Tools.Example.org/x?y"},
                           headers={"CF-Connecting-IP": "10.2.1.1"}, csrf=False)
            self.assertEqual(st, 200, j)
        reqs = [r for r in a.get("/api/requests")[1]["requests"] if r["domain"] == "tools.example.org"]
        self.assertEqual(len(reqs), 1, "duplicates are folded into one pending request")
        self.assertEqual(reqs[0]["hits"], 3)
        self.assertEqual(reqs[0]["company"], "Beta")
        st, j = a.post("/api/requests/resolve", {"id": reqs[0]["id"], "action": "approve", "scope": "company"})
        self.assertEqual(st, 200, j)
        self.assertEqual(j["results"][0]["scope"], "company")
        self.assertIn("tools.example.org", server.snapshot().by_id[beta]["whitelist"])
        glob = a.get("/api/policy")[1]["policy"]
        self.assertNotIn("tools.example.org", glob["whitelist"])
        st, j = self.checkin("dev-beta-req01", "10.2.1.1")
        self.assertIn("tools.example.org", j["config"]["whitelist"])
        hist = a.get("/api/requests?status=resolved")[1]["requests"]
        self.assertTrue(any(r["domain"] == "tools.example.org" and r["status"] == "approved" for r in hist))
        a.post("/api/companies/%d/policy" % beta, {"whitelist": []})

    def test_whitelist_mode_with_empty_list_needs_confirmation(self):
        a = self.admin()
        st, j = a.post("/api/policy", {"enforceMode": "whitelist", "whitelist": ""})
        self.assertEqual(st, 409)
        self.assertTrue(j.get("needsConfirm"))
        st, j = a.post("/api/policy", {"enforceMode": "whitelist", "whitelist": "", "confirmEmpty": True})
        self.assertEqual(st, 200)
        a.post("/api/policy", {"enforceMode": "off"})

    def test_policy_validation(self):
        a = self.admin()
        st, j = a.post("/api/policy", {"blacklist": "good.com\nnot a domain!!\n"})
        self.assertEqual(st, 400)
        self.assertIn("blacklist", j["fields"])
        st, j = a.post("/api/policy", {"enforceMode": "everything"})
        self.assertEqual(st, 400)

    def test_company_crud_and_validation(self):
        a = self.admin()
        st, j = a.post("/api/companies", {"name": "", "subnet": "banana"})
        self.assertEqual(st, 400)
        self.assertIn("name", j["fields"])
        self.assertIn("subnet", j["fields"])
        st, j = a.post("/api/companies", {"name": "Gamma", "subnet": "10.77.0.0/16", "nat_ips": ["203.0.113.0/29"],
                                          "computers": "G-1\nG-2"})
        self.assertEqual(st, 200, j)
        gid = j["id"]
        st, j = a.post("/api/companies", {"name": "gamma"})
        self.assertEqual(st, 409, "names are unique, case-insensitive")
        st, j = self.checkin("dev-gamma-0001", "203.0.113.5")
        self.assertEqual(j["policy"]["company"], "Gamma", "NAT entries accept CIDR ranges")
        st, j = a.post("/api/companies/%d" % gid, {"notes": "Main office", "dc_ip": "not-an-ip"})
        self.assertEqual(st, 400)
        st, j = a.post("/api/companies/%d" % gid, {"notes": "Main office"})
        self.assertEqual(st, 200)
        st, j = a.get("/api/companies/%d" % gid)
        self.assertEqual(j["company"]["notes"], "Main office")
        self.assertEqual(j["company"]["computers"], ["G-1", "G-2"])
        st, j = a.post("/api/companies/%d/delete" % gid)
        self.assertEqual(st, 200)
        self.assertEqual(a.get("/api/companies/%d" % gid)[0], 404)

    def test_import_export_roundtrip(self):
        a = self.admin()
        st, body, hdrs = a.call("GET", "/api/companies/export", raw=True)
        self.assertEqual(st, 200)
        data = json.loads(body)
        self.assertTrue(any(c["name"] == "Alpha" for c in data))
        data.append({"name": "Imported Co", "subnet": "10.200", "computers": ["X"]})
        st, j = a.post("/api/companies/import", json.dumps(data).encode())
        self.assertEqual(st, 200, j)
        self.assertEqual(j["created"], 1)
        self.assertGreaterEqual(j["updated"], 4)

    def test_overview_shape(self):
        a = self.admin()
        st, j = a.get("/api/overview")
        self.assertEqual(st, 200)
        for key in ("devices", "versions", "companies", "policy", "requests", "activity"):
            self.assertIn(key, j)

    def test_audit_log_records_actions(self):
        a = self.admin()
        a.post("/api/policy", {"enforceMode": "off"})
        events = a.get("/api/audit")[1]["events"]
        self.assertTrue(any(e["action"] == "policy.global" for e in events))
        self.assertTrue(any(e["action"] == "login" for e in events))


class ReleaseTests(ServerCase):
    def build_crx(self, version, key_path):
        sys.path.insert(0, ROOT)
        import pack_crx
        ext = tempfile.mkdtemp()
        with open(os.path.join(ext, "manifest.json"), "w") as f:
            json.dump({"manifest_version": 3, "name": "T", "version": version}, f)
        out = os.path.join(ext, "out.crx")
        argv = sys.argv
        sys.argv = ["pack_crx.py", ext, key_path, out]
        try:
            import contextlib
            import io
            with contextlib.redirect_stdout(io.StringIO()) as buf:
                pack_crx.main()
        finally:
            sys.argv = argv
        appid = [ln.split(":")[1].strip() for ln in buf.getvalue().splitlines() if ln.startswith("extension_id")][0]
        with open(out, "rb") as f:
            return f.read(), appid

    def test_upload_checks_extension_id_and_version(self):
        try:
            import cryptography  # noqa: F401
        except ImportError:
            self.skipTest("cryptography not installed")
        key = os.path.join(self.tmp, "k.pem")
        crx, appid = self.build_crx("3.0.0", key)
        a = self.admin()
        st, j = a.post("/api/releases/upload", crx)
        self.assertEqual(st, 400, "a package from a different key is refused")
        self.assertIn("different key", j["error"])
        old = server.APPID
        server.APPID = appid
        try:
            st, j = a.post("/api/releases/upload", crx)
            self.assertEqual(st, 200, j)
            st, body, _ = Client(self.base).call("GET", "/update_manifest.xml", raw=True)
            self.assertIn(b"version='3.0.0'", body)
            st, body, _ = Client(self.base).call("GET", "/downloads/url-safety-checker-3.0.0.crx", raw=True)
            self.assertEqual(body, crx)
            crx2, _ = self.build_crx("2.9.0", key)
            st, j = a.post("/api/releases/upload", crx2)
            self.assertEqual(st, 409, "older versions need confirmation")
            st, j = a.get("/api/releases")
            self.assertEqual(j["release"]["version"], "3.0.0")
        finally:
            server.APPID = old

    def test_garbage_upload(self):
        a = self.admin()
        st, j = a.post("/api/releases/upload", b"not a crx at all")
        self.assertEqual(st, 400)


class HardeningTests(ServerCase):
    """Regression tests for the issues found in the independent review."""

    def port(self):
        return self.httpd.server_address[1]

    def test_unread_body_cannot_smuggle_a_second_request(self):
        self.checkin("dev-smuggle-01", "198.51.100.1", "enroll")
        hidden = json.dumps({"deviceId": "dev-smuggle-01", "url": "https://smuggled.example/"}).encode()
        smuggled = (b"POST /api/request-access HTTP/1.1\r\nHost: x\r\nCF-Connecting-IP: 203.0.113.77\r\n"
                    b"Content-Type: application/json\r\nContent-Length: " + str(len(hidden)).encode() + b"\r\n\r\n" + hidden)
        conn = http.client.HTTPConnection("127.0.0.1", self.port(), timeout=5)
        conn.request("POST", "/api/logout", body=smuggled, headers={"Content-Type": "application/json"})
        r = conn.getresponse()
        r.read()
        self.assertEqual(r.status, 200)
        conn.request("GET", "/healthz")
        r2 = conn.getresponse()
        self.assertEqual(r2.status, 200)
        self.assertTrue(json.loads(r2.read())["ok"])
        conn.close()
        reqs = self.admin().get("/api/requests")[1]["requests"]
        self.assertFalse(any(x["domain"] == "smuggled.example" for x in reqs), "hidden request must not run")

    def test_keep_alive_after_rejected_post_with_body(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port(), timeout=5)
        conn.request("POST", "/api/policy", body=b'{"enforceMode":"off"}', headers={"Content-Type": "application/json"})
        r = conn.getresponse()
        r.read()
        self.assertEqual(r.status, 401)
        conn.request("GET", "/healthz")
        self.assertEqual(conn.getresponse().status, 200)
        conn.close()

    def test_chunked_body_refused(self):
        with socket.create_connection(("127.0.0.1", self.port()), timeout=5) as sock:
            sock.sendall(b"POST /api/heartbeat HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n")
            data = sock.recv(4096)
        self.assertIn(b" 411 ", data.split(b"\r\n")[0] + b" ")
        self.assertIn(b"Connection: close", data)

    def test_malformed_request_line_gets_400(self):
        with socket.create_connection(("127.0.0.1", self.port()), timeout=5) as sock:
            sock.sendall(b"GARBAGE\r\n\r\n")
            data = sock.recv(4096)
        self.assertTrue(data.startswith(b"HTTP/1.1 400") or data.startswith(b"HTTP/1.0 400"), data[:40])

    def test_password_reset_on_disk_is_picked_up_without_restart(self):
        import time as _t
        _t.sleep(0.01)
        salt = "ab" * 16
        new_pw = "reset-from-the-cli-123"
        with open(server.USER_PATH, "w") as f:
            json.dump({"username": "admin", "salt": salt, "hash": server._hash_pw(new_pw, salt)}, f)
        try:
            c = Client(self.base)
            st, _ = c.post("/api/login", {"username": "admin", "password": self.PASSWORD}, csrf=False)
            self.assertEqual(st, 401, "the old password must stop working")
            st, _ = c.post("/api/login", {"username": "admin", "password": new_pw}, csrf=False)
            self.assertEqual(st, 200)
        finally:
            _t.sleep(0.01)
            server.set_admin_password(self.PASSWORD)
            server.LOGIN_FAILS._hits.clear()

    def test_other_cookies_do_not_hide_the_session(self):
        c = Client(self.base)
        st, body, hdrs = c.call("POST", "/api/login", {"username": "admin", "password": self.PASSWORD}, csrf=False, raw=True)
        tok = hdrs.get("Set-Cookie").split(";")[0].split("=", 1)[1]
        raw = Client(self.base)
        st, _ = raw.get("/api/me", headers={"Cookie": 'prefs={"a":1}; x=hello world; cart[1]=5; usc_session=' + tok})
        self.assertEqual(st, 200)

    def test_non_ascii_username_is_a_normal_failure(self):
        st, _ = Client(self.base).post("/api/login", {"username": "админ", "password": "x"},
                                       headers={"CF-Connecting-IP": "203.0.113.200"}, csrf=False)
        self.assertEqual(st, 401)
        server.LOGIN_FAILS._hits.clear()

    def test_truncated_crx_is_a_400(self):
        st, j = self.admin().post("/api/releases/upload", b"Cr24\x03")
        self.assertEqual(st, 400)

    def test_request_from_unknown_device_is_refused(self):
        st, _ = Client(self.base).post("/api/request-access", {"deviceId": "never-enrolled-1", "url": "https://a.example/"},
                                       headers={"CF-Connecting-IP": "10.1.1.1"}, csrf=False)
        self.assertEqual(st, 403)

    def test_version_must_look_like_a_version(self):
        self.checkin("dev-weird-ver1", "10.1.2.3", "enroll", version="=cmd|' /C calc'!A0")
        devs = {d["device_id"]: d for d in self.admin().get("/api/devices")[1]["devices"]}
        self.assertEqual(devs["dev-weird-ver1"]["version"], "")

    def test_requests_without_company_are_never_widened(self):
        a = self.admin()
        self.checkin("dev-nocomp-001", "192.0.2.99", "enroll")
        self.checkin("dev-alpha-req1", "10.1.4.4", "enroll")
        c = Client(self.base)
        for did, ip in (("dev-nocomp-001", "192.0.2.99"), ("dev-alpha-req1", "10.1.4.4")):
            st, _ = c.post("/api/request-access", {"deviceId": did, "url": "https://videos.example/"},
                           headers={"CF-Connecting-IP": ip}, csrf=False)
            self.assertEqual(st, 200)
        pend = [r for r in a.get("/api/requests")[1]["requests"] if r["domain"] == "videos.example"]
        nocomp = [r for r in pend if r["company"] is None][0]
        withcomp = [r for r in pend if r["company"] == "Alpha"][0]
        before = a.get("/api/policy")[1]["policy"]
        st, j = a.post("/api/requests/resolve", {"id": nocomp["id"], "action": "block", "scope": "company"})
        self.assertEqual(st, 200)
        self.assertEqual(j["results"][0].get("skipped"), "no_company")
        self.assertEqual(a.get("/api/policy")[1]["policy"]["blacklist"], before["blacklist"], "global list untouched")
        st, j = a.post("/api/requests/resolve", {"id": nocomp["id"], "action": "reject", "scope": "company"})
        self.assertEqual(j["results"][0]["status"], "rejected")
        still = [r["id"] for r in a.get("/api/requests")[1]["requests"]]
        self.assertIn(withcomp["id"], still, "rejecting one request leaves other companies' requests open")
        a.post("/api/requests/resolve", {"id": withcomp["id"], "action": "reject"})

    def test_allowing_a_subdomain_of_a_blocked_domain_is_refused(self):
        a = self.admin()
        a.post("/api/policy", {"enforceMode": "blacklist", "blacklist": ["facebook.com"], "whitelist": []})
        self.checkin("dev-alpha-fb01", "10.1.9.9", "enroll")
        st, _ = Client(self.base).post("/api/request-access", {"deviceId": "dev-alpha-fb01", "url": "https://m.facebook.com/"},
                                       headers={"CF-Connecting-IP": "10.1.9.9"}, csrf=False)
        self.assertEqual(st, 200)
        rid = [r for r in a.get("/api/requests")[1]["requests"] if r["domain"] == "m.facebook.com"][0]["id"]
        st, j = a.post("/api/requests/resolve", {"id": rid, "action": "approve", "scope": "company"})
        self.assertEqual(j["results"][0].get("skipped"), "parent_blocked")
        self.assertEqual(j["results"][0].get("parent"), "facebook.com")
        a.post("/api/requests/resolve", {"id": rid, "action": "reject"})
        a.post("/api/policy", {"enforceMode": "off", "blacklist": []})

    def test_stale_editor_gets_a_conflict(self):
        a = self.admin()
        rev = a.get("/api/policy")[1]["policy"]["rev"]
        st, j = a.post("/api/policy", {"enforceMode": "off", "rev": rev})
        self.assertEqual(st, 200)
        st, j = a.post("/api/policy", {"enforceMode": "blacklist", "rev": rev})
        self.assertEqual(st, 409)
        self.assertTrue(j.get("stale"))
        comp = a.get("/api/companies")[1]["companies"][0]
        detail = a.get("/api/companies/%d" % comp["id"])[1]["company"]
        st, _ = a.post("/api/companies/%d/policy" % comp["id"], {"mode": "inherit", "rev": detail["rev"]})
        self.assertEqual(st, 200)
        st, j = a.post("/api/companies/%d/policy" % comp["id"], {"mode": "off", "rev": detail["rev"]})
        self.assertEqual(st, 409)

    def test_oversized_legacy_list_can_be_saved_but_not_grown_and_is_capped_for_devices(self):
        a = self.admin()
        big = ["site%05d.example.com" % i for i in range(700)]           # ~15 000 characters
        with server.write_db() as c:
            pol = server.load_policy(c)
            pol.update({"whitelist": "\n".join(big), "enforceMode": "off"})
            server.kv_set(c, "config", pol)
        server.invalidate()
        st, j = a.post("/api/policy", {"enforceMode": "off", "whitelist": big})
        self.assertEqual(st, 200, j)
        st, j = a.post("/api/policy", {"whitelist": big + ["one-more.example"]})
        self.assertEqual(st, 400)
        comp = [x for x in a.get("/api/companies")[1]["companies"] if x["name"] == "Beta"][0]
        extra = ["beta%05d.example.org" % i for i in range(350)]
        st, j = a.post("/api/companies/%d/policy" % comp["id"], {"whitelist": extra})
        self.assertEqual(st, 200, j)
        st, j = self.checkin("dev-beta-big01", "10.2.8.8")
        wl = j["config"]["whitelist"]
        self.assertLessEqual(len(wl), server.DELIVERY_MAX_CHARS)
        self.assertTrue(wl.startswith("beta00000.example.org"), "company entries are kept first")
        self.assertTrue(all(server.normalize_domain(d) for d in wl.split("\n")), "never cut inside a domain")
        a.post("/api/companies/%d/policy" % comp["id"], {"whitelist": []})
        a.post("/api/policy", {"whitelist": []})


class FakeDNS:
    """Tiny authoritative DNS on 127.0.0.1 answering A queries from a dict."""

    def __init__(self, records):
        self.records = {k.lower(): v for k, v in records.items()}
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("127.0.0.1", 0))
        self.port = self.sock.getsockname()[1]
        self.queries = []
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self):
        import struct
        while True:
            try:
                data, addr = self.sock.recvfrom(512)
            except OSError:
                return
            tid = data[:2]
            pos, labels = 12, []
            while data[pos]:
                ln = data[pos]
                labels.append(data[pos + 1:pos + 1 + ln].decode())
                pos += 1 + ln
            qend = pos + 5
            name = ".".join(labels).lower()
            self.queries.append(name)
            question = data[12:qend]
            ip = self.records.get(name)
            if ip is None and name.count(".") <= 1:      # the domain itself: answer "no A record"
                hdr = tid + struct.pack(">HHHHH", 0x8180, 1, 0, 0, 0)
                self.sock.sendto(hdr + question, addr)
            elif ip is None:
                hdr = tid + struct.pack(">HHHHH", 0x8183, 1, 0, 0, 0)
                self.sock.sendto(hdr + question, addr)
            else:
                hdr = tid + struct.pack(">HHHHH", 0x8180, 1, 1, 0, 0)
                ans = b"\xc0\x0c" + struct.pack(">HHIH", 1, 1, 60, 4) + socket.inet_aton(ip)
                self.sock.sendto(hdr + question + ans, addr)

    def close(self):
        self.sock.close()


class ComputersTests(ServerCase):
    def test_parse_computers_accepts_names_ips_and_objects(self):
        names, ips, bad = server.parse_computers("PC-01\nPC-02 10.1.0.22\npc-01\n{bad")
        self.assertEqual(names, ["PC-01", "PC-02", "{bad"])
        self.assertEqual(ips, {"pc-02": "10.1.0.22"})
        names, ips, bad = server.parse_computers([{"name": "A", "ip": "10.0.0.1"}, "B nonsense"])
        self.assertEqual(bad, ["B nonsense"])

    def test_dns_lookup_against_the_company_dc(self):
        dns = FakeDNS({"pc-01.zeta.local": "10.70.0.21", "pc-02.zeta.local": "10.70.0.22"})
        old = server.DNS_PORT
        server.DNS_PORT = dns.port
        try:
            a = self.admin()
            st, j = a.post("/api/companies", {"name": "Zeta", "domain": "zeta.local", "dc_ip": "127.0.0.1",
                                              "computers": "PC-01\nPC-02\nPC-03 10.70.0.99"})
            self.assertEqual(st, 200, j)
            cid = j["id"]
            st, j = a.post("/api/companies/%d/resolve" % cid)
            self.assertEqual(st, 200, j)
            self.assertEqual((j["dns"]["status"], j["dns"]["found"], j["dns"]["total"]), ("ok", 2, 3))
            pcs = {p["name"]: p for p in a.get("/api/companies/%d" % cid)[1]["company"]["computerList"]}
            self.assertEqual((pcs["PC-01"]["ip"], pcs["PC-01"]["ipSource"]), ("10.70.0.21", "dns"))
            self.assertEqual((pcs["PC-03"]["ip"], pcs["PC-03"]["ipSource"]), ("10.70.0.99", "manual"))
            self.assertIn("pc-01.zeta.local", dns.queries)
        finally:
            server.DNS_PORT = old
            dns.close()

    def test_unreachable_dc_is_reported(self):
        old_port, old_to = server.DNS_PORT, server.DNS_TIMEOUT
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.bind(("127.0.0.1", 0))          # bound but never answers
        server.DNS_PORT, server.DNS_TIMEOUT = sock.getsockname()[1], 0.2
        try:
            a = self.admin()
            st, j = a.post("/api/companies", {"name": "Silent", "domain": "silent.local", "dc_ip": "127.0.0.1",
                                              "computers": ["S-1"]})
            st, j = a.post("/api/companies/%d/resolve" % j["id"])
            self.assertEqual(j["dns"]["status"], "unreachable")
        finally:
            server.DNS_PORT, server.DNS_TIMEOUT = old_port, old_to
            sock.close()

    def test_computer_status_comes_from_the_extension_computer_name(self):
        a = self.admin()
        st, j = a.post("/api/companies", {"name": "Eta", "domain": "eta.local", "computers": ["ETA-01", "ETA-02", "PC-221"]})
        cid = j["id"]
        # the computer name alone identifies the company, even from an unknown address
        c = Client(self.base)
        st, j = c.post("/api/enroll", {"deviceId": "dev-eta-0001", "version": "2.4.0", "userAgent": "UA", "computerName": "eta-01"},
                       headers={"CF-Connecting-IP": "192.0.2.10"}, csrf=False)
        self.assertEqual(j["policy"]["company"], "Eta")
        self.assertEqual(j["policy"]["match"], "computer")
        # a computer name outside the AD list still shows up, flagged
        c.post("/api/enroll", {"deviceId": "dev-eta-0002", "version": "2.4.0", "userAgent": "UA", "computerName": "NEW-PC"},
               headers={"CF-Connecting-IP": "192.0.2.10"}, csrf=False)
        a.post("/api/devices/update", {"deviceIds": ["dev-eta-0002"], "companyId": cid})
        # bad names are ignored
        c.post("/api/heartbeat", {"deviceId": "dev-eta-0001", "version": "2.4.0", "computerName": "<script>"},
               headers={"CF-Connecting-IP": "192.0.2.10"}, csrf=False)
        pcs = {p["name"]: p for p in a.get("/api/companies/%d" % cid)[1]["company"]["computerList"]}
        self.assertEqual(pcs["ETA-01"]["status"], "online")
        self.assertEqual(pcs["ETA-01"]["version"], "2.4.0")
        self.assertEqual(pcs["ETA-02"]["status"], "none")
        self.assertFalse(pcs["NEW-PC"]["listed"])
        self.assertEqual(pcs["NEW-PC"]["status"], "online")

    def test_same_computer_name_in_two_companies_uses_the_address(self):
        a = self.admin()
        a.post("/api/companies", {"name": "Theta", "nat_ips": ["203.0.113.80"], "computers": ["DUP-PC"]})
        a.post("/api/companies", {"name": "Iota", "nat_ips": ["203.0.113.81"], "computers": ["DUP-PC"]})
        c = Client(self.base)
        st, j = c.post("/api/enroll", {"deviceId": "dev-dup-00001", "version": "2.4.0", "computerName": "DUP-PC"},
                       headers={"CF-Connecting-IP": "203.0.113.81"}, csrf=False)
        self.assertEqual((j["policy"]["company"], j["policy"]["match"]), ("Iota", "computer"))
        st, j = c.post("/api/enroll", {"deviceId": "dev-dup-00002", "version": "2.4.0", "computerName": "DUP-PC"},
                       headers={"CF-Connecting-IP": "192.0.2.99"}, csrf=False)
        self.assertIsNone(j["policy"]["company"], "two candidates and no address hint: do not guess")

    def test_export_keeps_manual_ips(self):
        a = self.admin()
        a.post("/api/companies", {"name": "Kappa", "computers": "K-1 10.9.9.1\nK-2"})
        st, body, _ = a.call("GET", "/api/companies/export", raw=True)
        kappa = [c for c in json.loads(body) if c["name"] == "Kappa"][0]
        self.assertEqual(kappa["computers"], ["K-1 10.9.9.1", "K-2"])


class BlocklistTests(ServerCase):
    def write_list(self, text, name="test.txt"):
        os.makedirs(server.BLOCKLIST_DIR, exist_ok=True)
        path = os.path.join(server.BLOCKLIST_DIR, name)
        with open(path, "w") as f:
            f.write(text)
        os.utime(path, None)
        return path

    def tearDown(self):
        import shutil as _sh
        _sh.rmtree(server.BLOCKLIST_DIR, ignore_errors=True)
        server.invalidate()

    def test_repo_blocklist_is_valid(self):
        with open(os.path.join(ROOT, "blocklists", "freight-phishing.txt"), encoding="utf-8") as f:
            entries = [ln.split("#", 1)[0].strip() for ln in f]
        entries = [e for e in entries if e]
        self.assertEqual(len(entries), 154)
        self.assertTrue(all(server.normalize_domain(e) == e.lower() for e in entries))

    def test_blocked_in_open_mode_and_merged_in_blacklist_mode(self):
        a = self.admin()
        a.post("/api/policy", {"enforceMode": "off", "whitelist": [], "blacklist": ["facebook.com"]})
        self.write_list("# comment\nhighwaa.com\n\nHighway-Carrier.com  # inline comment\nnot a domain!\n")
        st, j = self.checkin("dev-block-0001", "192.0.2.77", "enroll")
        self.assertEqual(j["config"]["enforceMode"], "blacklist", "open mode still blocks the phishing list")
        self.assertEqual(j["config"]["blacklist"].split("\n"), ["highwaa.com", "highway-carrier.com"],
                         "only the phishing list — the admin's blacklist is not enforced in open mode")
        a.post("/api/policy", {"enforceMode": "blacklist"})
        st, j = self.checkin("dev-block-0001", "192.0.2.77")
        self.assertEqual(j["config"]["blacklist"].split("\n"), ["highwaa.com", "highway-carrier.com", "facebook.com"])
        # an exact entry on the allowed list exempts a false positive
        a.post("/api/policy", {"whitelist": ["highwaa.com"]})
        st, j = self.checkin("dev-block-0001", "192.0.2.77")
        self.assertNotIn("highwaa.com", j["config"]["blacklist"].split("\n"))
        info = a.get("/api/policy")[1]["threats"]
        self.assertEqual(info["exempt"], ["highwaa.com"])
        self.assertEqual(info["files"], [{"file": "test.txt", "domains": 2}])
        a.post("/api/policy", {"enforceMode": "off", "whitelist": [], "blacklist": []})

    def test_whitelist_mode_unchanged_and_ui_mode_untouched(self):
        a = self.admin()
        a.post("/api/policy", {"enforceMode": "whitelist", "whitelist": ["google.com"], "blacklist": []})
        self.write_list("highwaa.com\n")
        st, j = self.checkin("dev-block-0002", "192.0.2.78", "enroll")
        self.assertEqual(j["config"]["enforceMode"], "whitelist")
        self.assertEqual(a.get("/api/overview")[1]["policy"]["mode"], "whitelist")
        a.post("/api/policy", {"enforceMode": "off", "whitelist": []})
        self.assertEqual(a.get("/api/overview")[1]["policy"]["mode"], "off", "dashboard shows the admin's mode")

    def test_list_reloads_when_the_file_changes(self):
        self.write_list("one-bad.example\n")
        st, j = self.checkin("dev-block-0003", "192.0.2.79", "enroll")
        self.assertEqual(j["config"]["blacklist"], "one-bad.example")
        import time as _t
        _t.sleep(0.02)
        self.write_list("one-bad.example\ntwo-bad.example\n")
        st, j = self.checkin("dev-block-0003", "192.0.2.79")
        self.assertEqual(j["config"]["blacklist"], "one-bad.example\ntwo-bad.example")

    def test_subdomain_of_listed_domain_cannot_be_approved(self):
        a = self.admin()
        self.write_list("rsrmissecured.top\n")
        self.checkin("dev-block-0004", "10.1.7.7", "enroll")
        st, _ = Client(self.base).post("/api/request-access", {"deviceId": "dev-block-0004", "url": "https://penskecar.rsrmissecured.top/"},
                                       headers={"CF-Connecting-IP": "10.1.7.7"}, csrf=False)
        rid = [r for r in a.get("/api/requests")[1]["requests"] if r["domain"] == "penskecar.rsrmissecured.top"][0]["id"]
        st, j = a.post("/api/requests/resolve", {"id": rid, "action": "approve", "scope": "global"})
        self.assertEqual(j["results"][0].get("skipped"), "parent_blocked")
        a.post("/api/requests/resolve", {"id": rid, "action": "reject"})


class ProxyModeTests(ServerCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        server.TRUST_PROXY = "none"

    @classmethod
    def tearDownClass(cls):
        server.TRUST_PROXY = "cloudflare"
        server._proxy_mismatch["seen"] = False
        super().tearDownClass()

    def test_header_ignored_and_mismatch_reported(self):
        st, j = self.checkin("dev-proxy-0001", "10.1.0.5", "enroll")
        self.assertIsNone(j["policy"]["company"], "CF-Connecting-IP must not be trusted by default")
        self.assertTrue(self.admin().get("/api/me")[1]["proxyMismatch"])


class MigrationTests(unittest.TestCase):
    """A fleet.db written by server v2 must upgrade in place without losing data."""

    def test_upgrade_from_v2_database(self):
        tmp = tempfile.mkdtemp(prefix="fleet-mig-")
        try:
            db = os.path.join(tmp, "fleet.db")
            c = sqlite3.connect(db)
            c.execute("""CREATE TABLE devices (device_id TEXT PRIMARY KEY, label TEXT DEFAULT '', version TEXT DEFAULT '',
                         user_agent TEXT DEFAULT '', first_seen TEXT, last_seen TEXT, last_ip TEXT DEFAULT '',
                         enroll_count INTEGER DEFAULT 0, beats INTEGER DEFAULT 0)""")
            c.execute("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)")
            c.execute("""CREATE TABLE requests (id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT, url TEXT,
                         device_id TEXT, label TEXT DEFAULT '', ts TEXT, status TEXT DEFAULT 'pending')""")
            c.execute("INSERT INTO devices VALUES ('dev-old-1','Reception','2.2.9','UA','2026-01-01T00:00:00Z',"
                      "'2026-01-02T00:00:00Z','198.51.100.9',1,10)")
            c.execute("INSERT INTO kv VALUES ('config', ?)", (json.dumps({
                "allowlist": "", "hoverPreview": True, "enforceMode": "whitelist",
                "whitelist": "google.com\ndat.com", "blacklist": "evil.com", "vtKey": "SECRET"}),))
            c.execute("INSERT INTO kv VALUES ('companies', ?)", (json.dumps([
                {"name": "Old Co", "domain": "old.local", "dc_ip": "10.5.0.10", "subnet": "10.5",
                 "computers": ["PC1", "PC2"], "count": 2, "nat_ips": ["198.51.100.9"]}]),))
            c.execute("INSERT INTO kv VALUES ('release', ?)", (json.dumps(
                {"appid": server.APPID, "version": "2.2.9", "filename": "url-safety-checker-2.2.9.crx"}),))
            c.execute("INSERT INTO requests (domain, url, device_id, ts) VALUES ('x.com','https://x.com','dev-old-1','2026-01-02T00:00:00Z')")
            c.commit()
            c.close()

            use_data_dir(tmp)
            server.init_db()
            server.init_db()  # idempotent
            with server.read_db() as conn:
                comps = [server.company_row_to_dict(r) for r in conn.execute("SELECT * FROM companies")]
                pol = server.load_policy(conn)
                cfg = server.kv_get(conn, "config")
                req = dict(conn.execute("SELECT * FROM requests").fetchone())
                rel = server.kv_get(conn, "release")
            self.assertEqual(len(comps), 1)
            self.assertEqual(comps[0]["nat_ips"], ["198.51.100.9"])
            self.assertEqual(comps[0]["computers"], ["PC1", "PC2"])
            self.assertEqual(pol["enforceMode"], "whitelist")
            self.assertEqual(pol["whitelist"], "google.com\ndat.com")
            self.assertNotIn("vtKey", cfg, "the API key is no longer stored server-side")
            self.assertEqual(req["status"], "pending")
            self.assertEqual(rel["version"], "2.2.9")
            snap = server.snapshot()
            comp, how, _ = snap.match("198.51.100.9")
            self.assertEqual((comp["name"], how), ("Old Co", "nat"))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_messy_v2_companies_are_all_kept_and_never_reimported(self):
        tmp = tempfile.mkdtemp(prefix="fleet-mig2-")
        try:
            c = sqlite3.connect(os.path.join(tmp, "fleet.db"))
            c.execute("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)")
            c.execute("INSERT INTO kv VALUES ('companies', ?)", (json.dumps([
                {"name": "Shod", "subnet": "10.111", "dc_ip": "10.111.0.5", "nat_ips": ["84.54.70.1,", " 84.54.70.2 "], "computers": ["A"]},
                {"name": "Artel", "subnet": "10.95", "dc_ip": "10.95.10.10, 10.95.10.11", "nat_ips": ["not-an-ip"]},
                {"name": "artel", "subnet": "banana"},
                {"name": "X" * 120},
            ]),))
            c.commit()
            c.close()
            use_data_dir(tmp)
            server.init_db()
            with server.read_db() as conn:
                comps = {r["name"]: server.company_row_to_dict(r) for r in conn.execute("SELECT * FROM companies")}
            self.assertEqual(len(comps), 4, "no company is dropped")
            self.assertEqual(comps["Shod"]["nat_ips"], ["84.54.70.1", "84.54.70.2"])
            self.assertEqual(comps["Artel"]["dc_ip"], "")
            self.assertIn("10.95.10.10, 10.95.10.11", comps["Artel"]["notes"])
            self.assertIn("not-an-ip", comps["Artel"]["notes"])
            self.assertIn("artel (2)", comps)
            with server.write_db() as conn:
                conn.execute("DELETE FROM companies")
            server.init_db()
            with server.read_db() as conn:
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM companies").fetchone()[0], 0,
                                 "deleted companies must not come back on restart")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
