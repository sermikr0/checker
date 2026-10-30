import { h, icon, replace } from '../dom.js';
import { api } from '../api.js';
import { t, num, dateTime } from '../i18n.js';
import { meter, empty, toast, confirmDialog, copyBtn, when } from '../ui.js';
import { loading, failed } from './common.js';

const kb = (n) => (n ? (n / 1024).toFixed(n > 102400 ? 0 : 1) + ' KB' : '—');

export async function render(page, params, ctx) {
  document.title = t('Extension updates') + ' — Fleet';
  page.append(h('header', { class: 'page-head' },
    h('div', { class: 'titles' }, h('h1', { class: 'page-title' }, t('Extension updates')),
      h('p', { class: 'page-sub' }, t('Publish a signed package once and every force-installed browser updates itself through Chrome’s own update channel.')))));
  const host = h('div');
  page.append(host);
  host.append(loading());

  async function upload(file, force) {
    if (!file) return;
    if (!/\.crx$/i.test(file.name)) { toast(t('Choose a .crx file.'), 'error'); return; }
    try {
      const r = await api('/api/releases/upload' + (force ? '?force=1' : ''), { method: 'POST', body: await file.arrayBuffer() });
      toast(t('Version {v} published. Browsers update within a few hours, or at once from chrome://extensions → Update.', { v: r.version }));
      load();
    } catch (e) {
      if (e.status === 409 && e.data.needsConfirm) {
        if (await confirmDialog({ title: t('Publish an older or equal version?'), body: t(e.message) + ' ' + t('Chrome never downgrades, so browsers that already have a newer version keep it.'), confirm: t('Publish anyway') })) upload(file, true);
        return;
      }
      toast(t('Upload failed: {error}', { error: t(e.message) }), 'error');
    }
  }

  function view(d) {
    const rel = d.release || {};
    const appid = d.appid;
    const fileInput = h('input', { type: 'file', accept: '.crx', class: 'hidden', onchange: () => { upload(fileInput.files[0]); fileInput.value = ''; } });
    const drop = h('div', { class: 'dropzone', role: 'button', tabindex: '0', onclick: () => fileInput.click(),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } } },
    icon('upload', 26), h('strong', null, t('Drop the signed .crx here')), h('span', null, t('or click to choose a file')), fileInput);
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('is-over'); upload(e.dataTransfer.files[0]); });

    const current = rel.version
      ? [h('div', { class: 'release-hero' },
        h('div', { class: 'ver-big' }, h('small', null, 'v'), rel.version),
        h('dl', { class: 'facts', style: { margin: 0 } },
          h('div', null, h('dt', null, t('Published')), h('dd', null, rel.uploaded_at ? when(rel.uploaded_at) : '—')),
          h('div', null, h('dt', null, t('Size')), h('dd', null, kb(rel.size))),
          rel.by ? h('div', null, h('dt', null, t('By')), h('dd', null, rel.by)) : null)),
      h('div', { style: { marginTop: '18px' } }, meter(d.adoption.latest, d.adoption.total, t('{n} of {m} browsers run this version', { n: num(d.adoption.latest), m: num(d.adoption.total) }))),
      rel.sha256 ? h('div', { style: { marginTop: '14px', display: 'flex', alignItems: 'center', gap: '6px' } },
        h('span', { class: 'field-hint' }, 'SHA-256'), h('span', { class: 'data', style: { fontSize: '12px' } }, rel.sha256.slice(0, 16) + '…'), copyBtn(rel.sha256)) : null]
      : empty('upload', t('Nothing published yet'), t('Devices keep the version they installed until you publish one here.'));


    return [
      h('div', { class: 'grid-2' },
        h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, t('Published version'))), h('div', { class: 'panel-body' }, current)),
        h('section', { class: 'panel' },
          h('div', { class: 'panel-head' }, h('h2', null, t('Publish a new version'))),
          h('div', { class: 'panel-body', style: { display: 'grid', gap: '14px' } },
            h('ol', { style: { margin: 0, paddingLeft: '20px', display: 'grid', gap: '6px', color: 'var(--ink-2)' } },
              h('li', null, t('Raise the version in manifest.json and in analyzer.js.')),
              h('li', null, t('Pack with the same signing key:'), ' ', h('span', { class: 'data' }, 'python3 pack_crx.py extension signing-key.pem out.crx')),
              h('li', null, t('Upload the .crx below.'))),
            drop,
            h('div', { class: 'field-hint' }, t('The server only accepts packages signed for this extension ID:'), ' ', h('span', { class: 'data' }, appid))))),
    ];
  }

  async function load() {
    try {
      const d = await api('/api/releases');
      replace(host, ...view(d));
    } catch (e) {
      replace(host, failed(e, load));
    }
  }
  await load();
  return {};
}

