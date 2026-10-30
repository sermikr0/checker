import { h, icon, replace, store, download, browserOf, versionCmp } from '../dom.js';
import { api, post } from '../api.js';
import { t, tn, num } from '../i18n.js';
import {
  status, when, empty, seg, searchBox, sortableHead, sortRows, confirmDialog, choiceDialog, toast, errText, matchInfo,
} from '../ui.js';
import { loading, failed, versionTag } from './common.js';

const PAGE = 200;

export async function render(page, params, ctx) {
  document.title = t('Devices') + ' — Fleet';
  const state = Object.assign({ q: '', status: 'all', company: 'all', version: 'all', sort: { key: 'seen', dir: 'desc' } }, store('devices') || {});
  const save = () => store('devices', state);
  const selected = new Set();
  let shown = PAGE;
  let devices = [];
  let companies = [];
  let latest = '';
  let editing = null;

  page.append(h('header', { class: 'page-head' },
    h('div', { class: 'titles' }, h('h1', { class: 'page-title' }, t('Devices')),
      h('p', { class: 'page-sub' }, t('Every browser that runs the extension. Name them so people can be recognised, pin them to a company when the address is shared.'))),
    h('div', { class: 'page-actions' },
      h('button', { class: 'btn btn--quiet', type: 'button', onclick: exportCsv }, icon('download', 16), t('Export CSV')),
      h('button', { class: 'btn btn--quiet', type: 'button', onclick: prune }, icon('trash', 16), t('Remove inactive')))));
  const toolbar = h('div', { class: 'toolbar' });
  const selBar = h('div');
  const tableHost = h('div');
  page.append(toolbar, selBar, tableHost);
  tableHost.append(loading());

  function filtered() {
    const q = state.q.trim().toLowerCase();
    return devices.filter((d) => {
      if (state.status === 'online' && !d.online) return false;
      if (state.status === 'offline' && d.online) return false;
      if (state.company === 'none' && d.company_id_effective != null) return false;
      if (state.company !== 'all' && state.company !== 'none' && String(d.company_id_effective) !== state.company) return false;
      if (state.version !== 'all' && (d.version || '') !== state.version) return false;
      if (q && ![d.label, d.device_id, d.last_ip, d.version, d.company, d.user_agent].some((v) => String(v || '').toLowerCase().includes(q))) return false;
      return true;
    });
  }

  function paintToolbar() {
    const on = devices.filter((d) => d.online).length;
    const versions = [...new Set(devices.map((d) => d.version || ''))].sort((a, b) => versionCmp(b, a));
    const companySel = h('select', { class: 'input', 'aria-label': t('Company'), onchange: (e) => { state.company = e.target.value; save(); shown = PAGE; paint(); } },
      h('option', { value: 'all' }, t('All companies')),
      h('option', { value: 'none' }, t('Without a company')),
      companies.map((c) => h('option', { value: String(c.id) }, c.name)));
    companySel.value = state.company;
    if (companySel.value !== state.company) { state.company = 'all'; companySel.value = 'all'; }
    const versionSel = h('select', { class: 'input', 'aria-label': t('Version'), onchange: (e) => { state.version = e.target.value; save(); shown = PAGE; paint(); } },
      h('option', { value: 'all' }, t('All versions')),
      versions.map((v) => h('option', { value: v }, v ? 'v' + v : t('unknown'))));
    versionSel.value = state.version;
    if (versionSel.value !== state.version) { state.version = 'all'; versionSel.value = 'all'; }
    replace(toolbar,
      searchBox(state.q, (q) => { state.q = q; save(); shown = PAGE; paint(); }, t('Search name, ID, address…')),
      seg([
        { value: 'all', label: t('All'), count: num(devices.length) },
        { value: 'online', label: t('Online'), count: num(on) },
        { value: 'offline', label: t('Offline'), count: num(devices.length - on) },
      ], state.status, (v) => { state.status = v; save(); shown = PAGE; paint(); }, { label: t('Status') }),
      companySel, versionSel);
  }

  const columns = [
    { key: 'status', label: t('Status'), sort: (d) => (d.online ? 0 : 1), render: (d) => status(d.online) },
    { key: 'label', label: t('Name'), sort: (d) => (d.label || '~').toLowerCase(), render: (d) => labelCell(d) },
    { key: 'company', label: t('Company'), sort: (d) => (d.company || '~').toLowerCase(),
      render: (d) => [d.company ? h('a', { href: '#/companies/' + d.company_id_effective, style: { fontWeight: 700 } }, d.company) : h('span', { class: 'muted' }, t('No company')), h('div', null, matchInfo(d))] },
    { key: 'ip', label: t('Address'), sort: (d) => d.last_ip || '', render: (d) => h('span', { class: 'data' }, d.last_ip || '—') },
    { key: 'version', label: t('Version'), sort: (d) => d.version || '', render: (d) => versionTag(d.version, latest) },
    { key: 'browser', label: t('Browser'), render: (d) => h('span', { class: 'nowrap', title: d.user_agent || '' }, browserOf(d.user_agent) || '—') },
    { key: 'first', label: t('Enrolled'), sort: (d) => d.first_seen || '', defaultDir: 'desc', render: (d) => when(d.first_seen) },
    { key: 'seen', label: t('Last check-in'), sort: (d) => d.last_seen || '', defaultDir: 'desc', render: (d) => when(d.last_seen) },
  ];

  function labelCell(d) {
    if (editing === d.device_id) {
      const input = h('input', { class: 'input label-input', value: d.label || '', maxlength: 120, 'aria-label': t('Device name') });
      let done = false;
      const finish = async (saveIt) => {
        if (done) return;
        done = true;
        editing = null;
        if (saveIt && input.value.trim() !== (d.label || '')) {
          try {
            await post('/api/devices/update', { deviceIds: [d.device_id], label: input.value.trim() });
            d.label = input.value.trim();
            toast(t('Name saved.'));
          } catch (e) { toast(errText(e), 'error'); }
        }
        paint();
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
      input.addEventListener('blur', () => finish(true));
      setTimeout(() => { input.focus(); input.select(); }, 0);
      return [input, h('span', { class: 'cell-sub data' }, d.device_id.slice(0, 13))];
    }
    return [h('button', { type: 'button', class: 'label-edit' + (d.label ? '' : ' is-empty'), title: t('Rename'), onclick: () => { editing = d.device_id; paint(); } },
      d.label || t('Add a name')), h('span', { class: 'cell-sub data', title: d.device_id }, d.device_id.slice(0, 13))];
  }

  function paintSelection() {
    if (!selected.size) { replace(selBar); return; }
    const pinSel = h('select', { class: 'input', 'aria-label': t('Pin to company') },
      h('option', { value: '' }, t('Pin to company…')), companies.map((c) => h('option', { value: c.id }, c.name)));
    pinSel.addEventListener('change', async () => {
      const cid = Number(pinSel.value);
      if (!cid) return;
      try {
        await post('/api/devices/update', { deviceIds: [...selected], companyId: cid });
        toast(tn(selected.size, '{n} device pinned.', '{n} devices pinned.'));
        selected.clear();
        load();
      } catch (e) { toast(errText(e), 'error'); }
    });
    replace(selBar, h('div', { class: 'selection-bar' },
      h('span', null, tn(selected.size, '{n} selected', '{n} selected')), pinSel,
      h('button', { class: 'btn btn--quiet btn--sm', type: 'button', onclick: async () => {
        try { await post('/api/devices/update', { deviceIds: [...selected], companyId: null }); toast(t('Pins removed.')); selected.clear(); load(); } catch (e) { toast(errText(e), 'error'); }
      } }, t('Remove pin')),
      h('button', { class: 'btn btn--quiet btn--sm', type: 'button', onclick: async () => {
        if (!await confirmDialog({ title: tn(selected.size, 'Delete {n} device?', 'Delete {n} devices?'), body: t('They reappear on their next check-in if the extension is still installed.'), confirm: t('Delete'), danger: true })) return;
        try { await post('/api/devices/delete', { deviceIds: [...selected] }); toast(t('Deleted.')); selected.clear(); load(); ctx.refreshBadges(); } catch (e) { toast(errText(e), 'error'); }
      } }, icon('trash', 14), t('Delete')),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--quiet btn--sm', type: 'button', onclick: () => { selected.clear(); paint(); } }, t('Clear selection'))));
  }

  function paint() {
    const rows = sortRows(filtered(), columns, state.sort);
    const visible = rows.slice(0, shown);
    for (const id of [...selected]) if (!devices.some((d) => d.device_id === id)) selected.delete(id);
    const all = h('input', { type: 'checkbox', class: 'check', 'aria-label': t('Select all'),
      checked: visible.length > 0 && visible.every((d) => selected.has(d.device_id)),
      onchange: (e) => { visible.forEach((d) => (e.target.checked ? selected.add(d.device_id) : selected.delete(d.device_id))); paint(); } });
    paintSelection();
    if (!devices.length) {
      replace(tableHost, h('section', { class: 'panel' }, empty('monitor', t('No devices yet'), t('Devices appear after the extension is installed and checks in.'),
        h('a', { class: 'btn btn--quiet', href: '#/updates' }, t('Show the install policy')))));
      return;
    }
    if (!rows.length) {
      replace(tableHost, h('section', { class: 'panel' }, empty('search', t('No devices match'), t('Change the search or the filters.'),
        h('button', { class: 'btn btn--quiet', onclick: () => { Object.assign(state, { q: '', status: 'all', company: 'all', version: 'all' }); save(); paintToolbar(); paint(); } }, t('Clear filters')))));
      return;
    }
    replace(tableHost, h('section', { class: 'panel panel--flush' },
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        sortableHead(columns, state.sort, (s) => { state.sort = s; save(); paint(); }, { selectAll: all }),
        h('tbody', null, visible.map((d) => h('tr', { class: selected.has(d.device_id) ? 'is-selected' : '' },
          h('td', { class: 'w-check' }, h('input', { type: 'checkbox', class: 'check', checked: selected.has(d.device_id), 'aria-label': t('Select'),
            onchange: (e) => { if (e.target.checked) selected.add(d.device_id); else selected.delete(d.device_id); paint(); } })),
          columns.map((c) => h('td', { class: c.key === 'browser' || c.key === 'seen' || c.key === 'first' ? 'nowrap' : null }, c.render(d)))))))),
      rows.length > shown ? h('div', { class: 'more-row' }, h('button', { class: 'btn btn--quiet', onclick: () => { shown += PAGE; paint(); } },
        t('Show {n} more', { n: Math.min(PAGE, rows.length - shown) }))) : null));
  }

  function exportCsv() {
    const rows = sortRows(filtered(), columns, state.sort);
    // Cells that start with = + - @ or a control character would run as formulas in Excel.
    const esc = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const lines = [['device_id', 'name', 'company', 'match', 'online', 'ip', 'version', 'browser', 'first_seen', 'last_seen'].join(',')];
    for (const d of rows) lines.push([d.device_id, d.label, d.company, d.match, d.online ? 'yes' : 'no', d.last_ip, d.version, browserOf(d.user_agent), d.first_seen, d.last_seen].map(esc).join(','));
    download('devices-' + new Date().toISOString().slice(0, 10) + '.csv', '﻿' + lines.join('\r\n'), 'text/csv');
  }

  async function prune() {
    const v = await choiceDialog({
      title: t('Remove inactive devices'), intro: t('Deletes browsers that have not checked in for a while — usually reinstalled or retired PCs.'), value: '604800',
      choices: [
        { value: '86400', title: t('Silent for more than 1 day') },
        { value: '604800', title: t('Silent for more than 7 days') },
        { value: '2592000', title: t('Silent for more than 30 days') },
      ], submit: t('Remove'),
    });
    if (!v) return;
    try {
      const r = await post('/api/devices/prune', { olderThanSec: Number(v) });
      toast(tn(r.removed, '{n} device removed.', '{n} devices removed.'));
      load();
      ctx.refreshBadges();
    } catch (e) { toast(errText(e), 'error'); }
  }

  async function load(soft) {
    try {
      const [dr, cr, rr] = await Promise.all([api('/api/devices'), api('/api/companies'), api('/api/releases').catch(() => null)]);
      devices = dr.devices;
      companies = cr.companies;
      latest = rr && rr.release ? rr.release.version : '';
    } catch (e) {
      if (!soft) replace(tableHost, failed(e, load));
      return;
    }
    if (!soft) paintToolbar();
    paint();
  }
  await load();
  return { refresh: () => { if (!editing && !selected.size && !(document.activeElement && document.activeElement.closest('.toolbar'))) load(true); } };
}

