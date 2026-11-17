// Authenticated probe of the Sakai Direct REST API.
// Credentials are read from .env and never printed.
const fs = require('fs');

const BASE = 'https://sakai.ug.edu.gh';

function env() {
  const out = {};
  const txt = fs.readFileSync('.env', 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

const jar = new Map();

function collect(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return raw.map((c) => c.split(';')[0].replace(/=.*/, '=<redacted>'));
}

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    redirect: 'manual',
    headers: { 'User-Agent': 'Mozilla/5.0', ...(opts.headers || {}) },
    ...opts,
    headers: { 'User-Agent': 'Mozilla/5.0', ...(opts.headers || {}), Cookie: cookieHeader() },
  });
  const text = await res.text();
  return { res, text };
}

function show(label, r, limit = 900) {
  const ct = r.res.headers.get('content-type') || '';
  console.log(`\n=== ${label}`);
  console.log(`status=${r.res.status} ct=${ct} len=${r.text.length}`);
  const body = r.text.replace(/\s+/g, ' ').slice(0, limit);
  console.log(body);
}

(async () => {
  const e = env();

  // 1. Login
  const form = new URLSearchParams();
  form.set('_username', e.SAKAI_ID);
  form.set('_password', e.SAKAI_PASSWORD);

  const login = await req('/direct/session', {
    method: 'POST',
    body: form.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  console.log('=== LOGIN /direct/session');
  console.log('status=', login.res.status);
  console.log('location=', login.res.headers.get('location'));
  console.log('cookies set=', collect(login.res));
  console.log('body:', login.text.replace(/\s+/g, ' ').slice(0, 600));
  console.log('\ncookie names in jar:', [...jar.keys()]);

  if (![200, 201, 204].includes(login.res.status)) {
    console.log('\nLogin did not succeed; stopping.');
    return;
  }

  const gets = [
    '/direct/session/current.json',
    '/direct/user/current.json',
    '/direct/site.json',
    '/direct/membership.json',
    '/direct/portal/notify.json',
    '/direct/pasystem/checkTimeZone',
  ];
  for (const g of gets) show(g, await req(g));

  fs.writeFileSync('probe_state.json', JSON.stringify({ cookieNames: [...jar.keys()] }, null, 2));
})();
