// Map: Direct entity catalogue + which tools each enrolled site actually has.
const fs = require('fs');
const { MongoClient } = {};
const BASE = 'https://sakai.ug.edu.gh';

function env() {
  const out = {};
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}
const jar = new Map();
async function req(path) {
  const res = await fetch(BASE + path, {
    redirect: 'manual',
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) },
  });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';'); const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return { status: res.status, text: await res.text() };
}

(async () => {
  const e = env();
  const body = new URLSearchParams({ _username: e.SAKAI_ID, _password: e.SAKAI_PASSWORD });
  const r = await fetch(BASE + '/direct/session', { method: 'POST', redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  for (const c of r.headers.getSetCookie()) { const [p] = c.split(';'); const i = p.indexOf('='); if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); }

  const desc = await req('/direct/describe');
  fs.writeFileSync('capture/describe.txt', desc.text);
  const lines = desc.text.split(/\r?\n/).filter(Boolean);
  console.log('=== /direct/describe  status', desc.status, 'lines', lines.length);
  console.log(lines.join('\n'));

  const mem = JSON.parse((await req('/direct/membership.json')).text).membership_collection;
  console.log('\n=== tool inventory per site');
  for (const m of mem) {
    const sid = m.locationReference.replace('/site/', '');
    const pages = JSON.parse((await req(`/direct/site/${sid}/pages.json`)).text);
    const tools = [];
    for (const pg of pages) for (const t of pg.tools || []) tools.push(`${t.toolId}`);
    console.log(`\n${sid}  (${pages.length} pages)`);
    for (const pg of pages) console.log(`   page: ${pg.title}  tools=${(pg.tools || []).map((t) => t.toolId).join(', ')}`);
    fs.writeFileSync(`capture/pages_${sid}.json`, JSON.stringify(pages, null, 2));
  }
})();
