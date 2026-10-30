# Shipping a new extension version

Chrome updates force-installed extensions from the fleet server's
`update_manifest.xml`. Chrome verifies the package signature; the server checks
that the package carries the fleet's extension ID before publishing it.

* **Extension ID:** `lddmakdihlenfbmdpggpahjooglgigoi` (fixed by `signing-key.pem`)
* **Update URL:** `https://fleet.red1.uz/update_manifest.xml`
* **Signing key:** `signing-key.pem` — keep an offline backup and reuse it for
  every version. Lose it and the extension ID changes; the fleet can no longer update.

## One-time: force-install on each computer

Self-hosted updates only work for policy-installed extensions ("Load unpacked"
never updates). On domain computers the **AD agent** sets this up through the
"URL Fleet - Chrome" GPO (DEPLOYMENT.md → *AD agent*). By hand:

* **Windows** (admin, then restart Chrome):
  ```
  reg add "HKLM\Software\Policies\Google\Chrome\ExtensionInstallForcelist" /v 1 /t REG_SZ /d "lddmakdihlenfbmdpggpahjooglgigoi;https://fleet.red1.uz/update_manifest.xml" /f
  ```
* **Linux** — `/etc/opt/chrome/policies/managed/url-fleet.json`:
  ```json
  { "ExtensionInstallForcelist": ["lddmakdihlenfbmdpggpahjooglgigoi;https://fleet.red1.uz/update_manifest.xml"] }
  ```
* **Group Policy / Google Admin console** — force-install the ID above with the update URL above.

For per-computer statuses (2.5.0) the `computerName` extension policy is
needed too — the AD agent's GPO sets it.

## Every release

1. Change the code in `extension/`.
2. Raise `"version"` in `extension/manifest.json` **and** `VERSION` in `extension/analyzer.js`.
3. Pack with the same key:
   ```bash
   python3 pack_crx.py extension signing-key.pem url-safety-checker-<version>.crx
   ```
4. Dashboard → **Updates** → drop the `.crx` on the upload area.
5. Browsers running **2.5.0 or newer** update within a few minutes: their next
   check-in learns the new version number and asks Chrome to update now
   (Chrome still downloads the CRX from the update URL and checks its signature).
   Older versions wait for Chrome's own check (every few hours, or at browser
   start); `chrome://extensions` → **Update** forces it on one computer.
   The Company pages show which version each computer runs.

Publishing a version that is not newer than the current one asks for
confirmation — Chrome never downgrades, so it would have no effect on
browsers that already run the newer version.
