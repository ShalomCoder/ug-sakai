// Probe the per-tool Direct endpoints that a frontend would actually consume.
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
async function req(path) {
  const res = await fetch(BASE + path, {
    redirect: 'manual',
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) },
  });
  for (const c of res.headers.getSetCookie()) { const [p] = c.split(';'); const i = p.indexOf('='); if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); }
  return { status: res.status, text: await res.text() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const e = env();
  const b = new URLSearchParams({ _username: e.SAKAI_ID, _password: e.SAKAI_PASSWORD });
  const r = await fetch(BASE + '/direct/session', { method: 'POST', redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded' }, body: b.toString() });
  for (const c of r.headers.getSetCookie()) { const [p] = c.split(';'); const i = p.indexOf('='); if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); }
  console.log('login', r.status);

  // Gradebook Next-Gen schema first
  for (const d of ['gbng', 'assignment', 'content', 'forums', 'polls', 'lessons', 'syllabus', 'sam_core', 'roster-membership']) {
    const res = await req(`/direct/${d}/describe`);
    fs.writeFileSync(`${OUT}/describe_${d.replace(/\//g, '_')}.html`, res.text);
    const urls = [...res.text.matchAll(/\/direct\/[A-Za-z0-9_\-{}./$:]+/g)].map((m) => m[0]);
    const uniq = [...new Set(urls)].filter((u) => !u.includes('describe'));
    console.log(`\n--- ${d} describe (${res.status}) endpoints:`);
    console.log(uniq.slice(0, 80).join('\n'));
    await sleep(100);
  }

  const sid = 'DCIT-101-1-S1-2627';
  const probes = [
    ['assignments', `/direct/assignment/site/${sid}.json`],
    ['assignments_my', `/direct/assignment/my.json`],
    ['announcements', `/direct/announcement/site/${sid}.json`],
    ['announcements_my', `/direct/announcement/user.json`],
    ['calendar', `/direct/calendar/site/${sid}.json`],
    ['calendar_my', `/direct/calendar/my.json`],
    ['content', `/direct/content/site/${sid}.json`],
    ['forums', `/direct/forums/site/${sid}.json`],
    ['polls', `/direct/polls/site/${sid}.json`],
    ['lessons', `/direct/lessons/site/${sid}.json`],
    ['syllabus', `/direct/syllabus/site/${sid}.json`],
    ['sam_core', `/direct/sam_core/site/${sid}.json`],
    ['sam_pub', `/direct/sam_pub/site/${sid}.json`],
    ['members', `/direct/membership/site/${sid}.json`],
    ['gbng_grades', `/direct/gbng/site/${sid}.json`],
    ['gbng_mygrades', `/direct/gbng/my.json`],
    ['dropbox', `/direct/dropbox/site/${sid}.json`],
    ['mailarchive', `/direct/mailarchive/site/${sid}.json`],
    ['wiki', `/direct/wiki/site/${sid}.json`],
    ['chat', `/direct/chat-channel/site/${sid}.json`],
    ['sitestats', `/direct/sitestats/site/${sid}.json`],
    ['roster', `/direct/roster-membership/site/${sid}.json`],
    ['profile', `/direct/profile/current.json`],
    ['userprefs', `/direct/userPrefs/current.json`],
  ];

  console.log('\n\n=== per-tool endpoint probe for', sid);
  for (const [name, path] of probes) {
    const res = await req(path);
    fs.writeFileSync(`${OUT}/raw_${name}.json`, res.text);
    const clean = res.text.replace(/\s+/g, ' ');
    console.log(`${name.padEnd(20)} ${String(res.status).padEnd(4)} ${String(res.text.length).padStart(8)}  ${clean.slice(0, 170)}`);
    await sleep(120);
  }
})();
