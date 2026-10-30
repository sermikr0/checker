import { h, icon, replace } from '../dom.js';
import { api, post } from '../api.js';
import { t, tn, num } from '../i18n.js';
import { plate, domainEditor, confirmDialog, toast, errText, empty, MODE_LABEL } from '../ui.js';
import { loading, failed } from './common.js';

export async function render(page, params, ctx) {
  document.title = t('Global policy') + ' — Fleet';
  page.append(loading());
  let data;
  try {
    data = await api('/api/policy');
  } catch (e) {
    replace(page, failed(e));
    return {};
  }

  let mode = data.policy.enforceMode;
  let wl = [...data.policy.whitelist];
  let bl = [...data.policy.blacklist];
  let orig = JSON.stringify([mode, wl, bl]);
  let dirty = false;

  const setDirty = () => {
    dirty = JSON.stringify([mode, wl, bl]) !== orig;
    ctx.setGuard(dirty ? () => window.confirm(t('Discard unsaved policy changes?')) : null);
    window.onbeforeunload = dirty ? () => true : null;
    paintSaveBar();
  };

  const picker = h('div', { class: 'plate-picker', role: 'radiogroup', 'aria-label': t('Policy mode') });
  const OPTIONS = [
    ['off', t('Nothing is blocked. The extension still warns about risky links.')],
    ['blacklist', t('Sites on the blocked list are stopped with a warning page. Everything else opens.')],
    ['whitelist', t('Only the allowed list opens. Every other site shows the warning page and a request button.')],
  ];
  function paintPicker() {
    replace(picker, OPTIONS.map(([m, desc]) => h('button', { type: 'button', class: 'plate-option', role: 'radio', 'aria-checked': String(m === mode),
      onclick: () => { mode = m; paintPicker(); setDirty(); } },
    h('span', { class: 'tick' }, icon('check', 14)), plate(m, { size: 'lg' }), h('span', { class: 'desc' }, desc))));
  }
  paintPicker();

  const allow = domainEditor({ title: t('Allowed sites'), tone: 'allow', items: wl, hint: t('Used in whitelist mode. Subdomains are included: google.com also allows mail.google.com.'),
    onChange: (l) => { wl = l; setDirty(); } });
  const block = domainEditor({ title: t('Blocked sites'), tone: 'block', items: bl, hint: t('Used in blacklist mode. Subdomains are included.'),
    onChange: (l) => { bl = l; setDirty(); } });

  const saveHost = h('div');
  function paintSaveBar() {
    if (!dirty) { replace(saveHost); return; }
    replace(saveHost, h('div', { class: 'savebar', role: 'region', 'aria-label': t('Unsaved changes') },
      icon('info', 18), h('span', null, t('Unsaved changes. Every browser gets them within a minute of saving.')), h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--quiet', type: 'button', onclick: () => {
        mode = data.policy.enforceMode; wl = [...data.policy.whitelist]; bl = [...data.policy.blacklist];
        allow.set(wl); block.set(bl); paintPicker(); setDirty();
      } }, t('Discard')),
      h('button', { class: 'btn', type: 'button', onclick: () => save(false) }, icon('check', 16), t('Save and send'))));
  }

  async function save(confirmEmpty) {
    if (mode === 'whitelist' && !confirmEmpty && !wl.length) {
      const ok = await confirmDialog({ title: t('Block every site?'), body: t('Whitelist mode with an empty allowed list stops every page in every company that follows the global policy.'), confirm: t('Block everything'), danger: true });
      if (!ok) return;
      confirmEmpty = true;
    }
    if (mode === 'whitelist' && data.policy.enforceMode !== 'whitelist' && !confirmEmpty) {
      const ok = await confirmDialog({ title: t('Switch to whitelist only?'), body: tn(wl.length, 'Browsers that follow the global policy will open only {n} allowed domain.', 'Browsers that follow the global policy will open only {n} allowed domains.'), confirm: t('Switch mode') });
      if (!ok) return;
    }
    try {
      const r = await post('/api/policy', { enforceMode: mode, whitelist: wl, blacklist: bl, confirmEmpty: !!confirmEmpty, rev: data.policy.rev });
      data.policy = { enforceMode: mode, whitelist: [...wl], blacklist: [...bl], rev: r.rev };
      orig = JSON.stringify([mode, wl, bl]);
      allow.set(wl); block.set(bl);
      setDirty();
      toast(t('Global policy saved. Browsers update within a minute.'));
      ctx.refreshBadges();
    } catch (e) {
      if (e.status === 409 && e.data.stale) {
        const ok = await confirmDialog({ title: t('Changed somewhere else'), body: t('The global policy was changed after you opened it — for example, a request was approved. Load the latest version? Your unsaved edits will be lost.'), confirm: t('Load latest') });
        if (ok) { ctx.setGuard(null); window.onbeforeunload = null; ctx.rerender(); }
        return;
      }
      const f = e.fields || {};
      toast(t(f.whitelist || f.blacklist || f.enforceMode || e.message), 'error');
    }
  }

  const overrides = data.overrides.length
    ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, t('Company')), h('th', null, t('Mode')), h('th', null, t('Own allowed')), h('th', null, t('Own blocked')))),
      h('tbody', null, data.overrides.map((o) => h('tr', null,
        h('td', null, h('a', { href: '#/companies/' + o.id + '/policy', style: { fontWeight: 700 } }, o.name)),
        h('td', null, plate(o.effectiveMode, { size: 'sm' }), o.mode === 'inherit' ? h('span', { class: 'plate-note' }, t('global mode')) : null),
        h('td', { class: 'num' }, num(o.whitelist)),
        h('td', { class: 'num' }, num(o.blacklist)))))))
    : empty('building', t('Every company follows this policy'), t('Open a company and choose its own mode or lists when an office needs different rules.'));

  replace(page,
    h('header', { class: 'page-head' },
      h('div', { class: 'titles' }, h('h1', { class: 'page-title' }, t('Global policy')),
        h('p', { class: 'page-sub' }, t('The default for every browser. A company can choose its own mode and add its own allowed or blocked sites — company entries win over global ones.')))),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, t('Mode')), h('p', null, t('Currently {mode}.', { mode: MODE_LABEL[data.policy.enforceMode]() }))),
      h('div', { class: 'panel-body' }, picker)),
    h('div', { class: 'grid-even', style: { marginTop: '20px' } }, allow.el, block.el),
    h('section', { class: 'panel', style: { marginTop: '20px' } },
      h('div', { class: 'panel-head' }, h('h2', null, t('Companies with their own rules')), h('span', { class: 'badge' }, num(data.overrides.length))),
      h('div', { class: 'panel-body' }, overrides)),
    saveHost);

  return { destroy: () => { window.onbeforeunload = null; } };
}
