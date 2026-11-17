/* Personal UG Sakai PWA — no dependencies. */
'use strict';

const CACHE_PREFIX = 'sakui:v1:';
const TABS = [
  { id: 'dashboard', icon: '◫', label: 'Dashboard' },
  { id: 'assignments', icon: '▤', label: 'Assignments' },
  { id: 'announcements', icon: '◉', label: 'Announcements' },
  { id: 'calendar', icon: '▦', label: 'Calendar' },
  { id: 'resources', icon: '▣', label: 'Resources' },
  { id: 'grades', icon: '◈', label: 'Grades' },
  { id: 'lessons', icon: '▧', label: 'Lessons' },
  { id: 'sites', icon: '⊞', label: 'Courses' },
];

const state = {
  tab: 'dashboard',
  siteFilter: '',
  user: null,
  envLogin: false,
  syncing: false,
  lastSync: null,
  cacheOnly: false,
  data: { sites: [], assignments: [], announcements: [], calendar: [], resources: {}, lessons: {}, grades: {}, pages: {} },
};

const $ = (s) => document.querySelector(s);
const el = (id) => document.getElementById(id);

/* ---------------- utilities ---------------- */

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const ALLOWED_TAGS = new Set(['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'SPAN', 'DIV', 'A', 'IMG', 'BLOCKQUOTE', 'PRE', 'CODE', 'HR', 'SUB', 'SUP']);

function sanitize(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  for (let pass = 0; pass < 8; pass++) {
    const bad = [...doc.body.querySelectorAll('*')].filter((n) => !ALLOWED_TAGS.has(n.tagName));
    if (!bad.length) break;
    for (const n of bad) {
      const parent = n.parentNode;
      if (!parent) continue;
      while (n.firstChild) parent.insertBefore(n.firstChild, n);
      n.remove();
    }
  }
  for (const n of doc.body.querySelectorAll('*')) {
    for (const attr of [...n.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      let keep = ['alt', 'title', 'colspan', 'rowspan'].includes(name);
      if (name === 'href' && n.tagName === 'A') keep = /^https?:\/\//i.test(value);
      if (name === 'src' && n.tagName === 'IMG') keep = /^https?:\/\//i.test(value);
      if (!keep) n.removeAttribute(attr.name);
    }
    if (n.tagName === 'A') {
      n.setAttribute('target', '_blank');
      n.setAttribute('rel', 'noopener noreferrer');
    }
  }
  return doc.body.innerHTML;
}

function plain(html) {
  const d = new DOMParser().parseFromString(String(html || ''), 'text/html');
  return (d.body.textContent || '').replace(/\s+/g, ' ').trim();
}

/**
 * Sakai's Direct API returns dates in several shapes depending on the endpoint:
 *   1794576015065                            (announcements)
 *   { epochSecond: 1794873540, nano: 0 }     (assignment/site/*.json)
 *   { display: 'Nov 3, 2026...', time: ... }  (calendar)
 *   '20260924005938936'                       (resource modifiedDate)
 * Normalise all of them to epoch milliseconds here.
 */
function ms(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') {
    if (Number.isFinite(v.time)) return v.time;
    if (Number.isFinite(v.epochSecond)) return v.epochSecond * 1000;
    if (Number.isFinite(v.epochMillis)) return v.epochMillis;
    v = v.display;
    if (v == null) return null;
  }
  const n = Number(v);
  if (Number.isFinite(n) && n > 1e11 && n < 1e14) return n;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function fmtDate(v, opts = {}) {
  if (v == null || v === '') return '—';
  const t = ms(v);
  if (t == null) return String(typeof v === 'object' ? (v.display || '') : v);
  return new Date(t).toLocaleDateString(undefined, {
    day: 'numeric', month: 'short',
    ...(opts.year ? { year: '2-digit' } : {}),
    ...(opts.time ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

function daysUntil(v) {
  const t = ms(v);
  if (!t) return null;
  return Math.ceil((t - Date.now()) / 86400000);
}

function dueLabel(v) {
  const d = daysUntil(v);
  if (d == null) return { cls: '', text: fmtDate(v, { year: true, time: true }) };
  if (d < 0) return { cls: 'muted', text: `${fmtDate(v, { year: true })} · ${Math.abs(d)}d ago` };
  if (d === 0) return { cls: 'deadline-urgent', text: 'Due today' };
  if (d === 1) return { cls: 'deadline-urgent', text: 'Due tomorrow' };
  if (d <= 3) return { cls: 'deadline-soon', text: `Due in ${d} days` };
  return { cls: '', text: fmtDate(v, { year: true }) };
}

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (!n) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

function toast(message, isError = false) {
  const t = el('toast');
  t.textContent = message;
  t.className = `toast${isError ? ' error' : ''}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}

function setSync(text) {
  el('sync-status').textContent = text;
}

function siteTitle(id) {
  return state.data.sites.find((s) => s.id === id)?.title || id || 'Unknown course';
}

function shortSite(id) {
  const t = siteTitle(id);
  return t.length > 34 ? `${t.slice(0, 32)}…` : t;
}

function fileKind(type) {
  if (type === 'collection') return '📁';
  if (/pdf/i.test(type || '')) return '📕';
  if (/word|document/i.test(type || '')) return '📘';
  if (/presentation|powerpoint/i.test(type || '')) return '📙';
  if (/sheet|excel/i.test(type || '')) return '📗';
  if (/image/i.test(type || '')) return '🖼️';
  if (/video/i.test(type || '')) return '🎬';
  return '📄';
}

/* ---------------- storage ---------------- */

function cacheSet(key, value) {
  try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), v: value })); } catch { /* quota */ }
}

function cacheGet(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    return raw ? JSON.parse(raw).v : undefined;
  } catch { return undefined; }
}

function loadCache() {
  const d = state.data;
  d.sites = cacheGet('sites') || [];
  d.assignments = cacheGet('assignments') || [];
  d.announcements = cacheGet('announcements') || [];
  d.calendar = cacheGet('calendar') || [];
  d.resources = cacheGet('resources') || {};
  d.lessons = cacheGet('lessons') || {};
  d.grades = cacheGet('grades') || {};
  d.pages = cacheGet('pages') || {};
  state.lastSync = cacheGet('lastSync') || null;
  state.user = cacheGet('user') || null;
  if (state.lastSync) setSync(`Cached ${fmtDate(state.lastSync, { time: true })}`);
}

/* ---------------- api ---------------- */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) {
    showLogin('Your session expired. Sign in again.');
    throw new Error('unauthorized');
  }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function login(username, password) {
  const body = username ? { username, password } : {};
  const out = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(body) });
  state.user = out.user;
  cacheSet('user', out.user);
  el('login-screen').hidden = true;
  el('app').hidden = false;
  updateUserChip();
  await refresh();
}

async function refresh(force = false) {
  if (state.syncing) return;
  // The upstream is slow and load-balanced; don't re-fetch everything on every open.
  const age = state.lastSync ? Date.now() - state.lastSync : Infinity;
  if (!force && age < 10 * 60 * 1000 && state.data.sites.length) {
    setSync(`Cached ${fmtDate(state.lastSync, { time: true })}`);
    render();
    return;
  }
  state.syncing = true;
  setSync('Syncing…');
  el('refresh-btn').disabled = true;

  try {
    // `fresh=1` tells the proxy to bypass its session cache.
    const q = force ? (p) => p + (p.includes('?') ? '&' : '?') + 'fresh=1' : (p) => p;
    const keys = {
      sites: q('/api/sites'),
      assignments: q('/api/assignments'),
      announcements: q('/api/announcements?n=40&d=365'),
      calendar: q('/api/calendar'),
    };
    const results = await Promise.allSettled(Object.entries(keys).map(async ([k, p]) => [k, await api(p)]));
    let failed = 0;
    for (const r of results) {
      if (r.status === 'fulfilled') {
        const [k, v] = r.value;
        state.data[k] = v;
        cacheSet(k, v);
        render(); // populate progressively; upstream calls can take a minute
      } else failed++;
    }

    const sites = state.data.sites;
    const perSite = [];
    for (const site of sites) {
      perSite.push(['resources', site.id, q(`/api/resources?site=${encodeURIComponent(site.id)}`)]);
      perSite.push(['lessons', site.id, q(`/api/lessons?site=${encodeURIComponent(site.id)}`)]);
      perSite.push(['grades', site.id, q(`/api/grades?site=${encodeURIComponent(site.id)}`)]);
      perSite.push(['pages', site.id, q(`/api/sites/${encodeURIComponent(site.id)}/pages`)]);
    }

    // 4 concurrent requests, so a slow course cannot hold up the rest
    let cursor = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (cursor < perSite.length) {
        const [kind, sid, path] = perSite[cursor++];
        try {
          const value = await api(path);
          state.data[kind][sid] = value;
          cacheSet(kind, state.data[kind]);
          if (kind === 'grades' || kind === 'resources') render();
        } catch { failed++; }
      }
    }));

    state.lastSync = Date.now();
    cacheSet('lastSync', state.lastSync);
    setSync(`Synced ${fmtDate(state.lastSync, { time: true })}`);
    render();
    if (failed) toast(`Synced with ${failed} failed request${failed > 1 ? 's' : ''}`, true);
  } catch (err) {
    if (err.message !== 'unauthorized') {
      state.cacheOnly = true;
      setSync('Offline · cached data');
      toast(`Sync failed: ${err.message}`, true);
      render();
    }
  } finally {
    state.syncing = false;
    el('refresh-btn').disabled = false;
  }
}

/* ---------------- rendering ---------------- */

function showLogin(message = '') {
  el('app').hidden = true;
  el('login-screen').hidden = false;
  el('login-error').textContent = message;
}

function updateUserChip() {
  const u = state.user;
  if (!u) return;
  el('user-chip').innerHTML = `<span class="avatar">${esc(initials(u.displayName))}</span><span>${esc(u.displayName)}</span>`;
}

function renderNav() {
  const counts = {
    assignments: state.data.assignments.filter((a) => daysUntil(a.dueTime) != null && daysUntil(a.dueTime) <= 7 && daysUntil(a.dueTime) >= 0).length,
    announcements: state.data.announcements.length,
    sites: state.data.sites.length,
  };
  el('nav').innerHTML = TABS.map((t) => `
    <button type="button" data-tab="${t.id}" class="${state.tab === t.id ? 'active' : ''}">
      <span class="icon">${t.icon}</span><span>${t.label}</span>
      ${counts[t.id] ? `<span class="badge">${counts[t.id]}</span>` : ''}
    </button>`).join('');
}

function renderSiteFilter() {
  const sel = el('site-filter');
  const current = state.siteFilter;
  sel.innerHTML = '<option value="">All courses</option>' + state.data.sites
    .map((s) => `<option value="${esc(s.id)}">${esc(s.title)}</option>`).join('');
  sel.value = current;
}

function inScope(item) {
  if (!state.siteFilter) return true;
  const sid = item.context || item.siteId || item.site || item.locationReference?.replace('/site/', '') || item.id;
  return sid === state.siteFilter;
}

function filtered(list) {
  return list.filter(inScope);
}

function render() {
  renderNav();
  renderSiteFilter();
  updateUserChip();
  const titles = {
    dashboard: ['Dashboard', 'What needs your attention right now'],
    assignments: ['Assignments', 'Deadlines and submission status across your courses'],
    announcements: ['Announcements', 'Latest messages from your courses'],
    calendar: ['Calendar', 'Events, quizzes and deadlines'],
    resources: ['Resources', 'Files shared in your courses'],
    grades: ['Grades', 'Gradebook summaries, read from your courses'],
    lessons: ['Lessons', 'Lesson materials published in your courses'],
    sites: ['Courses', 'Your current enrolments'],
  };
  el('page-title').textContent = titles[state.tab][0];
  el('page-subtitle').textContent = titles[state.tab][1];
  const fn = {
    dashboard: renderDashboard,
    assignments: renderAssignments,
    announcements: renderAnnouncements,
    calendar: renderCalendar,
    resources: renderResources,
    grades: renderGrades,
    lessons: renderLessons,
    sites: renderSites,
  }[state.tab];
  el('content').innerHTML = fn ? fn() : '<p>Unknown view.</p>';
}

function renderDashboard() {
  const a = filtered(state.data.assignments);
  const soon = a.filter((x) => { const d = daysUntil(x.dueTime); return d != null && d >= 0 && d <= 14 && !x.submissions?.[0]?.graded; });
  const graded = a.filter((x) => x.submissions?.some((s) => s.graded));
  const resources = Object.values(state.data.resources).flat();
  const gradeItems = Object.values(state.data.grades).reduce((n, g) => n + (g.items?.length || 0), 0);

  const deadlines = [
    ...a.map((x) => ({ kind: 'assignment', id: x.id, title: x.title, site: x.context, time: ms(x.dueTime), label: 'Assignment', extra: x.status })),
    ...filtered(state.data.calendar).map((x) => ({ kind: 'event', id: x.eventId, title: x.title, site: x.siteId, time: ms(x.firstTime), label: x.type || 'Event', extra: '' })),
  ].filter((x) => x.time != null && x.time >= Date.now() - 2 * 86400000 && x.time <= Date.now() + 21 * 86400000)
    .sort((x, y) => x.time - y.time).slice(0, 9);

  const anncs = filtered(state.data.announcements).slice(0, 4);

  return `
    <div class="grid grid-4">
      ${statCard(state.data.sites.length, 'Courses', 'This semester')}
      ${statCard(soon.length, 'Due in 14 days', 'Assignments not yet graded', soon.length ? 'var(--amber)' : 'var(--green)')}
      ${statCard(state.data.announcements.length, 'Announcements', 'Recent feed')}
      ${statCard(gradeItems, 'Graded items', `${Object.keys(state.data.grades).length} gradebooks`) }
    </div>

    <div class="grid grid-2" style="margin-top:20px">
      <section class="card">
        <div class="card-head"><h2>Upcoming deadlines</h2><span class="pill blue">21 days</span></div>
        ${deadlines.length ? `<div class="timeline">${deadlines.map((x) => {
          const l = dueLabel(x.time);
          return `<div class="item">
            <div class="row-title">${esc(x.title)}</div>
            <div class="row-meta"><span class="course-tag">${esc(shortSite(x.site))}</span><span>${esc(x.label)}</span></div>
            <div class="small ${l.cls}">${esc(l.text)}</div>
          </div>`;
        }).join('')}</div>` : '<div class="empty">Nothing due in the next three weeks. Enjoy it.</div>'}
      </section>

      <section class="card">
        <div class="card-head"><h2>Latest announcements</h2><span class="pill purple">${state.data.announcements.length}</span></div>
        ${anncs.length ? `<div class="list">${anncs.map((n) => `
          <div class="row">
            <div class="row-main">
              <div class="row-title">${esc(n.title || '(untitled)')}</div>
              <div class="row-meta"><span class="course-tag">${esc(shortSite(n.siteId))}</span><span>${esc(fmtDate(n.createdOn, { year: true }))}</span></div>
              <div class="annc-body small" style="margin-top:6px">${esc(plain(n.body).slice(0, 170))}${plain(n.body).length > 170 ? '…' : ''}</div>
            </div>
          </div>`).join('')}</div>` : '<div class="empty">No announcements yet.</div>'}
      </section>
    </div>

    <div class="grid grid-2" style="margin-top:20px">
      <section class="card">
        <div class="card-head"><h2>Submission progress</h2><span class="small muted">${graded.length} graded / ${a.length} total</span></div>
        ${a.length ? `<div class="chart">${a.slice(-14).map((x) => {
          const g = x.submissions?.some((s) => s.graded);
          const p = x.submissions?.some((s) => s.submitted);
          const h = g ? 100 : p ? 62 : 22;
          return `<div class="bar" style="height:${h}%" title="${esc(x.title)}"></div>`;
        }).join('')}</div><p class="tiny dim" style="margin-top:26px">Tall = graded, medium = submitted, short = not started.</p>` : '<div class="empty">No assignments.</div>'}
      </section>
      <section class="card">
        <div class="card-head"><h2>At a glance</h2></div>
        <table class="data">
          <tr><td>Course resources</td><td class="num">${resources.length} files & folders</td></tr>
          <tr><td>Calendar events</td><td class="num">${filtered(state.data.calendar).length}</td></tr>
          <tr><td>Lessons</td><td class="num">${Object.values(state.data.lessons).flat().length}</td></tr>
          <tr><td>Last synced</td><td class="num">${state.lastSync ? esc(fmtDate(state.lastSync, { time: true })) : 'never'}</td></tr>
        </table>
        <p class="tiny dim" style="margin-top:14px">All data is stored locally on this device. Sakai never sees a request from this UI that you did not trigger.</p>
      </section>
    </div>`;
}

function statCard(value, label, foot, color) {
  return `<div class="card stat"><div class="value" ${color ? `style="color:${color}"` : ''}>${esc(value)}</div><div class="label">${esc(label)}</div><div class="foot">${esc(foot)}</div></div>`;
}

function assignmentPill(x) {
  if (x.submissions?.some((s) => s.graded)) return `<span class="pill green">Graded ${esc(x.submissions.find((s) => s.graded).grade || '')}</span>`;
  if (x.submissions?.some((s) => s.submitted)) return '<span class="pill blue">Submitted</span>';
  if (x.status === 'CLOSED') return '<span class="pill gray">Closed</span>';
  if (x.status === 'NOT_OPEN' || x.status === 'DUE') return '<span class="pill purple">Upcoming</span>';
  return '<span class="pill amber">To do</span>';
}

function renderAssignments() {
  const all = filtered(state.data.assignments).slice().sort((a, b) => (ms(a.dueTime) || 0) - (ms(b.dueTime) || 0));
  const open = all.filter((x) => (ms(x.dueTime) || 0) >= Date.now() - 86400000);
  const past = all.filter((x) => (ms(x.dueTime) || 0) < Date.now() - 86400000).reverse();
  const block = (title, list) => list.length ? `
    <div class="section-title">${title} · ${list.length}</div>
    <div class="list">${list.map((x) => {
      const d = dueLabel(x.dueTime);
      return `<div class="row">
        <div class="row-main">
          <div class="row-title">${esc(x.title || '(untitled)')}</div>
          <div class="row-meta"><span class="course-tag">${esc(shortSite(x.context))}</span><span class="${d.cls}">${esc(d.text)}</span>${x.maxGradePoint ? `<span>Max ${esc(x.maxGradePoint)}</span>` : ''}</div>
        </div>
        <div class="row-side">${assignmentPill(x)}</div>
      </div>`;
    }).join('')}</div>` : '';
  return all.length ? block('Open & upcoming', open) + block('Past', past) : '<div class="empty">No assignments found for this selection.</div>';
}

function renderAnnouncements() {
  const list = filtered(state.data.announcements);
  return list.length ? `<div class="grid grid-2">${list.map((n) => `
    <article class="card">
      <div class="row-meta" style="margin-bottom:8px"><span class="course-tag">${esc(shortSite(n.siteId))}</span><span>${esc(n.createdByDisplayName || '')}</span><span>${esc(fmtDate(n.createdOn, { year: true, time: true }))}</span></div>
      <h3 style="font-size:16px;margin-bottom:10px">${esc(n.title || '(untitled)')}</h3>
      <div class="annc-body">${sanitize(n.body)}</div>
    </article>`).join('')}</div>` : '<div class="empty">No announcements yet.</div>';
}

function renderCalendar() {
  const list = filtered(state.data.calendar).slice().sort((a, b) => (a.firstTime || 0) - (b.firstTime || 0));
  const groups = new Map();
  for (const e of list) {
    const t = ms(e.firstTime);
    const group = t == null ? 'Other' : new Date(t).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(e);
  }
  if (!list.length) return '<div class="empty">No calendar events.</div>';
  return [...groups].map(([month, events]) => `
    <div class="section-title">${esc(month)}</div>
    <div class="list">${events.map((e) => {
      const d = dueLabel(e.firstTime);
      return `<div class="row">
        <div class="row-main">
          <div class="row-title">${esc(e.title || '(untitled)')}</div>
          <div class="row-meta"><span class="course-tag">${esc(shortSite(e.siteId))}</span><span>${esc(e.type || 'Event')}</span></div>
          ${e.description ? `<div class="annc-body small" style="margin-top:5px">${esc(plain(e.description).slice(0, 140))}</div>` : ''}
        </div>
        <div class="row-side"><span class="small ${d.cls}">${esc(fmtDate(e.firstTime, { year: true, time: true }))}</span></div>
      </div>`;
    }).join('')}</div>`).join('');
}

function renderResources() {
  const sites = state.data.sites.filter((s) => !state.siteFilter || s.id === state.siteFilter);
  if (!state.siteFilter) {
    return `<div class="grid grid-3">${sites.map((s) => {
      const items = state.data.resources[s.id] || [];
      return `<button class="card stat" type="button" data-action="pick-site" data-site="${esc(s.id)}" style="text-align:left">
        <div class="row-title">${esc(s.title)}</div>
        <div class="small muted" style="margin-top:6px">${items.length} items · ${humanSize(items.reduce((n, i) => n + (Number(i.size) || 0), 0))}</div>
      </button>`;
    }).join('')}</div>`;
  }
  const items = state.data.resources[state.siteFilter] || [];
  if (!items.length) return '<div class="empty">No resources in this course.</div>';
  const folders = new Map();
  for (const item of items) {
    const key = item.container || '/';
    if (!folders.has(key)) folders.set(key, []);
    folders.get(key).push(item);
  }
  return `<p class="small muted" style="margin-top:0">${items.length} items in ${esc(shortSite(state.siteFilter))}. Large files stream through the proxy.</p>` +
    [...folders].map(([path, files]) => `
      <section class="folder">
        <div class="folder-name">📁 ${esc(path.replace(/^\/content\/group\/[^/]+\/?/, '') || 'Course root')}</div>
        <div class="list">${files.map((f) => {
          const isFile = f.type !== 'collection';
          const p = new URL(f.url, location.href).pathname;
          const href = `/api/file?path=${encodeURIComponent(p)}`;
          const big = Number(f.size) > 20 * 1024 * 1024;
          return `<div class="row">
            <div class="row-main">
              <div class="row-title"><span class="file-icon">${fileKind(f.type)}</span>${isFile ? `<a href="${esc(href)}" download>${esc(f.title)}</a>` : esc(f.title)}</div>
              <div class="row-meta"><span>${esc(f.type === 'collection' ? `${f.numChildren || 0} items` : humanSize(f.size))}</span><span>Modified ${esc(String(f.modifiedDate || '').slice(0, 8))}</span></div>
            </div>
            <div class="row-side">${big && isFile ? '<span class="pill amber">Large file</span>' : ''}</div>
          </div>`;
        }).join('')}</div>
      </section>`).join('');
}

function renderGrades() {
  const sites = state.data.sites.filter((s) => !state.siteFilter || s.id === state.siteFilter);
  const blocks = sites.map((s) => {
    const g = state.data.grades[s.id];
    if (!g) return `<section class="card"><h2>${esc(s.title)}</h2><div class="empty">No gradebook data.</div></section>`;
    const items = g.items || [];
    return `<section class="card" style="margin-bottom:16px">
      <div class="card-head"><h2>${esc(s.title)}</h2><span class="small muted">Course grade: ${esc(g.courseGrade || '—')}</span></div>
      ${items.length ? `<table class="data"><thead><tr><th>Item</th><th>Due</th><th class="num">Score</th></tr></thead><tbody>
        ${items.map((i) => `<tr><td>${esc(i.title)}</td><td class="small muted">${esc(i.dueDate || '—')}</td>
          <td class="num">${i.score && i.score !== '-' ? `<b>${esc(i.score)}</b> ${esc(i.scoreOutOf || '')}` : '—'}</td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">No published grades.</div>'}
    </section>`;
  });
  return blocks.length ? blocks.join('') : '<div class="empty">No courses selected.</div>';
}

function renderLessons() {
  const sites = state.data.sites.filter((s) => !state.siteFilter || s.id === state.siteFilter);
  const out = sites.map((s) => {
    const list = state.data.lessons[s.id] || [];
    if (!list.length) return '';
    return `<div class="section-title">${esc(s.title)}</div><div class="list">${list.map((l) => `
      <div class="row"><div class="row-main"><div class="row-title">${esc(l.lessonTitle || 'Lesson')}</div>
      <div class="row-meta"><span>${l.releaseDate ? `Released ${esc(fmtDate(l.releaseDate, { year: true }))}` : 'No release date'}</span>${l.hidden ? '<span class="pill gray">Hidden</span>' : ''}</div></div>
      <div class="row-side"><a class="btn btn-small btn-ghost" href="/api/lessons?site=${encodeURIComponent(s.id)}" title="Lesson id ${esc(l.id)}">Details</a></div></div>`).join('')}</div>`;
  }).join('');
  return out || '<div class="empty">No lessons published.</div>';
}

function renderSites() {
  return `<div class="grid grid-3">${state.data.sites.map((s) => {
    const pages = state.data.pages[s.id] || [];
    const tools = [...new Set(pages.flatMap((p) => (p.tools || []).map((t) => t.title || t.toolId)))];
    const m = state.data.sites.find((x) => x.id === s.id);
    return `<article class="card">
      <div class="row-title" style="white-space:normal">${esc(s.title)}</div>
      <div class="row-meta" style="margin:8px 0 12px"><span class="pill blue">${esc(s.type || 'course')}</span><span class="pill gray">${esc(m?.role || 'member')}</span></div>
      <div class="tiny dim" style="word-break:break-all">${esc(s.id)}</div>
      <div class="tool-grid" style="margin-top:12px">${tools.slice(0, 10).map((t) => `<div class="tool-chip">${esc(t)}</div>`).join('')}</div>
      <a class="btn btn-small btn-ghost" style="margin-top:14px;display:inline-block" href="https://sakai.ug.edu.gh/portal/site/${encodeURIComponent(s.id)}" target="_blank" rel="noopener noreferrer">Open in Sakai ↗</a>
    </article>`;
  }).join('')}</div>`;
}

/* ---------------- events ---------------- */

function wire() {
  el('nav').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    state.tab = b.dataset.tab;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  el('site-filter').addEventListener('change', (e) => {
    state.siteFilter = e.target.value;
    render();
  });

  el('content').addEventListener('click', (e) => {
    const b = e.target.closest('[data-action="pick-site"]');
    if (!b) return;
    state.siteFilter = b.dataset.site;
    state.tab = 'resources';
    render();
  });

  el('refresh-btn').addEventListener('click', () => refresh(true));

  el('logout-btn').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    for (const k of Object.keys(localStorage)) if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
    state.data = { sites: [], assignments: [], announcements: [], calendar: [], resources: {}, lessons: {}, grades: {}, pages: {} };
    state.user = null;
    state.lastSync = null;
    showLogin();
  });

  el('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('login-error').textContent = '';
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await login(el('login-id').value.trim(), el('login-password').value);
      el('login-password').value = '';
    } catch (err) {
      el('login-error').textContent = err.message === 'unauthorized' ? 'Sign in failed.' : err.message;
    } finally { btn.disabled = false; }
  });

  el('login-env').addEventListener('click', async () => {
    el('login-error').textContent = '';
    try { await login(); } catch (err) { el('login-error').textContent = err.message; }
  });

  window.addEventListener('online', () => refresh(true));
  window.addEventListener('offline', () => {
    state.cacheOnly = true;
    setSync('Offline · cached data');
  });
}

/* ---------------- boot ---------------- */

async function boot() {
  loadCache();
  wire();
  render();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/app/sw.js').catch(() => {});
  }
  if (navigator.onLine) {
    try {
      const cfg = await api('/api/config');
      state.envLogin = !!cfg.envLogin;
      el('login-env').hidden = !state.envLogin;
    } catch { /* proxy may be an older build */ }
  }

  try {
    const me = await api('/api/me');
    state.user = me;
    el('login-screen').hidden = true;
    el('app').hidden = false;
    render();
    await refresh();
  } catch {
    showLogin();
    if (state.envLogin) toast('Not signed in — use the .env button to continue.');
  }
}

boot();
