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

document.getElementById('request').addEventListener('click', () => {
  status.className = 'warn';
  status.textContent = 'Sending request…';
  if (!api) { status.textContent = 'Cannot reach the extension.'; return; }
  api.sendMessage({ type: 'REQUEST_ACCESS', url: shown }, () => {
    status.className = 'ok';
    status.textContent = '✓ Request sent. Your IT team will review this site. Leave this tab or try again later.';
  });
});

document.getElementById('retry').addEventListener('click', () => {
  status.className = 'warn';
  status.textContent = 'Checking the latest policy…';
  const go = () => { if (raw) location.replace(shown); else history.back(); };
  if (api) api.sendMessage({ type: 'REFRESH_CONFIG' }, () => setTimeout(go, 600)); else go();
});

document.getElementById('back').addEventListener('click', () => history.back());
