// App shell: session check, navigation rail, hash router, background refresh.
import { h, icon, clear } from './dom.js';
import { api, post } from './api.js';
import { t, getLang, setLang } from './i18n.js';
import { toast, plate } from './ui.js';
import * as overview from './views/overview.js';
import * as companies from './views/companies.js';
import * as company from './views/company.js';
import * as policy from './views/policy.js';
import * as requests from './views/requests.js';
import * as updates from './views/updates.js';
import * as activity from './views/activity.js';
import * as settings from './views/settings.js';
import * as login from './views/login.js';

const NAV = [
  { path: 'overview', icon: 'overview', label: () => t('Overview') },
  { path: 'companies', icon: 'building', label: () => t('Companies'), badge: 'companies' },
  { path: 'policy', icon: 'policy', label: () => t('Global policy') },
  { path: 'requests', icon: 'inbox', label: () => t('Access requests'), badge: 'requests', alert: true },
  null,
  { path: 'updates', icon: 'upload', label: () => t('Updates') },
  { path: 'activity', icon: 'clock', label: () => t('Activity log') },
  { path: 'settings', icon: 'sliders', label: () => t('Settings') },
];

const VIEWS = { overview, companies, policy, requests, updates, activity, settings };

const root = document.getElementById('root');
const ctx = {
  me: null,
  badges: {},
  guard: null,
  navigate: (hash) => { location.hash = hash; },
  setGuard: (fn) => { ctx.guard = fn; },
  refreshBadges: () => refreshBadges(),
  rerender: () => { renderShell(); route(true); },
};

let current = null;     // { destroy?, refresh? }
let currentHash = '';
let main = null;
let navEl = null;

/* ── Theme ─────────────────────────────────────────────────────────────── */

export function themePref() {
  try { return localStorage.getItem('fleet.theme') || 'system'; } catch (_) { return 'system'; }
}
export function applyTheme(pref) {
  try { localStorage.setItem('fleet.theme', pref); } catch (_) { /* ignore */ }
  const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}
ctx.themePref = themePref;
// Theme is pure CSS: no re-render, so unsaved edits on the page are kept.
ctx.applyTheme = (p) => { applyTheme(p); paintThemeButton(); };
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (themePref() === 'system') applyTheme('system'); });

ctx.setLang = (l) => {
  if (ctx.me && ctx.guard && !ctx.guard()) return false;
  setLang(l);
  if (ctx.me) ctx.rerender();
  return true;
};

/* ── Shell ─────────────────────────────────────────────────────────────── */

function renderShell() {
  clear(root);
  navEl = h('nav', { class: 'nav', 'aria-label': t('Main') });
  for (const item of NAV) {
    if (!item) { navEl.append(h('div', { class: 'nav-sep', role: 'separator' })); continue; }
    navEl.append(h('a', { href: '#/' + item.path, dataset: { path: item.path } },
      icon(item.icon, 18), h('span', { class: 'lbl' }, item.label()),
      item.badge ? h('span', { class: 'nav-count hidden', dataset: { badge: item.badge, alert: item.alert ? '1' : '' } }) : null));
  }
  const rail = h('aside', { class: 'rail' },
    h('a', { class: 'brand', href: '#/overview' }, plate('off', { label: 'Fleet' }),
      h('div', null, h('small', null, 'URL Safety Checker'), h('small', null, t('Fleet control')))),
    navEl,
    h('div', { class: 'rail-foot' },
      h('div', { class: 'rail-user' },
        h('span', { class: 'avatar', 'aria-hidden': 'true' }, (ctx.me?.user || '?').slice(0, 1).toUpperCase()),
        h('div', { class: 'who' }, ctx.me?.user || '', h('small', null, t('Administrator')))),
      h('div', { class: 'rail-tools' },
        themeBtn = h('button', { type: 'button', onclick: () => ctx.applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark') }),
        h('button', { type: 'button', title: t('Change language'), 'aria-label': t('Change language'),
          onclick: () => ctx.setLang(getLang() === 'uz' ? 'en' : 'uz') }, icon('globe', 15), getLang() === 'uz' ? 'EN' : 'UZ'),
        h('button', { type: 'button', title: t('Sign out'), 'aria-label': t('Sign out'), onclick: signOut }, icon('logout', 15)))));
  main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  root.append(h('div', { class: 'shell' }, rail, main));
  paintThemeButton();
  paintBadges();
}

let themeBtn = null;
function paintThemeButton() {
  if (!themeBtn) return;
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const label = dark ? t('Switch to light theme') : t('Switch to dark theme');
  themeBtn.title = label;
  themeBtn.setAttribute('aria-label', label);
  themeBtn.replaceChildren(icon(dark ? 'sun' : 'moon', 15));
}

function paintBadges() {
  if (!navEl) return;
  navEl.querySelectorAll('[data-badge]').forEach((el) => {
    const n = ctx.badges[el.dataset.badge];
    const show = n != null && (el.dataset.alert ? n > 0 : true);
    el.classList.toggle('hidden', !show);
    el.classList.toggle('nav-count--alert', !!el.dataset.alert && n > 0);
    el.textContent = show ? String(n) : '';
  });
}

async function refreshBadges() {
  try {
    const o = await api('/api/overview');
    ctx.badges = { requests: o.requests.pending, companies: o.companies.length };
    ctx.overview = o;
    paintBadges();
  } catch (_) { /* handled globally */ }
}

async function signOut() {
  try { await post('/api/logout'); } catch (_) { /* ignore */ }
  ctx.me = null;
  showLogin();
}

/* ── Router ────────────────────────────────────────────────────────────── */

function parseHash() {
  const parts = (location.hash || '#/overview').replace(/^#\/?/, '').split('/').filter(Boolean);
  return { name: parts[0] || 'overview', params: parts.slice(1) };
}

let skipNext = false;
let navToken = 0;
async function route(force) {
  if (!ctx.me) return;
  if (skipNext) { skipNext = false; return; }
  if (!force && ctx.guard && location.hash !== currentHash && !ctx.guard()) {
    skipNext = true;
    location.hash = currentHash;
    return;
  }
  ctx.guard = null;
  window.onbeforeunload = null;
  currentHash = location.hash || '#/overview';
  const { name, params } = parseHash();
  let view = VIEWS[name];
  if (name === 'companies' && params[0]) view = company;
  if (!view) { location.hash = '#/overview'; return; }
  navEl.querySelectorAll('a').forEach((a) => {
    if (a.dataset.path === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  if (current && current.destroy) current.destroy();
  current = null;
  const token = ++navToken;
  clear(main);
  const page = h('div', { class: 'page' });
  main.append(page);
  main.scrollTop = 0;
  window.scrollTo(0, 0);
  try {
    const result = (await view.render(page, params, ctx)) || {};
    if (token !== navToken) {
      // The user moved on while this page was loading: discard it.
      if (result.destroy) result.destroy();
      return;
    }
    current = result;
  } catch (e) {
    if (token !== navToken) return;
    console.error(e);
    page.append(h('div', { class: 'note note--warn' }, icon('alert', 18), t('This page could not be loaded. Reload and try again.')));
  }
}
window.addEventListener('hashchange', () => route(false));

/* ── Boot ──────────────────────────────────────────────────────────────── */

function showLogin() {
  if (current && current.destroy) current.destroy();
  current = null;
  navEl = null;
  clear(root);
  login.render(root, ctx, async () => { await start(); });
}

async function start() {
  try {
    ctx.me = await api('/api/me');
  } catch (_) {
    showLogin();
    return;
  }
  renderShell();
  await route(true);
  refreshBadges();
}

window.addEventListener('fleet:unauthorized', () => {
  if (!ctx.me) return;
  ctx.me = null;
  toast(t('Your session ended. Sign in again.'), 'info');
  showLogin();
});

setInterval(() => {
  if (!ctx.me || document.visibilityState !== 'visible') return;
  refreshBadges();
  if (current && current.refresh) current.refresh();
}, 20000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ctx.me && current && current.refresh) current.refresh();
});

start();
