#!/usr/bin/env python3
"""fleet-rdp — opens fleet-rdp:// links from the fleet dashboard with xfreerdp.

    fleet-rdp://connect?host=10.111.0.5&domain=shod.local&user=Administrator

Installed by install.sh as the handler for the fleet-rdp:// scheme. Any web
page can try to open such a link, so the link is treated as untrusted input:

  * host, domain and user are checked against strict patterns,
  * only private (RFC 1918 / ULA) addresses are allowed unless
    FLEET_RDP_ALLOW_PUBLIC=1 is set,
  * nothing goes through a shell, and the target is shown in a terminal and
    confirmed with Enter before xfreerdp starts (the password is typed there).
"""
import ipaddress
import os
import re
import shutil
import socket
import subprocess
import sys
from urllib.parse import parse_qs, urlsplit

HOST_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$")
DOMAIN_RE = re.compile(r"^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)?$")
USER_RE = re.compile(r"^[A-Za-z0-9._@-]{0,64}$")


class LinkError(ValueError):
    pass


def _private(ip):
    addr = ipaddress.ip_address(ip)
    return addr.is_private and not addr.is_loopback and not addr.is_link_local


def validate(host, domain="", user="", allow_public=None):
    """Return (host, domain, user) or raise LinkError."""
    if allow_public is None:
        allow_public = os.environ.get("FLEET_RDP_ALLOW_PUBLIC") == "1"
    host, domain, user = (host or "").strip(), (domain or "").strip(), (user or "").strip()
    if not HOST_RE.match(host):
        raise LinkError("invalid host")
    if not DOMAIN_RE.match(domain):
        raise LinkError("invalid domain")
    if not USER_RE.match(user):
        raise LinkError("invalid user name")
    try:
        ips = [str(ipaddress.ip_address(host))]
    except ValueError:
        try:
            ips = sorted({ai[4][0] for ai in socket.getaddrinfo(host, 3389, proto=socket.IPPROTO_TCP)})
        except OSError:
            raise LinkError("host does not resolve") from None
    if not allow_public and not all(_private(ip) for ip in ips):
        raise LinkError("only private addresses are allowed (set FLEET_RDP_ALLOW_PUBLIC=1 to override)")
    return host, domain, user


def parse_link(url):
    parts = urlsplit(url)
    if parts.scheme != "fleet-rdp":
        raise LinkError("not a fleet-rdp link")
    q = parse_qs(parts.query, keep_blank_values=True)
    for key in q:
        if key not in ("host", "domain", "user"):
            raise LinkError("unexpected parameter")
    first = lambda k: (q.get(k) or [""])[0]  # noqa: E731
    return validate(first("host"), first("domain"), first("user"))


def freerdp_command(host, domain, user):
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
    args = [binary, "/v:" + host, "/dynamic-resolution", "+clipboard",
            "/cert:tofu" if major >= 3 else "/cert-tofu"]
    if domain:
        args.append("/d:" + domain)
    if user:
        args.append("/u:" + user)
    return args


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


def connect(host, domain, user):
    host, domain, user = validate(host, domain, user)
    args = freerdp_command(host, domain, user)
    print("Remote desktop to %s%s%s" % (host, (" — domain " + domain) if domain else "", (" — user " + user) if user else ""))
    try:
        input("Press Enter to connect, Ctrl+C to cancel… ")
    except (KeyboardInterrupt, EOFError):
        return 1
    os.execvp(args[0], args)
    return 0


def main(argv):
    try:
        if len(argv) >= 2 and argv[1] == "--run":
            return connect(*(argv[2:5] + [""] * (5 - len(argv))))
        if len(argv) < 2:
            print(__doc__)
            return 2
        host, domain, user = parse_link(argv[1])
        if sys.stdin.isatty():
            return connect(host, domain, user)
        cmd = terminal_command([sys.executable, os.path.abspath(__file__), "--run", host, domain, user])
        if not cmd:
            raise LinkError("no terminal emulator found")
        subprocess.Popen(cmd, start_new_session=True)
        return 0
    except LinkError as e:
        notify(str(e))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
