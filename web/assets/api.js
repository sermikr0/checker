// Fetch wrapper: same-origin session cookie + CSRF header on every write.

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data || {};
    this.fields = (data && data.fields) || {};
  }
}

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const opts = { method, credentials: 'same-origin', headers: { ...headers } };
  if (method !== 'GET') opts.headers['X-Fleet-CSRF'] = '1';
  if (body !== undefined) {
    if (body instanceof ArrayBuffer || body instanceof Blob || typeof body === 'string') {
      opts.body = body;
      opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/octet-stream';
    } else {
      opts.body = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
    }
  }
  let r;
  try {
    r = await fetch(path, opts);
  } catch (e) {
    throw new ApiError('network', 0, {});
  }
  let data = null;
  try { data = await r.json(); } catch (_) { data = null; }
  if (r.status === 401 && !path.startsWith('/api/login') && path !== '/api/me') {
    window.dispatchEvent(new CustomEvent('fleet:unauthorized'));
  }
  if (!r.ok || !data || data.ok === false) {
    throw new ApiError((data && data.error) || 'HTTP ' + r.status, r.status, data);
  }
  return data;
}

export const get = (p) => api(p);
export const post = (p, body = {}) => api(p, { method: 'POST', body });
