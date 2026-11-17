// Full sweep across every enrolled site + depth probes (forum threads, lesson items, file downloads).
const fs = require('fs');
const BASE = 'https://sakai.ug.edu.gh';
const OUT = 'capture';

function env() {
  const o = {};
  for (const l of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) o[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return o;
}
const jar = new Map();
async function req(p, { method = 'GET', body, accept = 'application/json' } = {}) {
  const url = p.startsWith('http') ? p : BASE + p;
  const res = await fetch(url, {
    method, redirect: 'manual', body,
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: accept, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) },
  });
  for (const c of res.headers.getSetCookie()) { const [x] = c.split(';'); const i = x.indexOf('='); if (i > 0) jar.set(x.slice(0, i).trim(), x.slice(i + 1).trim()); }
  return { status: res.status, ct: res.headers.get('content-type') || '', cd: res.headers.get('content-disposition'), text: await res.text() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (t) => { try { return JSON.parse(t); } catch { return null; } };
const coll = (o) => (o && Object.values(o).find(Array.isArray)) || [];

(async () => {
  const e = env();
  const b = new URLSearchParams({ _username: e.SAKAI_ID, _password: e.SAKAI_PASSWORD });
  const r = await req('/direct/session', { method: 'POST', body: b.toString() });
  console.log('login', r.status);

  const mem = coll(J((await req('/direct/membership.json')).text));
  const rows = [];
  for (const m of mem) {
    const sid = m.locationReference.replace('/site/', '');
    const site = J((await req(`/direct/site/${sid}.json`)).text);
    const assign = J((await req(`/direct/assignment/site/${sid}.json`)).text);
    const annc = J((await req(`/direct/announcement/site/${sid}.json?n=50&d=365`)).text);
    const cal = J((await req(`/direct/calendar/site/${sid}.json`)).text);
    const content = J((await req(`/direct/content/site/${sid}.json`)).text);
    const forums = J((await req(`/direct/forums/site/${sid}.json`)).text);
    const lessons = J((await req(`/direct/lessons/site/${sid}.json`)).text);
    rows.push({
      sid, title: site && site.title,
      assignments: coll(assign).length,
      announcements: coll(annc).length,
      calendar: coll(cal).length,
      resources: coll(content).length,
      forums: coll(forums).length,
      forumMsgs: coll(forums).reduce((a, f) => a + (f.totalMessages || 0), 0),
      lessons: coll(lessons).length,
    });
    await sleep(120);
  }
  console.log('\n=== per-site data volume');
  console.log(['siteId', 'assign', 'annc', 'cal', 'res', 'fora', 'msgs', 'lessons'].map((h) => h.padEnd(9)).join(''));
  for (const r2 of rows) console.log([r2.sid, r2.assignments, r2.announcements, r2.calendar, r2.resources, r2.forums, r2.forumMsgs, r2.lessons].map((v) => String(v).padEnd(9)).join(''));
  fs.writeFileSync(`${OUT}/sweep.json`, JSON.stringify(rows, null, 2));

  // --- forum drill-down on the site with most messages
  const target = rows.slice().sort((a, b2) => b2.forumMsgs - a.forumMsgs)[0];
  console.log(`\n=== forum drill-down: ${target.sid} (${target.forumMsgs} msgs)`);
  const fora = coll(J((await req(`/direct/forums/site/${target.sid}.json`)).text));
  for (const f of fora.slice(0, 3)) {
    const f1 = J((await req(`/direct/forums/site/${target.sid}/forum/${f.id}.json`)).text);
    console.log(` forum ${f.id} "${f.title}" topics=${coll(f1).length} keys=${f1 ? Object.keys(f1).slice(0, 6).join(',') : '-'}`);
    const topics = coll(f1);
    if (topics[0]) {
      const t = topics[0];
      console.log('   topic fields:', Object.keys(t).join(', ').slice(0, 300));
      const t1 = J((await req(`/direct/forums/site/${target.sid}/forum/${f.id}/topic/${t.id}.json`)).text);
      console.log('   topic detail keys:', t1 ? Object.keys(t1).join(', ').slice(0, 300) : '-');
      const msgs = coll(t1);
      if (msgs[0]) {
        console.log('   message[0] fields:', Object.keys(msgs[0]).join(', ').slice(0, 300));
        const mid = msgs[0].id || msgs[0].messageId;
        const m1 = J((await req(`/direct/forums/site/${target.sid}/forum/${f.id}/topic/${t.id}/message/${mid}.json`)).text);
        console.log('   msg detail keys:', m1 ? Object.keys(m1).join(', ').slice(0, 300) : '-');
        fs.writeFileSync(`${OUT}/forum_message_sample.json`, JSON.stringify(m1, null, 2));
      }
    }
    await sleep(150);
  }

  // --- lesson items
  const lrow = rows.slice().sort((a, b2) => b2.lessons - a.lessons)[0];
  const lessons = coll(J((await req(`/direct/lessons/site/${lrow.sid}.json`)).text));
  if (lessons[0]) {
    const l = lessons[0];
    const detail = await req(`/direct/lessons/lesson/${l.id}.json`);
    console.log(`\n=== lesson detail ${l.id}: ${detail.status} len=${detail.text.length}`);
    console.log(detail.text.replace(/\s+/g, ' ').slice(0, 600));
    fs.writeFileSync(`${OUT}/lesson_detail_sample.json`, detail.text);
  }

  // --- resource download with session cookie
  const c = rows.slice().sort((a, b2) => b2.resources - a.resources)[0];
  const items = coll(J((await req(`/direct/content/site/${c.sid}.json`)).text));
  const file = items.find((i) => i.type && i.type !== 'collection' && i.url);
  if (file) {
    const d = await req(file.url, { accept: '*/*' });
    console.log(`\n=== file download: ${file.title}`);
    console.log(`status=${d.status} ct=${d.ct} disposition=${d.cd} bytes=${d.text.length}`);
  }
  const folder = items.find((i) => i.type === 'collection' && i.url && i.numChildren > 0);
  if (folder) {
    const d = await req(folder.url + '.json');
    console.log(`\n=== folder listing ${folder.title}: status=${d.status} ct=${d.ct} len=${d.text.length}`);
    console.log(d.text.replace(/\s+/g, ' ').slice(0, 400));
  }
})();
