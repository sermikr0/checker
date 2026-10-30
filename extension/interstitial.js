'use strict';

/* Runs on the block page. Kept as an external file because the extension's
 * default CSP (script-src 'self') blocks inline <script>. */

const raw = location.hash ? location.hash.slice(1) : '';
let shown = raw, domain = '';
try { shown = decodeURIComponent(raw); } catch (_) { shown = raw; }
try { domain = new URL(shown).hostname; } catch (_) { domain = shown; }

document.getElementById('domain').textContent = domain || 'unknown site';
document.getElementById('fullurl').textContent = shown && shown !== domain ? shown : '';

const status = document.getElementById('status');
const api = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) ? chrome.runtime : null;
const say = (cls, text) => { status.className = cls; status.textContent = text; };

// Explain which rule blocked the page, using what the fleet server last sent.
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
  chrome.storage.local.get(['settings', 'managedCompany']).then((d) => {
    const mode = (d.settings && d.settings.enforceMode) || 'off';
    const company = d.managedCompany || '';
    const reason = document.getElementById('sign-reason');
    const lead = document.getElementById('lead');
    if (mode === 'blacklist') {
      reason.textContent = 'on your company’s blocked list';
      lead.textContent = 'Your IT team has blocked this site for everyone in your office. If you need it for work, ask for access below.';
    }
    const policy = document.getElementById('policy');
    const label = { whitelist: 'only approved sites are allowed', blacklist: 'listed sites are blocked' }[mode];
    if (label) {
      policy.textContent = '';
      const b = document.createElement('b');
      b.textContent = company || 'Your organization';
      policy.append(b, ': ' + label + '.');
    }
  }).catch(() => {});
}

document.getElementById('request').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  if (!api) { say('err', 'The extension could not be reached. Reload the page and try again.'); return; }
  btn.disabled = true;
  say('warn', 'Sending your request…');
  api.sendMessage({ type: 'REQUEST_ACCESS', url: shown }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      btn.disabled = false;
      say('err', 'The request could not be sent. Check your connection and try again.');
      return;
    }
    btn.textContent = 'Request sent';
    say('ok', 'Request sent. IT will review it. Press “Try again” later to see if the site is allowed.');
  });
});

document.getElementById('retry').addEventListener('click', () => {
  say('warn', 'Checking the latest policy…');
  const go = () => { if (raw) location.replace(shown); else history.back(); };
  if (api) api.sendMessage({ type: 'REFRESH_CONFIG' }, () => setTimeout(go, 600)); else go();
});

document.getElementById('back').addEventListener('click', () => history.back());
