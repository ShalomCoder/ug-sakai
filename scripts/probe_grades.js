// Hunt for the student-facing gradebook + quiz data paths.
const fs = require('fs');
const BASE = 'https://sakai.ug.edu.gh';

function env() {
  const o = {};
  for (const l of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) o[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return o;
}
const jar = new Map();
async function req(path, accept = 'application/json, text/html') {
  const res = await fetch(BASE + path, {
    redirect: 'manual',
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: accept, ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) },
  });
  for (const c of res.headers.getSetCookie()) { const [p] = c.split(';'); const i = p.indexOf('='); if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); }
  return { status: res.status, loc: res.headers.get('location'), ct: res.headers.get('content-type') || '', text: await res.text() };
}

(async () => {
  const e = env();
  const b = new URLSearchParams({ _username: e.SAKAI_ID, _password: e.SAKAI_PASSWORD });
  const r = await fetch(BASE + '/direct/session', { method: 'POST', redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded' }, body: b.toString() });
  for (const c of r.headers.getSetCookie()) { const [p] = c.split(';'); const i = p.indexOf('='); if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); }
  console.log('login', r.status);

  const sid = 'DCIT-101-1-S1-2627';
  const probes = [
    '/direct/gbng/ping.json',
    '/direct/gbng/comments.json',
    '/direct/gbng/courseGradeComment.json',
    '/direct/gbng/courseGradeComment?siteId=' + sid,
    '/gradebookng-tool/rest/students',
    `/gradebookng-tool/rest/sites/${sid}/grades`,
    `/direct/gradebook/site/${sid}.json`,
    `/direct/grades/site/${sid}.json`,
    `/direct/sam_pub/publishedAssessment/${sid}.json`,
    `/direct/sam_core/site/${sid}`,
    `/portal/site/${sid}/tool/${'*'}`,
  ];
  for (const p of probes) {
    const res = await req(p);
    console.log(`${p.padEnd(52)} ${res.status} ${res.text.length} ct=${res.ct.slice(0, 30)} ${res.loc ? 'loc=' + res.loc : ''} :: ${res.text.replace(/\s+/g, ' ').slice(0, 110)}`);
  }

  // Find the real tool ids from pages so we can fetch live tool markup
  const pages = JSON.parse((await req(`/direct/site/${sid}/pages.json`)).text);
  const want = ['sakai.gradebookng', 'sakai.samigo', 'sakai.assignment.grades', 'sakai.lessonbuildertool'];
  const found = [];
  for (const pg of pages) for (const t of pg.tools || []) if (want.includes(t.toolId)) found.push({ page: pg.title, ...t });
  console.log('\n=== tool ids');
  for (const t of found) console.log(t.toolId, t.id, t.page, t.title);

  console.log('\n=== live tool markup');
  for (const t of found) {
    const res = await req(`/portal/site/${sid}/tool/${t.id}`, 'text/html');
    fs.writeFileSync(`capture/tool_${t.toolId}.html`, res.text);
    const apiHits = [...res.text.matchAll(/["'](\/[A-Za-z0-9_.\-]*(?:rest|direct|api)[A-Za-z0-9_./\-${}]*)/g)].map((m) => m[1]);
    console.log(`\n--- ${t.toolId} page=${t.page} status=${res.status} len=${res.text.length}`);
    console.log('   api paths:', [...new Set(apiHits)].slice(0, 25).join(' ') || '(none)');
    const title = (res.text.match(/<title>([^<]*)/) || [])[1];
    console.log('   title:', title);
  }
})();
