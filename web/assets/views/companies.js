import { h, icon, replace, store } from '../dom.js';
import { api, post } from '../api.js';
import { t, tn, num } from '../i18n.js';
import {
  plate, lane, meter, when, empty, chips, searchBox, sortableHead, sortRows, formDialog, choiceDialog, toast, errText, matchInfo, status,
} from '../ui.js';
import { loading, failed } from './common.js';

const FILTERS = {
  all: () => true,
  active: (c) => c.devices > 0,
  idle: (c) => c.devices === 0,
  offline: (c) => c.devices > c.online,
  custom: (c) => c.policy.mode !== 'inherit' || c.policy.whitelist > 0 || c.policy.blacklist > 0,
  requests: (c) => c.pendingRequests > 0,
};

export function companyFields(c = {}) {
  return [
    { name: 'name', label: t('Company name'), value: c.name || '', span: true },
    { name: 'domain', label: t('AD domain'), value: c.domain || '', placeholder: 'office.local', mono: true },
    { name: 'dc_ip', label: t('Domain controller IP'), value: c.dc_ip || '', placeholder: '10.118.0.10', mono: true },
    { name: 'subnet', label: t('Office subnet'), value: c.subnet || '', placeholder: '10.118', mono: true, hint: t('Short form 10.118 or CIDR 10.118.0.0/16.') },
    { name: 'nat_ips', label: t('NAT addresses'), type: 'textarea', rows: 3, mono: true, value: (c.nat_ips || []).join('\n'),
      placeholder: '203.0.113.10', hint: t('Public IPs of the office router, one per line. Ranges like 203.0.113.0/29 work too.') },
    { name: 'computers', label: t('AD computers'), type: 'textarea', rows: 6, mono: true, value: (c.computers || []).join('\n'),
      hint: t('One computer per line. Add the local IP after the name (PC-01 10.118.5.20) only if AD DNS cannot be reached.'), span: true },
    { name: 'notes', label: t('Notes'), type: 'textarea', rows: 2, value: c.notes || '', span: true },
  ];
}

export function companyPayload(v) {
  const lines = (s) => String(s || '').split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
  return { name: v.name, domain: v.domain, dc_ip: v.dc_ip, subnet: v.subnet, nat_ips: lines(v.nat_ips), computers: lines(v.computers), notes: v.notes };
}

/* Remote desktop to the company's domain controller through the local
 * fleet-rdp:// handler (tools/fleet-rdp), which runs xfreerdp /dynamic-resolution. */
export function rdpHref(c) {
  let user = '';
  try { user = localStorage.getItem('fleet.rdpUser') || ''; } catch (_) { /* ignore */ }
  const q = new URLSearchParams({ host: c.dc_ip });
  if (c.domain) q.set('domain', c.domain);
  if (user) q.set('user', user);
  return 'fleet-rdp://connect?' + q.toString();
}

export function rdpButton(c, { large = false } = {}) {
  const size = large ? 16 : 14;
  if (!c.dc_ip) {
    return h('button', { class: 'btn btn--quiet' + (large ? '' : ' btn--sm'), type: 'button', disabled: true, title: t('Add the domain controller IP in Details to connect.') },
      icon('monitor', size), large ? t('Connect to AD') : 'RDP');
  }
  return h('a', { class: 'btn btn--quiet' + (large ? '' : ' btn--sm'), href: rdpHref(c),
    title: t('Connect to {dc} with xfreerdp (dynamic resolution)', { dc: c.dc_ip }),
    onclick: (e) => {
      e.stopPropagation();
      try {
        if (!sessionStorage.getItem('fleet.rdpHint')) {
          sessionStorage.setItem('fleet.rdpHint', '1');
          toast(t('If nothing opens, install the RDP helper once: Settings → Remote desktop.'), 'info');
        }
      } catch (_) { /* ignore */ }
    } }, icon('monitor', size), large ? t('Connect to AD') : 'RDP');
}

const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|::1|fc|fd)/i.test(ip || '');

export async function render(page, params, ctx) {
  document.title = t('Companies') + ' — Fleet';
  const state = Object.assign({ q: '', filter: 'all', sort: { key: 'devices', dir: 'desc' } }, store('companies') || {});
  const save = () => store('companies', state);
  let data = null;

  const fileInput = h('input', { type: 'file', accept: '.json,application/json', class: 'hidden', onchange: async () => {
    const f = fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    try {
      const r = await api('/api/companies/import', { method: 'POST', body: await f.text(), headers: { 'Content-Type': 'application/json' } });
      toast(t('Import finished: {created} new, {updated} updated.', { created: r.created, updated: r.updated }));
      if (r.skipped && r.skipped.length) toast(tn(r.skipped.length, '{n} entry was skipped because of errors.', '{n} entries were skipped because of errors.'), 'error');
      load();
      ctx.refreshBadges();
    } catch (e) { toast(errText(e), 'error'); }
  } });

  page.append(h('header', { class: 'page-head' },
    h('div', { class: 'titles' }, h('h1', { class: 'page-title' }, t('Companies')),
      h('p', { class: 'page-sub' }, t('Every office with its computers and browsers. Open a company to see its computers, their local IPs and status.'))),
    h('div', { class: 'page-actions' },
      h('button', { class: 'btn btn--quiet', type: 'button', onclick: () => fileInput.click() }, icon('upload', 16), t('Import')),
      h('a', { class: 'btn btn--quiet', href: '/api/companies/export', download: '' }, icon('download', 16), t('Export')),
      h('button', { class: 'btn', type: 'button', onclick: addCompany }, icon('plus', 16), t('Add company')), fileInput)));

  const toolbar = h('div', { class: 'toolbar' });
  const boardHost = h('div');
  const unmatchedHost = h('div');
  page.append(toolbar, boardHost, unmatchedHost);
  boardHost.append(loading());

  async function addCompany() {
    const res = await formDialog({
      title: t('Add company'), intro: t('Devices are matched to a company by NAT address first, then by subnet.'), wide: true,
      fields: companyFields(), submit: t('Add company'),
      onSubmit: async (v) => post('/api/companies', companyPayload(v)),
    });
    if (res && res.id) { toast(t('Company added.')); ctx.refreshBadges(); ctx.navigate('#/companies/' + res.id); }
  }

  function paintToolbar() {
    const counts = {};
    for (const k of Object.keys(FILTERS)) counts[k] = data.companies.filter(FILTERS[k]).length;
    replace(toolbar,
      searchBox(state.q, (q) => { state.q = q; save(); paintBoard(); }, t('Search name, domain, IP…')),
      chips([
        { value: 'all', label: t('All'), count: counts.all },
        { value: 'active', label: t('With browsers'), count: counts.active },
        { value: 'offline', label: t('Has offline browsers'), count: counts.offline },
        { value: 'custom', label: t('Own policy'), count: counts.custom },
        { value: 'requests', label: t('Pending requests'), count: counts.requests },
        { value: 'idle', label: t('No browsers'), count: counts.idle },
      ], state.filter, (f) => { state.filter = f; save(); paintBoard(); }, { label: t('Filter companies') }));
  }

  const columns = [
    { key: 'name', label: t('Company'), sort: (c) => c.name.toLowerCase(),
      render: (c) => [h('a', { class: 'co-name', href: '#/companies/' + c.id }, c.name), h('span', { class: 'co-sub data' }, c.domain || c.subnet || '—')] },
    { key: 'devices', label: t('Browsers'), sort: (c) => c.devices, defaultDir: 'desc',
      render: (c) => h('div', { class: 'lane-cell' }, lane(c.online, c.devices),
        h('span', { class: 'counts' }, c.devices ? [h('b', null, num(c.online)), ' ', t('online of {n}', { n: num(c.devices) })] : t('No devices yet'))) },
    { key: 'coverage', label: t('Coverage'), sort: (c) => (c.adComputers ? c.covered / c.adComputers : -1), defaultDir: 'desc',
      render: (c) => (c.adComputers ? meter(c.covered, c.adComputers, t('{n} of {m} AD computers', { n: num(c.covered), m: num(c.adComputers) })) : h('span', { class: 'muted' }, t('No AD list'))) },
    { key: 'policy', label: t('Policy'), sort: (c) => ({ off: 0, blacklist: 1, whitelist: 2 }[c.policy.effectiveMode] ?? 0),
      render: (c) => [plate(c.policy.effectiveMode, { size: 'sm' }),
        FILTERS.custom(c) ? h('span', { class: 'plate-note' }, t('own policy')) : null] },
    { key: 'requests', label: t('Requests'), sort: (c) => c.pendingRequests, defaultDir: 'desc', class: 'num',
      render: (c) => (c.pendingRequests ? h('span', { class: 'badge badge--warn' }, num(c.pendingRequests)) : h('span', { class: 'muted' }, '—')) },
    { key: 'seen', label: t('Last check-in'), sort: (c) => c.lastSeen || '', defaultDir: 'desc', render: (c) => when(c.lastSeen) },
    { key: 'rdp', label: '', class: 'actions', render: (c) => rdpButton(c) },
  ];

  function paintBoard() {
    const q = state.q.trim().toLowerCase();
    let rows = data.companies.filter(FILTERS[state.filter] || FILTERS.all);
    if (q) {
      rows = rows.filter((c) => [c.name, c.domain, c.dc_ip, c.subnet, c.notes, ...(c.nat_ips || [])].some((v) => String(v || '').toLowerCase().includes(q)));
    }
    rows = sortRows(rows, columns, state.sort);
    const head = sortableHead(columns, state.sort, (s) => { state.sort = s; save(); paintBoard(); });
    const body = h('tbody', null, rows.map((c) => h('tr', { class: 'clickable', onclick: (e) => { if (!e.target.closest('a,button')) ctx.navigate('#/companies/' + c.id); } },
      columns.map((col) => h('td', { class: col.class || null }, col.render(c))))));
    replace(boardHost, h('section', { class: 'panel panel--flush' },
      rows.length
        ? h('div', { class: 'board-wrap' }, h('table', { class: 'board' }, head, body))
        : data.companies.length
          ? empty('search', t('No companies match'), t('Change the search or pick another filter.'),
            h('button', { class: 'btn btn--quiet', onclick: () => { state.q = ''; state.filter = 'all'; save(); paintToolbar(); paintBoard(); } }, t('Clear filters')))
          : empty('building', t('No companies yet'), t('Add your offices, or import the companies.json exported from Active Directory.'),
            h('button', { class: 'btn', onclick: addCompany }, icon('plus', 16), t('Add company')))));
  }

  function paintUnmatched() {
    const list = data.unmatched || [];
    if (!list.length) { replace(unmatchedHost); return; }
    // Group by source address: one decision per office router, not per browser.
    const groups = new Map();
    for (const d of list) {
      const key = d.last_ip || '—';
      if (!groups.has(key)) groups.set(key, { ip: key, devices: [], online: 0, last: '' });
      const g = groups.get(key);
      g.devices.push(d);
      if (d.online) g.online++;
      if ((d.last_seen || '') > g.last) g.last = d.last_seen;
    }
    const rows = [...groups.values()].sort((a, b) => b.devices.length - a.devices.length);
    replace(unmatchedHost, h('section', { class: 'panel', style: { marginTop: '20px' } },
      h('div', { class: 'panel-head' }, h('h2', null, t('Browsers without a company')),
        h('span', { class: 'badge badge--warn' }, num(list.length)),
        h('p', null, t('They get the global policy. Link an address to a company and every browser behind it follows that company’s rules.'))),
      h('div', { class: 'table-wrap', style: { marginTop: '12px' } }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, t('Address')), h('th', null, t('Browsers')), h('th', null, t('Why')), h('th', null, t('Last check-in')), h('th', { class: 'actions' }, t('Link to company')))),
        h('tbody', null, rows.map((g) => h('tr', null,
          h('td', null, h('span', { class: 'data' }, g.ip), h('span', { class: 'cell-sub' }, isPrivate(g.ip) ? t('Private address') : t('Public address'))),
          h('td', null, status(g.online > 0), h('span', { class: 'cell-sub' }, t('{on} of {n} online', { on: g.online, n: g.devices.length }))),
          h('td', null, matchInfo(g.devices[0])),
          h('td', null, when(g.last)),
          h('td', { class: 'actions' }, linkSelect(g)))))))));
  }

  function linkSelect(g) {
    const sel = h('select', { class: 'input', style: { width: '200px', height: '32px' }, 'aria-label': t('Link to company') },
      h('option', { value: '' }, t('Choose a company…')),
      data.companies.map((c) => h('option', { value: c.id }, c.name)));
    sel.addEventListener('change', async () => {
      const cid = Number(sel.value);
      sel.value = '';
      if (!cid) return;
      const comp = data.companies.find((c) => c.id === cid);
      const how = await choiceDialog({
        title: t('Link to {company}', { company: comp.name }),
        intro: t('Address {ip} with {n} browser(s).', { ip: g.ip, n: g.devices.length }),
        value: isPrivate(g.ip) || g.ip === '—' ? 'pin' : 'nat',
        choices: [
          { value: 'nat', title: t('Add {ip} as a NAT address', { ip: g.ip }), desc: t('Every browser that reaches the server from this address belongs to {company} — now and in the future. Best for an office’s public IP.', { company: comp.name }) },
          { value: 'pin', title: tn(g.devices.length, 'Pin this browser only', 'Pin these {n} browsers only'), desc: t('Use this when the address is shared by several companies or changes often.') },
        ],
        submit: t('Link'),
      });
      if (!how) return;
      try {
        if (how === 'nat') await post('/api/companies/' + cid + '/nat-ip', { ip: g.ip, action: 'add' });
        else await post('/api/devices/update', { deviceIds: g.devices.map((d) => d.device_id), companyId: cid });
        toast(t('Linked to {company}.', { company: comp.name }));
        load();
        ctx.refreshBadges();
      } catch (e) { toast(errText(e), 'error'); }
    });
    return sel;
  }

  async function load() {
    try {
      data = await api('/api/companies');
    } catch (e) {
      replace(boardHost, failed(e, load));
      return;
    }
    paintToolbar();
    paintBoard();
    paintUnmatched();
  }
  await load();
  return { refresh: async () => {
    if (document.activeElement && document.activeElement.closest('.toolbar, select')) return;
    try { data = await api('/api/companies'); paintBoard(); paintUnmatched(); } catch (_) { /* keep last view */ }
  } };
}
