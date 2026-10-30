import { h, icon, replace } from '../dom.js';
import { api, post } from '../api.js';
import { t, tn, num } from '../i18n.js';
import {
  plate, when, empty, meter, formDialog, confirmDialog, dialog, copyBtn, toast, errText, searchBox, chips, sortableHead, sortRows,
} from '../ui.js';
import { loading, failed } from './common.js';
import { companyFields, companyPayload, rdpButton } from './companies.js';

const TABS = ['computers', 'details'];

export async function render(page, params, ctx) {
  const id = Number(params[0]);
  let tab = TABS.includes(params[1]) ? params[1] : 'computers';
  let c = null;
  const pcState = { q: '', filter: 'all', sort: { key: 'name', dir: 'asc' } };

  page.append(loading());

  async function fetchAll() {
    c = (await api('/api/companies/' + id)).company;
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
    if (ok) await reload();
  }

  function counts() {
    const listed = c.computerList.filter((p) => p.listed);
    return {
      total: listed.length,
      on: listed.filter((p) => p.power === 'on').length,
      online: listed.filter((p) => p.status === 'online').length,
      installed: listed.filter((p) => p.status !== 'none').length,
      withIp: listed.filter((p) => p.ip).length,
    };
  }

  function header() {
    const k = counts();
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
            plate(c.policy.effectiveMode),
            h('span', { class: 'ink-2' }, c.policy.modeSource === 'company' ? t('Own policy mode') : t('Follows the global policy')))),
        h('div', { class: 'page-actions' }, rdpButton(c, { large: true }))),
      h('dl', { class: 'facts' },
        fact(t('Computers'), !k.total ? t('none yet') : (c.agent && c.agent.configured)
          ? t('{n} in AD, {pc} turned on, {inst} with the extension', { n: num(k.total), pc: num(k.on), inst: num(k.installed) })
          : t('{n} in AD, {inst} with the extension, {on} online', { n: num(k.total), inst: num(k.installed), on: num(k.online) })),
        k.total ? h('div', { style: { minWidth: '180px' } }, h('dt', null, t('Coverage')), h('dd', null, meter(k.installed, k.total, t('{n} of {m} computers have the extension', { n: num(k.installed), m: num(k.total) })))) : null,
        fact(t('AD domain'), c.domain || '—', true),
        fact(t('Domain controller'), c.dc_ip || '—', true),
        fact(t('DC user name'), c.dc_user ? [h('span', { class: 'data' }, c.dc_user), c.hasPassword ? h('span', { class: 'muted' }, ' · ' + t('password saved')) : null] : '—'),
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
    const labels = { computers: [t('Computers'), c.computerList.filter((p) => p.listed).length], details: [t('Details'), null] };
    replace(tabsEl, TABS.map((k) => h('button', { role: 'tab', type: 'button', 'aria-selected': String(k === tab), onclick: () => switchTab(k) },
      labels[k][0], labels[k][1] != null ? h('span', { class: 'count' }, num(labels[k][1])) : null)));
  }
  function switchTab(k) {
    if (k === tab) return;
    tab = k;
    history.replaceState(null, '', '#/companies/' + id + (k === 'computers' ? '' : '/' + k));
    paintTabs();
    paintTab();
  }
  function paintTab() {
    if (tab === 'computers') paintComputers();
    else replace(tabHost, detailsTab());
  }

  /* ── Computers: AD list with local IP and extension status ── */
  const STATUS = {
    online: () => h('span', { class: 'status status--on' }, t('Online')),
    offline: () => h('span', { class: 'status status--off' }, t('Offline')),
    none: () => h('span', { class: 'muted' }, t('No extension')),
  };
  const POWER = {
    on: () => h('span', { class: 'status status--on' }, t('Turned on')),
    off: () => h('span', { class: 'status status--off' }, t('Turned off')),
    '': () => h('span', { class: 'muted' }, '—'),
  };
  const FILTERS = {
    all: () => true,
    on: (p) => p.power === 'on',
    online: (p) => p.status === 'online',
    offline: (p) => p.status === 'offline',
    none: (p) => p.status === 'none',
    noip: (p) => !p.ip,
  };
  const pcHost = h('div');
  const pcToolbar = h('div', { class: 'toolbar' });
  const dnsLine = h('div');

  function dnsInfo() {
    const d = c.dns;
    const a = c.agent || {};
    const info = a.info || {};
    const setupBtn = h('button', { class: 'btn btn--quiet btn--sm', type: 'button', onclick: agentSetup },
      icon('subnet', 14), a.configured ? t('Reinstall AD agent') : t('Set up AD agent'));
    const row = (...kids) => h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '14px' } }, ...kids);
    if (a.configured && a.seen && a.fresh && !info.error) {
      replace(dnsLine, row(h('span', { class: 'ink-2' },
        t('AD agent on {dc}: {n} computers, {up} answering', { dc: info.dc || c.dc_ip || '—', n: num(info.count || 0), up: num(info.up || 0) }),
        ' · ', when(a.seen)), setupBtn));
      return;
    }
    if (a.configured) {
      const msg = info.error
        ? t('The AD agent on {dc} reports an error: {e}', { dc: info.dc || c.dc_ip || '—', e: info.error })
        : a.seen
          ? t('The AD agent has not reported since {t}. Check the “URL Fleet AD agent” task on the domain controller (log: C:\\ProgramData\\URLFleet\\agent.log).', { t: new Date(a.seen).toLocaleString() })
          : t('Waiting for the first report from the AD agent. Run the install command on the domain controller.');
      replace(dnsLine, row(h('div', { class: 'note note--warn', style: { flex: '1 1 420px', margin: 0 } }, icon('alert', 16), h('div', null, msg)), setupBtn));
      return;
    }
    // No agent yet: offer it, and keep the server-side DNS lookup as a fallback.
    const refresh = h('button', { class: 'btn btn--quiet btn--sm', type: 'button', disabled: !d.configured, onclick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      b.replaceChildren(icon('refresh', 14), t('Looking up…'));
      try {
        const r = (await post('/api/companies/' + id + '/resolve')).dns;
        toast(r.status === 'ok' ? t('{n} of {m} computers found in AD DNS.', { n: r.found, m: r.total }) : t('The domain controller did not answer.'), r.status === 'ok' ? 'ok' : 'error');
        await reload();
      } catch (err) { toast(errText(err), 'error'); b.disabled = false; }
    } }, icon('refresh', 14), t('Refresh IPs'));
    const agentNote = h('div', { class: 'note', style: { flex: '1 1 420px', margin: 0 } }, icon('info', 16),
      h('div', null, t('Install the AD agent on the domain controller: the computer list, local IPs and on/off status then come from AD on their own, new computers appear automatically, and the extension is updated through group policy.')));
    let dnsText = null;
    if (d.configured && d.status === 'ok') {
      dnsText = h('span', { class: 'ink-2' }, t('{n} of {m} IPs found in AD DNS ({dc})', { n: num(d.found), m: num(d.total), dc: c.dc_ip }), ' · ', when(d.checkedAt));
    }
    replace(dnsLine, row(agentNote, setupBtn), d.configured && c.computers.length ? row(dnsText || h('span', { class: 'ink-2' }, t('Server-side DNS lookup')), refresh) : null);
  }

  async function agentSetup() {
    if (c.agent && c.agent.configured && !await confirmDialog({
      title: t('Create a new agent command?'),
      body: t('The new token replaces the old one: the agent that is installed now stops reporting until you run the new command on the domain controller.'),
      confirm: t('Create command'),
    })) return;
    let tok;
    try { tok = (await post('/api/companies/' + id + '/agent-token')).token; } catch (e) { toast(errText(e), 'error'); return; }
    const origin = window.location.origin;
    const cmd = "[Net.ServicePointManager]::SecurityProtocol='Tls12'; & ([scriptblock]::Create((irm " + origin + '/tools/ad/fleet-ad.ps1))) -Install -Server ' + origin + ' -Token ' + tok;
    const dlg = dialog({
      title: t('Set up the AD agent for {company}', { company: c.name }), wide: true,
      intro: t('Run this once on the domain controller. The command contains this company’s token: it is shown only now.'),
      body: [
        h('ol', { class: 'steps' },
          h('li', null, t('Connect to the domain controller (the RDP button above).')),
          h('li', null, t('Open PowerShell as administrator and paste the command.')),
          h('li', null, t('It installs a task that sends the computer list every 5 minutes, and sets up the “URL Fleet - Chrome” group policy: force-install with the fleet update URL and the computer name for the extension.'))),
        h('pre', { class: 'code' }, cmd, copyBtn(cmd)),
      ],
      actions: [h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, t('Done'))],
      onClose: () => reload(),
    });
  }

  const columns = [
    { key: 'n', label: '#', class: 'num', render: (p, i) => h('span', { class: 'muted num' }, i + 1) },
    { key: 'name', label: t('Computer'), sort: (p) => p.name.toLowerCase(),
      render: (p) => [h('b', { class: 'data' }, p.name), !p.listed ? h('span', { class: 'badge badge--warn', style: { marginLeft: '8px' } }, t('Not in the AD list')) : null,
        p.os ? h('span', { class: 'cell-sub' }, p.os) : null] },
    { key: 'ip', label: t('Local IP'), sort: (p) => (p.ip ? p.ip.split('.').map((x) => x.padStart(3, '0')).join('.') : '~'),
      render: (p) => (p.ip ? [h('span', { class: 'data' }, p.ip), p.ipSource === 'manual' ? h('span', { class: 'cell-sub' }, t('typed in')) : null] : h('span', { class: 'muted' }, '—')) },
    { key: 'power', label: t('Computer status'), sort: (p) => ({ on: 0, off: 1, '': 2 }[p.power]),
      render: (p) => [POWER[p.power](), p.power === 'off' && p.lastUp ? h('span', { class: 'cell-sub' }, t('Last on {t}', { t: new Date(p.lastUp).toLocaleString() })) : null] },
    { key: 'status', label: t('Extension'), sort: (p) => ({ online: 0, offline: 1, none: 2 }[p.status]), render: (p) => STATUS[p.status]() },
    { key: 'version', label: t('Version'), sort: (p) => p.version || '', render: (p) => (p.version ? h('span', { class: 'ver' }, p.version) : h('span', { class: 'muted' }, '—')) },
    { key: 'seen', label: t('Last check-in'), sort: (p) => p.lastSeen || '', defaultDir: 'desc', render: (p) => (p.lastSeen ? when(p.lastSeen) : h('span', { class: 'muted' }, '—')) },
  ];

  function paintComputers() {
    dnsInfo();
    const list = c.computerList;
    const counts = {};
    for (const k of Object.keys(FILTERS)) counts[k] = list.filter(FILTERS[k]).length;
    replace(pcToolbar,
      searchBox(pcState.q, (q) => { pcState.q = q; paintTable(); }, t('Find a computer or IP')),
      chips([
        { value: 'all', label: t('All'), count: counts.all },
        (counts.on || (c.agent && c.agent.configured)) ? { value: 'on', label: t('Turned on'), count: counts.on } : null,
        { value: 'online', label: t('Extension online'), count: counts.online },
        { value: 'offline', label: t('Extension offline'), count: counts.offline },
        { value: 'none', label: t('No extension'), count: counts.none },
        { value: 'noip', label: t('No IP'), count: counts.noip },
      ].filter(Boolean), pcState.filter, (f) => { pcState.filter = f; paintTable(); }, { label: t('Filter computers') }));
    replace(tabHost, dnsLine, pcToolbar, pcHost,
      c.unnamedBrowsers ? h('div', { class: 'note', style: { marginTop: '14px' } }, icon('info', 16), h('div', null,
        tn(c.unnamedBrowsers, '{n} browser in this company does not report its computer name yet. Its extension status appears after extension 2.5.0 and the computerName policy reach it (the AD agent sets the policy up).', '{n} browsers in this company do not report their computer name yet. Their extension status appears after extension 2.5.0 and the computerName policy reach them (the AD agent sets the policy up).'))) : null);
    paintTable();
  }

  function paintTable() {
    const q = pcState.q.trim().toLowerCase();
    let rows = c.computerList.filter(FILTERS[pcState.filter] || FILTERS.all);
    if (q) rows = rows.filter((p) => p.name.toLowerCase().includes(q) || (p.ip || '').includes(q));
    rows = sortRows(rows, columns, pcState.sort);
    if (!c.computerList.length) {
      replace(pcHost, h('section', { class: 'panel' }, empty('monitor', t('No AD computer list'), t('Set up the AD agent above, or paste the computer names in Details, one per line.'),
        h('button', { class: 'btn btn--quiet', onclick: () => switchTab('details') }, t('Open details')))));
      return;
    }
    if (!rows.length) { replace(pcHost, h('section', { class: 'panel' }, empty('search', t('Nothing matches “{q}”.', { q: pcState.q || pcState.filter }), null))); return; }
    replace(pcHost, h('section', { class: 'panel panel--flush' }, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      sortableHead(columns, pcState.sort, (st) => { pcState.sort = st; paintTable(); }),
      h('tbody', null, rows.map((p, i) => h('tr', null, columns.map((col) => h('td', { class: col.class || (col.key === 'seen' ? 'nowrap' : null) }, col.render(p, i))))))))));
  }

  /* ── Details ── */

  /* AD password: hidden by default; the eye button loads the saved one from the
   * server (audited) and shows it. Left empty, the saved password stays. */
  function passwordField() {
    const input = h('input', { id: 'cd-dc_password', class: 'input data', type: 'password', autocomplete: 'new-password', spellcheck: 'false',
      placeholder: c.hasPassword ? t('Saved — type a new one to change it') : t('Not saved') });
    let saved = null;
    const eye = h('button', { class: 'pw-eye', type: 'button', title: t('Show password'), 'aria-label': t('Show password'), 'aria-controls': 'cd-dc_password' }, icon('eye', 17));
    function paintEye(shown) {
      eye.replaceChildren(icon(shown ? 'eyeOff' : 'eye', 17));
      const label = shown ? t('Hide password') : t('Show password');
      eye.title = label;
      eye.setAttribute('aria-label', label);
      eye.setAttribute('aria-pressed', String(shown));
    }
    eye.addEventListener('click', async () => {
      if (input.type === 'text') { input.type = 'password'; paintEye(false); return; }
      if (!input.value && c.hasPassword && saved === null) {
        eye.disabled = true;
        try {
          saved = (await post('/api/companies/' + id + '/password')).password || '';
          input.value = saved;
        } catch (e) { toast(errText(e), 'error'); return; } finally { eye.disabled = false; }
      }
      input.type = 'text';
      paintEye(true);
    });
    const error = h('div', { class: 'field-error' });
    const remove = c.hasPassword ? h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: async () => {
      if (!await confirmDialog({ title: t('Remove the saved password?'), body: t('The RDP button then uses the user name and password saved on your computer.'), confirm: t('Remove'), danger: true })) return;
      try { await post('/api/companies/' + id, { dc_password: '', rev: c.rev }); toast(t('Password removed.')); await reload(); } catch (e) { toast(errText(e), 'error'); }
    } }, icon('trash', 14), t('Remove saved password')) : null;
    const node = h('div', { class: 'field' },
      h('label', { for: 'cd-dc_password' }, t('DC password')),
      h('div', { class: 'pw-wrap' }, input, eye),
      h('div', { class: 'field-hint' }, t('Stored encrypted on the fleet server. Viewing it and every RDP connection are written to the activity log.')),
      remove ? h('div', { class: 'field-actions' }, remove) : null,
      error);
    return { node, input, error, changed: () => input.value !== '' && input.value !== saved };
  }

  function detailsTab() {
    const fields = companyFields({ ...c, computers: c.computers.map((n) => (c.manualIps[n.toLowerCase()] ? n + ' ' + c.manualIps[n.toLowerCase()] : n)) });
    const inputs = {};
    const errs = {};
    const pw = passwordField();
    const form = h('form', { class: 'form-grid', onsubmit: async (e) => {
      e.preventDefault();
      Object.values(errs).forEach((x) => { x.textContent = ''; });
      const v = {};
      for (const [k, el] of Object.entries(inputs)) v[k] = el.value;
      const body = { ...companyPayload(v), rev: c.rev };
      if (pw.changed()) body.dc_password = pw.input.value;
      try {
        await post('/api/companies/' + id, body);
        toast(t('Company details saved.'));
        await reload();
      } catch (err) {
        if (err.status === 409 && err.data.stale) { staleReload(); return; }
        let shown = false;
        for (const [k, msg] of Object.entries(err.fields || {})) if (errs[k]) { errs[k].textContent = t(msg); shown = true; }
        if (err.fields && err.fields.dc_password) { pw.error.textContent = t(err.fields.dc_password); shown = true; }
        if (!shown) toast(errText(err), 'error');
      }
    } }, fields.flatMap((f) => {
      const fid = 'cd-' + f.name;
      const el = f.type === 'textarea'
        ? h('textarea', { id: fid, class: 'input' + (f.mono ? ' data' : ''), rows: f.rows || 4, placeholder: f.placeholder || '', spellcheck: 'false' })
        : h('input', { id: fid, class: 'input' + (f.mono ? ' data' : ''), placeholder: f.placeholder || '', spellcheck: 'false' });
      el.value = f.value;
      inputs[f.name] = el;
      errs[f.name] = h('div', { class: 'field-error' });
      const node = h('div', { class: 'field' + (f.span ? ' span-2' : '') }, h('label', { for: fid }, f.label), el, f.hint ? h('div', { class: 'field-hint' }, f.hint) : null, errs[f.name]);
      return f.name === 'dc_user' ? [node, pw.node] : [node];
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
      if (tab !== 'computers' || (document.activeElement && document.activeElement.closest('.toolbar'))) return;
      try { await fetchAll(); replace(headHost, header()); paintTabs(); paintComputers(); } catch (_) { /* keep */ }
    },
  };
}
