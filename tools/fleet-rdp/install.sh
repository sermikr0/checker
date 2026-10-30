#!/usr/bin/env bash
# Registers the fleet-rdp:// link handler for the current Linux user so the
# dashboard's RDP button opens xfreerdp (dynamic resolution) to a company's DC.
#
#   bash tools/fleet-rdp/install.sh
#   curl -fsSL https://raw.githubusercontent.com/sermikr0/checker/main/tools/fleet-rdp/install.sh | bash
set -euo pipefail

BIN="${HOME}/.local/bin"
APPS="${XDG_DATA_HOME:-${HOME}/.local/share}/applications"
SRC_URL="https://raw.githubusercontent.com/sermikr0/checker/main/tools/fleet-rdp/fleet_rdp.py"
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
  echo "Note: install FreeRDP first: sudo apt install freerdp3-x11   (older systems: freerdp2-x11)"
fi
echo "Done. Press RDP next to a company in the dashboard; Chrome asks once to allow xdg-open."
