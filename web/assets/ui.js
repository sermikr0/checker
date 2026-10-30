// Shared UI pieces: dialogs, toasts, plates, lanes, tables, domain list editor.
import { h, icon, clear, append } from './dom.js';
import { t, tn, relTime, dateTime } from './i18n.js';

/* ── Toasts ───────────────────────────────────────────────────────────── */

let toastRoot = null;
export function toast(message, kind = 'ok') {
  if (!toastRoot) {
    toastRoot = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastRoot);
  }
  const el = h('div', { class: 'toast toast--' + kind },
    icon(kind === 'error' ? 'alert' : kind === 'info' ? 'info' : 'check', 16), h('div', null, message));
  toastRoot.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}

export function errText(e) {
  if (!e) return t('Something went wrong.');
  if (e.status === 0) return t('The server cannot be reached. Check the connection and try again.');
  if (e.status === 429) return t('Too many attempts. Wait a few minutes and try again.');
  if (e.status === 403 && /CSRF/.test(e.message)) return t('Your session expired. Reload the page.');
  return t(e.message) || t('Something went wrong.');
}

/* ── Dialogs ──────────────────────────────────────────────────────────── */

export function dialog({ title, intro, body = [], actions = [], onClose, wide }) {
  const dlg = h('dialog', { class: 'dlg', style: wide ? { width: 'min(680px, calc(100vw - 32px))' } : null },
    h('div', { class: 'dlg-head' }, h('h2', null, title), intro ? h('p', null, intro) : null),
    h('div', { class: 'dlg-body' }, body),
    actions.length ? h('div', { class: 'dlg-foot' }, actions) : null);
  document.body.append(dlg);
  dlg.addEventListener('close', () => { dlg.remove(); if (onClose) onClose(dlg.returnValue); });
  dlg.showModal();
  const first = dlg.querySelector('input:not([type=hidden]), select, textarea');
  if (first) first.focus();
  return dlg;
}

export function confirmDialog({ title, body, confirm = t('Confirm'), danger = false }) {
  return new Promise((resolve) => {
    let ok = false;
    const yes = h('button', { class: 'btn ' + (danger ? 'btn--danger' : ''), onclick: () => { ok = true; dlg.close(); } }, confirm);
    const no = h('button', { class: 'btn btn--quiet', onclick: () => dlg.close() }, t('Cancel'));
    const dlg = dialog({ title, intro: body, actions: [no, yes], onClose: () => resolve(ok) });
    yes.focus();
  });
}

/**
 * fields: [{ name, label, type: text|textarea|select|password, value, placeholder, hint, options, mono, span }]
 * onSubmit(values) may throw an ApiError with .fields to show errors next to inputs.
 */
export function formDialog({ title, intro, fields, submit = t('Save'), onSubmit, wide }) {
  return new Promise((resolve) => {
    let result = null;
    const inputs = {};
    const errors = {};
    const rows = fields.map((f) => {
      let input;
      const id = 'f-' + f.name + '-' + Math.random().toString(36).slice(2, 7);
      const cls = 'input' + (f.mono ? ' data' : '');
      if (f.type === 'textarea') {
        input = h('textarea', { id, class: cls, rows: f.rows || 5, placeholder: f.placeholder || '', spellcheck: 'false' });
        input.value = f.value ?? '';
      } else if (f.type === 'select') {
        input = h('select', { id, class: 'input' }, f.options.map((o) => h('option', { value: o.value }, o.label)));
        input.value = f.value ?? '';
      } else {
        input = h('input', { id, class: cls, type: f.type || 'text', placeholder: f.placeholder || '', autocomplete: f.autocomplete || 'off', spellcheck: 'false' });
        input.value = f.value ?? '';
      }
      inputs[f.name] = input;
      errors[f.name] = h('div', { class: 'field-error', 'aria-live': 'polite' });
      return h('div', { class: 'field' + (f.span ? ' span-2' : '') },
        h('label', { for: id }, f.label), input,
        f.hint ? h('div', { class: 'field-hint' }, f.hint) : null, errors[f.name]);
    });
    const general = h('div', { class: 'field-error' });
    const btn = h('button', { class: 'btn', type: 'submit' }, submit);
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault();
      Object.values(errors).forEach((el) => { el.textContent = ''; });
      Object.values(inputs).forEach((el) => el.classList.remove('is-invalid'));
      general.textContent = '';
      const values = {};
      for (const [k, el] of Object.entries(inputs)) values[k] = el.value;
      btn.disabled = true;
      try {
        result = onSubmit ? (await onSubmit(values)) ?? values : values;
        dlg.close();
      } catch (err) {
        const fe = (err && err.fields) || {};
        let shown = false;
        for (const [k, msg] of Object.entries(fe)) {
          if (errors[k]) { errors[k].textContent = t(msg); inputs[k].classList.add('is-invalid'); shown = true; }
        }
        if (!shown) general.textContent = errText(err);
      } finally {
        btn.disabled = false;
      }
    } }, h('div', { class: 'dlg-body' }, wide ? h('div', { class: 'form-grid' }, rows) : rows, general));
    const cancel = h('button', { class: 'btn btn--quiet', type: 'button', onclick: () => dlg.close() }, t('Cancel'));
    form.append(h('div', { class: 'dlg-foot' }, cancel, btn));
    const dlg = h('dialog', { class: 'dlg', style: wide ? { width: 'min(720px, calc(100vw - 32px))' } : null },
      h('div', { class: 'dlg-head' }, h('h2', null, title), intro ? h('p', null, intro) : null), form);
    document.body.append(dlg);
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    dlg.showModal();
    const first = form.querySelector('input, textarea, select');
    if (first) first.focus();
  });
}

/** choices: [{ value, title, desc }] → resolves the chosen value or null */
export function choiceDialog({ title, intro, choices, value, submit = t('Continue') }) {
  return new Promise((resolve) => {
    let result = null;
    const name = 'c' + Math.random().toString(36).slice(2, 7);
    const cards = choices.map((c) => h('label', { class: 'radio-card' },
      h('input', { type: 'radio', name, value: c.value, checked: c.value === value }),
      h('div', null, h('b', null, c.title), c.desc ? h('span', null, c.desc) : null)));
    const ok = h('button', { class: 'btn', onclick: () => {
      const sel = dlg.querySelector('input[name="' + name + '"]:checked');
      result = sel ? sel.value : null;
      dlg.close();
    } }, submit);
    const dlg = dialog({ title, intro, body: cards, actions: [h('button', { class: 'btn btn--quiet', onclick: () => dlg.close() }, t('Cancel')), ok],
      onClose: () => resolve(result) });
  });
}

/* ── Plates, status, lanes, meters ────────────────────────────────────── */

export const MODE_LABEL = {
  off: () => t('All sites open'),
  blacklist: () => t('Blacklist'),
  whitelist: () => t('Whitelist only'),
  inherit: () => t('Global policy'),
};

export function plate(mode, { size, label } = {}) {
  const m = MODE_LABEL[mode] ? mode : 'off';
  return h('span', { class: ['plate', 'plate--' + m, size ? 'plate--' + size : ''] }, label || MODE_LABEL[m]());
}

export function status(online) {
  return h('span', { class: 'status ' + (online ? 'status--on' : 'status--off') }, online ? t('Online') : t('Offline'));
}

/** One tick per device (online first); falls back to a bar for big fleets. */
export function lane(online, total, { max = 44 } = {}) {
  if (!total) return h('div', { class: 'lane-empty', title: t('No devices yet') });
  const label = t('{on} online, {off} offline', { on: online, off: total - online });
  if (total > max) {
    return h('div', { class: 'lane--bar', role: 'img', 'aria-label': label, title: label },
      online ? h('span', { style: { width: (online / total * 100).toFixed(1) + '%' } }) : null);
  }
  const ticks = [];
  for (let i = 0; i < total; i++) ticks.push(h('i', { class: i < online ? 'on' : '', style: { '--i': i } }));
  return h('div', { class: 'lane', role: 'img', 'aria-label': label, title: label }, ticks);
}

export function meter(value, max, label) {
  const pct = max ? Math.min(100, Math.round(value / max * 100)) : 0;
  return h('div', { class: 'meter' },
    h('div', { class: 'meter-track', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': max || 0, 'aria-valuenow': value, 'aria-label': label },
      h('div', { class: 'meter-fill', style: { width: pct + '%' } })),
    h('div', { class: 'meter-label' }, label));
}

export function matchInfo(d) {
  const map = {
    pinned: ['pin', t('Pinned manually')],
    computer: ['monitor', t('By computer name')],
    nat: ['route', t('By NAT address')],
    subnet: ['subnet', t('By subnet')],
    ambiguous: ['alert', t('Several companies match')],
    none: ['question', t('No company matches')],
  };
  const [ic, label] = map[d.match] || map.none;
  const title = d.match === 'ambiguous' && d.candidates?.length ? label + ': ' + d.candidates.join(', ') : label;
  return h('span', { class: 'match' + (d.match === 'ambiguous' ? ' match--ambiguous' : ''), title }, icon(ic, 13),
    d.match === 'ambiguous' ? t('Ambiguous') : d.match === 'none' ? t('Unassigned') : label);
}

export function when(iso) {
  if (!iso) return h('span', { class: 'muted' }, '—');
  return h('time', { datetime: iso, title: dateTime(iso) }, relTime(iso));
}

export function empty(iconName, title, text, action) {
  return h('div', { class: 'empty' }, icon(iconName, 28), h('h3', null, title), text ? h('p', null, text) : null, action || null);
}

export function copyBtn(text, { ghost = true } = {}) {
  const b = h('button', { class: 'btn btn--sm btn--icon copy ' + (ghost ? 'btn--ghost' : 'btn--quiet'), title: t('Copy'), 'aria-label': t('Copy') }, icon('copy', 15));
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(typeof text === 'function' ? text() : text); toast(t('Copied')); } catch (_) { toast(t('Copy failed — select the text manually.'), 'error'); }
  });
  return b;
}

export function seg(options, value, onChange, { label } = {}) {
  const el = h('div', { class: 'seg', role: 'group', 'aria-label': label || null });
  const set = (v) => { value = v; el.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v))); };
  for (const o of options) {
    el.append(h('button', { type: 'button', dataset: { v: o.value }, 'aria-pressed': String(o.value === value), onclick: () => { set(o.value); onChange(o.value); } },
      o.icon ? icon(o.icon, 15) : null, o.label, o.count != null ? h('span', { class: 'count' }, o.count) : null));
  }
  el.set = set;
  return el;
}

export function chips(options, value, onChange, { label } = {}) {
  const el = h('div', { class: 'chips', role: 'group', 'aria-label': label || null });
  for (const o of options) {
    el.append(h('button', { type: 'button', class: 'chip', 'aria-pressed': String(o.value === value), onclick: () => {
      el.querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      el.querySelector('[data-v="' + CSS.escape(o.value) + '"]').setAttribute('aria-pressed', 'true');
      onChange(o.value);
    }, dataset: { v: o.value } }, o.label, o.count != null ? h('span', { class: 'count' }, o.count) : null));
  }
  return el;
}

export function searchBox(value, onInput, placeholder) {
  const input = h('input', { class: 'input', type: 'search', placeholder, value: value || '', 'aria-label': placeholder });
  input.addEventListener('input', () => onInput(input.value));
  return h('div', { class: 'input-icon grow' }, icon('search', 16), input);
}

/* ── Sortable table ───────────────────────────────────────────────────── */

/**
 * columns: [{ key, label, sort?: row => value, render: row => node, class?, thClass? }]
 * state: { key, dir }   onSort(newState)
 */
export function sortableHead(columns, state, onSort, extra = {}) {
  const tr = h('tr');
  if (extra.selectAll) tr.append(h('th', { class: 'w-check' }, extra.selectAll));
  for (const c of columns) {
    const th = h('th', { class: c.thClass || c.class || null, scope: 'col' });
    if (c.sort) {
      const active = state.key === c.key;
      if (active) th.setAttribute('aria-sort', state.dir === 'asc' ? 'ascending' : 'descending');
      th.append(h('button', { type: 'button', onclick: () => onSort({ key: c.key, dir: active && state.dir === 'asc' ? 'desc' : active ? 'asc' : (c.defaultDir || 'asc') }) },
        c.label, active ? icon(state.dir === 'asc' ? 'arrowUp' : 'arrowDown', 12) : null));
    } else {
      th.append(c.label || '');
    }
    tr.append(th);
  }
  return h('thead', null, tr);
}

export function sortRows(rows, columns, state) {
  const col = columns.find((c) => c.key === state.key && c.sort);
  if (!col) return rows;
  const dir = state.dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const va = col.sort(a), vb = col.sort(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string' || typeof vb === 'string') return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' }) * dir;
    return (va - vb) * dir;
  });
}

/* ── Domain list editor ───────────────────────────────────────────────── */

export function normalizeDomain(item) {
  let s = String(item || '').trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '').replace(/^\*\./, '').replace(/:\d+$/, '').replace(/^\.+|\.+$/g, '');
  if (!s || s.length > 253 || !/^[a-z0-9.-]+$/.test(s) || s.includes('..')) return '';
  return s;
}

export function parseDomains(text) {
  const valid = [], invalid = [], seen = new Set();
  for (const raw of String(text || '').split(/[\s,;]+/)) {
    if (!raw.trim()) continue;
    const d = normalizeDomain(raw);
    if (!d) invalid.push(raw.trim());
    else if (!seen.has(d)) { seen.add(d); valid.push(d); }
  }
  return { valid, invalid };
}

/**
 * Editable domain list. tone: 'allow' | 'block'.
 * Returns { el, get(), set(list) }; onChange(list) fires on every edit.
 */
export function domainEditor({ title, hint, tone = 'allow', items = [], onChange, placeholder }) {
  let list = [...items];
  const fresh = new Set();
  let filter = '';
  const count = h('span', { class: 'count' });
  const ul = h('ul', { class: 'dlist-items' });
  const err = h('div', { class: 'dlist-error hidden', role: 'alert' });
  const input = h('input', { class: 'input', placeholder: placeholder || t('example.com'), spellcheck: 'false', 'aria-label': title });
  const filterBox = h('div', { class: 'dlist-filter hidden' },
    h('input', { class: 'input', type: 'search', placeholder: t('Find in list'), 'aria-label': t('Find in list'), oninput: (e) => { filter = e.target.value.trim().toLowerCase(); render(); } }));

  function add() {
    const { valid, invalid } = parseDomains(input.value);
    let added = 0;
    for (const d of valid) if (!list.includes(d)) { list.push(d); fresh.add(d); added++; }
    if (invalid.length) {
      err.textContent = t('Not a domain: {list}', { list: invalid.slice(0, 4).join(', ') });
      err.classList.remove('hidden');
      input.value = invalid.join('\n');
    } else {
      err.classList.add('hidden');
      input.value = '';
    }
    if (added) { render(); onChange && onChange([...list]); }
    input.focus();
  }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  input.addEventListener('paste', () => setTimeout(() => { if (/[\s,;]/.test(input.value.trim())) add(); }, 0));

  function render() {
    count.textContent = tn(list.length, '{n} domain', '{n} domains');
    filterBox.classList.toggle('hidden', list.length < 12);
    clear(ul);
    const shown = list.filter((d) => !filter || d.includes(filter));
    if (!list.length) {
      ul.append(h('li', { class: 'dlist-empty' }, tone === 'allow' ? t('No allowed domains yet.') : t('No blocked domains yet.')));
      return;
    }
    if (!shown.length) { ul.append(h('li', { class: 'dlist-empty' }, t('Nothing matches “{q}”.', { q: filter }))); return; }
    for (const d of shown) {
      ul.append(h('li', { class: fresh.has(d) ? 'is-new' : '' },
        h('span', { class: 'd', title: d }, d),
        h('button', { class: 'btn btn--ghost btn--sm btn--icon rm', title: t('Remove {d}', { d }), 'aria-label': t('Remove {d}', { d }), onclick: () => {
          list = list.filter((x) => x !== d);
          render();
          onChange && onChange([...list]);
        } }, icon('x', 14))));
    }
  }
  render();
  const el = h('section', { class: 'dlist dlist--' + tone },
    h('div', null,
      h('div', { class: 'dlist-head' }, h('h3', null, h('span', { class: 'swatch' }), title), count),
      hint ? h('div', { class: 'field-hint', style: { padding: '8px 14px 10px' } }, hint) : null,
      h('div', { class: 'dlist-add' }, input, h('button', { class: 'btn btn--quiet', type: 'button', onclick: add }, icon('plus', 15), t('Add'))),
      err),
    filterBox, ul);
  return {
    el,
    get: () => [...list],
    set: (l) => { list = [...l]; fresh.clear(); render(); },
  };
}

export { relTime, dateTime, append };
