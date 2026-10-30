import { h, replace, store } from '../dom.js';
import { api } from '../api.js';
import { t } from '../i18n.js';
import { empty, searchBox, chips } from '../ui.js';
import { eventItem, eventSentence, loading, failed } from './common.js';

const GROUPS = {
  all: () => true,
  policy: (e) => e.action.startsWith('policy.') || e.action === 'company.policy',
  requests: (e) => e.action.startsWith('request.'),
  companies: (e) => e.action.startsWith('company.') && e.action !== 'company.policy',
  devices: (e) => e.action.startsWith('device.'),
  security: (e) => e.action.startsWith('login') || e.action === 'password.changed' || e.action === 'sessions.revoked',
  releases: (e) => e.action.startsWith('release.'),
};

export async function render(page, params, ctx) {
  document.title = t('Activity log') + ' — Fleet';
  const state = Object.assign({ group: 'all', q: '' }, store('activity') || {});
  let events = [];
  page.append(h('header', { class: 'page-head' },
    h('div', { class: 'titles' }, h('h1', { class: 'page-title' }, t('Activity log')),
      h('p', { class: 'page-sub' }, t('Who changed what, and from where. The last 5,000 events are kept.')))));
  const toolbar = h('div', { class: 'toolbar' });
  const host = h('div');
  page.append(toolbar, host);
  host.append(loading());

  function paint() {
    const q = state.q.trim().toLowerCase();
    const rows = events.filter(GROUPS[state.group] || GROUPS.all).filter((e) => !q || [eventSentence(e), e.target, e.ip, e.detail].some((v) => String(v || '').toLowerCase().includes(q)));
    replace(host, h('section', { class: 'panel' }, h('div', { class: 'panel-body', style: { paddingTop: '6px', paddingBottom: '6px' } },
      rows.length ? h('ul', { class: 'feed' }, rows.map(eventItem)) : empty('clock', t('Nothing here yet'), null))));
  }

  replace(toolbar,
    searchBox(state.q, (q) => { state.q = q; store('activity', state); paint(); }, t('Search the log…')),
    chips([
      { value: 'all', label: t('Everything') },
      { value: 'policy', label: t('Policy') },
      { value: 'requests', label: t('Requests') },
      { value: 'companies', label: t('Companies') },
      { value: 'devices', label: t('Devices') },
      { value: 'security', label: t('Sign-ins') },
      { value: 'releases', label: t('Updates') },
    ], state.group, (g) => { state.group = g; store('activity', state); paint(); }));

  async function load() {
    try {
      events = (await api('/api/audit?limit=1000')).events;
      paint();
    } catch (e) {
      replace(host, failed(e, load));
    }
  }
  await load();
  return { refresh: load };
}
