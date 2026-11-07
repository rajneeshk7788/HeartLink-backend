# Deploying the HeartLink / ConnectPulse backend (Render + MongoDB Atlas, free)

Total time: about 15 minutes. You need free **MongoDB Atlas** and **Render** accounts.
Deploys run through **GitHub Actions** after the tests pass.

---

## Step 1: Create the database (MongoDB Atlas)

1. Sign up / log in at <https://cloud.mongodb.com>.
2. **Create** a cluster → choose **M0 (Free)** → provider AWS, region **Mumbai (ap-south-1)**
   or **Singapore** → **Create Deployment**.
3. **Create a database user** in the pop-up (or **Security → Database Access → Add New User**):
   - Username: e.g. `heartlink`
   - Password: click **Autogenerate** and **copy it somewhere safe**.
   - Role: *Read and write to any database*.
4. **Allow Render to connect:** **Security → Network Access → Add IP Address →
   Allow Access From Anywhere** (`0.0.0.0/0`) → Confirm.
   (Render's free plan has no fixed IP address; the database password still protects it.)
5. **Get the connection string:** **Database → Connect → Drivers** → copy the string. It looks like
   ```
   mongodb+srv://heartlink:<db_password>@cluster0.abcd123.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0
   ```
   Edit it before using it:
   - Replace `<db_password>` with the password (no `< >`). If the password contains
     `@ : / ? # [ ] %`, URL-encode it (e.g. `@` → `%40`).
   - Add the database name before the `?`:
     `...mongodb.net/dating_chat_app?retryWrites=true...`

Keep this string private. **Don't commit it or paste it into chats.**

Optional check from your PC: put it in `backend/.env` as `MONGODB_URI=...` and run
`npm run test:db`.

---

## Step 2: Create the service on Render

1. Sign in at <https://render.com>.
2. **New + → Blueprint**. Under **Public Git Repository**, paste
   `https://github.com/rajneeshk7788/HeartLink-backend` → **Continue**.
   Render reads [`render.yaml`](render.yaml) and shows the service `heartlink-backend`.
3. Fill in the values it asks for:
   - **MONGODB_URI**: the Atlas string from Step 1.
   - **SMTP_***: leave empty for now (only needed for "Forgot password" emails).
4. **Deploy Blueprint.** The first build takes about 3–5 minutes. Logs should end with
   `[DB] Connected successfully to primary MongoDB instance.`
5. Copy the service URL from the top of the page, e.g. `https://heartlink-backend.onrender.com`.
   Check `https://<your-url>/api/health` shows `"status":"ok"`.

Render generates `JWT_SECRET` and `JWT_REFRESH_SECRET` automatically.

## Step 3: Let GitHub Actions deploy (CI/CD)

The pipeline is [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml):

```
push to main ─▶ build + type-check ─▶ end-to-end tests (real MongoDB) ─▶ Render deploy hook ─▶ wait until live
pull request ─▶ build + type-check ─▶ end-to-end tests                  (no deploy)
```

Render's own auto-deploy is off (`autoDeploy: false`). Code only goes live after the tests pass.

One-time setup:
1. **Render → heartlink-backend → Settings → Deploy Hook → copy** the URL
   (`https://api.render.com/deploy/srv-...?key=...`). It's a secret: anyone with it can trigger deploys.
2. **GitHub → HeartLink-backend → Settings → Secrets and variables → Actions:**
   - **Secrets** tab → **New repository secret**: name `RENDER_DEPLOY_HOOK_URL`, value = the hook URL.
   - **Variables** tab → **New repository variable**: name `RENDER_SERVICE_URL`,
     value = `https://<your-url>` (no trailing slash). The pipeline uses it to wait until the new
     version is live.
3. **Actions tab → "CI / Deploy to Render" → Run workflow** (or push any commit to `main`).

Each run's **Deploy to Render** job finishes green only once `/api/health` reports the new commit.
Until the secret exists, the deploy job is skipped with a warning (tests still run).

### Free-plan behaviour
- The service **sleeps after 15 minutes without traffic**. The next request wakes it in about
  30–60 seconds. The app waits up to 70 s for an `https://` server, so the first login after a
  pause is just slow, not broken.
- Want it always on? Upgrade the service to the Starter plan in Render.

---

## Step 4: Point the Android app at the hosted backend

```bash
# 1. Put your Render URL in mobile/app.env.json:
#    { "productionApiUrl": "https://heartlink-backend.onrender.com" }
# 2. Build the APK:
cd mobile
npm run apk:prod
```

Install `mobile/android/app/build/outputs/apk/release/app-release.apk` on your phone
(`adb install -r ...`, or copy the file to the phone). The app now works on any network
(Wi-Fi or mobile data) with no PC running.

Already-installed apps can switch without rebuilding: **⚙️ Server** on the login screen → enter
`https://<your-url>` → **Test Server** → **Apply & Save**.

Optional hardening once everything uses https: set `connectpulse.allowCleartext=false` in
`mobile/android/gradle.properties` and rebuild.

---

## Environment variables (Render → service → Environment)

| Variable | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Set by `render.yaml` |
| `MONGODB_URI` | Atlas connection string | **Required.** You paste it |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | generated | Set by Render. Changing them logs everyone out |
| `JWT_ACCESS_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | `15m` / `7d` | |
| `CLIENT_URL` | `http://localhost:5173` | Web-app origin(s) for CORS. Set to the hosted web URL when you deploy the web frontend. The Android app doesn't need it |
| `SEED_DEMO_DATA` | `false` | Set `true` to create alice/bob/charlie (`Password123!`) for testing, then set it back |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | empty | Needed for password-reset emails. E.g. Gmail: host `smtp.gmail.com`, port `587`, user = your Gmail address, pass = a Google **App Password** |
| `PORT` | set by Render | Don't set it yourself |

In production the server **refuses to start** if `MONGODB_URI`, `JWT_SECRET` or
`JWT_REFRESH_SECRET` is missing. It never uses a temporary database, never seeds demo users
unless asked, and never returns password-reset tokens in API responses.

---

## Troubleshooting

| Symptom in Render logs | Fix |
|---|---|
| `Environment variable MONGODB_URI must be set in production` | Add `MONGODB_URI` under Environment, then **Manual Deploy** |
| `bad auth` / `Authentication failed` | Wrong Atlas username/password in the URI, or the password needs URL-encoding |
| `Server selection timed out` / `ETIMEDOUT` | Atlas **Network Access** is missing `0.0.0.0/0` |
| `querySrv ENOTFOUND` | Typo in the cluster host in the URI |
| App says "Cannot reach the server" right after a pause | Free instance is waking up. Wait about 1 minute and retry |
