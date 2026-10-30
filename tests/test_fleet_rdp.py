"""Tests for the fleet-rdp:// link handler (tools/fleet-rdp/fleet_rdp.py)."""
import os
import stat
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools", "fleet-rdp"))

import fleet_rdp  # noqa: E402


class LinkTests(unittest.TestCase):
    def setUp(self):
        os.environ.pop("FLEET_RDP_ALLOW_PUBLIC", None)

    def test_valid_link(self):
        self.assertEqual(fleet_rdp.parse_link("fleet-rdp://connect?host=10.111.0.5&domain=shod.local&user=Administrator"),
                         ("10.111.0.5", "shod.local", "Administrator"))
        self.assertEqual(fleet_rdp.parse_link("fleet-rdp://connect?host=10.111.0.5"), ("10.111.0.5", "", ""))

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
            "fleet-rdp://connect?host=10.0.0.1&user=a%20/p:x",
            "fleet-rdp://connect?host=10.0.0.1&domain=x;rm",
            "fleet-rdp://connect?host=10.0.0.1&extra=1",
            "http://connect?host=10.0.0.1",
        ]
        for url in bad:
            with self.assertRaises(fleet_rdp.LinkError, msg=url):
                fleet_rdp.parse_link(url)

    def test_command_uses_dynamic_resolution_and_no_shell(self):
        tmp = tempfile.mkdtemp()
        fake = os.path.join(tmp, "xfreerdp")
        with open(fake, "w") as f:
            f.write("#!/bin/sh\necho 'This is FreeRDP version 2.11.5'\n")
        os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
        old = os.environ["PATH"]
        os.environ["PATH"] = tmp
        try:
            args = fleet_rdp.freerdp_command("10.111.0.5", "shod.local", "admin")
        finally:
            os.environ["PATH"] = old
        self.assertEqual(args[0], "xfreerdp")
        self.assertIn("/v:10.111.0.5", args)
        self.assertIn("/dynamic-resolution", args)
        self.assertIn("/d:shod.local", args)
        self.assertIn("/u:admin", args)
        self.assertIn("/cert-tofu", args)


if __name__ == "__main__":
    unittest.main()
