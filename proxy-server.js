'use strict';
/**
 * Same-origin API proxy + PWA shell for the personal UG Sakai dashboard.
 *
 * Sakai sends no Access-Control-Allow-* headers, so a browser cannot call /direct
 * directly. This proxy holds the Sakai session in an encrypted, HttpOnly cookie,
 * which makes it work both as `node proxy-server.js` and on serverless (Vercel),
 * where there is no long-lived process memory.
 *
 *   node proxy-server.js            → http://localhost:8787/app/
 *   vercel deploy                   → https://<project>.vercel.app/app/
 *
 * Browser flow:
 *   POST /api/login   { "username": "...", "password": "..." }  (empty body = use .env)
 *   GET  /api/me, /api/sites, /api/assignments, /api/announcements, /api/calendar
 *   GET  /api/resources?site=, /api/lessons?site=, /api/forums?site=, /api/grades?site=
 *   GET  /api/file?path=/access/content/group/<siteId>/...
 *   POST /api/logout
 *
 * Note: /api/auth/* is reserved by Vercel's own authentication, hence /api/login.
 *
 * No npm dependencies. Node 18+.
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const nodePath = require('path');
const { SakaiClient } = require('./sakai-client');

const PORT = Number(process.env.PORT || 8787);
const ORIGIN = process.env.ALLOWED_ORIGIN || `http://localhost:${PORT}`;
const IDLE_S = 10 * 60; // Sakai reports maxInactiveInterval: 600
const FRONTEND_DIR = nodePath.join(__dirname, 'public', 'app');
const ENV_LOGIN = process.env.ALLOW_ENV_LOGIN !== '0'; // personal-use convenience
const COOKIE_NAME = 'ug_session';

// Load .env locally only. It must never be read (or bundled) in the deployed app:
// there, credentials are typed into the page and live solely in the encrypted cookie.
if (!process.env.VERCEL) {
  try {
    for (const line of fs.readFileSync(nodePath.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  } catch { /* no .env — manual login still works */ }
}

// The cookie carries the Sakai session, so it must be authenticated encryption.
// Set SESSION_SECRET explicitly in production; fall back to the .env password.
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.SAKAI_PASSWORD || 'local-development-only';
const CIPHER_KEY = crypto.createHash('sha256').update(SESSION_SECRET).digest();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * Per-user response cache. Cold reads from this upstream take 30-180 seconds,
 * so a new browser session for the same person must not pay that cost again.
 * Keyed by Sakai user id, so different accounts can never see each other's data.
 * `?fresh=1` bypasses it (used by the Refresh button).
 * On serverless this is best-effort: each instance has its own map.
 */
const dataCache = new Map(); // `${scope}:${key}` -> { t, v }
function cached(scope, key, ttlMs, fresh, load) {
  const id = `${scope}:${key}`;
  if (!fresh) {
    const hit = dataCache.get(id);
    if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  }
  return Promise.resolve(load()).then((v) => {
    dataCache.set(id, { t: Date.now(), v });
    return v;
  });
}

function seal(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', CIPHER_KEY, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');
}

function unseal(token) {
  try {
    const raw = Buffer.from(token, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', CIPHER_KEY, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function isSecure(req) {
  const fp = req.headers['x-forwarded-proto'];
  return (typeof fp === 'string' && fp.split(',')[0].trim() === 'https') || process.env.VERCEL === '1';
}

function sessionCookie(value, maxAge, req) {
  return [
    `${COOKIE_NAME}=${value}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    ...(isSecure(req) ? ['Secure'] : []),
    `Max-Age=${maxAge}`,
  ].join('; ');
}

/** Rebuild a SakaiClient from the signed browser cookie. */
function clientFor(req) {
  const state = unseal(parseCookies(req.headers.cookie)[COOKIE_NAME]);
  if (!state || !state.cookies || typeof state.cookies !== 'object') return null;
  return new SakaiClient(state);
}

function requireSession(req, res) {
  const c = clientFor(req);
  if (!c || !c.authenticated) {
    send(res, 401, { error: 'not authenticated' });
    return null;
  }
  return c;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

function send(res, status, payload, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Serve the PWA shell locally. On Vercel these files are static from public/. */
function serveStatic(route, res) {
  let rel = route === '/app' ? 'index.html' : route.slice('/app/'.length);
  if (rel === '') rel = 'index.html';
  const file = nodePath.resolve(FRONTEND_DIR, rel);
  if (!file.startsWith(FRONTEND_DIR + nodePath.sep) && file !== FRONTEND_DIR) {
    return send(res, 403, { error: 'forbidden' });
  }
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': MIME[nodePath.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  if (path === '/' && req.method === 'GET') {
    res.writeHead(302, { Location: '/app/' });
    res.end();
    return;
  }
  if ((path === '/app' || path.startsWith('/app/')) && req.method === 'GET') {
    return serveStatic(path, res);
  }
  if (path === '/api/config' && req.method === 'GET') {
    return send(res, 200, {
      envLogin: ENV_LOGIN,
      envConfigured: !!(process.env.SAKAI_ID && process.env.SAKAI_PASSWORD),
    });
  }

  try {
    // ---- auth ------------------------------------------------------------
    if (path === '/api/login' && req.method === 'POST') {
      let { username, password } = await readJson(req);
      if (!username && !password) {
        if (!ENV_LOGIN) return send(res, 400, { error: 'username and password required' });
        username = process.env.SAKAI_ID;
        password = process.env.SAKAI_PASSWORD;
        if (!username || !password) return send(res, 400, { error: 'no credentials found in .env' });
      }
      if (!username || !password) return send(res, 400, { error: 'username and password required' });

      const client = new SakaiClient();
      try {
        await client.login(String(username), String(password));
      } catch (err) {
        return send(res, err.status === 403 ? 401 : 502, { error: err.message });
      }

      res.setHeader('Set-Cookie', sessionCookie(seal(client.authState), IDLE_S, req));
      return send(res, 200, {
        user: {
          id: client.user?.id,
          displayName: client.user?.displayName,
          email: client.user?.email,
        },
      });
    }

    if (path === '/api/logout' && req.method === 'POST') {
      const state = unseal(parseCookies(req.headers.cookie)[COOKIE_NAME]);
      if (state && state.sessionId) {
        const client = clientFor(req);
        if (client) await client.logout().catch(() => {});
      }
      res.setHeader('Set-Cookie', sessionCookie('', 0, req));
      return send(res, 200, { ok: true });
    }

    // ---- reads -----------------------------------------------------------
    const entry = clientFor(req);
    const scope = entry?.user?.id || 'anon';
    const fresh = url.searchParams.get('fresh') === '1';

    if (path === '/api/me' && req.method === 'GET') {
      const c = requireSession(req, res);
      if (!c) return;
      return send(res, 200, await c.me());
    }

    if (path === '/api/sites' && req.method === 'GET') {
      const c = requireSession(req, res);
      if (!c) return;
      const body = await cached(scope, 'sites', 5 * 60e3, fresh, async () => {
        const [sites, memberships] = await Promise.all([c.sites(), c.memberships()]);
        const roles = new Map(memberships.map((m) => [m.locationReference.replace('/site/', ''), m.memberRole]));
        return sites.map((s) => ({
          id: s.id,
          title: s.title,
          type: s.type,
          role: roles.get(s.id) || null,
          description: s.description,
          published: s.published,
        }));
      });
      return send(res, 200, body);
    }

    if (path.startsWith('/api/sites/') && path.endsWith('/pages') && req.method === 'GET') {
      const c = requireSession(req, res);
      if (!c) return;
      const siteId = decodeURIComponent(path.split('/')[3]);
      return send(res, 200, await cached(scope, `pages:${siteId}`, 15 * 60e3, fresh, () => c.pages(siteId)));
    }

    if (path === '/api/assignments' && req.method === 'GET') {
      const c = requireSession(req, res);
      if (!c) return;
      const site = url.searchParams.get('site');
      if (site) {
        return send(res, 200, await cached(scope, `assignments:${site}`, 2 * 60e3, fresh, () => c.assignments(site)));
      }

      // /direct/assignment/my.json takes ~60s on this deployment. Per-site calls
      // return the same live assignments in ~200ms, so merge those in parallel.
      const out = await cached(scope, 'assignments:all', 2 * 60e3, fresh, async () => {
        const sites = await c.sites();
        const list = [];
        const seen = new Set();
        let cursor = 0;
        await Promise.all(Array.from({ length: 4 }, async () => {
          while (cursor < sites.length) {
            const sid = sites[cursor++].id;
            try {
              for (const a of await c.assignments(sid)) {
                if (!seen.has(a.id)) { seen.add(a.id); list.push(a); }
              }
            } catch { /* one slow course must not break the list */ }
          }
        }));
        return list;
      });
      return send(res, 200, out);
    }

    if (path === '/api/announcements' && req.method === 'GET') {
      const c = requireSession(req, res);
      if (!c) return;
      const n = Number(url.searchParams.get('n')) || 20;
      const d = Number(url.searchParams.get('d')) || 365;
      return send(res, 200, await cached(scope, `announcements:${n}:${d}`, 5 * 60e3, fresh,
        () => c.announcements({ n, d })));
    }

    if (path === '/api/calendar' && req.method === 'GET') {
      const c = requireSession(req, res);
      if (!c) return;
      const site = url.searchParams.get('site') || undefined;
      return send(res, 200, await cached(scope, `calendar:${site || 'all'}`, 5 * 60e3, fresh,
        () => c.calendar(site)));
    }

    if (path === '/api/resources' && req.method === 'GET') {
      const c = requireSession(req, res);
      if (!c) return;
      const siteId = url.searchParams.get('site');
      if (!siteId) return send(res, 400, { error: 'site query parameter required' });
      return send(res, 200, await cached(scope, `resources:${siteId}`, 15 * 60e3, fresh,
        () => c.resources(siteId)));
    }

    if (path === '/api/lessons' && req.method === 'GET') {
      const c = requireSession(req, res);
      if (!c) return;
      const siteId = url.searchParams.get('site');
      if (!siteId) return send(res, 400, { error: 'site query parameter required' });
      return send(res, 200, await cached(scope, `lessons:${siteId}`, 15 * 60e3, fresh,
        () => c.lessons(siteId)));
    }

    if (path === '/api/forums' && req.method === 'GET') {
      const c = requireSession(req, res);
      if (!c) return;
      const siteId = url.searchParams.get('site');
      if (!siteId) return send(res, 400, { error: 'site query parameter required' });
      return send(res, 200, await cached(scope, `forums:${siteId}`, 15 * 60e3, fresh,
        () => c.forums(siteId)));
    }

    if (path === '/api/grades' && req.method === 'GET') {
      const c = requireSession(req, res);
      if (!c) return;
      const siteId = url.searchParams.get('site');
      if (!siteId) return send(res, 400, { error: 'site query parameter required' });
      return send(res, 200, await cached(scope, `grades:${siteId}`, 15 * 60e3, fresh,
        () => c.grades(siteId)));
    }

    // ---- binary passthrough ---------------------------------------------
    if (path === '/api/file' && req.method === 'GET') {
      const c = requireSession(req, res);
      if (!c) return;
      const target = url.searchParams.get('path') || '';
      // only ever proxy the content mount, never arbitrary hosts or /direct
      if (!target.startsWith('/access/') || target.includes('..')) {
        return send(res, 400, { error: 'path must start with /access/' });
      }
      const upstream = await c.download(target);
      if (!upstream.ok) return send(res, upstream.status, { error: `upstream ${upstream.status}` });
      res.writeHead(200, {
        'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
        'Content-Disposition': upstream.headers.get('content-disposition') || 'inline',
        'Cache-Control': 'private, max-age=300',
      });
      try {
        for await (const chunk of upstream.body) res.write(chunk);
        res.end();
      } catch (streamErr) {
        // headers are gone; the only honest signal left is to cut the connection
        console.error(`GET /api/file: stream failed for ${target}:`, streamErr.message);
        res.destroy(streamErr);
      }
      return;
    }

    send(res, 404, { error: 'not found' });
  } catch (err) {
    if (res.headersSent) {
      console.error(`${req.method} ${path}: failed after headers sent:`, err.message);
      res.destroy(err);
      return;
    }
    const status = err.status || 500;
    if (status >= 500 && status !== 502) console.error(`${req.method} ${path}:`, err.message);
    send(res, status, { error: err.message });
  }
}

module.exports = handler;

if (require.main === module) {
  const server = http.createServer(handler);
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Sakai PWA + proxy on http://localhost:${PORT}/app/`);
    console.log(`  API origin: ${ORIGIN}  |  .env login: ${ENV_LOGIN ? 'on' : 'off'}  |  bound to loopback only`);
  });
}
