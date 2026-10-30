'use strict';

/**
 * Service worker: context menus, badge, and the network checks that must not
 * run inside a web page (RDAP, VirusTotal, Google Safe Browsing, live fetch).
 *
 * Privacy model: by default nothing contacts the link being checked. Domain
 * age goes to rdap.org (domain name only). VirusTotal / Safe Browsing run only
 * when the user pasted an API key. The live fetch is opt-in because it visits
 * the link from this browser and would "burn" one-time tracking links.
 */
importScripts('analyzer.js');

const USC = globalThis.USC;
const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 9000;
const HTML_READ_LIMIT = 150 * 1024;
const memCache = new Map();

/* ════════════════════════════════════════════════════════════════════════════
 * MANAGED DEPLOYMENT (disclosed inventory + central configuration)
 *
 * This corporate build reports to an organization-run server so IT/security can
 * see which machines run the extension and push *settings* (allowlist, feature
 * toggles) centrally. Logistics managers are informed before enrollment, and the
 * popup shows a visible "managed by your organization" notice (see popup).
 *
 * IMPORTANT — what this channel is NOT:
 *   • It sends NO browsing history and NO page contents — only a random device
 *     id, the extension version, the user-agent and, when IT sets it by policy,
 *     the Windows computer name. The server additionally
 *     sees the source IP of the request (unavoidable for any network call).
 *   • It NEVER downloads or executes code from the server. The config it pulls
 *     is strictly data and is type-checked before use. Extension *code* updates
 *     are delivered only through Chrome's signed-CRX Enterprise update channel
 *     (update_url / force-install policy) — see DEPLOYMENT.md.
 * ════════════════════════════════════════════════════════════════════════════ */

const MGMT = Object.freeze({
  // Organization fleet server (global, behind Cloudflare: fleet.red1.uz).
  server: 'https://fleet.red1.uz',
  heartbeatAlarm: 'usc-heartbeat',
  defaultHeartbeatMin: 1,
});

async function getDeviceId() {
  try {
    const d = await chrome.storage.local.get('deviceId');
    if (d.deviceId) return d.deviceId;
    const id = (crypto.randomUUID && crypto.randomUUID()) ||
      'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    await chrome.storage.local.set({ deviceId: id });
    return id;
  } catch (_) {
    return 'dev-unknown';
  }
}

/** Apply ONLY known, type-checked setting keys pulled from the server (data, not code). */
async function applyManagedConfig(config) {
  if (!config || typeof config !== 'object') return;
  // Only the central WEB-FILTERING policy is pushed from the server (already
  // merged for this device's company). Everything else (toggles, VirusTotal
  // key, allowlist) is the extension's own local setting and must never be
  // overwritten by the server.
  const clean = {};
  if (config.enforceMode === 'off' || config.enforceMode === 'blacklist' || config.enforceMode === 'whitelist') clean.enforceMode = config.enforceMode;
  if (typeof config.whitelist === 'string') clean.whitelist = config.whitelist.slice(0, 20000);
  if (typeof config.blacklist === 'string') clean.blacklist = config.blacklist.slice(0, 20000);
  if (!Object.keys(clean).length) return;
  try {
    const d = await chrome.storage.local.get('settings');
    const merged = { ...USC.DEFAULT_SETTINGS, ...(d.settings || {}), ...clean };
    await chrome.storage.local.set({ settings: merged, managedConfigAt: Date.now() });
    await rebuildBlockingRules(merged);
    await enforceOpenTabs(merged);
  } catch (_) { /* ignore */ }
}

/**
 * Enforcement: block page navigations with declarativeNetRequest, redirecting
 * them to our own SCAM warning page. Only main-frame navigations are touched —
 * page subresources, and the extension's own heartbeat, are never blocked.
 *   whitelist mode → everything blocked except whitelisted domains
 *   blacklist mode → only blacklisted domains blocked
 * This is signed, declarative blocking data — it runs no remote code.
 */
async function rebuildBlockingRules(s) {
  if (!chrome.declarativeNetRequest) return;
  const mode = (s && s.enforceMode) || 'off';
  const interstitial = chrome.runtime.getURL('interstitial.html');
  const wl = USC.parseAllowlist(s && s.whitelist);
  const bl = USC.parseAllowlist(s && s.blacklist);
  const redirect = { type: 'redirect', redirect: { regexSubstitution: interstitial + '#\\1' } };
  const rules = [];
  let id = 1;
  const SERVER_HOST = MGMT.server.replace(/^https?:\/\//, '').replace(/:\d+$/, '').split('/')[0];
  if (mode === 'whitelist') {
    // Never lock out the management server or (implicitly) extension pages.
    rules.push({ id: id++, priority: 3, action: { type: 'allow' },
      condition: { urlFilter: '||' + SERVER_HOST, resourceTypes: ['main_frame'] } });
    if (wl.size) rules.push({ id: id++, priority: 2, action: { type: 'allow' },
      condition: { requestDomains: [...wl], resourceTypes: ['main_frame'] } });
    rules.push({ id: id++, priority: 1, action: redirect,
      condition: { regexFilter: '^(https?://.*)', resourceTypes: ['main_frame'] } });
  } else if (mode === 'blacklist' && bl.size) {
    rules.push({ id: id++, priority: 1, action: redirect,
      condition: { regexFilter: '^(https?://.*)', requestDomains: [...bl], resourceTypes: ['main_frame'] } });
  }
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((r) => r.id),
      addRules: rules,
    });
  } catch (_) { /* ignore */ }
}

/** Does this URL get blocked under the current policy? (mirrors the DNR rules) */
function isBlockedUrl(url, s) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch (_) { return false; }
  const serverHost = MGMT.server.replace(/^https?:\/\//, '').replace(/:\d+$/, '').split('/')[0];
  if (host === serverHost) return false;
  const inList = (set) => { for (const d of set) { if (host === d || host.endsWith('.' + d)) return true; } return false; };
  const mode = (s && s.enforceMode) || 'off';
  if (mode === 'whitelist') return !inList(USC.parseAllowlist(s && s.whitelist));
  if (mode === 'blacklist') return inList(USC.parseAllowlist(s && s.blacklist));
  return false;
}

/** Re-check already-open tabs when the policy changes (closes the SPA / open-tab gap). */
async function enforceOpenTabs(s) {
  if (!s || (s.enforceMode || 'off') === 'off') return;
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch (_) { return; }
  for (const tab of tabs) {
    if (typeof tab.id !== 'number' || !tab.url || !/^https?:/i.test(tab.url)) continue;
    if (isBlockedUrl(tab.url, s)) {
      chrome.tabs.update(tab.id, { url: chrome.runtime.getURL('interstitial.html') + '#' + tab.url }).catch(() => {});
    }
  }
}

/** Tell the server a blocked site was hit, so an admin can approve/reject it. */
async function reportAccessRequest(url) {
  const deviceId = await getDeviceId();
  try {
    const resp = await fetch(MGMT.server + '/api/request-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, url: String(url || '') }),
      credentials: 'omit', cache: 'no-store',
      signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
    });
    return resp.ok;
  } catch (_) {
    return false;
  }
}

async function applyStoredRules() {
  try {
    const d = await chrome.storage.local.get('settings');
    const s = { ...USC.DEFAULT_SETTINGS, ...(d.settings || {}) };
    await rebuildBlockingRules(s);
    await enforceOpenTabs(s);
  } catch (_) { /* ignore */ }
}

/** Computer name set by IT through Chrome's extension policy (managed storage). */
async function managedComputerName() {
  try {
    if (!chrome.storage.managed) return '';
    const d = await chrome.storage.managed.get('computerName');
    const name = String((d && d.computerName) || '').trim();
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ? name : '';
  } catch (_) {
    return '';   // no policy on this computer
  }
}

async function reportTo(path, extra) {
  const deviceId = await getDeviceId();
  const computerName = await managedComputerName();
  const payload = { deviceId, version: USC.VERSION, userAgent: navigator.userAgent, ...extra };
  if (computerName) payload.computerName = computerName;
  try {
    const resp = await fetch(MGMT.server + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const company = data && data.policy && typeof data.policy.company === 'string' ? data.policy.company.slice(0, 120) : '';
    await chrome.storage.local.set({ managedLastSeen: Date.now(), managedServer: MGMT.server, managedCompany: company, managedComputer: computerName });
    if (data && data.config) await applyManagedConfig(data.config);
    const mins = Number(data && data.heartbeatSec) > 0 ? Math.max(1, Math.round(data.heartbeatSec / 60)) : MGMT.defaultHeartbeatMin;
    try { chrome.alarms.create(MGMT.heartbeatAlarm, { periodInMinutes: mins }); } catch (_) { /* ignore */ }
  } catch (_) {
    // Server unreachable (LAN down, firewall): the extension keeps working
    // locally and retries on the next heartbeat. Enrollment is best-effort.
  }
}

function enroll() { return reportTo('/api/enroll', {}); }
function heartbeat() { return reportTo('/api/heartbeat', {}); }

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === MGMT.heartbeatAlarm) heartbeat();
});
chrome.runtime.onStartup.addListener(() => { heartbeat(); applyStoredRules(); });

// ── Context menus ─────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'usc-check-link', title: 'Check link safety', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'usc-check-selection', title: 'Check selected text as a URL', contexts: ['selection'] });
  });
  injectIntoOpenTabs();
  // Managed deployment: register with the organization fleet server and start
  // the periodic heartbeat. Best-effort — failure never breaks the extension.
  enroll();
  applyStoredRules();
  try { chrome.alarms.create(MGMT.heartbeatAlarm, { periodInMinutes: MGMT.defaultHeartbeatMin }); } catch (_) { /* ignore */ }
});

/** Chrome only injects content scripts into pages loaded after install; cover the tabs already open. */
async function injectIntoOpenTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch (_) { return; }
  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue;
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['analyzer.js', 'content.js'] }).catch(() => {});
  }
}

chrome.contextMenus.onClicked.addListener((info) => {
  const url = info.linkUrl || (info.selectionText || '').trim();
  if (url) openCheck(url);
});

async function openCheck(url) {
  try { await chrome.storage.local.set({ pendingUrl: url }); } catch (_) { /* ignore */ }
  try {
    await chrome.action.openPopup();
  } catch (_) {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') + '?url=' + encodeURIComponent(url) });
  }
}

// ── Messages ──────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  switch (msg.type) {
    case 'REQUEST_ACCESS':
      reportAccessRequest(String(msg.url || ''))
        .then((ok) => sendResponse({ ok }))
        .catch(() => sendResponse({ ok: false }));
      return true;

    case 'REFRESH_CONFIG':
      // Interstitial "Retry": pull the latest config now (picks up an approval
      // without waiting for the next heartbeat), then rebuild rules.
      heartbeat()
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;

    case 'CHECK_URL':
      performCheck(String(msg.url || ''), msg.settings || {})
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      return true; // async response

    case 'OPEN_CHECK':
      if (typeof msg.url === 'string') openCheck(msg.url);
      sendResponse({ ok: true });
      return false;

    case 'PAGE_RISK_COUNT':
      setBadge(sender.tab && sender.tab.id, Number(msg.count) || 0);
      return false;

    default:
      return false;
  }
});

function setBadge(tabId, count) {
  if (typeof tabId !== 'number') return;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '', tabId }).catch(() => {});
  if (count > 0) chrome.action.setBadgeBackgroundColor({ color: '#ef4444', tabId }).catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') setBadge(tabId, 0);
});

// ── Cache (survives popup re-opens; cleared when the browser closes) ──────────

async function cacheGet(key) {
  const hit = memCache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;
  try {
    const stored = await chrome.storage.session.get(key);
    const v = stored[key];
    if (v && Date.now() - v.ts < CACHE_TTL_MS) return v.data;
  } catch (_) { /* storage.session unavailable */ }
  return null;
}

async function cacheSet(key, data) {
  const v = { ts: Date.now(), data };
  memCache.set(key, v);
  if (memCache.size > 200) memCache.delete(memCache.keys().next().value);
  try { await chrome.storage.session.set({ [key]: v }); } catch (_) { /* ignore */ }
}

// ── Network checks ────────────────────────────────────────────────────────────

async function performCheck(url, settings) {
  const allow = USC.parseAllowlist(settings.allowlist);
  const base = USC.analyzeUrl(url, { allow });
  const result = {
    url: base.url,
    finalUrl: base.url,
    riskScore: 0,
    issues: [],
    redirects: [],
    domainAge: null,
    registered: null,
    statusCode: null,
    contentType: null,
    title: null,
    sslValid: null,
    vt: null,
    gsb: null,
    checks: { rdap: 'skipped', virustotal: settings.vtKey ? 'pending' : 'no key', safeBrowsing: settings.gsbKey ? 'pending' : 'no key', liveFetch: settings.activeFetch ? 'pending' : 'off' },
    cached: false,
  };

  if (!/^https?:$/.test(new URL(base.url).protocol)) return result;

  const key = `cache:${settings.activeFetch ? 1 : 0}${settings.vtKey ? 1 : 0}${settings.gsbKey ? 1 : 0}:${base.url}`;
  const cached = await cacheGet(key);
  if (cached) return { ...cached, cached: true };

  try {
    result.siteAccess = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  } catch (_) {
    result.siteAccess = true;
  }

  const tasks = [];
  if (!USC.isIpLiteral(base.host) && !USC.isPrivateHost(base.host)) {
    result.checks.rdap = 'pending';
    tasks.push(['rdap', 'Domain age', checkDomainAge(base, result)]);
  }
  if (settings.vtKey) tasks.push(['virustotal', 'VirusTotal', checkVirusTotal(base.url, settings.vtKey, result)]);
  if (settings.gsbKey) tasks.push(['safeBrowsing', 'Safe Browsing', checkSafeBrowsing(base.url, settings.gsbKey, result)]);
  if (settings.activeFetch) tasks.push(['liveFetch', 'Live fetch', fetchAndAnalyze(base, allow, result)]);

  await Promise.all(tasks.map(([key, label, task]) => task.catch((err) => {
    const why = describeError(err, result.siteAccess);
    result.checks[key] = `failed — ${why}`;
    result.issues.push({ t: 'i', m: `${label} check could not run: ${why}` });
  })));

  result.riskScore = Math.min(100, Math.max(0, Math.round(result.riskScore)));
  await cacheSet(key, result);
  return result;
}

function withTimeout(ms) {
  return AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
}

function describeError(err, siteAccess) {
  const name = err && err.name;
  const msg = String((err && err.message) || err || '');
  if (name === 'TimeoutError' || name === 'AbortError') return 'timed out';
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return siteAccess === false
      ? 'blocked — site access for this extension is restricted (see the notice in the popup)'
      : 'network request blocked (firewall, VPN or DNS)';
  }
  return msg.slice(0, 100) || 'unknown error';
}

// Domain age via RDAP (free, no key, sends only the registrable domain) ---------

const RDAP_DIRECT = {
  com: 'https://rdap.verisign.com/com/v1/domain/',
  net: 'https://rdap.verisign.com/net/v1/domain/',
  org: 'https://rdap.publicinterestregistry.org/rdap/domain/',
};

async function checkDomainAge(base, result) {
  const domain = base.registrable;
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  const endpoints = [`https://rdap.org/domain/${encodeURIComponent(domain)}`];
  if (RDAP_DIRECT[tld]) endpoints.push(RDAP_DIRECT[tld] + encodeURIComponent(domain));

  let resp = null;
  let lastErr = null;
  for (const endpoint of endpoints) {
    try {
      const candidate = await fetch(endpoint, { signal: withTimeout(6000), credentials: 'omit', cache: 'no-store' });
      if (candidate.ok || candidate.status === 404) { resp = candidate; break; }
      lastErr = new Error(`HTTP ${candidate.status}`);
    } catch (err) {
      lastErr = err;
    }
  }
  if (!resp) throw lastErr || new Error('RDAP servers unreachable');

  if (resp.status === 404) {
    result.checks.rdap = 'no data';
    result.issues.push({ t: 'i', m: `No public registration record found for ${base.registrable}` });
    return;
  }
  if (!resp.ok) {
    result.checks.rdap = `error ${resp.status}`;
    return;
  }
  const data = await resp.json();
  const reg = (data.events || []).find((e) => e.eventAction === 'registration');
  result.checks.rdap = 'done';
  if (!reg || !reg.eventDate) return;

  const registered = new Date(reg.eventDate);
  if (Number.isNaN(registered.getTime())) return;
  const days = Math.floor((Date.now() - registered.getTime()) / 86400000);
  result.domainAge = days;
  result.registered = registered.toISOString().slice(0, 10);

  if (days < 45) {
    result.riskScore += 35;
    result.issues.push({ t: 'd', m: `Domain is only ${days} day${days === 1 ? '' : 's'} old — scam domains are registered weeks before the campaign` });
  } else if (days < 120) {
    result.riskScore += 20;
    result.issues.push({ t: 'w', m: `Domain is young (${days} days) — verify the sender another way` });
  } else if (days < 365) {
    result.riskScore += 5;
    result.issues.push({ t: 'w', m: `Domain ${USC.describeAge(days)}` });
  } else {
    result.issues.push({ t: 'ok', m: `Domain ${USC.describeAge(days)}` });
  }
}

// VirusTotal (lookup only — the URL is never submitted for scanning) ------------

async function checkVirusTotal(url, apiKey, result) {
  const id = btoa(unescape(encodeURIComponent(url))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const resp = await fetch(`https://www.virustotal.com/api/v3/urls/${id}`, {
    headers: { 'x-apikey': apiKey },
    signal: withTimeout(8000),
    credentials: 'omit',
    cache: 'no-store',
  });
  if (resp.status === 404) {
    result.checks.virustotal = 'unknown url';
    result.vt = { positives: 0, total: 0, known: false };
    result.issues.push({ t: 'i', m: 'VirusTotal has not seen this exact URL yet — no reputation available' });
    return;
  }
  if (resp.status === 401 || resp.status === 403) {
    result.checks.virustotal = 'bad key';
    result.issues.push({ t: 'i', m: 'VirusTotal rejected the API key (check Settings)' });
    return;
  }
  if (resp.status === 429) {
    result.checks.virustotal = 'rate limited';
    result.issues.push({ t: 'i', m: 'VirusTotal quota exceeded — try again in a minute' });
    return;
  }
  if (!resp.ok) { result.checks.virustotal = `error ${resp.status}`; return; }

  const data = await resp.json();
  const stats = (data.data && data.data.attributes && data.data.attributes.last_analysis_stats) || {};
  const positives = (stats.malicious || 0) + (stats.suspicious || 0);
  const total = Object.values(stats).reduce((a, b) => a + (Number(b) || 0), 0);
  result.vt = { positives, total, known: true };
  result.checks.virustotal = 'done';
  if (positives > 0) {
    result.riskScore += Math.min(positives * 15, 60);
    result.issues.push({ t: 'd', m: `VirusTotal: ${positives} of ${total} security vendors flag this URL` });
  } else if (total > 0) {
    result.issues.push({ t: 'ok', m: `VirusTotal: ${total} security vendors see no problem` });
  }
}

// Google Safe Browsing Lookup API ----------------------------------------------

async function checkSafeBrowsing(url, apiKey, result) {
  const resp = await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'omit',
    cache: 'no-store',
    signal: withTimeout(6000),
    body: JSON.stringify({
      client: { clientId: 'url-safety-checker', clientVersion: USC.VERSION },
      threatInfo: {
        threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
        platformTypes: ['ANY_PLATFORM'],
        threatEntryTypes: ['URL'],
        threatEntries: [{ url }],
      },
    }),
  });
  if (resp.status === 400 || resp.status === 403) {
    result.checks.safeBrowsing = 'bad key';
    result.issues.push({ t: 'i', m: 'Google Safe Browsing rejected the API key (check Settings)' });
    return;
  }
  if (!resp.ok) { result.checks.safeBrowsing = `error ${resp.status}`; return; }

  const data = await resp.json();
  result.checks.safeBrowsing = 'done';
  const matches = Array.isArray(data.matches) ? data.matches : [];
  result.gsb = { matches: matches.length };
  if (matches.length) {
    const types = [...new Set(matches.map((m) => String(m.threatType || '').replace(/_/g, ' ').toLowerCase()))].join(', ');
    result.riskScore += 70;
    result.issues.push({ t: 'd', m: `Google Safe Browsing lists this URL: ${types}` });
  } else {
    result.issues.push({ t: 'ok', m: 'Not on the Google Safe Browsing block list' });
  }
}

// Live fetch (opt-in): follow the link and look at what comes back -------------

async function fetchAndAnalyze(base, allow, result) {
  const url = base.url;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      credentials: 'omit',
      cache: 'no-store',
      signal: withTimeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      result.checks.liveFetch = 'timeout';
      result.issues.push({ t: 'w', m: `The site did not respond within ${FETCH_TIMEOUT_MS / 1000} seconds` });
    } else if (/ssl|certificate|cert/i.test(msg)) {
      result.checks.liveFetch = 'tls error';
      result.sslValid = false;
      result.riskScore += 25;
      result.issues.push({ t: 'd', m: 'TLS certificate problem when connecting' });
    } else {
      result.checks.liveFetch = 'unreachable';
      result.issues.push({ t: 'i', m: 'Could not connect (site offline, blocked, DNS or certificate problem)' });
    }
    return;
  }

  result.checks.liveFetch = 'done';
  result.statusCode = resp.status;
  result.finalUrl = resp.url || url;
  result.contentType = (resp.headers.get('content-type') || '').toLowerCase();
  result.sslValid = result.finalUrl.startsWith('https://');

  // Redirects ------------------------------------------------------------------
  if (result.finalUrl !== url) {
    result.redirects = [url, result.finalUrl];
    let finalHost = '';
    try { finalHost = new URL(result.finalUrl).hostname.toLowerCase(); } catch (_) { /* ignore */ }
    const finalReg = USC.registrableDomain(finalHost);
    if (finalReg && finalReg !== base.registrable) {
      result.riskScore += 15;
      result.issues.push({ t: 'w', m: `Redirects to a different site: ${finalHost}` });
    } else {
      result.issues.push({ t: 'i', m: `Redirects within the same site to ${finalHost}` });
    }
    if (url.startsWith('https://') && result.finalUrl.startsWith('http://')) {
      result.riskScore += 25;
      result.sslValid = false;
      result.issues.push({ t: 'd', m: 'Redirects from HTTPS down to plain HTTP' });
    }
    // Analyze the destination with the same rules and keep whatever is worse.
    const fin = USC.analyzeUrl(result.finalUrl, { allow });
    const seen = new Set(base.issues.map((i) => i.m));
    for (const issue of fin.issues) {
      if (issue.t !== 'ok' && issue.t !== 'i' && !seen.has(issue.m)) result.issues.push({ t: issue.t, m: `Destination: ${issue.m}` });
    }
    result.riskScore += Math.max(0, fin.riskScore - base.riskScore);
  } else {
    result.redirects = [url];
  }

  // Downloads --------------------------------------------------------------------
  const cd = resp.headers.get('content-disposition') || '';
  if (/attachment/i.test(cd)) {
    const fname = parseFilename(cd);
    const ext = (fname.toLowerCase().match(/\.[a-z0-9]{1,5}$/) || [''])[0];
    if (USC.DANGEROUS_EXT.has(ext)) {
      result.riskScore += 50;
      result.issues.push({ t: 'd', m: `Immediately downloads an executable file: ${fname}` });
    } else if (USC.ARCHIVE_EXT.has(ext) || USC.RISKY_ATTACHMENT_EXT.has(ext)) {
      result.riskScore += 25;
      result.issues.push({ t: 'w', m: `Immediately downloads a file that often carries malware: ${fname}` });
    } else {
      result.riskScore += 10;
      result.issues.push({ t: 'w', m: `Immediately downloads a file: ${fname}` });
    }
  }
  if (/application\/(octet-stream|x-msdownload|x-msdos-program|x-dosexec|vnd\.microsoft\.portable-executable|java-archive|x-msi)/.test(result.contentType)) {
    result.riskScore += 40;
    result.issues.push({ t: 'd', m: `Serves a program file (${result.contentType.split(';')[0]})` });
  }

  if (resp.status >= 400) result.issues.push({ t: 'i', m: `HTTP ${resp.status} — the page is missing or refused the request` });

  // HTML inspection ----------------------------------------------------------------
  if (result.contentType.includes('text/html') && resp.body) {
    const html = await readLimited(resp.body, HTML_READ_LIMIT);
    inspectHtml(html, result, allow);
  } else if (resp.body) {
    try { await resp.body.cancel(); } catch (_) { /* ignore */ }
  }
}

function parseFilename(cd) {
  const star = cd.match(/filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i);
  if (star) { try { return decodeURIComponent(star[2].trim()); } catch (_) { return star[2].trim(); } }
  const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].trim() : 'unknown';
}

async function readLimited(body, limit) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  let bytes = 0;
  try {
    while (bytes < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      bytes += value.byteLength;
    }
  } catch (_) { /* partial content is fine */ }
  try { await reader.cancel(); } catch (_) { /* ignore */ }
  return html;
}

function inspectHtml(html, result, allow) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  if (titleMatch) result.title = decodeEntities(titleMatch[1].replace(/\s+/g, ' ').trim()).slice(0, 120);

  let finalHost = '';
  try { finalHost = new URL(result.finalUrl).hostname.toLowerCase(); } catch (_) { /* ignore */ }
  const finalReg = USC.registrableDomain(finalHost);
  const finalTrusted = USC.isTrustedDomain(finalReg) || USC.matchesAllow(finalHost, allow) || USC.isGovHost(finalHost);

  if (/<meta[^>]+http-equiv\s*=\s*["']?refresh/i.test(html)) {
    result.riskScore += 10;
    result.issues.push({ t: 'w', m: 'Page forwards visitors automatically (meta refresh)' });
  }

  const asksPassword = /<input[^>]+type\s*=\s*["']?password/i.test(html);
  if (asksPassword && !finalTrusted) {
    const text = decodeEntities(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).slice(0, 60000);
    const mentioned = USC.BRANDS.find((b) => b.text.test(text) && !b.domains.includes(finalReg));
    if (mentioned) {
      result.riskScore += 45;
      result.issues.push({ t: 'd', m: `Login form mentions ${mentioned.name} but the page is hosted on ${finalReg}` });
    } else {
      result.riskScore += 20;
      result.issues.push({ t: 'w', m: `Asks for a password on ${finalReg}, a domain we do not recognize` });
    }
  }
}

function decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (m, k) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", nbsp: ' ' })[k]);
}
