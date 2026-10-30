import { h, icon, replace } from '../dom.js';
import { api } from '../api.js';
import { t, tn, num } from '../i18n.js';
import { plate, lane, meter, empty } from '../ui.js';
import { eventItem, loading, failed } from './common.js';

let firstPaint = true;

export async function render(page, params, ctx) {
  document.title = t('Overview') + ' — Fleet';
  const body = h('div');
  page.append(body);
  body.append(loading());

  async function load() {
    let o;
    try {
      const [ov, me] = await Promise.all([api('/api/overview'), api('/api/me')]);
      o = ov;
      ctx.me = me;
    } catch (e) {
      replace(body, failed(e, load));
      return;
    }
    ctx.overview = o;
    replace(body, ...view(o, ctx));
    if (firstPaint) {
      body.classList.add('anim-lane');
      setTimeout(() => body.classList.remove('anim-lane'), 1500);
      firstPaint = false;
    }
  }
  await load();
  return { refresh: load };
}

function view(o, ctx) {
  const d = o.devices;
  const out = [];

  // Headline: how much of the fleet is talking to us right now.
  const head = h('section', { class: 'statement' });
  if (!d.total) {
    head.append(h('h1', null, t('No browsers have checked in yet')),
      h('p', { class: 'page-sub' }, t('Install the extension with the force-install policy and devices will appear here within a minute.'), ' ',
        h('a', { href: '#/updates' }, t('Show the install policy'))));
  } else {
    head.append(h('h1', null,
      h('span', { class: 'num' }, num(d.online)),
      h('span', { class: 'of num' }, ' / ' + num(d.total)), ' ',
      t('browsers online')));
  }
  const facts = h('div', { class: 'statement-facts' });
  if (ctx.me && ctx.me.proxyMismatch) {
    out.push(h('div', { class: 'note note--warn', style: { marginBottom: '18px' } }, icon('alert', 18),
      h('div', null, t('Browsers reach this server through Cloudflare, but the server is not reading their real address. Set FLEET_TRUST_PROXY=cloudflare in docker-compose.yml and restart — until then every browser looks like it comes from the same address and cannot be matched to its company.'))));
  }
  facts.append(h('span', { class: 'fact' }, plate(o.policy.mode, { size: 'sm' }),
    h('a', { href: '#/policy' }, t('Global policy')),
    o.policy.overrides ? h('span', null, tn(o.policy.overrides, '{n} company has its own', '{n} companies have their own')) : null));
  if (o.requests.pending) {
    facts.append(h('span', { class: 'fact' }, icon('inbox', 17),
      h('a', { href: '#/requests' }, tn(o.requests.pending, '{n} access request is waiting', '{n} access requests are waiting'))));
  }
  if (d.unmatched) {
    facts.append(h('span', { class: 'fact' }, icon('alert', 17),
      h('a', { href: '#/companies' }, tn(d.unmatched, '{n} device is not linked to a company', '{n} devices are not linked to a company'))));
  }
  if (d.new24h) facts.append(h('span', { class: 'fact' }, icon('plus', 17), tn(d.new24h, '{n} new in the last 24 hours', '{n} new in the last 24 hours')));
  head.append(facts);
  out.push(head);

  // Requests that need a decision.
  if (o.requests.top && o.requests.top.length) {
    out.push(h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, t('Waiting for a decision')), h('span', { class: 'spacer' }),
        h('a', { class: 'btn btn--quiet btn--sm', href: '#/requests' }, t('Review requests'))),
      h('div', { class: 'panel-body' },
        h('div', { class: 'tag-list' }, o.requests.top.map((r) => h('span', { class: 'tag', title: tn(r.hits, '{n} request', '{n} requests') },
          r.domain, h('b', { class: 'num', style: { marginLeft: '4px' } }, '×' + r.hits)))))));
  }

  // The board: one lane per company.
  const rows = o.companies.map((c) => {
    const tr = h('tr', { class: 'clickable', onclick: (e) => { if (!e.target.closest('a')) ctx.navigate('#/companies/' + c.id); } },
      h('td', null, h('a', { class: 'co-name', href: '#/companies/' + c.id }, c.name)),
      h('td', null, h('div', { class: 'lane-cell' }, lane(c.online, c.devices),
        h('span', { class: 'counts' }, c.devices ? [h('b', null, num(c.online)), ' ', t('online of {n}', { n: num(c.devices) })] : t('No devices yet')))),
      h('td', null, c.adComputers ? meter(c.devices, c.adComputers, t('{n} of {m} AD computers', { n: num(c.devices), m: num(c.adComputers) })) : h('span', { class: 'muted' }, t('No AD list'))),
      h('td', null, plate(c.mode, { size: 'sm' }), c.override ? h('span', { class: 'plate-note' }, t('own policy')) : null));
    return tr;
  });
  out.push(h('section', { class: 'panel' },
    h('div', { class: 'panel-head' },
      h('h2', null, t('Fleet board')), h('span', { class: 'spacer' }),
      h('a', { class: 'btn btn--ghost btn--sm', href: '#/companies' }, t('All companies'), icon('chevRight', 14)),
      h('p', null, t('Each mark is one browser. Green marks checked in during the last {m} minutes.', { m: Math.round((ctx.me?.onlineSec || 180) / 60) }))),
    o.companies.length
      ? h('div', { class: 'board-wrap' }, h('table', { class: 'board' },
        h('thead', null, h('tr', null, h('th', null, t('Company')), h('th', null, t('Browsers')), h('th', null, t('Coverage')), h('th', null, t('Policy')))),
        h('tbody', null, rows)))
      : h('div', { class: 'panel-body' }, empty('building', t('No companies yet'), t('Add your offices so devices can be grouped and filtered per company.'),
        h('a', { class: 'btn', href: '#/companies' }, t('Add a company'))))));

  // Versions + activity.
  const latest = o.release && o.release.version;
  const maxV = Math.max(1, ...o.versions.map((v) => v[1]));
  const versions = o.versions.length
    ? h('div', { class: 'bars' }, o.versions.slice(0, 8).map(([v, n]) => h('div', { class: 'bar-row' + (v === latest ? ' is-latest' : '') },
      h('span', { class: 'label' }, v === 'unknown' ? t('unknown') : 'v' + v),
      h('div', { class: 'track', title: tn(n, '{n} browser', '{n} browsers') }, h('div', { class: 'fill', style: { width: (n / maxV * 100) + '%' } })),
      h('span', { class: 'value' }, num(n)))))
    : h('p', { class: 'muted' }, t('No data yet.'));
  out.push(h('div', { class: 'grid-2', style: { marginTop: '20px' } },
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, t('Extension versions')), h('span', { class: 'spacer' }),
        latest ? h('span', { class: 'badge badge--good' }, t('Published: v{v}', { v: latest })) : h('span', { class: 'badge' }, t('Nothing published'))),
      h('div', { class: 'panel-body' }, versions)),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, t('Recent activity')), h('span', { class: 'spacer' }),
        h('a', { class: 'btn btn--ghost btn--sm', href: '#/activity' }, t('Full log'), icon('chevRight', 14))),
      h('div', { class: 'panel-body', style: { paddingTop: '6px' } },
        o.activity.length ? h('ul', { class: 'feed' }, o.activity.map(eventItem)) : h('p', { class: 'muted' }, t('Nothing has happened yet.'))))));
  return out;
}
