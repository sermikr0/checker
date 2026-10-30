# URL Safety Checker — Logistics Edition

A Chrome extension that tells dispatchers, brokers, accounting and safety staff
whether a link is safe **before** they click it. It knows the scams that target
trucking companies: fake DAT / Truckstop / Highway logins, "renew your USDOT
registration" fraud, rate-confirmation and BOL attachments that are really
malware, carrier-packet lures, and "we changed our bank account" invoice fraud.

Version 2.4.0, Manifest V3, no build step, no dependencies.

## Install (unpacked)

1. Unzip this folder somewhere permanent (Chrome loads it from disk).
2. Open `chrome://extensions`, turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the folder that contains `manifest.json`.
4. Pin the shield icon from the puzzle-piece menu.
5. **Settings tab → add your company domains** (one per line) so your own
   portals are never reported as impersonation. Save.

Works in Edge, Brave and other Chromium browsers the same way.

## What it does

| Where | What you get |
| --- | --- |
| **Hover any link** | A small card appears: verdict, risk score, the reasons. No click needed. |
| **Risky links on pages** | Orange/red outline and a dot next to Suspicious/Dangerous links; the toolbar icon shows how many. Click the dot for details. |
| **Right-click a link** | "Check link safety" opens the full report. Selected text can be checked as a URL too. |
| **Popup → Check** | Paste a link (defanged `hxxp://evil[.]com` is understood). Shows findings, the real destination, domain age, reputation. |
| **Popup → This page** | Scans every link on the current tab and lists the ones worth a second look. |
| **History** | Last 50 checks, stored only in this browser. |

### Verdicts

| Verdict | Score | Meaning |
| --- | --- | --- |
| ✅ Safe | 0–14 | No warning signs. (Not a guarantee — unknown domains with clean addresses also land here.) |
| ⚠️ Caution | 15–44 | Something is unusual: plain HTTP, link shortener, free hosting platform, young domain… |
| 🔶 Suspicious | 45–69 | Several red flags. Verify through a known phone number before acting. |
| 🚨 Dangerous | 70–100 | Looks like impersonation, malware or credential theft. Do not open. |

## Logistics-specific checks

- **Brand impersonation** for 60+ names: DAT, Truckstop, Highway, RMIS,
  MyCarrierPackets, Carrier411, Amazon Relay, Uber Freight, J.B. Hunt,
  C.H. Robinson, TQL, Coyote, Landstar, XPO, Schneider, Werner, TriumphPay,
  RTS, OTR, Apex, WEX/EFS, Comdata, Pilot, Love's, Samsara, Motive, Omnitracs,
  FourKites, project44, UPS, FedEx, DHL, USPS, Microsoft 365, Google, DocuSign,
  Adobe, Dropbox, PayPal, QuickBooks, major US banks, Zelle, Venmo and more.
  The official domains of each brand are never flagged.
- **FMCSA / USDOT / UCR / MCS-150 / BOC-3 wording on a non-.gov domain** —
  the "registration renewal" scam. Any `.gov` site is trusted.
- **Freight lure words** on unknown domains: rate con, BOL, POD, load board,
  carrier packet / setup, MC number, operating authority, factoring, quick pay,
  remittance, detention, lumper, TONU, W-9, certificate of insurance, notice
  of assignment.
- **Payment-change wording** (ACH / wire / remittance / banking details +
  update / change / new) — the invoice-fraud lure.
- **Pressure wording**: urgent, suspended, reinstate, revoked, final notice,
  renewal, action required.
- **Archive and HTML "documents"** (`rate_confirmation.zip`, `invoice.html`)
  and direct links to executables (`.exe .msi .bat .ps1 .iso .lnk …`).
- Generic phishing structure: decoy text before `@`, raw IP addresses,
  punycode look-alikes, embedded domain names (`dat.com.evil.net`), cheap
  TLDs, link shorteners, free hosting platforms, open-redirect parameters,
  login/verify words in the domain itself.
- Your own servers on private addresses (`10.x`, `192.168.x`, `localhost`) are
  reported as internal, not as dangerous.

## Network checks and privacy

The address rules above run entirely inside the browser. The rest is explicit:

| Check | Default | What leaves the browser |
| --- | --- | --- |
| Domain age (RDAP via rdap.org) | on | the registrable domain name only |
| VirusTotal reputation | off until you add a key | the URL, as a lookup (never submitted for scanning) |
| Google Safe Browsing | off until you add a key | the URL |
| **Live check** (fetch the link) | **off** | a request to the link itself |

The live check is off on purpose: fetching a phishing link confirms to the
attacker that your mailbox is live, and fetching a one-time link (password
reset, tracking link) can use it up. Turn it on only when you need to see
redirects, forced downloads or the page title; it never sends cookies.
Results are cached for 10 minutes.

API keys and the allowlist are stored with `chrome.storage.local` in your
browser profile only.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| Company domains | empty | Your portals, mail hosts and partner sites — treated as trusted. |
| Hover preview | on | Card on mouse-over. |
| Mark risky links on pages | on | Outline, dot and badge count. |
| Live check | off | See above. |
| VirusTotal API key | — | Free key from virustotal.com. |
| Google Safe Browsing API key | — | From console.cloud.google.com (Safe Browsing API). |

## Files

```
manifest.json   permissions: storage, contextMenus, activeTab, scripting; host access for the checks
analyzer.js     all scoring rules (one copy shared by popup, content script and service worker)
background.js   context menus, badge, RDAP / VirusTotal / Safe Browsing / live fetch, result cache
content.js      hover card, link marking, page link list
popup.html/js/css  the toolbar popup
icons/          generated by tools/make-icons.js (outside the extension folder)
```

Tests: `node tests/analyzer.test.js` from the project root (outside this
folder) runs the verdict suite against `analyzer.js`.

## Troubleshooting

- **No hover card / no dots on a page.** Tabs that were already open when the
  extension was installed or reloaded do not have the script yet: reload the
  tab. (The extension also tries to inject itself into open tabs on install.)
  Then check `chrome://extensions` → URL Safety Checker → *Details* →
  *Site access* = **On all sites**; the popup shows a yellow notice when access
  is restricted.
- **"Domain age check could not run: network request blocked".** rdap.org and
  the registry RDAP servers (Verisign for .com/.net, PIR for .org) could not be
  reached — a firewall, VPN or DNS filter is in the way. The address rules
  still work; the verdict just lacks the domain-age signal.
- **A partner's legitimate site shows Caution.** Add its domain to *Your
  company domains* in Settings.

## Limitations

- Static rules cannot know that an unfamiliar but clean-looking domain is a
  phishing site; pair this with VirusTotal / Safe Browsing keys for reputation.
- The redirect chain shows start and final destination (browsers do not expose
  intermediate hops to extensions).
- Pages inside the Chrome Web Store, `chrome://` pages and the PDF viewer
  cannot be scanned.
- Scores are heuristics. A Caution on your own partner's new domain is normal;
  add it to the allowlist.

## Changes in 2.4.0

- Reads the Windows computer name from Chrome extension policy
  (`computerName`, schema in `managed_schema.json`) and sends it with the
  heartbeat, so the fleet dashboard can show each AD computer as online or
  offline. Without the policy nothing changes. The popup's Settings tab shows
  the name being sent.

## Changes in 2.3.0

- New look shared with the fleet dashboard: the verdict is shown as a road-sign
  plate, domains in a monospace face so look-alikes stand out, light and dark
  theme follow the system.
- History tab is back (last 50 checks, stored only in this browser).
- Settings show which company manages the browser and its web-filtering mode.
- The block page names the company and the rule that blocked the site, and
  tells the user when an access request could not be sent.
- The server now sends each browser its company's policy; nothing changes in
  what the extension sends (device ID, version, user-agent).

## Changes in 2.0.1

- New rules from a real inbox sample (`ratecon.talgrassfreight.com/?gdfhghsdvf=…`,
  previously only Caution): misspellings and look-alike spellings of ~120
  well-known freight, software and bank domains (talgrass ↔ tallgrass,
  chrobinsan, micr0soft-online), document-named subdomains (`ratecon.`,
  `invoice.`, `bol.`, `remittance.` …) on unknown domains, and
  machine-generated parameter names. That sample now scores Dangerous without
  any network check.
- Domain age: falls back to the registry RDAP server when rdap.org is
  unreachable, tightened age tiers (< 45 days = danger), and the exact reason
  is shown when the lookup cannot run.
- Content script is injected into tabs that were already open at install;
  the popup warns when site access is restricted.

## Changes from 1.x

- English UI; logistics brand list, FMCSA/USDOT, freight-lure and
  payment-change rules; company allowlist; private-network awareness.
- Live fetch is now opt-in (it used to visit every checked link automatically
  with a GET request).
- Fixed: clicking the red dot did nothing (`OPEN_CHECK` was never handled);
  "mark links" toggle only worked together with auto-scan; `@` in a query
  string was reported as credential phishing; noisy HTML heuristics (`eval`,
  `iframe`, `atob`, `window.location`) flagged ordinary sites; domain age was
  queried for `co.uk` instead of `example.co.uk`; checks ran one after another
  (now in parallel, with a 10-minute cache); `tabs` permission removed.
- One shared analyzer instead of three diverging copies; tooltip and lists are
  built with DOM APIs instead of HTML strings.
