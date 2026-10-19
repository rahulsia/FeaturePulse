# FeaturePulse

A product quality hub for teams building internally hosted web applications.
It gives you one place to catalog an app's features, capture structured
feedback against them per release, verify them with automated UI tests and a
manual regression suite, and compare release-to-release health before you
ship — instead of feedback scattered across email, spreadsheets and chat,
with no way to tell whether an issue was already reported last release.

See **[docs/WORKFLOW.md](docs/WORKFLOW.md)** for the full lifecycle, data
model, and what happens on a test run, with diagrams.

## Why

Teams testing an internal app typically hit three problems:

1. Feedback lives in email / Excel / Teams, not one searchable place.
2. There's no record of what was reported before, so the same bug gets
   re-reported release after release.
3. "Does this feature still work?" is answered by someone remembering to
   click through it manually, if at all.

FeaturePulse addresses all three: one capture flow (with an in-app browser
preview and screenshot/recording evidence), a feature-scoped feedback
history with live duplicate detection as you type, and authored UI tests
that run in a real browser and can be re-run on demand or per release.

## Stack

| Layer | Tech |
|---|---|
| Backend | FastAPI + SQLAlchemy, SQLite by default (Postgres via `DATABASE_URL`) |
| Frontend | React 19 + Vite, single-file app (`frontend/src/main.tsx`) |
| UI test runner | Node, drives the system's Chrome over the DevTools Protocol — no Playwright dependency |

## Features

- **Feature catalog** — manual entry, or scan a Git repository for
  candidate features (routes, UI pages/components, README headings); every
  suggestion requires human Accept / Merge / Ignore before it enters the
  catalog.
- **Feedback capture** — in-app browser preview of the app under test,
  one-click screenshot or screen recording as evidence, submitted against a
  feature + release with severity and an auto-assigned reviewer.
- **Duplicate detection** — as you type a feedback title, FeaturePulse
  flags similarly-titled reports already filed against that feature, across
  every release, so you catch re-reports before they happen.
- **Reviewer workflow** — each feature has a reviewer; new feedback on it
  auto-assigns to them. Reviewers triage with `Fixed`, `By Design`, or
  `Will Fix Later` (which can link or create a JIRA ticket — see below).
- **Authored UI tests** — build a test from steps (`goto`, `waitFor`,
  `click`, `fill`, `expectVisible`, `expectText`, `screenshot`, `wait`) or
  import test cases your team already wrote (JSON or a simple text format),
  then run them in a real headless browser. Works against any web app —
  Angular, React, Vue, or plain HTML — local or hosted.
- **Regression suite** — pin feedback for persistent regression tracking;
  record Pass/Fail/Blocked per release; a Fail flips the item to
  `Regression`.
- **Release comparison** — feature counts, feedback counts, open/critical
  counts, and regression pass/fail, side by side for two releases.
- **JIRA integration** — create a real JIRA ticket directly from a
  "Will Fix Later" item via JIRA's REST API (Cloud or Server/Data Center),
  or link an existing one. Disabled by default; see Configuration.
- **Egress allowlist for tests** — restrict which hosts authored tests may
  navigate to, enforced both at authoring time and at the browser-driving
  runner itself.

## Quickstart (no Docker)

### Backend
Requires Python 3.11+.

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export DATABASE_URL=sqlite:///./featurepulse.db
uvicorn app.main:app --reload --port 8000
```

### Frontend
Requires Node 20+.

```bash
cd frontend
npm install
npm run dev
```

Open the Vite URL shown in the terminal (normally http://localhost:5173).
Vite proxies `/api` to FastAPI.

### UI test runner
No install step — it drives your system's installed Chrome/Chromium over
the DevTools Protocol. Node must be on the server's `PATH`. Set
`CHROME_PATH` if it isn't in one of the default install locations.

## Configuration

All configuration is environment variables read by the backend. Copy
[.env.example](.env.example) and fill in what you need.

**The backend refuses to start without `API_TOKEN`** unless you explicitly
opt out with `FP_ALLOW_NO_AUTH=1` (for local-only development — never set
that for anything reachable beyond your own machine). This is deliberate:
earlier versions defaulted to open, and an unauthenticated instance of this
app can drive a headless browser to arbitrary URLs, clone git repositories,
and create JIRA tickets, so "just works with no config" was the wrong
default for anything but your own machine.

| Variable | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | SQLAlchemy URL | `sqlite:///./featurepulse.db` |
| `STORAGE_DIR` | Where evidence uploads and test-run screenshots are stored | `./uploads` |
| `API_TOKEN` | Bearer token required on every API call | **required** (or set `FP_ALLOW_NO_AUTH=1`) |
| `FP_ALLOW_NO_AUTH` | Set to `1` to run with no token, for local-only dev | unset |
| `FP_ENABLE_DOCS` | Set to `1` to expose `/docs`, `/redoc`, `/openapi.json` | unset (hidden) |
| `ALLOWED_HOSTS` | Comma-separated Host headers the backend accepts (anti DNS-rebinding) | `localhost,127.0.0.1,testserver` |
| `CORS_ORIGINS` | Comma-separated allowed frontend origins | `http://localhost:5173` |
| `ALLOWED_TEST_HOSTS` | Comma-separated host patterns (supports `*.domain`) authored UI tests may navigate to | unset (unrestricted) |
| `CHROME_PATH` | Explicit path to Chrome/Chromium for the test runner | auto-detected |
| `CHROME_NO_SANDBOX` | Set to `1` to launch Chrome with `--no-sandbox` (needed in most containers; leave unset on a normal host so Chrome's own sandbox stays active) | unset |
| `MAX_CONCURRENT_SCANS` | Concurrent Git repository scans allowed before `429` | `2` |
| `MAX_CONCURRENT_JIRA_CALLS` | Concurrent JIRA API calls allowed before `429` | `3` |
| `JIRA_BASE_URL` | Your JIRA site — **must be `https://`** | unset (JIRA features hidden) |
| `JIRA_EMAIL` | Account email for the API token below | unset |
| `JIRA_API_TOKEN` | API token — create at [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens) | unset |
| `JIRA_PROJECT_KEY` | Project to file tickets in, e.g. `PROJ` | unset |
| `JIRA_ISSUE_TYPE` | Issue type name to create | `Bug` |
| `JIRA_API_VERSION` | `3` for Jira Cloud, `2` for Jira Server/Data Center | `3` |

With only `JIRA_BASE_URL` set, FeaturePulse shows a link to open JIRA's
create-issue screen manually. With all four JIRA variables set (and
`JIRA_BASE_URL` using `https://`), it creates the ticket directly via the
API and stores the returned key.

### Docker

`docker compose up --build` runs the full stack (Postgres, backend,
frontend/nginx). `API_TOKEN` and `POSTGRES_PASSWORD` are required in
`.env` — compose refuses to start without them. The published port binds
to `127.0.0.1` by default; override explicitly once you've put a reverse
proxy, TLS and network policy in front of it. The backend image installs
Node and Chromium so authored UI tests actually run in a container (they
didn't in earlier versions of this image). **The Docker/compose setup in
this repo is written to known-good patterns but has not been exercised
with a live `docker build`/`docker compose up` in this environment** — do
a smoke test, especially of a UI test run, before relying on it.

## Git feature discovery

Connect a Git repository (public HTTPS or one your server can already
reach) in Setup, choose the branch, and scan. FeaturePulse clones a
temporary shallow copy, analyzes user-facing code/docs/routes for
feature-like signals, stores suggestions, and deletes the temporary copy.
Suggestions always require Accept / Merge / Ignore review — nothing enters
the catalog automatically.

Private repository authentication is intentionally not stored in this
prototype. Add GitHub App/OAuth or enterprise credential management before
using it against private repos in production.

## Security notes

This has had a real security pass (see below), but it's still a
local-first / single-tenant tool, not a hardened multi-tenant deployment:

- `API_TOKEN` is required by default — a single shared token gates all API
  access, but there is still no per-user identity, role, or audit trail.
- All data lives in one SQLite file by default — no tenancy isolation
  between applications or teams.
- The UI-test runner and Git-repo scanner both pass a minimal, secret-free
  environment to their subprocesses, validate URLs against internal/
  private-IP targets, and (for tests) enforce the egress allowlist at the
  network layer inside Chrome — not just by checking the page URL
  afterward.
- JIRA integration requires `https://`, never follows redirects (so the
  auth header can't leak to a different host), and ticket creation is
  rate-limited and idempotent (won't double-file a ticket for the same
  feedback item without `force=true`).
- The API token lives in `sessionStorage`, not `localStorage` — it no
  longer persists indefinitely, though it's still readable by any script
  able to run on this origin. A real fix would be an HttpOnly session
  cookie, which isn't implemented.

See [docs/WORKFLOW.md](docs/WORKFLOW.md#known-limitations) for the full,
current list of what's fixed and what's still open before running this
against a real company network.

## License

MIT — see [LICENSE](LICENSE).
