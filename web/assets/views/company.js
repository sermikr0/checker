import { h, icon, replace, browserOf } from '../dom.js';
import { api, post } from '../api.js';
import { t, tn, num } from '../i18n.js';
import {
  plate, status, when, empty, meter, formDialog, confirmDialog, toast, errText, matchInfo, domainEditor, MODE_LABEL, searchBox,
} from '../ui.js';
import { loading, failed, versionTag } from './common.js';
import { companyFields, companyPayload } from './companies.js';

const TABS = ['devices', 'policy', 'computers', 'details'];

export async function render(page, params, ctx) {
  const id = Number(params[0]);
  let tab = TABS.includes(params[1]) ? params[1] : 'devices';
  let c = null;
  let globalPolicy = null;
  let release = null;
  let dirty = false;

  page.append(loading());

  async function fetchAll() {
    const [cr, pr, rr] = await Promise.all([api('/api/companies/' + id), api('/api/policy'), api('/api/releases').catch(() => null)]);
    c = cr.company;
    globalPolicy = pr.policy;
    release = rr && rr.release;
  }

  try {
    await fetchAll();
  } catch (e) {
    replace(page, h('a', { class: 'crumb', href: '#/companies' }, icon('chevLeft', 15), t('Companies')),
      e.status === 404 ? empty('building', t('This company no longer exists'), t('It may have been deleted.'), h('a', { class: 'btn btn--quiet', href: '#/companies' }, t('Back to companies'))) : failed(e));
    return {};
  }

  document.title = c.name + ' — Fleet';
  const tabHost = h('div');

  async function staleReload() {
    const ok = await confirmDialog({ title: t('Changed somewhere else'), body: t('This company was changed after you opened it — for example, a request was approved. Load the latest version? Your unsaved edits will be lost.'), confirm: t('Load latest') });
    if (!ok) return;
    setDirty(false);
    await reload();
  }

  function header() {
    const eff = c.policyDetail.effective;
    const natChips = h('div', { class: 'ipchips' },
      c.nat_ips.length ? c.nat_ips.map((ip) => h('span', { class: 'ipchip' }, ip,
        h('button', { type: 'button', title: t('Remove {d}', { d: ip }), 'aria-label': t('Remove {d}', { d: ip }), onclick: () => removeNat(ip) }, icon('x', 13))))
        : h('span', { class: 'muted' }, t('none')),
      h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: addNat }, icon('plus', 14), t('Add address')));
    return h('header', null,
      h('a', { class: 'crumb', href: '#/companies' }, icon('chevLeft', 15), t('Companies')),
      h('div', { class: 'page-head', style: { marginBottom: '0' } },
        h('div', { class: 'titles' },
          h('h1', { class: 'page-title' }, c.name),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px', flexWrap: 'wrap' } },
            plate(eff.mode),
            h('span', { class: 'ink-2' }, eff.modeSource === 'company' ? t('Own policy mode') : t('Follows the global policy')),
            c.pendingRequests || c.requests.length ? h('a', { class: 'badge badge--warn', href: '#/requests' }, tn(c.requests.length, '{n} request waiting', '{n} requests waiting')) : null)),
        h('div', { class: 'page-actions' },
          h('a', { class: 'btn btn--quiet', href: '#/devices?company=' + c.id, onclick: (e) => { e.preventDefault(); sessionStorage.setItem('fleet.devices', JSON.stringify({ company: String(c.id) })); ctx.navigate('#/devices'); } }, icon('monitor', 16), t('Open in Devices')))),
      h('dl', { class: 'facts' },
        fact(t('Browsers'), c.devices ? t('{on} online of {n}', { on: num(c.online), n: num(c.devices) }) : t('none yet')),
        c.adComputers ? h('div', { style: { minWidth: '180px' } }, h('dt', null, t('Coverage')), h('dd', null, meter(c.devices, c.adComputers, t('{n} of {m} AD computers', { n: num(c.devices), m: num(c.adComputers) })))) : null,
        fact(t('AD domain'), c.domain || '—', true),
        fact(t('Domain controller'), c.dc_ip || '—', true),
        fact(t('Subnet'), c.subnet || '—', true),
        h('div', null, h('dt', null, t('NAT addresses')), h('dd', null, natChips))));
  }

  function fact(label, value, data) {
    return h('div', null, h('dt', null, label), h('dd', { class: data ? 'data' : null }, value));
  }

  async function addNat() {
    const res = await formDialog({
      title: t('Add a NAT address'), intro: t('Browsers that reach the server from this public address will belong to {company}.', { company: c.name }),
      fields: [{ name: 'ip', label: t('IP address or range'), placeholder: '203.0.113.10', mono: true }], submit: t('Add address'),
      onSubmit: (v) => post('/api/companies/' + id + '/nat-ip', { ip: v.ip.trim(), action: 'add' }).catch((e) => { e.fields = { ip: e.message }; throw e; }),
    });
    if (res) { toast(t('Address added.')); reload(); }
  }
  async function removeNat(ip) {
    if (!await confirmDialog({ title: t('Remove {d}?', { d: ip }), body: t('Browsers behind this address will no longer be matched to {company} unless another rule matches.', { company: c.name }), confirm: t('Remove'), danger: true })) return;
    try { await post('/api/companies/' + id + '/nat-ip', { ip, action: 'remove' }); toast(t('Address removed.')); reload(); } catch (e) { toast(errText(e), 'error'); }
  }

  const tabsEl = h('div', { class: 'tabs', role: 'tablist' });
  function paintTabs() {
    const labels = {
      devices: [t('Browsers'), c.devices],
      policy: [t('Policy'), null],
      computers: [t('AD computers'), c.adComputers],
      details: [t('Details'), null],
    };
    replace(tabsEl, TABS.map((k) => h('button', { role: 'tab', type: 'button', 'aria-selected': String(k === tab), onclick: () => switchTab(k) },
      labels[k][0], labels[k][1] != null ? h('span', { class: 'count' }, num(labels[k][1])) : null)));
  }
  function switchTab(k) {
    if (k === tab) return;
    if (dirty && !window.confirm(t('Discard unsaved policy changes?'))) return;
    setDirty(false);
    tab = k;
    history.replaceState(null, '', '#/companies/' + id + (k === 'devices' ? '' : '/' + k));
    paintTabs();
    paintTab();
  }

  function setDirty(v) {
    dirty = v;
    ctx.setGuard(v ? () => window.confirm(t('Discard unsaved policy changes?')) : null);
    window.onbeforeunload = v ? () => true : null;
  }

  function paintTab() {
    if (tab === 'devices') replace(tabHost, devicesTab());
    else if (tab === 'policy') replace(tabHost, policyTab());
    else if (tab === 'computers') replace(tabHost, computersTab());
    else replace(tabHost, detailsTab());
  }

  /* ── Browsers tab ── */
  function devicesTab() {
    const list = c.deviceList;
    if (!list.length) {
      return h('section', { class: 'panel' }, empty('monitor', t('No browsers from this company yet'),
        c.nat_ips.length || c.subnet ? t('Browsers appear here after their first check-in from {where}.', { where: [...c.nat_ips, c.subnet].filter(Boolean).join(', ') })
          : t('Add the office’s NAT address so its browsers can be recognised.'),
        c.nat_ips.length ? null : h('button', { class: 'btn', onclick: addNat }, icon('plus', 16), t('Add address'))));
    }
    const latest = release && release.version;
    return h('section', { class: 'panel panel--flush' }, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, [t('Status'), t('Name'), t('Address'), t('Matched'), t('Version'), t('Browser'), t('Last check-in'), ''].map((x) => h('th', null, x)))),
      h('tbody', null, list.map((d) => h('tr', null,
        h('td', null, status(d.online)),
        h('td', null, h('b', null, d.label || ''), h('span', { class: 'cell-sub data' }, d.device_id.slice(0, 13))),
        h('td', { class: 'data' }, d.last_ip),
        h('td', null, matchInfo(d)),
        h('td', null, versionTag(d.version, latest)),
        h('td', { class: 'nowrap' }, browserOf(d.user_agent) || h('span', { class: 'muted' }, '—')),
        h('td', { class: 'nowrap' }, when(d.last_seen)),
        h('td', { class: 'actions' }, d.match === 'pinned'
          ? h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: async () => {
            try { await post('/api/devices/update', { deviceIds: [d.device_id], companyId: null }); toast(t('Pin removed.')); reload(); } catch (e) { toast(errText(e), 'error'); }
          } }, icon('pin', 14), t('Unpin')) : null)))))));
  }

  /* ── Policy tab ── */
  function policyTab() {
    const pd = c.policyDetail;
    let mode = pd.mode;
    let wl = [...pd.whitelist];
    let bl = [...pd.blacklist];
    const orig = JSON.stringify([pd.mode, pd.whitelist, pd.blacklist]);
    const changed = () => {
      setDirty(JSON.stringify([mode, wl, bl]) !== orig);
      paintSaveBar();
      paintPreview();
    };

    const opts = [
      ['inherit', t('Uses the global mode, now: {mode}.', { mode: MODE_LABEL[globalPolicy.enforceMode]() })],
      ['off', t('Nothing is blocked for this company, whatever the global mode is.')],
      ['blacklist', t('Only the blocked list is stopped. Everything else opens.')],
      ['whitelist', t('Everything is blocked except the allowed list. For strict offices.')],
    ];
    const picker = h('div', { class: 'plate-picker', role: 'radiogroup', 'aria-label': t('Policy mode'), style: { '--n': 4 } });
    function paintPicker() {
      replace(picker, opts.map(([m, desc]) => h('button', { type: 'button', class: 'plate-option', role: 'radio', 'aria-checked': String(m === mode),
        onclick: () => { mode = m; paintPicker(); changed(); } },
      h('span', { class: 'tick' }, icon('check', 14)), plate(m), h('span', { class: 'desc' }, desc))));
    }
    paintPicker();

    const allow = domainEditor({ title: t('Allowed for {company}', { company: c.name }), tone: 'allow', items: wl,
      hint: t('Added to the global allowed list. Wins over the same domain on the global blocked list.'), onChange: (l) => { wl = l; changed(); } });
    const block = domainEditor({ title: t('Blocked for {company}', { company: c.name }), tone: 'block', items: bl,
      hint: t('Added to the global blocked list. Wins over the same domain on the global allowed list.'), onChange: (l) => { bl = l; changed(); } });

    const preview = h('div', { class: 'effective' });
    function paintPreview() {
      const gwl = globalPolicy.whitelist, gbl = globalPolicy.blacklist;
      const effMode = mode === 'inherit' ? globalPolicy.enforceMode : mode;
      const ewl = [...wl, ...gwl.filter((d) => !bl.includes(d) && !wl.includes(d))];
      const ebl = [...bl, ...gbl.filter((d) => !wl.includes(d) && !bl.includes(d))];
      const shadowed = effMode === 'blacklist' ? wl.map((d) => [d, ebl.find((p) => d !== p && d.endsWith('.' + p))]).filter((x) => x[1]) : [];
      const overridden = [...gwl.filter((d) => bl.includes(d)), ...gbl.filter((d) => wl.includes(d))];
      const tags = (arr, own) => (arr.length
        ? h('div', { class: 'tag-list' }, arr.slice(0, 60).map((d) => h('span', { class: 'tag' + (own.includes(d) ? ' tag--company' : ''), title: own.includes(d) ? t('From this company') : t('From the global policy') }, d)),
          arr.length > 60 ? h('span', { class: 'muted' }, t('and {n} more', { n: arr.length - 60 })) : null)
        : h('span', { class: 'muted' }, t('empty')));
      let explain;
      if (effMode === 'off') explain = h('p', { class: 'ink-2', style: { margin: 0 } }, t('Browsers in this company open every site. The lists are kept but not enforced.'));
      else if (effMode === 'blacklist') explain = [h('div', { class: 'field-label' }, tn(ebl.length, '{n} blocked domain', '{n} blocked domains')), tags(ebl, bl)];
      else explain = [h('div', { class: 'field-label' }, tn(ewl.length, 'Only {n} domain opens', 'Only {n} domains open')), tags(ewl, wl),
        !ewl.length ? h('div', { class: 'note note--warn' }, icon('alert', 16), t('The allowed list is empty: every site will be blocked for this company.')) : null];
      replace(preview,
        h('div', { class: 'row' }, plate(effMode), h('span', { class: 'ink-2' }, mode === 'inherit' ? t('from the global policy') : t('set for this company'))),
        explain,
        shadowed.length ? h('div', { class: 'note note--warn' }, icon('alert', 16), h('div', null,
          shadowed.map(([d, p]) => h('div', null, t('{d} stays blocked because {parent} is on the blocked list.', { d, parent: p }))))) : null,
        c.policyDetail.effective.truncated ? h('div', { class: 'note note--warn' }, icon('alert', 16), t('The combined list is longer than a browser accepts; the oldest global entries are left out. Shorten the global lists.')) : null,
        overridden.length ? h('div', null, h('div', { class: 'field-label' }, t('Global entries this company overrides')),
          h('div', { class: 'tag-list', style: { marginTop: '6px' } }, overridden.map((d) => h('span', { class: 'tag tag--strike' }, d)))) : null);
    }
    paintPreview();

    const saveHost = h('div');
    function paintSaveBar() {
      if (!dirty) { replace(saveHost); return; }
      replace(saveHost, h('div', { class: 'savebar', role: 'region', 'aria-label': t('Unsaved changes') },
        icon('info', 18), h('span', null, t('Unsaved changes. Browsers get them within a minute of saving.')), h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn--quiet', type: 'button', onclick: () => { setDirty(false); paintTab(); } }, t('Discard')),
        h('button', { class: 'btn', type: 'button', onclick: savePolicy }, icon('check', 16), t('Save policy'))));
    }
    async function savePolicy() {
      const effMode = mode === 'inherit' ? globalPolicy.enforceMode : mode;
      const effAllowed = [...globalPolicy.whitelist.filter((d) => !bl.includes(d)), ...wl];
      if (effMode === 'whitelist' && !effAllowed.length) {
        if (!await confirmDialog({ title: t('Block every site for {company}?', { company: c.name }), body: t('Whitelist mode with an empty allowed list stops every page in this company.'), confirm: t('Block everything'), danger: true })) return;
      }
      try {
        await post('/api/companies/' + id + '/policy', { mode, whitelist: wl, blacklist: bl, rev: c.rev });
        setDirty(false);
        toast(t('Policy saved for {company}.', { company: c.name }));
        await reload();
      } catch (e) {
        if (e.status === 409 && e.data.stale) return staleReload();
        const f = e.fields || {};
        toast(t(f.whitelist || f.blacklist || f.policy_mode || e.message), 'error');
      }
    }

    const reqPanel = c.requests.length ? h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, t('Requests from this company')), h('span', { class: 'badge badge--warn' }, num(c.requests.length))),
      h('div', { class: 'table-wrap', style: { marginTop: '10px' } }, h('table', { class: 'table' },
        h('tbody', null, c.requests.map((r) => h('tr', null,
          h('td', null, h('b', { class: 'data' }, r.domain), h('span', { class: 'cell-sub truncate' }, r.url)),
          h('td', { class: 'nowrap' }, tn(r.hits || 1, '{n} time', '{n} times')),
          h('td', { class: 'nowrap' }, when(r.last_ts || r.ts)),
          h('td', { class: 'actions' },
            h('button', { class: 'btn btn--sm', type: 'button', onclick: () => resolve(r, 'approve') }, icon('check', 14), t('Allow')),
            h('button', { class: 'btn btn--quiet btn--sm', type: 'button', onclick: () => resolve(r, 'reject') }, t('Reject')),
            h('button', { class: 'btn btn--danger-quiet btn--sm', type: 'button', onclick: () => resolve(r, 'block') }, icon('ban', 14), t('Block'))))))))) : null;

    async function resolve(r, action) {
      if (dirty && !window.confirm(t('Discard unsaved policy changes?'))) return;
      try {
        const res = await post('/api/requests/resolve', { id: r.id, action, scope: 'company' });
        const skip = res.results.find((x) => x.skipped === 'parent_blocked');
        if (skip) {
          toast(t('{d} is part of {parent}, which is on the blocked list. Remove {parent} from the blocked list first, or reject the request.', { d: skip.domain, parent: skip.parent }), 'error');
          return;
        }
        setDirty(false);
        toast(action === 'approve' ? t('{d} is allowed for {company}.', { d: r.domain, company: c.name }) : action === 'block' ? t('{d} is blocked for {company}.', { d: r.domain, company: c.name }) : t('Request rejected.'));
        ctx.refreshBadges();
        await reload();
      } catch (e) { toast(errText(e), 'error'); }
    }

    return [
      reqPanel,
      h('section', { class: 'panel', style: reqPanel ? { marginTop: '20px' } : null },
        h('div', { class: 'panel-head' }, h('h2', null, t('Mode for {company}', { company: c.name }))),
        h('div', { class: 'panel-body' }, picker)),
      h('div', { class: 'grid-2', style: { marginTop: '20px' } },
        h('div', { class: 'grid-even', style: { gridTemplateColumns: '1fr 1fr' } }, allow.el, block.el),
        h('section', { class: 'panel' },
          h('div', { class: 'panel-head' }, h('h2', null, t('What these browsers get')),
            h('p', null, t('Global lists plus this company’s lists, as sent to every browser in {company}.', { company: c.name }))),
          h('div', { class: 'panel-body' }, preview))),
      saveHost,
    ];
  }

  /* ── AD computers tab ── */
  function computersTab() {
    if (!c.computers.length) {
      return h('section', { class: 'panel' }, empty('monitor', t('No AD computer list'), t('Paste computer names in Details to measure how many PCs run the extension.'),
        h('button', { class: 'btn btn--quiet', onclick: () => switchTab('details') }, t('Open details'))));
    }
    const grid = h('div', { class: 'pc-grid' });
    const paint = (q) => {
      const list = c.computers.filter((n) => !q || n.toLowerCase().includes(q.toLowerCase()));
      replace(grid, list.length ? list.map((n) => h('div', { class: 'pc', title: n }, icon('monitor', 14), n)) : h('p', { class: 'muted' }, t('Nothing matches “{q}”.', { q })));
    };
    paint('');
    return h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, tn(c.computers.length, '{n} computer in Active Directory', '{n} computers in Active Directory')),
        h('p', null, t('Browsers cannot report their computer name, so this list is used for coverage only.'))),
      h('div', { class: 'panel-body' }, h('div', { class: 'toolbar' }, searchBox('', paint, t('Find a computer'))), grid));
  }

  /* ── Details tab ── */
  function detailsTab() {
    const fields = companyFields(c);
    const inputs = {};
    const errs = {};
    const form = h('form', { class: 'form-grid', onsubmit: async (e) => {
      e.preventDefault();
      Object.values(errs).forEach((x) => { x.textContent = ''; });
      const v = {};
      for (const [k, el] of Object.entries(inputs)) v[k] = el.value;
      try {
        await post('/api/companies/' + id, { ...companyPayload(v), rev: c.rev });
        toast(t('Company details saved.'));
        await reload();
      } catch (err) {
        if (err.status === 409 && err.data.stale) { staleReload(); return; }
        let shown = false;
        for (const [k, msg] of Object.entries(err.fields || {})) if (errs[k]) { errs[k].textContent = t(msg); shown = true; }
        if (!shown) toast(errText(err), 'error');
      }
    } }, fields.map((f) => {
      const fid = 'cd-' + f.name;
      const el = f.type === 'textarea'
        ? h('textarea', { id: fid, class: 'input' + (f.mono ? ' data' : ''), rows: f.rows || 4, placeholder: f.placeholder || '', spellcheck: 'false' })
        : h('input', { id: fid, class: 'input' + (f.mono ? ' data' : ''), placeholder: f.placeholder || '', spellcheck: 'false' });
      el.value = f.value;
      inputs[f.name] = el;
      errs[f.name] = h('div', { class: 'field-error' });
      return h('div', { class: 'field' + (f.span ? ' span-2' : '') }, h('label', { for: fid }, f.label), el, f.hint ? h('div', { class: 'field-hint' }, f.hint) : null, errs[f.name]);
    }), h('div', { class: 'span-2' }, h('button', { class: 'btn', type: 'submit' }, icon('check', 16), t('Save details'))));

    return [
      h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, t('Company details'))), h('div', { class: 'panel-body' }, form)),
      h('section', { class: 'panel danger-zone' },
        h('div', { class: 'panel-head' }, h('h2', null, t('Delete company')),
          h('p', null, t('Its browsers stay enrolled and fall back to the global policy. Pins to this company are removed.'))),
        h('div', { class: 'panel-body' }, h('button', { class: 'btn btn--danger-quiet', type: 'button', onclick: async () => {
          if (!await confirmDialog({ title: t('Delete {company}?', { company: c.name }), body: t('This cannot be undone. Its own policy and AD list are deleted too.'), confirm: t('Delete company'), danger: true })) return;
          try { await post('/api/companies/' + id + '/delete'); toast(t('Company deleted.')); ctx.refreshBadges(); ctx.navigate('#/companies'); } catch (e) { toast(errText(e), 'error'); }
        } }, icon('trash', 16), t('Delete company')))),
    ];
  }

  const headHost = h('div');
  async function reload() {
    try { await fetchAll(); } catch (e) { toast(errText(e), 'error'); return; }
    replace(headHost, header());
    paintTabs();
    paintTab();
  }

  replace(page, headHost, tabsEl, tabHost);
  replace(headHost, header());
  paintTabs();
  paintTab();

  return {
    refresh: async () => {
      if (dirty || tab !== 'devices') return;
      try { await fetchAll(); replace(headHost, header()); paintTabs(); paintTab(); } catch (_) { /* keep */ }
    },
    destroy: () => { window.onbeforeunload = null; },
  };
}
