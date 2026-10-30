#!/usr/bin/env bash
# Ubuntu/Linux: registers the fleet-rdp:// link handler for the current user,
# so the dashboard's RDP button opens xfreerdp (dynamic resolution) at once,
# and asks once for the user name and password used on every domain controller.
#
#   bash tools/fleet-rdp/install.sh
#   curl -fsSL https://fleet.red1.uz/tools/fleet-rdp/install.sh | FLEET_SERVER=https://fleet.red1.uz bash
set -euo pipefail

BIN="${HOME}/.local/bin"
APPS="${XDG_DATA_HOME:-${HOME}/.local/share}/applications"
SERVER="${FLEET_SERVER:-https://fleet.red1.uz}"
SRC_URL="${SERVER%/}/tools/fleet-rdp/fleet_rdp.py"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"

command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
mkdir -p "$BIN" "$APPS"

if [ -n "$HERE" ] && [ -f "$HERE/fleet_rdp.py" ]; then
  install -m 755 "$HERE/fleet_rdp.py" "$BIN/fleet-rdp"
else
  curl -fsSL "$SRC_URL" -o "$BIN/fleet-rdp"
  chmod 755 "$BIN/fleet-rdp"
fi

cat > "$APPS/fleet-rdp.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Fleet RDP
Comment=Open fleet-rdp:// links with xfreerdp
Exec=$BIN/fleet-rdp %u
Terminal=false
NoDisplay=true
MimeType=x-scheme-handler/fleet-rdp;
EOF

command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" 2>/dev/null || true
xdg-mime default fleet-rdp.desktop x-scheme-handler/fleet-rdp

if ! command -v xfreerdp3 >/dev/null && ! command -v xfreerdp >/dev/null; then
  echo "Note: install FreeRDP: sudo apt install freerdp3-x11   (older systems: freerdp2-x11)"
fi

# Fallback user name + password for companies without a password saved in the
# dashboard; stored only on this computer (keyring, or a 600 file).
if (: </dev/tty) 2>/dev/null; then
  echo "Companies with a password in the dashboard need nothing more. For the others:"
  python3 "$BIN/fleet-rdp" --setup </dev/tty || true
else
  echo "Optional: save a user name and password for companies without one in the dashboard: $BIN/fleet-rdp --setup"
fi
echo "Done. Press RDP next to a company in the dashboard; Chrome asks once to allow it."
