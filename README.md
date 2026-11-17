# UG Sakai — personal PWA

A zero-dependency personal dashboard for [`sakai.ug.edu.gh`](https://sakai.ug.edu.gh).
It reads your courses, deadlines, announcements, calendar, files, lessons and grades through
Sakai's own Direct REST API. It is read-only: anything that needs a write or a JSF form
(quiz attempts, submissions, forum posts) links out to the real Sakai UI.

| File | What it is |
| --- | --- |
| `SAKAI_API.md` | Verified backend contract, dead ends and architecture notes. **Start here for the API.** |
| `sakai-client.js` | Dependency-free Node client for the Direct API, including the gradebook HTML scraper. |
| `proxy-server.js` | Same-origin API proxy + session handling. Runs locally or as a Vercel function. |
| `public/app/` | The PWA itself (plain HTML/CSS/JS + service worker + manifest). |
| `api/[...path].js` | Vercel catch-all entry point for `/api/*`. |
| `scripts/` | Throwaway reconnaissance probe scripts. |

## Run locally

```bash
# .env (git-ignored):
#   SAKAI_ID="22553484"
#   SAKAI_PASSWORD="..."
#   SESSION_SECRET="a-long-random-string"   # optional locally; required on Vercel

node proxy-server.js
# → http://localhost:8787/  redirects to /app/
```

Open <http://localhost:8787/app/>. Click **Use credentials from .env** to sign in, or type
your student ID and password into the form. The server only binds to `127.0.0.1`.

If you want to use the client directly from Node instead:

```bash
node -e "
const {SakaiClient}=require('./sakai-client');
(async()=>{
  const s=new SakaiClient();
  await s.login(process.env.SAKAI_ID, process.env.SAKAI_PASSWORD);
  console.log((await s.sites()).map(x=>x.id));
  console.log(await s.grades('DCIT-101-1-S1-2627'));
  await s.logout();
})();
"
```

## API routes

`POST /api/login` (empty body = use `.env`), `POST /api/logout`,
`GET /api/config`, `/api/me`, `/api/sites`, `/api/sites/:id/pages`, `/api/assignments`,
`/api/announcements`, `/api/calendar`, `/api/resources?site=`, `/api/lessons?site=`,
`/api/forums?site=`, `/api/grades?site=`, `/api/file?path=/access/content/...`.

Add `?fresh=1` to any read to bypass the proxy's per-user cache (the Refresh button does this).

## Live deployment

**<https://ug-sakai.vercel.app/app/>** — private, personal use only. Sign in with your student
ID and password on the page; no credentials are stored in the Vercel project. Keep the URL to
yourself: anyone who can sign in as you will see your data.

## Deploy to Vercel

The repo includes `vercel.json` and `api/[...path].js`, so:

```bash
vercel link
vercel env add SESSION_SECRET production   # any long random string
vercel env add ALLOW_ENV_LOGIN production   # value: 0 — sign in on the page, not via .env
vercel --prod
```

The live project uses exactly those two variables. Locally you can instead leave
`ALLOW_ENV_LOGIN` unset and put credentials in `.env` for the one-click button.

Why it works there: Sakai sends no CORS headers, so the PWA and `/api/*` share one Vercel
origin. The Sakai session is carried in an AES-256-GCM encrypted, HttpOnly cookie rather than
in process memory, so any function instance can serve any request. The in-memory response
cache is only an optimisation; the browser also caches data in `localStorage`.

## The three things that shape any frontend

1. **No CORS.** Browser → Sakai `/direct` is impossible from another origin. Proxy required.
2. **Grades and quizzes are HTML-only.** Grades are scraped from the Velocity gradebook page;
   quizzes are a JSF app with `ViewState` — link out rather than reimplement.
3. **Forum messages are broken.** Topic/message retrieval returns `500` on this deployment;
   only forum + topic metadata is available.

## Privacy / authorisation

For your account only. Credentials and captured personal data are git-ignored (`.env`,
`capture/`). Nothing in the PWA writes to Sakai. Deploying it publicly with your own
credentials in the project environment means anyone with the URL can read **your** data —
keep the URL private and don't share it. An official integration for other students would
need UG ITD involvement (`sakai@ug.edu.gh`).
