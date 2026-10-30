'use strict';

/* Popup: paste-and-check, page scan, history, settings. All strings that come
 * from URLs or pages are inserted with textContent — never as HTML. */

const USC = globalThis.USC;
const $ = (id) => document.getElementById(id);
const ORDER = { d: 0, w: 1, i: 2, ok: 3 };
const HISTORY_LIMIT = 50;

let settings = { ...USC.DEFAULT_SETTINGS };
let allow = new Set();
let history = [];

const els = {
  input: $('url-input'),
  checkBtn: $('check-btn'),
  btnText: $('btn-text'),
  spinner: $('spinner'),
  result: $('result'),
  verdictBox: $('verdict-box'),
  verdictIcon: $('verdict-icon'),
  verdictLabel: $('verdict-label'),
  verdictUrl: $('verdict-url'),
  riskBadge: $('risk-badge'),
  riskBar: $('risk-bar'),
  barScore: $('bar-score'),
  issues: $('issues-list'),
  redirectSection: $('redirect-section'),
  redirectChain: $('redirect-chain'),
  details: $('details-grid'),
  checksLine: $('checks-line'),
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function checkSiteAccess() {
  try {
    const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    $('access-warning').classList.toggle('hidden', granted);
  } catch (_) { /* API unavailable: stay quiet */ }
}

document.addEventListener('DOMContentLoaded', async () => {
  const ub = $('ub-ver'); if (ub) ub.textContent = 'v' + USC.VERSION;
  checkSiteAccess();
  await loadSettings();
  await loadHistory();
  setupTabs();
  setupListeners();

  let start = null;
  try {
    const stored = await chrome.storage.local.get('pendingUrl');
    if (stored.pendingUrl) {
      start = stored.pendingUrl;
      await chrome.storage.local.remove('pendingUrl');
    }
  } catch (_) { /* ignore */ }
  if (!start) start = new URLSearchParams(location.search).get('url');

  if (start) {
    els.input.value = start;
    await checkUrl();
  } else {
    els.input.focus();
  }
});

function setupTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => showTab(tab.dataset.tab));
  });
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-content').forEach((c) => c.classList.toggle('hidden', c.id !== 'tab-' + name));
  if (name === 'history') renderHistory();
  if (name === 'check') els.input.focus();
}

function setupListeners() {
  $('paste-btn').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) { els.input.value = text.trim(); checkUrl(); return; }
    } catch (_) { /* clipboard permission denied */ }
    els.input.focus();
  });
  els.checkBtn.addEventListener('click', checkUrl);
  els.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') checkUrl(); });

  $('scan-page-btn').addEventListener('click', scanPage);
  $('page-links-list').addEventListener('click', (e) => {
    const item = e.target.closest('[data-url]');
    if (item) openInCheck(item.dataset.url);
  });
  $('save-settings').addEventListener('click', saveSettings);
}

function openInCheck(url) {
  els.input.value = url;
  showTab('check');
  checkUrl();
}

// ── Check ─────────────────────────────────────────────────────────────────────

async function checkUrl() {
  const raw = els.input.value.trim();
  if (!raw) { els.input.focus(); return; }

  const stat = USC.analyzeUrl(raw, { allow });
  els.input.value = stat.url;
  setLoading(true);
  els.result.classList.remove('hidden');
  render(stat, null);

  let net = null;
  if (/^https?:/.test(stat.url) && !stat.tags.includes('non-web')) {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'CHECK_URL', url: stat.url, settings });
      if (resp && resp.ok) net = resp.data;
      else net = { riskScore: 0, issues: [{ t: 'i', m: 'Network checks failed: ' + ((resp && resp.error) || 'unknown error') }] };
    } catch (_) {
      net = { riskScore: 0, issues: [{ t: 'i', m: 'Background checks unavailable — showing address analysis only' }] };
    }
  }

  const merged = merge(stat, net);
  render(merged, net);
  addToHistory(merged);
  setLoading(false);
}

function merge(stat, net) {
  const m = { ...stat, issues: [...stat.issues] };
  if (!net) return m;
  const seen = new Set(m.issues.map((i) => i.m));
  for (const issue of net.issues || []) {
    if (!seen.has(issue.m)) { m.issues.push(issue); seen.add(issue.m); }
  }
  m.riskScore = Math.min(100, stat.riskScore + (net.riskScore || 0));
  m.verdict = USC.verdictFor(m.riskScore);
  m.finalUrl = net.finalUrl || stat.url;
  m.redirects = net.redirects || [];
  m.domainAge = net.domainAge;
  m.registered = net.registered;
  m.statusCode = net.statusCode;
  m.title = net.title;
  m.vt = net.vt;
  m.gsb = net.gsb;
  m.checks = net.checks;
  m.cached = net.cached;
  return m;
}

function setLoading(on) {
  els.checkBtn.disabled = on;
  els.btnText.textContent = on ? 'Checking…' : 'Check link';
  els.spinner.classList.toggle('hidden', !on);
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch (_) { return url; }
}

// ── Render ────────────────────────────────────────────────────────────────────

function render(r, net) {
  const cfg = USC.VERDICTS[r.verdict] || USC.VERDICTS.UNKNOWN;

  els.verdictBox.className = 'verdict-box ' + (r.verdict || 'UNKNOWN');
  els.verdictIcon.textContent = cfg.icon;
  els.verdictLabel.textContent = cfg.label;
  const finalHost = r.finalUrl && r.finalUrl !== r.url ? hostOf(r.finalUrl) : null;
  els.verdictUrl.textContent = finalHost && finalHost !== r.host ? `${r.host || hostOf(r.url)} → ${finalHost}` : (r.host || hostOf(r.url));
  els.verdictUrl.title = r.finalUrl || r.url;

  const score = r.riskScore || 0;
  els.riskBadge.textContent = String(score);
  els.riskBadge.style.color = cfg.color;
  els.barScore.textContent = `${score} / 100`;
  els.riskBar.style.width = score + '%';
  els.riskBar.style.background = cfg.color;

  // Findings, most severe first
  els.issues.replaceChildren();
  const issues = [...(r.issues || [])].sort((a, b) => (ORDER[a.t] ?? 1) - (ORDER[b.t] ?? 1));
  if (!issues.length) {
    els.issues.appendChild(el('li', 'ok', 'No warning signs found in the address'));
  } else {
    for (const issue of issues) {
      const cls = issue.t === 'd' ? 'danger' : issue.t === 'w' ? 'warning' : issue.t === 'ok' ? 'ok' : 'info';
      els.issues.appendChild(el('li', cls, issue.m));
    }
  }

  // Redirects
  const chain = r.redirects && r.redirects.length > 1 ? r.redirects : r.redirectTarget ? [r.url, r.redirectTarget] : [];
  els.redirectSection.classList.toggle('hidden', chain.length < 2);
  els.redirectChain.replaceChildren();
  chain.forEach((u, i) => {
    if (i > 0) els.redirectChain.appendChild(el('div', 'redirect-arrow', '↓'));
    els.redirectChain.appendChild(el('div', 'redirect-item', u));
  });

  // Details
  els.details.replaceChildren();
  const detail = (key, value, color, wide) => {
    const box = el('div', 'detail-item' + (wide ? ' wide' : ''));
    box.appendChild(el('div', 'detail-key', key));
    const val = el('div', 'detail-val', value);
    if (color) val.style.color = color;
    box.appendChild(val);
    els.details.appendChild(box);
  };

  if (!r.tags.includes('non-web')) {
    detail('Encryption', r.https ? 'HTTPS' : 'Plain HTTP', r.https ? USC.VERDICTS.SAFE.color : USC.VERDICTS.DANGEROUS.color);
    detail('Domain', r.registrable || r.host || '—', r.trusted ? USC.VERDICTS.SAFE.color : null);
  }
  if (r.domainAge != null) {
    const ageColor = r.domainAge < 30 ? USC.VERDICTS.DANGEROUS.color : r.domainAge < 90 ? USC.VERDICTS.CAUTION.color : USC.VERDICTS.SAFE.color;
    detail('Domain age', `${USC.describeAge(r.domainAge)}${r.registered ? ` (${r.registered})` : ''}`, ageColor);
  }
  if (r.statusCode) detail('HTTP status', String(r.statusCode), r.statusCode >= 400 ? USC.VERDICTS.SUSPICIOUS.color : USC.VERDICTS.SAFE.color);
  if (r.brand) detail('Imitates', r.brand, USC.VERDICTS.DANGEROUS.color);
  if (r.platform) detail('Hosting platform', r.platform, USC.VERDICTS.CAUTION.color);
  if (r.vt && r.vt.known) detail('VirusTotal', `${r.vt.positives} of ${r.vt.total} vendors flag it`, r.vt.positives ? USC.VERDICTS.DANGEROUS.color : USC.VERDICTS.SAFE.color);
  if (r.gsb) detail('Safe Browsing', r.gsb.matches ? 'Listed as unsafe' : 'Not listed', r.gsb.matches ? USC.VERDICTS.DANGEROUS.color : USC.VERDICTS.SAFE.color);
  if (r.title) detail('Page title', r.title, null, true);

  // Which checks ran
  els.checksLine.replaceChildren();
  if (net && net.checks) {
    const c = net.checks;
    const parts = [
      ['address rules', 'done'],
      ['domain age', c.rdap],
      ['VirusTotal', c.virustotal],
      ['Safe Browsing', c.safeBrowsing],
      ['live fetch', c.liveFetch],
    ];
    els.checksLine.appendChild(el('span', null, 'Checks: '));
    parts.forEach(([name, state], i) => {
      if (i) els.checksLine.appendChild(el('span', null, ' · '));
      els.checksLine.appendChild(el('b', null, name));
      els.checksLine.appendChild(el('span', null, ` ${state}`));
    });
    if (net.cached) els.checksLine.appendChild(el('span', null, ' · cached result'));
  } else if (!r.tags.includes('non-web')) {
    els.checksLine.textContent = net === null ? 'Address rules only (network checks running…)' : '';
  }
}

// ── Page scan ─────────────────────────────────────────────────────────────────

async function scanPage() {
  const btn = $('scan-page-btn');
  const statsEl = $('page-stats');
  const listEl = $('page-links-list');
  btn.disabled = true;
  btn.textContent = 'Scanning…';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null) throw new Error('no active tab');

    let resp;
    try {
      resp = await chrome.tabs.sendMessage(tab.id, { type: 'SCAN_LINKS' });
    } catch (_) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['analyzer.js', 'content.js'] });
      resp = await chrome.tabs.sendMessage(tab.id, { type: 'SCAN_LINKS' });
    }
    const links = (resp && resp.links) || [];
    showPageStats(links.map((u) => USC.analyzeUrl(u, { allow })));
  } catch (_) {
    listEl.replaceChildren(el('div', 'empty-state', 'This page cannot be scanned. Browser pages, the Chrome Web Store and PDF viewers are off-limits to extensions.'));
    statsEl.classList.remove('hidden');
  }

  btn.disabled = false;
  btn.textContent = 'Scan again';
}

function showPageStats(results) {
  const counts = { SAFE: 0, CAUTION: 0, SUSPICIOUS: 0, DANGEROUS: 0 };
  results.forEach((r) => { if (r.verdict in counts) counts[r.verdict]++; });
  $('cnt-safe').textContent = counts.SAFE;
  $('cnt-caution').textContent = counts.CAUTION;
  $('cnt-suspicious').textContent = counts.SUSPICIOUS;
  $('cnt-dangerous').textContent = counts.DANGEROUS;

  const listEl = $('page-links-list');
  listEl.replaceChildren();
  const flagged = results
    .filter((r) => r.verdict !== 'SAFE')
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 60);

  if (!results.length) {
    listEl.appendChild(el('div', 'empty-state', 'No web links found on this page.'));
  } else if (!flagged.length) {
    listEl.appendChild(el('div', 'empty-state', `All ${results.length} links look fine by the address rules.`));
  } else {
    for (const r of flagged) {
      const item = el('div', 'link-item');
      item.dataset.url = r.url;
      item.title = 'Open in the Check tab';
      item.appendChild(el('div', 'link-verdict ' + r.verdict, `${USC.VERDICTS[r.verdict].label} · ${r.riskScore}`));
      item.appendChild(el('div', 'link-url', r.url));
      const why = r.issues.find((i) => i.t === 'd') || r.issues.find((i) => i.t === 'w');
      if (why) item.appendChild(el('div', 'link-why', why.m));
      listEl.appendChild(item);
    }
  }
  $('page-stats').classList.remove('hidden');
}

// ── History ───────────────────────────────────────────────────────────────────

async function loadHistory() {
  try {
    const d = await chrome.storage.local.get('history');
    history = Array.isArray(d.history) ? d.history : [];
  } catch (_) { history = []; }
}

function addToHistory(r) {
  history = history.filter((h) => h.url !== r.url);
  history.unshift({ url: r.url, verdict: r.verdict, score: r.riskScore, ts: Date.now() });
  if (history.length > HISTORY_LIMIT) history = history.slice(0, HISTORY_LIMIT);
  chrome.storage.local.set({ history }).catch(() => {});
}

function renderHistory() {
  const listEl = $('history-list');
  listEl.replaceChildren();
  if (!history.length) {
    listEl.appendChild(el('div', 'empty-state', 'Nothing checked yet'));
    return;
  }
  for (const item of history) {
    const cfg = USC.VERDICTS[item.verdict] || USC.VERDICTS.UNKNOWN;
    const row = el('div', 'history-item');
    row.dataset.url = item.url;
    row.title = item.url;
    row.appendChild(el('span', 'h-badge ' + item.verdict, cfg.label));
    row.appendChild(el('span', 'h-url', hostOf(item.url)));
    row.appendChild(el('span', 'h-time', new Date(item.ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })));
    const score = el('span', 'h-score', String(item.score));
    score.style.color = cfg.color;
    row.appendChild(score);
    listEl.appendChild(row);
  }
}

async function clearHistory() {
  history = [];
  try { await chrome.storage.local.set({ history: [] }); } catch (_) { /* ignore */ }
  renderHistory();
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function loadSettings() {
  try {
    const d = await chrome.storage.local.get('settings');
    settings = { ...USC.DEFAULT_SETTINGS, ...(d.settings || {}) };
  } catch (_) {
    settings = { ...USC.DEFAULT_SETTINGS };
  }
  allow = USC.parseAllowlist(settings.allowlist);
  $('hover-preview').checked = settings.hoverPreview !== false;
  $('mark-links').checked = settings.markLinks !== false;
  $('active-fetch').checked = settings.activeFetch === true;
  $('vt-key').value = settings.vtKey || '';
  showManagedNotice();
}

// Disclosure: when this device is enrolled with an organization fleet server,
// show it plainly in Settings (server, device id, last check-in).
async function showManagedNotice() {
  try {
    const d = await chrome.storage.local.get(['managedServer', 'deviceId', 'managedLastSeen']);
    if (!d.managedServer) return;
    $('managed-server').textContent = d.managedServer;
    $('managed-notice').classList.remove('hidden');
  } catch (_) { /* ignore */ }
}

async function saveSettings() {
  settings = {
    ...settings,
    hoverPreview: $('hover-preview').checked,
    markLinks: $('mark-links').checked,
    activeFetch: $('active-fetch').checked,
    vtKey: $('vt-key').value.trim(),
  };
  allow = USC.parseAllowlist(settings.allowlist);
  try { await chrome.storage.local.set({ settings }); } catch (_) { /* ignore */ }
  const msg = $('settings-saved');
  msg.classList.remove('hidden');
  setTimeout(() => msg.classList.add('hidden'), 2000);
}
