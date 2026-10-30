// Helpers shared by several views.
import { h, icon, versionCmp } from '../dom.js';
import { t, tn } from '../i18n.js';
import { MODE_LABEL, when } from '../ui.js';

function parseDetail(e) {
  try { return e.detail ? JSON.parse(e.detail) : {}; } catch (_) { return {}; }
}

const EVENTS = {
  'login': ['user', '', '{actor} signed in'],
  'login.failed': ['alert', 'warn', 'Failed sign-in attempt as “{actor}”'],
  'password.changed': ['key', '', '{actor} changed the admin password'],
  'sessions.revoked': ['logout', '', '{actor} signed out the other sessions'],
  'device.update': ['monitor', '', '{actor} updated devices'],
  'device.delete': ['trash', 'danger', '{actor} deleted devices'],
  'device.prune': ['trash', '', '{actor} removed inactive devices'],
  'company.create': ['building', 'good', '{actor} added the company {target}'],
  'company.update': ['edit', '', '{actor} edited the company {target}'],
  'company.policy': ['policy', 'warn', '{actor} changed the policy of {target}'],
  'company.delete': ['trash', 'danger', '{actor} deleted the company {target}'],
  'company.nat_add': ['route', '', '{actor} added a NAT address to {target}'],
  'company.nat_remove': ['route', '', '{actor} removed a NAT address from {target}'],
  'company.import': ['upload', '', '{actor} imported companies'],
  'policy.global': ['policy', 'warn', '{actor} changed the global policy'],
  'request.approve': ['check', 'good', '{actor} allowed {target}'],
  'request.reject': ['x', '', '{actor} turned down access to {target}'],
  'request.block': ['ban', 'danger', '{actor} blocked {target}'],
  'release.publish': ['upload', 'good', '{actor} published version {target}'],
};

export const EVENT_TYPES = Object.keys(EVENTS);

export function eventSentence(e) {
  const [, , tpl] = EVENTS[e.action] || ['dot', '', e.action];
  return t(tpl, { actor: e.actor || t('Someone'), target: e.target || '' });
}

function eventMeta(e) {
  const d = parseDetail(e);
  const parts = [];
  switch (e.action) {
    case 'policy.global':
    case 'company.policy':
      if (d.mode) parts.push(d.mode === 'inherit' ? t('Follows the global policy') : (MODE_LABEL[d.mode] ? MODE_LABEL[d.mode]() : d.mode));
      if (d.whitelist != null) parts.push(tn(d.whitelist, '{n} allowed domain', '{n} allowed domains'));
      if (d.blacklist != null) parts.push(tn(d.blacklist, '{n} blocked domain', '{n} blocked domains'));
      break;
    case 'request.approve':
    case 'request.block':
    case 'request.reject':
      if (d.scope === 'company' && d.company) parts.push(t('Only for {company}', { company: d.company }));
      else if (d.scope) parts.push(t('For every company'));
      break;
    case 'device.update':
      if (d.count != null) parts.push(tn(d.count, '{n} device', '{n} devices'));
      if ('label' in d) parts.push(t('Name: {label}', { label: d.label || '—' }));
      if ('companyId' in d) parts.push(d.company ? t('Pinned to {company}', { company: d.company }) : t('Pin removed'));
      break;
    case 'device.delete':
    case 'device.prune':
      if (d.count != null) parts.push(tn(d.count, '{n} device', '{n} devices'));
      break;
    case 'company.nat_add':
    case 'company.nat_remove':
      if (d.ip) parts.push(d.ip);
      break;
    case 'company.import':
      parts.push(t('{created} new, {updated} updated', { created: d.created || 0, updated: d.updated || 0 }));
      break;
    case 'password.changed':
    case 'sessions.revoked':
      if (d.revokedSessions != null || d.count != null) parts.push(tn(d.revokedSessions ?? d.count, '{n} session closed', '{n} sessions closed'));
      break;
    case 'company.update':
      if (d.fields && d.fields.length) parts.push(t('Changed: {fields}', { fields: d.fields.join(', ') }));
      break;
    default:
  }
  if (e.ip) parts.push(t('from {ip}', { ip: e.ip }));
  return parts;
}

export function eventItem(e) {
  const [ic, tone] = EVENTS[e.action] || ['dot', ''];
  const meta = eventMeta(e);
  return h('li', null,
    h('span', { class: 'ic' + (tone ? ' ic--' + tone : '') }, icon(ic, 14)),
    h('div', null,
      h('div', { class: 'what' }, eventSentence(e)),
      meta.length ? h('div', { class: 'meta' }, meta.join('; ')) : null),
    h('span', { class: 'when' }, when(e.ts)));
}

export function versionTag(v, latest) {
  if (!v) return h('span', { class: 'muted' }, '—');
  const cls = !latest ? 'ver' : versionCmp(v, latest) >= 0 ? 'ver ver--latest' : 'ver ver--old';
  const title = !latest ? '' : versionCmp(v, latest) >= 0 ? t('Latest version') : t('Older than the published {v}', { v: latest });
  return h('span', { class: cls, title }, v);
}

/** Loading placeholder that keeps the page height stable. */
export function loading() {
  return h('div', { class: 'empty', 'aria-busy': 'true' }, h('p', null, t('Loading…')));
}

export function failed(err, retry) {
  return h('div', { class: 'note note--warn' }, icon('alert', 18),
    h('div', null, t('Could not load data: {error}', { error: err && err.message ? t(err.message) : '' }), ' ',
      retry ? h('button', { class: 'linkish', type: 'button', onclick: retry }, t('Try again')) : null));
}
