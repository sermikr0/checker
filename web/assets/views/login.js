import { h, icon } from '../dom.js';
import { api } from '../api.js';
import { t, getLang } from '../i18n.js';
import { plate, errText } from '../ui.js';

export function render(root, ctx, onDone) {
  const user = h('input', { id: 'l-user', class: 'input', autocomplete: 'username', value: 'admin', required: true });
  const pass = h('input', { id: 'l-pass', class: 'input', type: 'password', autocomplete: 'current-password', required: true });
  const error = h('div', { class: 'error', role: 'alert' });
  const btn = h('button', { class: 'btn', type: 'submit' }, t('Sign in'));

  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    error.textContent = '';
    btn.disabled = true;
    try {
      await api('/api/login', { method: 'POST', body: { username: user.value.trim(), password: pass.value } });
      await onDone();
    } catch (err) {
      pass.value = '';
      pass.focus();
      error.textContent = err.status === 401 ? t('Wrong username or password.') : errText(err);
    } finally {
      btn.disabled = false;
    }
  } },
  h('div', { class: 'field' }, h('label', { for: 'l-user' }, t('Username')), user),
  h('div', { class: 'field' }, h('label', { for: 'l-pass' }, t('Password')), pass),
  btn, error);

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  root.append(h('div', { class: 'login' },
    h('section', { class: 'login-road', 'aria-hidden': 'true' },
      h('div', { class: 'sign' },
        plate('off', { label: 'Fleet', size: 'lg' }),
        h('p', null, t('One place to see every office, every browser and every blocked site.')))),
    h('section', { class: 'login-form' },
      h('div', { class: 'login-tools' },
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => { ctx.applyTheme(isDark ? 'light' : 'dark'); root.innerHTML = ''; render(root, ctx, onDone); } },
          icon(isDark ? 'sun' : 'moon', 15), isDark ? t('Light') : t('Dark')),
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => { ctx.setLang(getLang() === 'uz' ? 'en' : 'uz'); root.innerHTML = ''; render(root, ctx, onDone); } },
          icon('globe', 15), getLang() === 'uz' ? 'English' : 'O‘zbekcha')),
      h('h1', null, t('Sign in to Fleet')),
      h('p', { class: 'sub' }, t('URL Safety Checker administration')),
      form)));
  setTimeout(() => pass.focus(), 0);
}
