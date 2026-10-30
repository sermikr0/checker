'use strict';

/**
 * Content script: hover preview, risky-link marking, and the link list used
 * by the popup's "Scan this page". Runs in every http(s) page, so it is
 * wrapped in an IIFE and guarded against being injected twice.
 */
(() => {
  if (globalThis.__uscContentLoaded) return;
  globalThis.__uscContentLoaded = true;

  const USC = globalThis.USC;
  if (!USC || !chrome.runtime || !chrome.runtime.id) return;

  const MARK_ATTR = 'data-usc-mark';
  const MAX_LINKS = 1500;
  const OUTLINE = { CAUTION: '#f59e0b55', SUSPICIOUS: '#f97316aa', DANGEROUS: '#ef4444cc' };
  const DOT = { SUSPICIOUS: '#f97316', DANGEROUS: '#ef4444' };

  let settings = { ...USC.DEFAULT_SETTINGS };
  let allow = new Set();
  const cache = new Map();

  function analyze(href) {
    let r = cache.get(href);
    if (!r) {
      r = USC.analyzeUrl(href, { allow });
      if (cache.size > 3000) cache.clear();
      cache.set(href, r);
    }
    return r;
  }

  async function loadSettings() {
    try {
      const d = await chrome.storage.local.get('settings');
      settings = { ...USC.DEFAULT_SETTINGS, ...(d.settings || {}) };
    } catch (_) {
      settings = { ...USC.DEFAULT_SETTINGS };
    }
    allow = USC.parseAllowlist(settings.allowlist);
    cache.clear();
  }

  // ── Hover preview ─────────────────────────────────────────────────────────

  let tip = null;
  let tipParts = null;
  let hideTimer = null;
  let currentLink = null;

  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.id = 'usc-hover-preview';
    tip.setAttribute('role', 'tooltip');
    tip.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'pointer-events:none', 'display:none',
      'width:300px', 'max-width:calc(100vw - 24px)', 'box-sizing:border-box',
      'background:#1c2226', 'color:#e5e7eb', 'border:1px solid #2b3338', 'border-radius:10px',
      'box-shadow:0 10px 30px rgba(0,0,0,.55)', 'font:12px/1.4 "Segoe UI",system-ui,sans-serif',
      'text-align:left', 'opacity:0', 'transition:opacity .12s ease',
    ].join(';');

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px 8px;border-bottom:1px solid #262e33';
    const icon = document.createElement('span');
    icon.style.cssText = 'font-size:18px;line-height:1';
    const meta = document.createElement('div');
    meta.style.cssText = 'flex:1;min-width:0';
    const label = document.createElement('div');
    label.style.cssText = 'font-weight:800;font-size:13px;letter-spacing:.4px';
    const host = document.createElement('div');
    host.style.cssText = 'font-size:11px;color:#98a5a0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    const score = document.createElement('div');
    score.style.cssText = 'font-size:17px;font-weight:900';
    meta.append(label, host);
    head.append(icon, meta, score);

    const barWrap = document.createElement('div');
    barWrap.style.cssText = 'margin:0 12px 8px;height:4px;border-radius:3px;background:#262e33;overflow:hidden';
    const bar = document.createElement('div');
    bar.style.cssText = 'height:100%;border-radius:3px;width:0';
    barWrap.appendChild(bar);

    const list = document.createElement('div');
    list.style.cssText = 'padding:6px 12px 8px;max-height:132px;overflow:hidden';

    const foot = document.createElement('div');
    foot.style.cssText = 'padding:5px 12px 7px;font-size:10px;color:#6f7a80;border-top:1px solid #262e33';
    foot.textContent = 'URL Safety Checker · static preview';

    tip.append(head, barWrap, list, foot);
    tipParts = { icon, label, host, score, bar, list };
    (document.body || document.documentElement).appendChild(tip);
    return tip;
  }

  function showTip(link, event) {
    const href = link.href;
    if (!/^https?:/i.test(href)) return;
    const r = analyze(href);
    const cfg = USC.VERDICTS[r.verdict] || USC.VERDICTS.UNKNOWN;
    ensureTip();

    tipParts.icon.textContent = cfg.icon;
    tipParts.label.textContent = cfg.label.toUpperCase();
    tipParts.label.style.color = cfg.color;
    tipParts.host.textContent = r.host || href;
    tipParts.score.textContent = String(r.riskScore);
    tipParts.score.style.color = cfg.color;
    tipParts.bar.style.width = r.riskScore + '%';
    tipParts.bar.style.background = cfg.color;

    tipParts.list.replaceChildren();
    const issues = r.issues.filter((i) => i.t !== 'i');
    if (!issues.length) {
      const row = document.createElement('div');
      row.style.cssText = 'font-size:11px;color:#22c55e';
      row.textContent = 'No warning signs in the address';
      tipParts.list.appendChild(row);
    } else {
      issues.slice(0, 5).forEach((issue) => {
        const row = document.createElement('div');
        row.style.cssText = 'padding:3px 0;border-bottom:1px solid #262e33;font-size:11px;color:' + (issue.t === 'd' ? '#fca5a5' : issue.t === 'ok' ? '#86efac' : '#d5dcd8');
        row.textContent = (issue.t === 'd' ? '• ' : issue.t === 'ok' ? '✓ ' : '• ') + issue.m;
        tipParts.list.appendChild(row);
      });
      if (issues.length > 5) {
        const more = document.createElement('div');
        more.style.cssText = 'padding-top:4px;font-size:11px;color:#98a5a0';
        more.textContent = `+${issues.length - 5} more — right-click the link › Check link safety`;
        tipParts.list.appendChild(more);
      }
    }

    tip.style.display = 'block';
    positionTip(event);
    tip.style.opacity = '1';
  }

  function positionTip(event) {
    if (!tip || tip.style.display === 'none') return;
    const gap = 14;
    const w = tip.offsetWidth || 300;
    const h = tip.offsetHeight || 200;
    let x = event.clientX + gap;
    let y = event.clientY + gap;
    if (x + w > window.innerWidth - 8) x = event.clientX - w - gap;
    if (y + h > window.innerHeight - 8) y = event.clientY - h - gap;
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top = Math.max(8, y) + 'px';
  }

  function hideTip() {
    currentLink = null;
    if (!tip) return;
    tip.style.opacity = '0';
    tip.style.display = 'none';
  }

  function linkFrom(target) {
    return target && typeof target.closest === 'function' ? target.closest('a[href]') : null;
  }

  document.addEventListener('mouseover', (e) => {
    if (!settings.hoverPreview) return;
    const link = linkFrom(e.target);
    if (!link || link === currentLink) return;
    clearTimeout(hideTimer);
    currentLink = link;
    showTip(link, e);
  }, true);

  document.addEventListener('mousemove', (e) => {
    if (currentLink && tip && tip.style.display !== 'none') positionTip(e);
  }, true);

  document.addEventListener('mouseout', (e) => {
    const link = linkFrom(e.target);
    if (!link || link !== currentLink) return;
    if (e.relatedTarget && link.contains(e.relatedTarget)) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideTip, 120);
  }, true);

  window.addEventListener('blur', hideTip);
  document.addEventListener('scroll', hideTip, true);

  // ── Risky-link marking ────────────────────────────────────────────────────

  function markLinks(rescan) {
    if (!settings.markLinks) return 0;
    const selector = rescan ? 'a[href]' : `a[href]:not([${MARK_ATTR}])`;
    const links = document.querySelectorAll(selector);
    let n = 0;
    for (const link of links) {
      if (++n > MAX_LINKS) break;
      if (link.closest('#usc-hover-preview')) continue;
      const href = link.href;
      if (!/^https?:/i.test(href)) { link.setAttribute(MARK_ATTR, 'skip'); continue; }
      const r = analyze(href);
      link.setAttribute(MARK_ATTR, r.verdict);
      if (r.verdict === 'SAFE') { clearMark(link); continue; }
      applyMark(link, r);
    }
    const risky = document.querySelectorAll(`a[${MARK_ATTR}="DANGEROUS"], a[${MARK_ATTR}="SUSPICIOUS"]`).length;
    chrome.runtime.sendMessage({ type: 'PAGE_RISK_COUNT', count: risky }).catch(() => {});
    return risky;
  }

  function applyMark(link, r) {
    link.style.outline = `1px solid ${OUTLINE[r.verdict] || 'transparent'}`;
    link.style.outlineOffset = '1px';
    link.style.borderRadius = link.style.borderRadius || '2px';

    const next = link.nextElementSibling;
    const hasDot = next && next.classList && next.classList.contains('usc-dot');
    if (r.verdict === 'DANGEROUS' || r.verdict === 'SUSPICIOUS') {
      const dot = hasDot ? next : document.createElement('span');
      dot.className = 'usc-dot';
      dot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;margin-left:4px;vertical-align:middle;cursor:pointer;background:${DOT[r.verdict]};box-shadow:0 0 0 2px ${DOT[r.verdict]}33`;
      dot.title = `URL Safety Checker: ${USC.VERDICTS[r.verdict].label} (${r.riskScore}/100) — click for details\n${r.url}`;
      dot.dataset.uscUrl = r.url;
      if (!hasDot) link.insertAdjacentElement('afterend', dot);
    } else if (hasDot) {
      next.remove();
    }
  }

  function clearMark(link) {
    link.style.outline = '';
    link.style.outlineOffset = '';
    const next = link.nextElementSibling;
    if (next && next.classList && next.classList.contains('usc-dot')) next.remove();
  }

  function unmarkAll() {
    document.querySelectorAll(`a[${MARK_ATTR}]`).forEach((link) => {
      clearMark(link);
      link.removeAttribute(MARK_ATTR);
    });
    chrome.runtime.sendMessage({ type: 'PAGE_RISK_COUNT', count: 0 }).catch(() => {});
  }

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.dataset && t.dataset.uscUrl) {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'OPEN_CHECK', url: t.dataset.uscUrl }).catch(() => {});
    }
  }, true);

  // ── Messages from the popup ───────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return false;
    if (msg.type === 'SCAN_LINKS') {
      const links = [...new Set(
        Array.from(document.querySelectorAll('a[href]'))
          .map((a) => a.href)
          .filter((h) => /^https?:/i.test(h)),
      )].slice(0, 400);
      sendResponse({ links, page: { url: location.href, title: document.title } });
      return false;
    }
    if (msg.type === 'MARK_LINKS') {
      sendResponse({ ok: true, count: markLinks(true) });
      return false;
    }
    return false;
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  let mutationTimer = null;
  const observer = new MutationObserver(() => {
    if (!settings.markLinks) return;
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => markLinks(false), 1200);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    loadSettings().then(() => {
      if (settings.markLinks) markLinks(true); else unmarkAll();
      if (!settings.hoverPreview) hideTip();
    });
  });

  loadSettings().then(() => {
    if (settings.markLinks) markLinks(false);
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  });
})();
