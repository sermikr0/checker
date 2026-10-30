import { h, icon, replace, store } from '../dom.js';
import { api, post } from '../api.js';
import { t, tn, num } from '../i18n.js';
import { when, empty, seg, searchBox, toast, errText, confirmDialog } from '../ui.js';
import { loading, failed } from './common.js';

export async function render(page, params, ctx) {
  document.title = t('Access requests') + ' — Fleet';
  const state = Object.assign({ tab: 'pending', scope: 'company', q: '' }, store('requests') || {});
  const save = () => store('requests', state);
  const selected = new Set();
  let pending = [];
  let history = [];

  page.append(h('header', { class: 'page-head' },
    h('div', { class: 'titles' }, h('h1', { class: 'page-title' }, t('Access requests')),
      h('p', { class: 'page-sub' }, t('When someone hits a blocked site they can ask for it. Allowing adds the site to the allowed list, blocking adds it to the blocked list.')))));
  const tabsEl = h('div', { class: 'tabs', role: 'tablist' });
  const toolbar = h('div', { class: 'toolbar' });
  const selBar = h('div');
  const host = h('div');
  page.append(tabsEl, toolbar, selBar, host);
  host.append(loading());

  function paintTabs() {
    replace(tabsEl,
      h('button', { role: 'tab', type: 'button', 'aria-selected': String(state.tab === 'pending'), onclick: () => { state.tab = 'pending'; save(); selected.clear(); paintAll(); } },
        t('Waiting'), h('span', { class: 'count' }, num(pending.length))),
      h('button', { role: 'tab', type: 'button', 'aria-selected': String(state.tab === 'history'), onclick: () => { state.tab = 'history'; save(); selected.clear(); paintAll(); } },
        t('Decided')));
  }

  function paintToolbar() {
    const parts = [searchBox(state.q, (q) => { state.q = q; save(); paintList(); }, t('Search site or company…'))];
    if (state.tab === 'pending') {
      parts.push(h('span', { class: 'spacer' }),
        h('span', { class: 'field-label' }, t('Decisions apply to')),
        seg([
          { value: 'company', label: t('The requester’s company'), icon: 'building' },
          { value: 'global', label: t('Every company'), icon: 'globe' },
        ], state.scope, (v) => { state.scope = v; save(); paintList(); }, { label: t('Decisions apply to') }));
    }
    replace(toolbar, ...parts);
  }

  const match = (r) => {
    const q = state.q.trim().toLowerCase();
    return !q || [r.domain, r.url, r.company, r.label, r.device_id].some((v) => String(v || '').toLowerCase().includes(q));
  };

  async function decide(ids, action) {
    const rows = pending.filter((r) => ids.includes(r.id));
    if (action === 'block' && state.scope === 'global' && rows.length > 1) {
      if (!await confirmDialog({ title: tn(rows.length, 'Block {n} site for every company?', 'Block {n} sites for every company?'), body: t('They are added to the global blocked list.'), confirm: t('Block'), danger: true })) return;
    }
    try {
      const r = await post('/api/requests/resolve', { ids, action, scope: state.scope });
      const done = r.results.filter((x) => !x.skipped);
      const noCompany = r.results.filter((x) => x.skipped === 'no_company');
      const parent = r.results.filter((x) => x.skipped === 'parent_blocked');
      const n = done.length;
      if (n) {
        toast(action === 'approve' ? tn(n, '{n} site allowed.', '{n} sites allowed.')
          : action === 'block' ? tn(n, '{n} site blocked.', '{n} sites blocked.') : tn(n, '{n} request rejected.', '{n} requests rejected.'));
      }
      if (noCompany.length) toast(tn(noCompany.length, '{n} request is from a browser without a company. Link it to a company first, or apply the decision to every company.', '{n} requests are from browsers without a company. Link them to a company first, or apply the decision to every company.'), 'error');
      for (const p of parent) toast(t('{d} is part of {parent}, which is on the blocked list. Remove {parent} from the blocked list first, or reject the request.', { d: p.domain, parent: p.parent }), 'error');
      selected.clear();
      ctx.refreshBadges();
      await load();
    } catch (e) { toast(errText(e), 'error'); }
  }

  const needsCompany = (r) => state.scope === 'company' && !r.company;

  function scopeHint(r) {
    if (state.scope === 'global') return t('for every company');
    return t('only for {company}', { company: r.company });
  }

  function paintSelection() {
    if (state.tab !== 'pending' || !selected.size) { replace(selBar); return; }
    const ids = [...selected];
    replace(selBar, h('div', { class: 'selection-bar' },
      h('span', null, tn(ids.length, '{n} selected', '{n} selected')),
      h('button', { class: 'btn btn--sm', type: 'button', onclick: () => decide(ids, 'approve') }, icon('check', 14), t('Allow')),
      h('button', { class: 'btn btn--quiet btn--sm', type: 'button', onclick: () => decide(ids, 'reject') }, t('Reject')),
      h('button', { class: 'btn btn--quiet btn--sm', type: 'button', onclick: () => decide(ids, 'block') }, icon('ban', 14), t('Block')),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--quiet btn--sm', type: 'button', onclick: () => { selected.clear(); paintList(); } }, t('Clear selection'))));
  }

  function paintList() {
    paintSelection();
    if (state.tab === 'pending') {
      const rows = pending.filter(match);
      if (!pending.length) { replace(host, h('section', { class: 'panel' }, empty('inbox', t('No one is waiting'), t('New requests appear here as soon as someone presses “Request access” on the block page.')))); return; }
      if (!rows.length) { replace(host, h('section', { class: 'panel' }, empty('search', t('No requests match'), null))); return; }
      const all = h('input', { type: 'checkbox', class: 'check', 'aria-label': t('Select all'), checked: rows.every((r) => selected.has(r.id)),
        onchange: (e) => { rows.forEach((r) => (e.target.checked ? selected.add(r.id) : selected.delete(r.id))); paintList(); } });
      replace(host, h('section', { class: 'panel panel--flush' }, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', { class: 'w-check' }, all), h('th', null, t('Site')), h('th', null, t('Company')), h('th', null, t('Asked by')),
          h('th', null, t('Times')), h('th', null, t('Last asked')), h('th', { class: 'actions' }, t('Decision')))),
        h('tbody', null, rows.map((r) => h('tr', { class: selected.has(r.id) ? 'is-selected' : '' },
          h('td', { class: 'w-check' }, h('input', { type: 'checkbox', class: 'check', checked: selected.has(r.id), 'aria-label': t('Select'),
            onchange: (e) => { if (e.target.checked) selected.add(r.id); else selected.delete(r.id); paintList(); } })),
          h('td', null, h('b', { class: 'data' }, r.domain), h('span', { class: 'cell-sub truncate', title: r.url }, r.url)),
          h('td', null, r.company ? h('a', { href: '#/companies/' + r.company_id + '/policy', style: { fontWeight: 700 } }, r.company) : h('span', { class: 'muted' }, t('No company'))),
          h('td', null, r.label || h('span', { class: 'data muted' }, (r.device_id || '—').slice(0, 13))),
          h('td', { class: 'num' }, num(r.hits || 1)),
          h('td', { class: 'nowrap' }, when(r.last_ts || r.ts)),
          h('td', { class: 'actions' },
            h('button', { class: 'btn btn--sm', type: 'button', disabled: needsCompany(r), title: needsCompany(r) ? t('This browser has no company. Link it to a company, or apply decisions to every company.') : t('Allow {d}', { d: r.domain }) + ' ' + scopeHint(r), onclick: () => decide([r.id], 'approve') }, icon('check', 14), t('Allow')),
            h('button', { class: 'btn btn--quiet btn--sm', type: 'button', title: t('Close the request without changing any list'), onclick: () => decide([r.id], 'reject') }, t('Reject')),
            h('button', { class: 'btn btn--danger-quiet btn--sm', type: 'button', disabled: needsCompany(r), title: needsCompany(r) ? t('This browser has no company. Link it to a company, or apply decisions to every company.') : t('Block {d}', { d: r.domain }) + ' ' + scopeHint(r), onclick: () => decide([r.id], 'block') }, icon('ban', 14), t('Block')))))))),
        rows.some(needsCompany) ? h('div', { class: 'note', style: { margin: '12px' } }, icon('info', 16),
          t('Some requests come from browsers without a company. Allow and Block are off for them while decisions apply to the requester’s company — link the browser on the Companies page, or switch to “Every company”.')) : null));
    } else {
      const rows = history.filter(match);
      if (!rows.length) { replace(host, h('section', { class: 'panel' }, empty('clock', t('No decisions yet'), null))); return; }
      const badge = { approved: ['badge--good', t('Allowed')], rejected: ['', t('Rejected')], blocked: ['badge--danger', t('Blocked')] };
      replace(host, h('section', { class: 'panel panel--flush' }, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, [t('Site'), t('Company'), t('Decision'), t('Applies to'), t('By'), t('When')].map((x) => h('th', null, x)))),
        h('tbody', null, rows.map((r) => {
          const [cls, label] = badge[r.status] || ['', r.status];
          return h('tr', null,
            h('td', null, h('b', { class: 'data' }, r.domain), h('span', { class: 'cell-sub truncate', title: r.url }, r.url)),
            h('td', null, r.company || h('span', { class: 'muted' }, '—')),
            h('td', null, h('span', { class: 'badge ' + cls }, label)),
            h('td', null, r.scope === 'company' ? t('This company') : t('Every company')),
            h('td', null, r.resolved_by || '—'),
            h('td', { class: 'nowrap' }, when(r.resolved_at || r.ts)));
        }))))));
    }
  }

  function paintAll() { paintTabs(); paintToolbar(); paintList(); }

  async function load() {
    try {
      const [p, hst] = await Promise.all([api('/api/requests?status=pending'), api('/api/requests?status=resolved')]);
      pending = p.requests;
      history = hst.requests;
    } catch (e) {
      replace(host, failed(e, load));
      return;
    }
    for (const id of [...selected]) if (!pending.some((r) => r.id === id)) selected.delete(id);
    paintTabs();
    paintList();
  }
  paintToolbar();
  await load();
  return { refresh: () => { if (!selected.size && !(document.activeElement && document.activeElement.closest('.toolbar'))) load(); } };
}
