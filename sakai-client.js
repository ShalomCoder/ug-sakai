'use strict';
/**
 * Minimal, dependency-free client for the Sakai Direct REST API at UG.
 * Verified against Sakai 25.1 @ https://sakai.ug.edu.gh
 *
 *   const { SakaiClient } = require('./sakai-client');
 *   const s = new SakaiClient();
 *   await s.login('22553484', 'password');
 *   console.log(await s.assignments());
 *   await s.logout();
 *
 * See SAKAI_API.md for the endpoint contract and its limits.
 */

const BASE = 'https://sakai.ug.edu.gh';

class SakaiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'SakaiError';
    this.status = status;
    this.body = body;
  }
}

class SakaiClient {
  /**
   * @param {{base?: string, userAgent?: string, timeoutMs?: number,
   *          cookies?: Record<string,string>, sessionId?: string, user?: object}} [opts]
   */
  constructor(opts = {}) {
    this.base = (opts.base || BASE).replace(/\/+$/, '');
    this.userAgent = opts.userAgent || 'sakai-client/1.0';
    this.timeoutMs = opts.timeoutMs || 180000; // this host is intermittently very slow
    this.cookies = new Map(Object.entries(opts.cookies || {})); // name -> value
    this.sessionId = opts.sessionId || null;   // UUID returned by POST /direct/session
    this.user = opts.user || null;
  }

  /** Credentials + identity, for sealing into a browser cookie on serverless hosts. */
  get authState() {
    return {
      cookies: Object.fromEntries(this.cookies),
      sessionId: this.sessionId,
      user: this.user,
    };
  }

  get authenticated() {
    return this.cookies.has('SAKAI2SESSIONID');
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  _absorb(res) {
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      if (i <= 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!value || /^(deleted|""?)$/i.test(value)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  /**
   * @param {string} path absolute path on the Sakai host, or a full URL
   * @param {{method?: string, body?: URLSearchParams|string, accept?: string,
   *          redirect?: RequestRedirect, timeoutMs?: number}} [opts]
   */
  async request(path, opts = {}) {
    const url = path.startsWith('http') ? path : this.base + path;
    const headers = { 'User-Agent': this.userAgent, Accept: opts.accept || 'application/json' };
    if (this.cookies.size) headers.Cookie = this.cookieHeader();
    if (opts.body) headers['Content-Type'] = 'application/x-www-form-urlencoded';

    const res = await fetch(url, {
      method: opts.method || 'GET',
      body: opts.body instanceof URLSearchParams ? opts.body.toString() : opts.body,
      headers,
      redirect: opts.redirect || 'manual',
      signal:
        opts.timeoutMs === 0 || opts.timeoutMs === null
          ? undefined
          : AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
    });
    this._absorb(res);
    return res;
  }

  async json(path, opts) {
    const res = await this.request(path, opts);
    const text = await res.text();
    if (!res.ok) {
      const msg = (text.match(/<b>Message<\/b>\s*([^<]+)/) || [])[1] || res.statusText;
      throw new SakaiError(`GET ${path} -> ${res.status}: ${msg.trim()}`, res.status, text);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new SakaiError(`GET ${path} returned non-JSON`, res.status, text);
    }
  }

  /** Log in. @returns {Promise<string>} the Sakai session id */
  async login(username, password) {
    const body = new URLSearchParams();
    body.set('_username', username);
    body.set('_password', password);

    const res = await this.request('/direct/session', { method: 'POST', body });
    const text = await res.text();

    if (res.status !== 201) {
      const msg = (text.match(/<b>Message<\/b>\s*([^<]+)/) || [])[1] || text.slice(0, 200);
      throw new SakaiError(
        res.status === 403 ? 'Invalid username or password' : `Login failed (${res.status}): ${msg.trim()}`,
        res.status,
        text,
      );
    }
    this.sessionId = text.trim();
    this.user = await this.json('/direct/user/current.json');
    return this.sessionId;
  }

  /**
   * Log out. Must use the session UUID; /direct/session/current does not accept DELETE.
   * Always clears local state, even if the network call fails.
   */
  async logout() {
    const id = this.sessionId;
    this.cookies.clear();
    this.sessionId = null;
    this.user = null;
    if (!id) return;
    try {
      await this.request(`/direct/session/${id}`, { method: 'DELETE' });
    } catch {
      /* session expires on its own within 10 minutes */
    }
  }

  // ---- identity -------------------------------------------------------------

  me() {
    return this.json('/direct/user/current.json');
  }

  session() {
    return this.json('/direct/session/current.json');
  }

  // ---- sites ----------------------------------------------------------------

  async sites() {
    const d = await this.json('/direct/site.json');
    return d.site_collection || [];
  }

  async memberships() {
    const d = await this.json('/direct/membership.json');
    return d.membership_collection || [];
  }

  /** Per-site page + tool instance map. Needed to build /portal/site/.../tool/{id} URLs. */
  async pages(siteId) {
    return this.json(`/direct/site/${encodeURIComponent(siteId)}/pages.json`);
  }

  /** Find the per-site tool instance UUID for a tool type, e.g. 'sakai.gradebookng'. */
  async toolId(siteId, toolType) {
    const pages = await this.pages(siteId);
    for (const page of pages) {
      for (const tool of page.tools || []) {
        if (tool.toolId === toolType) return tool.id;
      }
    }
    return null;
  }

  // ---- tools with JSON ------------------------------------------------------

  /**
   * Assignments for a site, or (without a site id) all of the user's via my.json.
   * On this deployment my.json is very slow (~60s); the proxy merges per-site calls instead.
   */
  async assignments(siteId) {
    const path = siteId
      ? `/direct/assignment/site/${encodeURIComponent(siteId)}.json`
      : '/direct/assignment/my.json';
    const d = await this.json(path);
    return d.assignment_collection || [];
  }

  assignment(assignmentId) {
    return this.json(`/direct/assignment/${encodeURIComponent(assignmentId)}.json`);
  }

  /** Cross-site announcement feed. @param {{n?: number, d?: number, asc?: boolean}} [opts] */
  async announcements(opts = {}) {
    const q = new URLSearchParams();
    if (opts.n != null) q.set('n', opts.n);
    if (opts.d != null) q.set('d', opts.d);
    if (opts.asc != null) q.set('a', opts.asc ? '1' : '0');
    const qs = q.toString();
    const d = await this.json(`/direct/announcement/user.json${qs ? `?${qs}` : ''}`);
    return d.announcement_collection || [];
  }

  async calendar(siteId) {
    const path = siteId
      ? `/direct/calendar/site/${encodeURIComponent(siteId)}.json`
      : '/direct/calendar/my.json';
    const d = await this.json(path);
    return d.calendar_collection || [];
  }

  /** Flat list of every resource item (folders and files) in a site. */
  async resources(siteId) {
    const d = await this.json(`/direct/content/site/${encodeURIComponent(siteId)}.json`);
    return d.content_collection || [];
  }

  async lessons(siteId) {
    try {
      const d = await this.json(`/direct/lessons/site/${encodeURIComponent(siteId)}.json`);
      return d.lessons_collection || [];
    } catch (err) {
      // Several real courses (DCIT-103, UGRC-150) return 500 for this endpoint.
      if (err.status === 500 || err.status === 404) return [];
      throw err;
    }
  }

  lesson(lessonId) {
    return this.json(`/direct/lessons/lesson/${encodeURIComponent(lessonId)}.json`);
  }

  async syllabus(siteId) {
    const d = await this.json(`/direct/syllabus/site/${encodeURIComponent(siteId)}.json`);
    return d.items || [];
  }

  async polls(siteId) {
    const d = await this.json(`/direct/polls/site/${encodeURIComponent(siteId)}.json`);
    return d.polls_collection || [];
  }

  /**
   * Forums + topics. Note: topic-level message retrieval returns 500 on this deployment,
   * so this stops at topic metadata.
   */
  async forums(siteId) {
    try {
      const d = await this.json(`/direct/forums/site/${encodeURIComponent(siteId)}.json`);
      return d.forums_collection || [];
    } catch (err) {
      if (err.status === 500 || err.status === 404) return [];
      throw err;
    }
  }

  async forum(siteId, forumId) {
    return this.json(
      `/direct/forums/site/${encodeURIComponent(siteId)}/forum/${encodeURIComponent(forumId)}.json`,
    );
  }

  /**
   * Resource bytes. Returns a Response so callers can stream or buffer it.
   * No timeout: lecture files run to 139 MB, and a fixed deadline would abort mid-stream.
   */
  download(urlOrPath) {
    return this.request(urlOrPath, { accept: '*/*', timeoutMs: 0 });
  }

  // ---- HTML-only tools ------------------------------------------------------

  /**
   * Student gradebook summary, scraped from the Velocity page (there is no JSON API).
   * @returns {Promise<{courseGrade: string, items: Array<{title:string, score:string,
   *            scoreOutOf:string, dueDate:string, dueDateEpoch:number|null, comment:string}>}>}
   */
  async grades(siteId) {
    const toolId = await this.toolId(siteId, 'sakai.gradebookng');
    if (!toolId) return { courseGrade: '', items: [] };

    const res = await this.request(
      `/portal/site/${encodeURIComponent(siteId)}/tool/${toolId}/gradebook`,
      { accept: 'text/html' },
    );
    if (!res.ok) throw new SakaiError(`gradebook page -> ${res.status}`, res.status, '');
    const html = await res.text();

    const text = (s) =>
      decodeEntities(s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());

    const courseGrade = text(
      (html.match(/gb-summary-course-grade-value[^>]*>([\s\S]*?)<\//) || [])[1] || '',
    );

    const items = [];
    const rows = html.split(/<tr class="gb-summary-grade-row/).slice(1);
    for (const row of rows) {
      const pick = (cls) => {
        const m = row.match(new RegExp(`class="[^"]*${cls}[^"]*"[^>]*>([\\s\\S]*?)<\\/`));
        return m ? text(m[1]) : '';
      };
      const due = row.match(/class="gb-summary-grade-duedate"[^>]*data-sort-key="(\d+)"/);
      items.push({
        title: pick('gb-summary-grade-title'),
        score: pick('gb-summary-grade-score-raw'),
        scoreOutOf: pick('gb-summary-grade-score-outof'),
        dueDate: pick('gb-summary-grade-duedate'),
        dueDateEpoch: due ? Number(due[1]) : null,
        comment: pick('gb-summary-grade-comments'),
      });
    }
    return { courseGrade, items };
  }
}

function decodeEntities(s) {
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', '#039': "'", '#39': "'", apos: "'", nbsp: ' ' };
  return s.replace(/&(#?\w+);/g, (m, e) => map[e] ?? m);
}

module.exports = { SakaiClient, SakaiError, BASE };
