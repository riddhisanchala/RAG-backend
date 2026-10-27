# Arche — Backend (Node.js + Express)

API for **Arche**, a secure multi-modal RAG system (PDFs, images via OCR, CSV records) with access control
enforced inside the retrieval layer. Stack: Express · MongoDB (Mongoose) · FAISS (`faiss-node`) · Tesseract.js · pdf.js · JWT.

This repo is **backend only**. The frontend lives in a separate repo (`arche-frontend`) and is deployed on Vercel.
This guide deploys the backend on **Render (free instance)**.

> Last checked against Render's docs: October 2026. Dashboard labels move around occasionally; the ideas stay the same.

---

## What you need

- A GitHub account (to hold this repo)
- A [Render](https://render.com) account (sign up with GitHub — no card needed for a free web service)
- A [MongoDB Atlas](https://www.mongodb.com/atlas) account (free M0 cluster)
- An API key for at least one LLM provider (OpenAI, Gemini, Anthropic, or Voyage) — added later inside the app UI, **not** as an env var

---

## ⚠️ Read this first: Render free-tier limits

| Limit | What it means for Arche |
|---|---|
| **Temporary disk** | Files written to `data/` (uploaded documents + FAISS indexes) are **lost on every restart, spin-down wake-up, or redeploy**. MongoDB (users, chats, settings) is safe, but you must re-upload / re-load sample data afterwards. |
| **Spins down when idle** | After ~15 minutes without traffic the service sleeps; the next request can take up to ~1 minute. |
| **512 MB RAM** | OCR (Tesseract) and big PDFs are memory-hungry. Large uploads can crash the instance ("ran out of memory"). Keep demo files small. |
| **750 free hours / month** | Per workspace; enough for one always-on service. |
| **No persistent disk** | Persistent disks are a paid feature. If Render asks you to upgrade, check that you did **not** attach a disk and that **Instance Type = Free**. |

For a demo this is fine. For real use, upgrade the instance and add a persistent disk (mount path e.g. `/var/data`, then set `DATA_DIR=/var/data`).
Official details: <https://render.com/docs/free>

---

## Step 1 — Create the MongoDB Atlas database

1. In Atlas, create a free **M0** cluster.
2. **Database Access** → *Add New Database User* → choose a username + strong password (avoid `@ : / ?` in the password, or URL-encode them).
3. **Network Access** → *Add IP Address* → **Allow access from anywhere** (`0.0.0.0/0`).
   Render's free instances do not have fixed outbound IPs, so Atlas must accept any IP.
4. **Database** → *Connect* → *Drivers* → copy the connection string and add the database name `secure_rag` before the `?`:

   ```
   mongodb+srv://<user>:<password>@<cluster>.mongodb.net/secure_rag?retryWrites=true&w=majority
   ```

   Keep this — it is your `MONGO_URI`.

## Step 2 — Generate your secrets

Run these two commands locally (Node 20+) and save the output:

```bash
# JWT_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# ENCRYPTION_KEY  (must be exactly 64 hex characters)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> Keep `ENCRYPTION_KEY` safe and **never change it** afterwards — it encrypts the provider API keys stored in MongoDB.

## Step 3 — Push this repo to GitHub

```bash
cd arche-backend
git init
git add .
git status            # make sure .env is NOT listed (it is gitignored)
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<you>/arche-backend.git
git push -u origin main
```

## Step 4 — Create the Render web service

1. Render Dashboard → **New → Web Service**.
2. Choose **Build and deploy from a Git repository** and connect your GitHub account / the `arche-backend` repo.
3. Fill in the form:

   | Field | Value |
   |---|---|
   | Name | `arche-backend` (this becomes `https://arche-backend.onrender.com`) |
   | Language / Runtime | **Node** |
   | Branch | `main` |
   | Root Directory | *(leave empty — this repo is backend only)* |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | **Instance Type** | **Free** |

4. Open **Advanced** and:
   - **Do not add a Disk.**
   - Set **Health Check Path** to `/api/health`.
   - Add the **environment variables** below.

5. Click **Create Web Service**. The first build takes a few minutes (it compiles/downloads the FAISS native module).

### Environment variables

| Key | Value | Required |
|---|---|---|
| `NODE_VERSION` | `22` | yes |
| `MONGO_URI` | your Atlas string from Step 1 | **yes** |
| `JWT_SECRET` | from Step 2 | **yes** |
| `ENCRYPTION_KEY` | 64-hex string from Step 2 | **yes** |
| `CORS_ORIGIN` | your Vercel URL, e.g. `https://arche-frontend.vercel.app` (no trailing `/`). Use a placeholder now, fix it in Step 6. | **yes** |
| `SEED_DEFAULT_USERS` | `true` for the first login (see Step 7) | yes |
| `DATA_DIR` | `./data` | no (default) |
| `MAX_UPLOAD_MB` | `25` | no (default) |
| `JWT_EXPIRES_IN` | `12h` | no (default) |
| `RETRIEVAL_TOP_K` / `RETRIEVAL_MIN_SCORE` | `6` / `0.12` | no (defaults) |
| `GOOGLE_CLIENT_ID` | only if you want "Continue with Google" | no |

Do **not** set `PORT` — Render provides it (the app reads it automatically).

> Alternative: the included `render.yaml` is a Blueprint. Render Dashboard → **New → Blueprint** → select this repo; it pre-fills everything above and asks you for the secret values.

## Step 5 — Verify the backend

When the deploy shows **Live**, open:

```
https://<your-service>.onrender.com/api/health
```

You should see `{"status":"ok", ... "database":"connected"}`. If `database` says `disconnected`, re-check `MONGO_URI` and Atlas Network Access.

## Step 6 — Connect it to the Vercel frontend

After you deploy the frontend (see the `arche-frontend` README) you will have a URL like `https://arche-frontend.vercel.app`.

1. Render → your service → **Environment** → set `CORS_ORIGIN` to exactly that URL (several origins can be comma-separated; no trailing slash).
2. Save — Render redeploys automatically.

Vercel *preview* deployments have different URLs; add them to `CORS_ORIGIN` too if you want to test from them.

## Step 7 — First login and basic hardening

With `SEED_DEFAULT_USERS=true`, the first start creates:

| Username | Password | Role |
|---|---|---|
| `admin` | `admin` | ADMIN |
| `hr01` | `Demo@123` | HR |
| `employee01` | `Demo@123` | EMPLOYEE |

These passwords are public (they're in the source). **Immediately after your first login:**

1. Sign in as `admin` → change the admin password (Account page).
2. Create your own users in the Admin area; deactivate or delete `hr01` / `employee01` if you don't need them.
3. Optionally set `SEED_DEFAULT_USERS=false` afterwards. (Only do this *after* an admin account exists in MongoDB, otherwise nobody can log in.)

## Step 8 — Configure providers and load data (in the app)

1. **Settings → LLM Providers & Keys**: paste an API key for a chat provider **and** an embeddings provider
   (OpenAI or Gemini cover both; with Anthropic for chat, add Voyage or OpenAI for embeddings). Click *Test connection*, then pick default models.
2. **Knowledge Base → Load sample data**, or upload your own documents.
3. Chat. Because of the free-tier temporary disk, repeat step 2 after any restart or redeploy.
   If the Knowledge Base lists documents whose files/indexes vanished, delete those entries and upload them again (or use **Re-index** only when the original files still exist).

---

## Run locally

```bash
cp .env.example .env     # then fill MONGO_URI (+ secrets, see Step 2)
npm install
npm run dev              # http://localhost:5000  → health: /api/health
```

Other scripts: `npm start`, `npm test` (needs MongoDB at `mongodb://127.0.0.1:27017` or `TEST_MONGO_URI`),
`npm run seed:users`, `npm run seed:sample`, `npm run check:db`.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Render asks to **upgrade** | A Disk is attached, or Instance Type isn't *Free*, or service type isn't *Web Service*. Remove the disk / pick Free. |
| Build OK, then **"Ran out of memory (used over 512MB)"** | OCR or a large PDF exceeded the free 512 MB. Use smaller files, or upgrade the instance. |
| Log: `Missing required environment variable ...` | Add the variable on Render → Environment. |
| Log: `ENCRYPTION_KEY must be 64 hex characters` | Regenerate with the command in Step 2. |
| Log: `MongoDB connection failed` | Wrong `MONGO_URI`/password, or Atlas Network Access doesn't allow `0.0.0.0/0`. |
| Deploy never goes live / health check fails | Health Check Path must be `/api/health`; check logs for a crash during startup. Render allows each health check 5 seconds. |
| Browser shows **CORS blocked** | `CORS_ORIGIN` must exactly match the frontend origin (scheme + host, no trailing `/`). |
| First request after a while is very slow | Free instance was asleep; it wakes in up to ~1 min. |
| Documents/answers vanished | Free-tier temporary disk was reset. Re-load data (Step 8). |

## Security checklist

- [ ] Real `.env` is **not** in Git (it's in `.gitignore`)
- [ ] Strong, unique `JWT_SECRET` and `ENCRYPTION_KEY` on Render
- [ ] Default `admin/admin` password changed; demo users removed or changed
- [ ] Atlas user has a strong password; rotate it if it was ever shared
- [ ] `CORS_ORIGIN` set to your real frontend URL only
