# Sakai @ UG — verified API reference

Live reconnaissance notes for `https://sakai.ug.edu.gh`, captured by authenticating with a real
student account. Everything below was executed against the live server unless marked
**unverified**.

| Property | Value |
| --- | --- |
| Product | Sakai 25.1 (Apereo), `version.service = UG Sakai` |
| Front end | nginx → Tomcat 9.0.112 / 9.0.115 (load-balanced pool, node `ugghana_app6`) |
| Direct REST base | `https://sakai.ug.edu.gh/direct` |
| WebDAV / file base | `https://sakai.ug.edu.gh/access` |
| Portal (Velocity UI) | `https://sakai.ug.edu.gh/portal` |
| Gateway site | `!gateway` |
| Registered Direct entities | 73 (`GET /direct/describe`) |
| CORS | **none** — no `Access-Control-Allow-Origin` on any response |

---

## 1. The one blocking fact: no CORS

```
OPTIONS /direct/session
  Origin: https://example.com
  Access-Control-Request-Method: POST
→ 400, no Access-Control-* headers
```

A browser page served from any other origin cannot read `/direct` responses. There is also no
JSONP and no token auth. So a custom frontend **must** sit behind its own server-side proxy that:

1. logs in on behalf of the user,
2. stores `SAKAI2SESSIONID` server-side,
3. re-serves the data to the browser on your own origin.

`proxy-server.js` in this folder is a working, dependency-free implementation of exactly that.

## 2. Authentication

`POST /direct/session`, `application/x-www-form-urlencoded`, fields `_username` and `_password`.
JSON bodies are rejected (`400 No request params for html input request`).

```
POST /direct/session
_username=22553484&_password=********
→ 201 Created
  Location: /session/new.html
  Body: 13817a3f-8ecb-448b-87d0-a475b65ebb0c      ← session id (UUID), keep it
  Set-Cookie: SAKAI2SESSIONID=<opaque>; Path=/; Secure
  Set-Cookie: srv_id=<opaque>; Domain=sakai.ug.edu.gh; Path=/; Max-Age=3600;
              HttpOnly; Secure; SameSite=Lax
```

Failure modes:

| Case | Status | Message |
| --- | --- | --- |
| Wrong password | `403` | `The username or password provided were invalid, could not authenticate user (X) to create a session` |
| Missing field | `400` | both `_username` and `_password` must be supplied |
| No session on a protected call | `403` | e.g. `Anonymous users may not view memberships in (/site/!gateway)` |

Notes:

* `srv_id` is load-balancer affinity. Send **both** cookies or you will bounce between Tomcats
  and lose the session.
* `SAKAI2SESSIONID` is `Secure` but **not** `HttpOnly` — it is readable by JS on the Sakai origin.
* Session entity reports `maxInactiveInterval: 600` (10 min idle). Any authenticated request
  refreshes it; there is no working "touch" verb (`PUT /direct/session/current` → `400`).
* Logout: `DELETE /direct/session/{sessionId}` → `204`. Use the UUID from the login body.
  `DELETE /direct/session/current` and `DELETE /direct/session` both fail with `400`.
  `GET /portal/logout` → `302 /portal` also works.

Nothing was cached by the browser: do not attempt to reuse a cookie across users.

## 3. Who am I

```
GET /direct/session/current.json
  → { userEid, userId, active: true, creationTime, maxInactiveInterval: 600, ... }

GET /direct/user/current.json
  → { id, eid, displayId, displayName, firstName, lastName, email,
      type: "registered", reference: "/user/22553484", entityURL, ... }
```

`user/current.json` returns an all-null object when anonymous, with HTTP `200` — check `id`.

## 4. Enrolments — the site list

```
GET /direct/site.json          → { site_collection: [ ... ] }
GET /direct/membership.json    → { membership_collection: [ ... ] }
```

For the account we tested: **7 sites, all `type: "course"`, all `memberRole: "Student"`**.
Both collections are already filtered to what the user may see; no extra params needed.

Useful site fields: `id`, `title`, `description`, `htmlDescription`, `type`, `published`,
`createdDate`, `siteOwner.userDisplayName`, `sitePages[]`, `props`.

Course site ids follow the pattern `DCIT-101-1-S1-2627`
(`DEPT-CODE-?‑SEMESTER-ACADEMIC_YEAR`), but **treat them as opaque strings** — the admin site
`7772a064-4369-485d-98a5-8c2918e810dd` is a UUID.

Membership fields: `id` (`USER::site:SITEID`), `locationReference` (`/site/SITEID`),
`memberRole`, `siteType`, `lastLoginTime`, `active`, `provided`.

`GET /direct/membership/site/{siteId}.json` (class roster) → **403 for students**. Staff only.
That is the correct behaviour, not a bug you can work around.

## 5. Per-tool endpoints — what actually works

Everything below was probed on all 7 sites. `n` = items returned for our test account.

| Tool | Endpoint | Result |
| --- | --- | --- |
| Assignments | `GET /direct/assignment/my.json` | all assignments + own submission state, but **~60 s** on this host |
| Assignments | `GET /direct/assignment/site/{siteId}.json` | **use this** — 200 ms, open assignments + own submission state (n=0..7) |
| Assignment detail | `GET /direct/assignment/{assignmentId}.json` | full object incl. `submissions` |
| Announcements | `GET /direct/announcement/user.json` | **best** — cross-site feed (n=3) |
| Announcements | `GET /direct/announcement/site/{siteId}.json?n=50&d=365` | mostly empty on this instance (n=0..1) |
| Calendar | `GET /direct/calendar/site/{siteId}.json` | works (n=0..37) |
| Calendar | `GET /direct/calendar/my.json` | works, merged across sites |
| Resources | `GET /direct/content/site/{siteId}.json` | **flat recursive list** incl. every file (n=0..37) |
| Resources file | `GET /access/content/group/{siteId}/...` | real bytes with session cookie (verified PDF, 619 KB) |
| Forums | `GET /direct/forums/site/{siteId}.json` | forums only (n=1 per site) |
| Forum detail | `GET /direct/forums/site/{siteId}/forum/{forumId}.json` | forum **plus nested `topics[]`** |
| Forum thread | `GET .../forum/{f}/topic/{t}.json` | **500 Internal Server Error** — broken on this deployment |
| Lessons | `GET /direct/lessons/site/{siteId}.json` | works (n=0..7) |
| Lesson item | `GET /direct/lessons/lesson/{lessonId}.json` | works |
| Syllabus | `GET /direct/syllabus/site/{siteId}.json` | `items: []` on every site tested |
| Polls | `GET /direct/polls/site/{siteId}.json` | works, empty here |
| Gradebook | no JSON endpoint | see §6 |
| Tests & Quizzes | no JSON endpoint | see §6 |

Dead ends, so you don't waste time re-probing them:

```
/direct/sam_core/site/{id}.json       404
/direct/sam_pub/site/{id}.json        404
/direct/gbng/site/{id}.json           404
/direct/gbng/my.json                  404
/direct/gradebook/site/{id}.json      501
/direct/grades/site/{id}.json         501
/direct/forum/site/{id}.json          500
/direct/forum_topic/site/{id}.json    500
/direct/wiki/site/{id}.json           500
/direct/dropbox/site/{id}.json        400
/direct/profile/current.json          404
/direct/userPrefs/current.json        403
```

`/direct/gbng` only exposes custom actions (`ping`, `comments`, `courseGradeComment`,
`assignment-order`, `messageStudents`, `listMessageRecipients`, `isotheruserediting`) — no grade
listing. `comment`/`courseGradeComment` need POST-style params and return `400` on a plain GET.

## 6. Grades and quizzes are HTML-only

This is the biggest constraint on a custom frontend.

**Grades.** The student Gradebook view is server-rendered Velocity at

```
GET /portal/site/{siteId}/tool/{gradebookToolId}/      → 302 ./gradebook
GET /portal/site/{siteId}/tool/{gradebookToolId}/gradebook
```

The returned HTML contains the whole table as DOM (`gb-summary-grade-panel`):

```
Course Grade: -        Comment: -
Gradebook Item | Grade | Due Date | Comments
Quiz 1 (Safe Exam Browser) | 19 /20 | 11/3/26
Quiz2 (Safe Exam Browser) | 16 /20 | 11/10/26
Quiz 2B (Safe Exam Browser) | - /20 | 11/17/26
```

`.gb-summary-grade-title`, `-score`, `-score-raw`, `-score-outof`, `-duedate`, `-comments`,
`-flags`, plus `data-sort-key` (epoch ms) are stable hooks. Scrape with a parser, not regex on
the raw string.

**Tests & Quizzes.** Samigo is a JSF app:

```
GET /portal/site/{siteId}/tool/{samigoToolId}      → 302 .../jsf/index/mainIndex
GET .../jsf/index/mainIndex                        → 200 HTML
```

No JSON. Driving a quiz attempt (save/ submit answers) means reproducing JSF `ViewState` and
`javax.faces.*` POSTs. Recommend: do not attempt it; link out to the tool.

`gradebookToolId` and `samigoToolId` are per-site UUIDs. Look them up once from

```
GET /direct/site/{siteId}/pages.json
→ [ { id, title, tools: [ { toolId: "sakai.gradebookng", id: "6f4490a7-...", title } ] } ]
```

`toolId` is the stable type (`sakai.gradebookng`); `id` is the per-site instance UUID to put in
the `/portal/site/.../tool/{id}` URL. Note `/direct/site/{siteId}/tools.json` is not a real
sub-resource — it returns the site object.

Also HTML-only: Messages, Chat, Email Archive, Dropbox, Wiki (500), Commons.

## 7. Assignment shape (the workhorse)

`GET /direct/assignment/my.json` is the richest call but takes ~60 s here. For a dashboard,
merge the fast per-site `/assignment/site/{id}.json` responses (dedupe by `id`); they carry the
same `submissions` array. Key fields:

```jsonc
{
  "id": "a96f7729-...", "title": "Halting Problem", "context": "DCIT-101-1-S1-2627",
  "dueTimeString": "2026-11-16T23:59:00Z", "openTime": ..., "closeTime": ...,
  "dropDeadTimeString": null,
  "status": "DUE" | "OPEN" | "CLOSED" | "NOT_OPEN",
  "gradeScale": "SCORE_GRADE_TYPE" | "CHECK_GRADE_TYPE" | "PASS_FAIL_GRADE_TYPE",
  "maxGradePoint": "1.00",
  "gradebookItemId": "...", "gradebookItemName": "Test Assignment Submission",
  "submissionType": 1, "allowResubmission": false, "anonymousGrading": false,
  "instructions": "<p>HTML</p>", "attachments": [ ... ],
  "submissions": [ {
      "id": "f4e8fd9f-...", "gradableId": "a96f7729-...",
      "submitted": true, "returned": false, "graded": false,
      "status": "Submitted Nov 5, 2026, 1:28 PM",
      "dateSubmittedEpochSeconds": 1794959940, "late": null,
      "grade": "", "feedbackText": null, "feedbackComment": null,
      "submittedText": null, "submittedAttachments": null,
      "submitters": [ { "id": "22553484", "displayName": "...", "grade": "" } ],
      "properties": { "log0": "...", "last_graded_date": "..." }
  } ]
}
```

`submissions` is `null` for assignments you have not started. `grade` is a string
(`""` when ungraded, `"19"` when graded out of `maxGradePoint`).

Submission routes exist in the provider (`itemSubmission`, `item`, `setGrade`, `getGrade`,
`getTimeSheet`) but were not exercised — writing to a live student account was out of scope.

## 8. Announcements, calendar, resources

**Announcements** (`/direct/announcement/user.json`):

```jsonc
{ "announcementId": "...", "siteId": "...", "siteTitle": "...",
  "title": "...", "body": "<p>HTML</p>", "createdByDisplayName": "...",
  "createdOn": 1794..., "attachments": [ ... ], "highlight": false, "selectedRoles": [...] }
```

Params: `n` (count), `d` (days back), `a` (ascending `true|false`). Defaults 3 / 10 / false.

**Calendar** (`/direct/calendar/site/{siteId}.json`):

```jsonc
{ "eventId": "...", "title": "...", "type": "Activity" | "Deadline" | ...,
  "description": "HTML", "siteId": "...", "siteName": "...",
  "firstTime": 1794..., "duration": 60, "recurrenceRule": null,
  "assignmentId": "", "reference": "...", "eventIcon": "..." }
```

**Resources** (`/direct/content/site/{siteId}.json`) returns a **flat array of every item**,
folders and files together, so you can build the tree from `container` + `title`. Fields:
`title`, `type` (MIME, or `collection`), `container` (`/content/group/SITE/Week 1/`),
`numChildren`, `size`, `url` (direct `/access/content/...` link), `modifiedDate`
(`yyyyMMddHHmmssSSS` string), `hidden`, `visible`, `webLinkUrl`.

Downloading the `url` with the session cookie works and streams real bytes with correct
`Content-Type` and `Content-Disposition`. Browsers on your origin must fetch it through your
proxy. `GET /access/content/.../.json` is **404** — there is no folder-listing variant; you
already have the full list.

## 9. Misc verified

```
GET /direct/portal/notify.json          → { error: [], info: [], notice: [], success: [] }
GET /direct/pasystem/checkTimeZone      → {"status":"OK"}
GET /direct/server-config.json          → 28 non-sensitive config keys
GET /api/users/me/notifications         → []        (new-style JSON API; only this one found)
GET /sakai-ws/rest/i18n/getI18nProperties  → i18n bundles
```

`/direct/server-config.json` is readable by students and exposes `version.sakai`,
`version.service`, `database.vendor`, `serverId`, `serverHostName`, `gatewaySiteId`,
`portalUrl`, `accessUrl`, `skin.default`, `locales`, `ui.institution`, `ui.service`.
No secrets (`secret|password|key|token|ldap|jdbc` → none present). Still, don't depend on it —
it is a config surface, not an API.

Entity-level `GET /direct/{entity}/describe` exists for every registered entity and is
world-readable. `/direct/describe` lists all 73. Unknown entity → `501`, unknown id → `404`.

Paging/sorting on collection endpoints: `_start`, `_page`, `_perpage`, `_limit`,
`_order` / `_sort`, `_validateSession`.

## 10. Architecture for your frontend

```
browser (same origin: /app/ + /api/*)
   │  HttpOnly, AES-256-GCM-encrypted cookie holding the Sakai session
   ▼
proxy (proxy-server.js — local Node or a Vercel function)
   │  SAKAI2SESSIONID + srv_id restored from the cookie on every request
   ▼
https://sakai.ug.edu.gh/direct/...
```

The cookie approach is stateless, so it survives serverless invocations and process restarts.
`SESSION_SECRET` (or, as a local fallback, the `.env` password) is the encryption key.

Rules that follow from the findings:

1. **Never put the user's password in the browser.** Log in server-side and hand the browser
   only your own encrypted, HttpOnly cookie.
2. **Send both cookies** (`SAKAI2SESSIONID`, `srv_id`) on every call.
3. **Expect a 10-minute idle timeout.** Retry-on-403 by re-authenticating, or keep-warm with
   a cheap `GET /direct/session/current.json` every few minutes if you cache credentials.
4. **Scope reads to per-site assignments, `/direct/announcement/user.json`,
   `/direct/calendar/my.json`, `/direct/content/site/{id}.json`,
   `/direct/lessons/site/{id}.json`.** That covers a dashboard without scraping.
5. **Grades and quizzes require HTML scraping** of the `/portal/site/.../tool/{id}` pages,
   and the gradebook HTML is per-site with a per-site tool UUID.
6. **Forums are metadata-only** — topic/message retrieval returns `500` on this deployment.
7. **Cache aggressively.** Content trees and pages change rarely; assignment/submission state
   and announcements do not.

## 11. Caveats, stated plainly

* Only one real student account was used. Staff roles (`Instructor`, `TA`) will see different
  results, especially `membership/site/{id}`, gradebook internals, and `userPrefs`.
* The account is a real person's. Any write operation (submit, post, vote, unenrol) mutates
  their academic record. Read-only was the deliberate limit here.
* Pointing a production client at `/direct` with harvested student credentials is an
  authorisation question for UG ITD, not a technical one. `sakai@ug.edu.gh` is the admin
  contact published on the gateway site. Ask them about an official integration, an LTI tool,
  or at least written tolerance, before launching something other students log into.
* Sakai is ECL-2.0 open source. For anything not covered above, read
  `github.com/sakaiproject/sakai` at tag `25.1` instead of guessing at endpoints.
