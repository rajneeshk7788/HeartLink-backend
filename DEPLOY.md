# Deploying the HeartLink / ConnectPulse backend (Render + PostgreSQL)

The backend stores everything in **PostgreSQL**. [`render.yaml`](render.yaml) creates both the
database and the web service on Render, and **GitHub Actions** deploys each tested commit.

```
push to main ─▶ build + type-check ─▶ migrations + end-to-end tests (real PostgreSQL) ─▶ Render deploy hook ─▶ wait until live
pull request ─▶ build + type-check ─▶ migrations + end-to-end tests                      (no deploy)
```

The schema is created and upgraded automatically: on start-up the server applies any pending
migrations from [`src/db/migrations.ts`](src/db/migrations.ts), recorded in the
`schema_migrations` table.

---

## Step 1: Create the database and service on Render

1. Sign in at <https://render.com>.
2. **New + → Blueprint**. Under **Public Git Repository**, paste
   `https://github.com/rajneeshk7788/HeartLink-backend` → **Continue**.
3. Render shows two resources from `render.yaml`:
   - **heartlink-db**: PostgreSQL 17 (free)
   - **heartlink-backend**: the API (free), with `DATABASE_URL` wired to the database automatically
4. Leave the **SMTP_*** fields empty for now (only needed for "Forgot password" emails).
   Click **Deploy Blueprint**.
5. The first deploy takes about 3–5 minutes. The service logs should show:
   ```
   [DB] Connected to PostgreSQL.
   [DB] Applying migration 1_initial_schema...
   🚀 ConnectPulse Server running on 0.0.0.0:10000
   ```
6. Copy the service URL, e.g. `https://heartlink-backend.onrender.com`, and check
   `https://<your-url>/api/health` shows `"status":"ok"`.

> **Free Render PostgreSQL databases expire 30 days after creation** (Render emails you first).
> For a database that doesn't expire, either upgrade `heartlink-db` to a paid plan in Render, or
> use a free [Neon](https://neon.tech) database: create a project, copy its connection string
> (`postgresql://...neon.tech/...?sslmode=require`), and set it as `DATABASE_URL` on the web
> service (Environment tab). This replaces the `fromDatabase` link.

## Step 2: Let GitHub Actions deploy (CI/CD)

Render's auto-deploy is off (`autoDeploy: false`). Code only goes live after the tests pass.

One-time setup:
1. **Render → heartlink-backend → Settings → Deploy Hook → copy** the URL
   (`https://api.render.com/deploy/srv-...?key=...`). It's a secret: anyone with it can trigger deploys.
2. **GitHub → HeartLink-backend → Settings → Secrets and variables → Actions:**
   - **Secrets** tab → **New repository secret**: name `RENDER_DEPLOY_HOOK_URL`, value = the hook URL.
   - **Variables** tab → **New repository variable**: name `RENDER_SERVICE_URL`, value = `https://<your-url>`.
3. **Actions → "CI / Deploy to Render" → Run workflow** (or push to `main`).

The **Deploy to Render** job turns green once `/api/health` reports the new commit.
Until the secret exists, it's skipped with a warning (tests still run).

### Free-plan behaviour
- The web service **sleeps after 15 minutes without traffic**. The next request wakes it in about
  30–60 seconds. The app waits up to 70 s for an `https://` server, so the first login after a
  pause is just slow.

---

## Step 3: Point the Android app at the hosted backend

- **Release pipeline** (recommended): set the repository variable `PRODUCTION_API_URL` in
  Connecto-android-app and push a version tag. See `mobile/RELEASING.md`.
- **Local build:** put the URL in `mobile/app.env.json` (`productionApiUrl`), then run `npm run apk:prod`.
- **Installed app:** **⚙️ Server** on the login screen → `https://<your-url>` → **Apply & Save**.

---

## Environment variables (Render → heartlink-backend → Environment)

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | from `heartlink-db` | **Required.** Set by the blueprint (or your Neon URL) |
| `DATABASE_SSL` | `auto` (default) | TLS on for neon.tech / supabase / `*.render.com` external URLs and `sslmode=require`; off for Render's internal URL |
| `NODE_ENV` | `production` | |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | generated | Changing them logs everyone out |
| `JWT_ACCESS_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | `15m` / `7d` | |
| `CLIENT_URL` | `http://localhost:5173` | Web-app origin(s) for CORS. The Android app doesn't need it |
| `SEED_DEMO_DATA` | `false` | `true` creates alice/bob/charlie (`Password123!`) in an **empty** database |
| `SMTP_*` | empty | For password-reset emails (e.g. Gmail: `smtp.gmail.com`, `587`, your address, a Google App Password) |

In production the server **refuses to start** without `DATABASE_URL`, `JWT_SECRET` and
`JWT_REFRESH_SECRET`. It never starts a bundled database, never seeds demo users unless asked,
and never returns password-reset tokens in API responses.

---

## Troubleshooting

| Symptom in Render logs | Fix |
|---|---|
| `Environment variable DATABASE_URL must be set in production` | Link the database (blueprint) or add `DATABASE_URL`, then **Manual Deploy** |
| `password authentication failed` (`28P01`) | Wrong credentials in `DATABASE_URL` |
| `database "..." does not exist` (`3D000`) | Database name at the end of the URL is wrong |
| `no pg_hba.conf entry ... SSL off` / `SSL required` | Set `DATABASE_SSL=require` |
| `self-signed certificate` | Use `DATABASE_SSL=require` (encrypted, not certificate-pinned) |
| App says "Cannot reach the server" right after a pause | Free instance waking up. Retry after about a minute |

Check any database from your PC:
```bash
DATABASE_URL="postgres://..." npm run test:db
```
