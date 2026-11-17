// Inventory pass: log in once, then walk site + per-site tool endpoints.
const fs = require('fs');

const BASE = 'https://sakai.ug.edu.gh';
const OUT = 'capture';
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

function env() {
  const out = {};
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

const jar = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(path) {
  const res = await fetch(BASE + path, {
    redirect: 'manual',
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json, text/html',
      ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
    },
  });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  const text = await res.text();
  return { status: res.status, ct: res.headers.get('content-type') || '', text };
}

async function login() {
  const e = env();
  const body = new URLSearchParams({ _username: e.SAKAI_ID, _password: e.SAKAI_PASSWORD });
  const res = await fetch(BASE + '/direct/session', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return res.status;
}

function save(name, r) {
  fs.writeFileSync(`${OUT}/${name}`, r.text);
}

function brief(label, r, n = 200) {
  console.log(`${label.padEnd(52)} ${String(r.status).padEnd(4)} ${String(r.text.length).padStart(8)}  ${r.text.replace(/\s+/g, ' ').slice(0, n)}`);
}

(async () => {
  console.log('login status:', await login());

  const sites = JSON.parse((await req('/direct/site.json')).text);
  save('site.json', { text: JSON.stringify(sites) });
  const list = sites.site_collection || [];
  console.log('site_collection length:', list.length);

  const byType = {};
  for (const s of list) byType[s.type || 'null'] = (byType[s.type || 'null'] || 0) + 1;
  console.log('by type:', byType);

  const member = JSON.parse((await req('/direct/membership.json')).text);
  save('membership.json', { text: JSON.stringify(member) });
  const mem = member.membership_collection || [];
  console.log('membership length:', mem.length);
  const roles = {};
  for (const m of mem) roles[m.memberRole] = (roles[m.memberRole] || 0) + 1;
  console.log('by role:', roles);

  const first = mem.slice(0, 40);
  console.log('\n--- per-site endpoints (first %d enrolments)', first.length);
  for (const m of first) {
    const sid = (m.locationReference || '').replace('/site/', '');
    if (!sid) continue;
    for (const [label, path] of [
      ['site', `/direct/site/${sid}.json`],
      ['pages', `/direct/site/${sid}/pages.json`],
      ['tools', `/direct/site/${sid}/tools.json`],
    ]) {
      brief(`${label} ${sid}`, await req(path));
      await sleep(60);
    }
  }
})();
