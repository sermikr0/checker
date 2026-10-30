// Interface language. Keys are the English strings; ./i18n-uz.js maps them to Uzbek.
import UZ, { PATTERNS as UZ_PATTERNS } from './i18n-uz.js';

const DICTS = { uz: UZ };
const PATTERNS = { uz: UZ_PATTERNS };
const SUPPORTED = ['uz', 'en'];

function initial() {
  try {
    const saved = localStorage.getItem('fleet.lang');
    if (SUPPORTED.includes(saved)) return saved;
  } catch (_) { /* ignore */ }
  return 'uz';
}

let lang = initial();
document.documentElement.lang = lang;

export const getLang = () => lang;

export function setLang(l) {
  if (!SUPPORTED.includes(l)) return;
  lang = l;
  document.documentElement.lang = l;
  try { localStorage.setItem('fleet.lang', l); } catch (_) { /* ignore */ }
}

export function t(s, vars) {
  if (s == null) return '';
  let out = DICTS[lang] && DICTS[lang][s];
  if (out == null) {
    out = s;
    for (const [re, rep] of PATTERNS[lang] || []) {
      if (re.test(s)) { out = s.replace(re, rep); break; }
    }
  }
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
  return out;
}

/** Plural: English picks one/other; Uzbek nouns do not change after numbers. */
export function tn(n, one, other, vars = {}) {
  const key = lang === 'en' && n === 1 ? one : other;
  return t(key, { n: num(n), ...vars });
}

const locale = () => (lang === 'uz' ? 'uz-Latn-UZ' : 'en-GB');

// Uzbek date/number formats are written by hand: many browser builds ship
// without Uzbek locale data and would print "2026 M10 30" or "-6 min".
const UZ_MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
const pad = (n) => String(n).padStart(2, '0');

export function num(n) {
  if (lang === 'uz') return Number(n).toLocaleString('en-US').replace(/,/g, ' ');
  try { return new Intl.NumberFormat(locale()).format(n); } catch (_) { return String(n); }
}

export function relTime(iso) {
  const ts = Date.parse(iso);
  if (!ts) return '—';
  const s = Math.round((ts - Date.now()) / 1000);
  const a = Math.abs(s);
  if (a < 45) return t('just now');
  let unit, n;
  if (a < 2700) { unit = 'minute'; n = Math.max(1, Math.round(a / 60)); }
  else if (a < 79200) { unit = 'hour'; n = Math.round(a / 3600); }
  else if (a < 26 * 86400) { unit = 'day'; n = Math.round(a / 86400); }
  else return dateOnly(iso);
  if (lang === 'uz') {
    if (unit === 'day' && n === 1) return s < 0 ? 'kecha' : 'ertaga';
    const word = { minute: 'daqiqa', hour: 'soat', day: 'kun' }[unit];
    return s < 0 ? n + ' ' + word + ' oldin' : n + ' ' + word + 'dan keyin';
  }
  try { return new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' }).format(s < 0 ? -n : n, unit); } catch (_) { return n + ' ' + unit + (s < 0 ? ' ago' : ''); }
}

export function dateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  if (lang === 'uz') return dateOnly(iso) + ', ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  try { return d.toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) { return d.toLocaleString(); }
}

export function dateOnly(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  if (lang === 'uz') return d.getDate() + '-' + UZ_MONTHS[d.getMonth()] + ', ' + d.getFullYear();
  try { return d.toLocaleDateString(locale(), { dateStyle: 'medium' }); } catch (_) { return d.toLocaleDateString(); }
}
