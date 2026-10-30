#!/usr/bin/env python3
"""fleet-rdp — opens the dashboard's RDP links on Ubuntu/Linux with xfreerdp.

    fleet-rdp://connect?host=10.242.0.10[&user=Administrator&pass=...]

runs, without asking anything:

    xfreerdp /v:10.242.0.10 /u:<user> /p:<password> /dynamic-resolution +clipboard /cert:tofu

When the company has a password saved in the dashboard, the RDP button puts
the user name and password in the link. Otherwise the helper uses the user
name and password kept on this computer — in the desktop keyring (secret-tool)
when available, else in ~/.config/fleet-rdp/credentials (mode 600). Set them:

    fleet-rdp --setup

Any web page can try to open a fleet-rdp:// link, so links are checked:
strict host pattern, private (RFC 1918) targets only unless
FLEET_RDP_ALLOW_PUBLIC=1, nothing goes through a shell. Chrome also asks
before a site may open the handler.
"""
import getpass
import ipaddress
import os
import re
import shutil
import socket
import subprocess
import sys
from urllib.parse import parse_qs, urlsplit

HOST_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$")
USER_RE = re.compile(r"^[A-Za-z0-9._@\\][A-Za-z0-9 ._@\\-]{0,103}$")
CONF_DIR = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "fleet-rdp")
CONF_FILE = os.path.join(CONF_DIR, "credentials")
LOG_FILE = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"), "fleet-rdp.log")
KEYRING_ATTRS = ["service", "fleet-rdp"]


class LinkError(ValueError):
    pass


def _private(ip):
    addr = ipaddress.ip_address(ip)
    return addr.is_private and not addr.is_loopback and not addr.is_link_local


def validate_host(host, allow_public=None):
    if allow_public is None:
        allow_public = os.environ.get("FLEET_RDP_ALLOW_PUBLIC") == "1"
    host = (host or "").strip()
    if not HOST_RE.match(host):
        raise LinkError("invalid host")
    try:
        ips = [str(ipaddress.ip_address(host))]
    except ValueError:
        try:
            ips = sorted({ai[4][0] for ai in socket.getaddrinfo(host, 3389, proto=socket.IPPROTO_TCP)})
        except OSError:
            raise LinkError("host does not resolve") from None
    if not allow_public and not all(_private(ip) for ip in ips):
        raise LinkError("only private addresses are allowed (set FLEET_RDP_ALLOW_PUBLIC=1 to override)")
    return host


def valid_password(pw):
    return 0 < len(pw) <= 256 and not any(ord(ch) < 32 or ord(ch) == 127 for ch in pw)


def parse_link(url):
    """-> (host, user, password); user and password are "" unless both are in the link."""
    parts = urlsplit(url)
    if parts.scheme != "fleet-rdp":
        raise LinkError("not a fleet-rdp link")
    q = parse_qs(parts.query, keep_blank_values=True)
    for key in q:
        if key not in ("host", "user", "pass", "domain"):   # domain: older dashboard links, ignored
            raise LinkError("unexpected parameter")
    host = validate_host((q.get("host") or [""])[0])
    user, pw = (q.get("user") or [""])[0].strip(), (q.get("pass") or [""])[0]
    if not pw:
        return host, "", ""
    if not USER_RE.match(user or "Administrator") or not valid_password(pw):
        raise LinkError("invalid user name or password in the link")
    return host, user or "Administrator", pw


# ── credentials (local only) ──────────────────────────────────────────────

def _read_conf():
    data = {}
    try:
        with open(CONF_FILE, encoding="utf-8") as f:
            for line in f:
                k, sep, v = line.rstrip("\n").partition("=")
                if sep:
                    data[k.strip()] = v
    except OSError:
        pass
    return data


def _write_conf(data):
    os.makedirs(CONF_DIR, mode=0o700, exist_ok=True)
    tmp = CONF_FILE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        for k, v in data.items():
            f.write("%s=%s\n" % (k, v))
    os.replace(tmp, CONF_FILE)


def load_credentials():
    """-> (user, password) or (None, None)"""
    conf = _read_conf()
    user = conf.get("user")
    if not user:
        return None, None
    if conf.get("storage") == "keyring" and shutil.which("secret-tool"):
        try:
            out = subprocess.run(["secret-tool", "lookup"] + KEYRING_ATTRS, capture_output=True, text=True, timeout=10)
            if out.returncode == 0 and out.stdout:
                return user, out.stdout.rstrip("\n")
        except (OSError, subprocess.SubprocessError):
            pass
        return None, None
    pw = conf.get("password")
    return (user, pw) if pw else (None, None)


def save_credentials(user, password):
    if shutil.which("secret-tool"):
        try:
            r = subprocess.run(["secret-tool", "store", "--label=Fleet RDP"] + KEYRING_ATTRS,
                               input=password, text=True, capture_output=True, timeout=30)
            if r.returncode == 0:
                _write_conf({"user": user, "storage": "keyring"})
                return "keyring"
        except (OSError, subprocess.SubprocessError):
            pass
    _write_conf({"user": user, "storage": "file", "password": password})
    return "file"


def _tty_input(prompt):
    try:
        with open("/dev/tty", "r+") as tty:
            tty.write(prompt)
            tty.flush()
            return tty.readline().strip()
    except OSError:
        return input(prompt).strip()


def setup():
    print("Fleet RDP: the user name and password used for every domain controller.")
    user = _tty_input("User name [Administrator]: ") or "Administrator"
    if not USER_RE.match(user):
        print("Invalid user name.")
        return 1
    pw = getpass.getpass("Password: ")
    if not pw or pw != getpass.getpass("Repeat: "):
        print("Passwords are empty or do not match.")
        return 1
    where = save_credentials(user, pw)
    print("Saved in the %s." % ("desktop keyring" if where == "keyring" else CONF_FILE + " (readable only by you)"))
    return 0


# ── launching ─────────────────────────────────────────────────────────────

def freerdp_command(host, user, password):
    binary = next((b for b in ("xfreerdp3", "xfreerdp", "sdl-freerdp3", "sdl-freerdp") if shutil.which(b)), None)
    if not binary:
        raise LinkError("xfreerdp is not installed (sudo apt install freerdp3-x11 or freerdp2-x11)")
    major = 3 if binary.endswith("3") else 2
    if major == 2:
        try:
            out = subprocess.run([binary, "/version"], capture_output=True, text=True, timeout=5).stdout
            m = re.search(r"version (\d+)", out)
            major = int(m.group(1)) if m else 2
        except (OSError, subprocess.SubprocessError):
            pass
    return [binary, "/v:" + host, "/u:" + user, "/p:" + password, "/dynamic-resolution", "+clipboard",
            "/cert:tofu" if major >= 3 else "/cert-tofu"]


def terminal_command(argv):
    for term, prefix in (("gnome-terminal", ["--"]), ("konsole", ["-e"]), ("xfce4-terminal", ["-x"]),
                         ("kitty", []), ("alacritty", ["-e"]), ("xterm", ["-e"]), ("x-terminal-emulator", ["-e"])):
        if shutil.which(term):
            return [term] + prefix + argv
    return None


def notify(message):
    for cmd in (["notify-send", "Fleet RDP", message], ["zenity", "--error", "--text", message]):
        if shutil.which(cmd[0]):
            subprocess.run(cmd, check=False)
            return
    print("fleet-rdp: " + message, file=sys.stderr)


def connect(host, user=None, password=None):
    host = validate_host(host)
    if not (user and password):
        user, password = load_credentials()
    if not user:
        raise LinkError("no saved credentials — run: fleet-rdp --setup")
    args = freerdp_command(host, user, password)
    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
    log = open(LOG_FILE, "ab")
    subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    return 0


def main(argv):
    try:
        if len(argv) >= 2 and argv[1] == "--setup":
            rc = setup()
            if rc == 0 and len(argv) >= 4 and argv[2] == "--connect":
                return connect(argv[3])
            return rc
        if len(argv) < 2:
            print(__doc__)
            return 2
        host, user, password = parse_link(argv[1])
        if user and password:
            return connect(host, user, password)
        if load_credentials()[0] is None:
            # First use: ask for the credentials in a terminal, then connect.
            cmd = terminal_command([sys.executable, os.path.abspath(__file__), "--setup", "--connect", host])
            if not cmd:
                raise LinkError("no saved credentials — run: fleet-rdp --setup")
            subprocess.Popen(cmd, start_new_session=True)
            return 0
        return connect(host)
    except LinkError as e:
        notify(str(e))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
