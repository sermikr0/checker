"""Tests for the fleet-rdp:// link handler (tools/fleet-rdp/fleet_rdp.py)."""
import importlib
import os
import stat
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools", "fleet-rdp"))

import fleet_rdp  # noqa: E402


def fake_freerdp(version_line):
    tmp = tempfile.mkdtemp()
    fake = os.path.join(tmp, "xfreerdp")
    with open(fake, "w") as f:
        f.write("#!/bin/sh\necho '%s'\n" % version_line)
    os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
    return tmp


class LinkTests(unittest.TestCase):
    def setUp(self):
        os.environ.pop("FLEET_RDP_ALLOW_PUBLIC", None)

    def test_host_only_link(self):
        self.assertEqual(fleet_rdp.parse_link("fleet-rdp://connect?host=10.111.0.5"), ("10.111.0.5", "", ""))
        # older dashboard links carried domain/user without a password: ignored
        self.assertEqual(fleet_rdp.parse_link("fleet-rdp://connect?host=10.111.0.5&domain=shod.local&user=Administrator"),
                         ("10.111.0.5", "", ""))

    def test_link_with_company_password(self):
        self.assertEqual(fleet_rdp.parse_link("fleet-rdp://connect?host=10.93.0.5&user=Administrator&pass=T%40st+Pa55%3F"),
                         ("10.93.0.5", "Administrator", "T@st Pa55?"))
        self.assertEqual(fleet_rdp.parse_link("fleet-rdp://connect?host=10.93.0.5&pass=x"), ("10.93.0.5", "Administrator", "x"))

    def test_rejects_public_and_loopback_targets(self):
        for host in ("8.8.8.8", "127.0.0.1", "169.254.1.1"):
            with self.assertRaises(fleet_rdp.LinkError, msg=host):
                fleet_rdp.parse_link("fleet-rdp://connect?host=" + host)
        os.environ["FLEET_RDP_ALLOW_PUBLIC"] = "1"
        self.assertEqual(fleet_rdp.parse_link("fleet-rdp://connect?host=8.8.8.8")[0], "8.8.8.8")

    def test_rejects_injection_attempts(self):
        bad = [
            "fleet-rdp://connect?host=10.0.0.1%20/drive:home,/",
            "fleet-rdp://connect?host=-10.0.0.1",
            "fleet-rdp://connect?host=10.0.0.1&user=a/p:x&pass=y",
            "fleet-rdp://connect?host=10.0.0.1&user=-admin&pass=y",
            "fleet-rdp://connect?host=10.0.0.1&user=a&pass=x%0Ay",
            "fleet-rdp://connect?host=10.0.0.1&extra=1",
            "http://connect?host=10.0.0.1",
        ]
        for url in bad:
            with self.assertRaises(fleet_rdp.LinkError, msg=url):
                fleet_rdp.parse_link(url)

    def test_command_v2(self):
        old = os.environ["PATH"]
        os.environ["PATH"] = fake_freerdp("This is FreeRDP version 2.11.5")
        try:
            args = fleet_rdp.freerdp_command("10.111.0.5", "Administrator", "secret")
        finally:
            os.environ["PATH"] = old
        self.assertEqual(args[0], "xfreerdp")
        self.assertEqual(args[1:5], ["/v:10.111.0.5", "/u:Administrator", "/p:secret", "/dynamic-resolution"])
        self.assertIn("/cert-tofu", args)

    def test_command_v3(self):
        old = os.environ["PATH"]
        os.environ["PATH"] = fake_freerdp("This is FreeRDP version 3.5.1")
        try:
            args = fleet_rdp.freerdp_command("10.111.0.5", "Administrator", "secret")
        finally:
            os.environ["PATH"] = old
        self.assertIn("/cert:tofu", args)


class CredentialTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.old_env = {k: os.environ.get(k) for k in ("XDG_CONFIG_HOME", "PATH")}
        os.environ["XDG_CONFIG_HOME"] = self.tmp
        os.environ["PATH"] = tempfile.mkdtemp()      # no secret-tool: file storage
        importlib.reload(fleet_rdp)

    def tearDown(self):
        for k, v in self.old_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        importlib.reload(fleet_rdp)

    def test_file_storage_round_trip(self):
        self.assertEqual(fleet_rdp.load_credentials(), (None, None))
        self.assertEqual(fleet_rdp.save_credentials("Administrator", "p@ss=word"), "file")
        self.assertEqual(fleet_rdp.load_credentials(), ("Administrator", "p@ss=word"))
        mode = stat.S_IMODE(os.stat(fleet_rdp.CONF_FILE).st_mode)
        self.assertEqual(mode, 0o600)


if __name__ == "__main__":
    unittest.main()
