import { h, icon, replace } from '../dom.js';
import { api, post } from '../api.js';
import { t, tn, getLang } from '../i18n.js';
import { seg, toast, errText, confirmDialog, copyBtn } from '../ui.js';

export async function render(page, params, ctx) {
  document.title = t('Settings') + ' — Fleet';
  let me = ctx.me;
  try { me = await api('/api/me'); ctx.me = me; } catch (_) { /* keep cached */ }

  const cur = h('input', { id: 's-cur', class: 'input', type: 'password', autocomplete: 'current-password' });
  const nw = h('input', { id: 's-new', class: 'input', type: 'password', autocomplete: 'new-password' });
  const nw2 = h('input', { id: 's-new2', class: 'input', type: 'password', autocomplete: 'new-password' });
  const msg = h('div', { class: 'field-error', 'aria-live': 'polite' });
  const strength = h('div', { class: 'field-hint' }, t('At least 10 characters. A short sentence is easy to remember and hard to guess.'));
  nw.addEventListener('input', () => {
    const n = nw.value.length;
    strength.textContent = n === 0 ? t('At least 10 characters. A short sentence is easy to remember and hard to guess.')
      : n < 10 ? t('{n} more characters needed.', { n: 10 - n }) : t('Long enough.');
    strength.style.color = n >= 10 ? 'var(--accent-ink)' : '';
  });

  const pwForm = h('form', { style: { display: 'grid', gap: '14px', maxWidth: '420px' }, onsubmit: async (e) => {
    e.preventDefault();
    msg.textContent = '';
    if (nw.value.length < 10) { msg.textContent = t('The new password needs at least 10 characters.'); return; }
    if (nw.value !== nw2.value) { msg.textContent = t('The new passwords do not match.'); return; }
    try {
      const r = await post('/api/change-password', { current_password: cur.value, new_password: nw.value });
      cur.value = nw.value = nw2.value = '';
      toast(r.revokedSessions ? tn(r.revokedSessions, 'Password changed. {n} other session was signed out.', 'Password changed. {n} other sessions were signed out.') : t('Password changed.'));
    } catch (err) {
      msg.textContent = err.status === 403 ? t('The current password is wrong.') : errText(err);
    }
  } },
  h('div', { class: 'field' }, h('label', { for: 's-cur' }, t('Current password')), cur),
  h('div', { class: 'field' }, h('label', { for: 's-new' }, t('New password')), nw, strength),
  h('div', { class: 'field' }, h('label', { for: 's-new2' }, t('Repeat the new password')), nw2),
  msg,
  h('div', null, h('button', { class: 'btn', type: 'submit' }, icon('key', 16), t('Change password'))));

  const sessionsLine = h('p', { style: { margin: '0 0 12px', color: 'var(--ink-2)' } },
    tn(me.sessions, '{n} active session, including this one.', '{n} active sessions, including this one.'));

  replace(page,
    h('header', { class: 'page-head' }, h('div', { class: 'titles' }, h('h1', { class: 'page-title' }, t('Settings')))),
    h('div', { class: 'grid-even' },
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, t('Admin password')),
          h('p', null, t('Changing it signs out every other session.'))),
        h('div', { class: 'panel-body' }, pwForm)),
      h('div', { class: 'stack' },
        h('section', { class: 'panel' },
          h('div', { class: 'panel-head' }, h('h2', null, t('Appearance'))),
          h('div', { class: 'panel-body', style: { display: 'grid', gap: '16px' } },
            h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('Theme')),
              seg([
                { value: 'system', label: t('Same as system') },
                { value: 'light', label: t('Light'), icon: 'sun' },
                { value: 'dark', label: t('Dark'), icon: 'moon' },
              ], ctx.themePref(), (v) => ctx.applyTheme(v), { label: t('Theme') })),
            h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('Language')),
              seg([{ value: 'uz', label: 'O‘zbekcha' }, { value: 'en', label: 'English' }], getLang(), (v) => ctx.setLang(v), { label: t('Language') })))),
        rdpPanel(),
        h('section', { class: 'panel' },
          h('div', { class: 'panel-head' }, h('h2', null, t('Sessions'))),
          h('div', { class: 'panel-body' }, sessionsLine,
            h('button', { class: 'btn btn--quiet', type: 'button', disabled: me.sessions <= 1, onclick: async () => {
              if (!await confirmDialog({ title: t('Sign out everywhere else?'), body: t('Every other browser signed in to this dashboard has to sign in again.'), confirm: t('Sign out others') })) return;
              try { const r = await post('/api/logout-all'); toast(tn(r.revoked, '{n} session signed out.', '{n} sessions signed out.')); ctx.rerender(); } catch (e) { toast(errText(e), 'error'); }
            } }, icon('logout', 16), t('Sign out other sessions')))),
        h('section', { class: 'panel' },
          h('div', { class: 'panel-head' }, h('h2', null, t('About this server'))),
          h('div', { class: 'panel-body' }, h('dl', { class: 'facts', style: { margin: 0 } },
            h('div', null, h('dt', null, t('Server version')), h('dd', null, me.serverVersion)),
            h('div', null, h('dt', null, t('Extension ID')), h('dd', { class: 'data' }, me.appid)),
            h('div', null, h('dt', null, t('Check-in interval')), h('dd', null, t('{n} s', { n: me.heartbeatSec }))),
            h('div', null, h('dt', null, t('Offline after')), h('dd', null, t('{n} s', { n: me.onlineSec })))))))));
  return {};
}

/* Remote desktop to a company's domain controller: the Companies page opens
 * fleet-rdp:// links, which a small helper on this computer hands to xfreerdp
 * (Linux) or Remote Desktop (Windows). The helpers are served by this server. */
function rdpPanel() {
  const origin = window.location.origin;
  const linux = 'curl -fsSL ' + origin + '/tools/fleet-rdp/install.sh | FLEET_SERVER=' + origin + ' bash';
  // no "$" inside: works pasted into cmd and into PowerShell
  const windows = 'powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm ' + origin + '/tools/fleet-rdp/install-windows.ps1))) -Server ' + origin + '"';
  const isWin = /Windows/i.test(navigator.userAgent || '');
  const block = (label, cmd, hint) => h('div', { class: 'field' }, h('span', { class: 'field-label' }, label),
    h('pre', { class: 'code' }, cmd, copyBtn(cmd)), h('div', { class: 'field-hint' }, hint));
  const ubuntu = block(t('Ubuntu / Linux — in a terminal'), linux,
    t('Needs xfreerdp (sudo apt install freerdp3-x11, or freerdp2-x11 on older systems).'));
  const win = block(t('Windows — in PowerShell'), windows,
    t('Opens Remote Desktop (mstsc). Run it as administrator once if Remote Desktop still asks for the password.'));
  return h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', null, t('Remote desktop')),
      h('p', null, t('The RDP button next to each company connects to its domain controller at once, with dynamic resolution.'))),
    h('div', { class: 'panel-body', style: { display: 'grid', gap: '14px' } },
      isWin ? win : ubuntu, isWin ? ubuntu : win,
      h('div', { class: 'field-hint' }, t('The button uses the user name and password saved in the company’s Details. For a company without a saved password, the helper asks once for a user name and password and keeps them only on this computer. It connects only to private addresses, and the browser asks once before opening it.'))));
}

