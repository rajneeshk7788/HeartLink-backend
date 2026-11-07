# Deploying the HeartLink / ConnectPulse backend (Render + MongoDB Atlas, free)

Total time: about 15 minutes. You need a GitHub account (you have one), plus free
**MongoDB Atlas** and **Render** accounts.

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

## Step 2: Deploy on Render

1. Sign up at <https://render.com> with **"Sign in with GitHub"**, and allow it access to
   the `HeartLink-backend` repository.
2. **New + → Blueprint** → select `rajneeshk7788/HeartLink-backend` → branch `main`.
   Render reads [`render.yaml`](render.yaml) and shows the service `heartlink-backend`.
3. Fill in the values it asks for:
   - **MONGODB_URI**: the Atlas string from Step 1.
   - **SMTP_HOST / SMTP_USER / SMTP_PASS / SMTP_FROM**: leave **empty** for now (only needed
     for "Forgot password" emails, see below).
4. **Apply / Deploy Blueprint.** The first build takes about 3–5 minutes. Logs should end with
   ```
   [DB] Connected successfully to primary MongoDB instance.
   🚀 ConnectPulse Server running on 0.0.0.0:10000
   ```
5. Copy your URL from the top of the service page, e.g.
   `https://heartlink-backend.onrender.com` (Render adds a suffix if the name is taken).
6. Test it in a browser: `https://<your-url>/api/health` should show `"status":"ok"`.

Render generates `JWT_SECRET` and `JWT_REFRESH_SECRET` automatically. Every later
`git push` to `main` redeploys automatically.

### Free-plan behaviour
- The service **sleeps after 15 minutes without traffic**. The next request wakes it in about
  30–60 seconds. The app waits up to 70 s for an `https://` server, so the first login after a
  pause is just slow, not broken.
- Want it always on? Upgrade the service to the Starter plan in Render.

---

## Step 3: Point the Android app at the hosted backend

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
