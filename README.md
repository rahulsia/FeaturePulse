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
[.env.example](.env.example) and fill in what you need; everything is
optional except for a real deployment's `API_TOKEN`.

| Variable | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | SQLAlchemy URL | `sqlite:///./featurepulse.db` |
| `STORAGE_DIR` | Where evidence uploads and test-run screenshots are stored | `./uploads` |
| `API_TOKEN` | Bearer token required on every API call, if set | unset (open) |
| `CORS_ORIGINS` | Comma-separated allowed frontend origins | `http://localhost:5173` |
| `ALLOWED_TEST_HOSTS` | Comma-separated host patterns (supports `*.domain`) authored UI tests may navigate to | unset (unrestricted) |
| `CHROME_PATH` | Explicit path to Chrome/Chromium for the test runner | auto-detected |
| `JIRA_BASE_URL` | Your JIRA site, e.g. `https://yourco.atlassian.net` | unset (JIRA features hidden) |
| `JIRA_EMAIL` | Account email for the API token below | unset |
| `JIRA_API_TOKEN` | API token — create at [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens) | unset |
| `JIRA_PROJECT_KEY` | Project to file tickets in, e.g. `PROJ` | unset |
| `JIRA_ISSUE_TYPE` | Issue type name to create | `Bug` |
| `JIRA_API_VERSION` | `3` for Jira Cloud, `2` for Jira Server/Data Center | `3` |

With only `JIRA_BASE_URL` set, FeaturePulse shows a link to open JIRA's
create-issue screen manually. With all four JIRA variables set, it creates
the ticket directly via the API and stores the returned key.

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

This is a local-first prototype, not a hardened multi-tenant deployment:

- A single shared `API_TOKEN` (if set) gates all API access — there is no
  per-user identity, role, or audit trail.
- All data lives in one SQLite file by default — no tenancy isolation
  between applications or teams.
- JIRA credentials and the egress allowlist are server-side configuration,
  not secrets managed per user.

See [docs/WORKFLOW.md](docs/WORKFLOW.md#known-limitations) for the full
list of known gaps before running this against a real company network.
