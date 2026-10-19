# FeaturePulse Product v3

Product-first local development package. Docker is optional and not required for development.

## Included
- Applications, releases, feature groups and manual features
- Per-feature configurable feedback questions
- Screenshots, screen recording and evidence uploads
- Assignment, severity and feedback workflow
- Persistent regression suite and release validation
- Release comparison
- GitHub/public Git repository scanning with human-reviewed feature suggestions
- Accept / merge / ignore discovery workflow
- Feature Assistant
- Release-feature mapping

## Local development (no Docker)

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

Open the Vite URL shown in the terminal (normally http://localhost:5173). Vite proxies `/api` to FastAPI.

## GitHub discovery
Connect a public GitHub HTTPS repository in Setup, choose the branch and scan. FeaturePulse clones a temporary shallow copy, analyzes user-facing code/docs/routes, stores suggestions and deletes the temporary copy. Suggestions require Accept/Merge/Ignore review.

Private GitHub authentication is intentionally not stored in this local prototype. Add GitHub App/OAuth or enterprise credential management before production use.
