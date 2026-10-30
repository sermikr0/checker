# Fleet auto-update — how it works (signed, legitimate)

This gives you exactly the outcome you wanted — **publish once from the
dashboard, every machine auto-updates** — using Chrome's own signed-update
channel instead of pushing/executing code. Chrome verifies the package
signature before installing; nothing runs arbitrary code at runtime.

Key facts:
- **Extension ID:** `lddmakdihlenfbmdpggpahjooglgigoi` (fixed; comes from `signing-key.pem`)
- **Update URL:** `http://10.252.13.126:8080/update_manifest.xml`
- **Signing key:** `/home/ai/backup/url-fleet/signing-key.pem` — **guard it, back it up, reuse it for every version.** Lose it and the extension ID changes (fleet can't update).

## One-time: force-install the extension on each machine

Self-hosted auto-update works only for **policy-installed** extensions (a
"Load unpacked" copy never auto-updates). Deploy the policy once per machine
(GPO/MDM for the whole fleet, or by hand for a test).

**Windows** — registry (admin), then restart Chrome:
```
reg add "HKLM\Software\Policies\Google\Chrome\ExtensionInstallForcelist" /v 1 /t REG_SZ ^
 /d "lddmakdihlenfbmdpggpahjooglgigoi;http://10.252.13.126:8080/update_manifest.xml" /f
```

**Linux** — create `/etc/opt/chrome/policies/managed/url-fleet.json`, restart Chrome:
```json
{ "ExtensionInstallForcelist":
  ["lddmakdihlenfbmdpggpahjooglgigoi;http://10.252.13.126:8080/update_manifest.xml"] }
```

**macOS** — same key via a configuration profile / `com.google.Chrome` plist.

**Google Admin console (managed Chrome):** Devices → Chrome → Apps & extensions
→ add by ID `lddmakdihlenfbmdpggpahjooglgigoi`, Installation = *Force install*,
"Install URL" = the update_url above.

After the policy is applied, Chrome installs the extension automatically and
then polls the update URL every few hours (or immediately on
`chrome://extensions` → **Update**).

## Every time you ship a new version

1. Make your code changes in the extension folder.
2. Bump `"version"` in `manifest.json` **and** `VERSION` in `analyzer.js`.
3. Re-pack **with the same key**:
   ```bash
   cd /home/ai/backup/url-fleet
   python3 pack_crx.py extension signing-key.pem url-safety-checker-<NEW>.crx
   ```
4. Dashboard → **Extension updates** → *Choose File* → the new `.crx` →
   **Upload & publish**. (The server reads the version from the package and
   updates `update_manifest.xml` automatically.)
5. Done. Force-installed machines auto-update within hours; the device table
   shows each machine's version so you watch the rollout.

## Test it on one browser now

1. Apply the force-install policy above on your machine, restart Chrome →
   the extension installs itself from the server (v2.1.0) and appears in the
   dashboard.
2. Bump to 2.1.1, pack, Upload & publish.
3. On `chrome://extensions` click **Update** → it jumps to 2.1.1 with no
   reinstall. That is the whole fleet experience, on one machine.

## Reminders
- `signing-key.pem` is the crown jewel — without it you cannot ship updates
  that the fleet will accept. Keep an offline backup.
- Put the server behind **TLS** before leaving the trusted LAN; serve the
  update URL and `.crx` over https then.
- The extension still shows the compact "managed by your organization" line in
  Settings — keep that; it is what keeps the deployment disclosed and legitimate.
