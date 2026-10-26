# HubSync

HubSync is a local HubSpot workspace. It connects to HubSpot with OAuth, keeps
contacts in PostgreSQL, and provides a React dashboard for contacts, notes, and
sync status.

> **Deployment:** The frontend is deployed at
> `https://hubsync-fe.vercel.app/`. The backend API and Redis are deployed on
> Render. The worker runs locally.

Long-running work runs in a separate BullMQ worker. The API creates a durable
job and returns immediately; the worker fetches HubSpot data and saves progress.

For the design behind the project, see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Main parts

- `backend/` — Express API, Prisma schema, OAuth, sync services, and worker.
- `frontend/` — React/Vite dashboard.
- `hubsync-intern/` — HubSpot developer-project metadata and CRM card starter.

## Features

- HubSpot OAuth with encrypted access and refresh tokens.
- Contact sync through Redis/BullMQ with durable job status and cursors.
- Contact search, pagination, and newest-first ordering.
- Local-first notes with optional HubSpot note synchronization.
- API health, connection status, sync counters, and safe error messages.

The current app supports one stored HubSpot connection. It does not include
user accounts, sessions, or multi-tenant authorization.

## Requirements

- Node.js 20+ and npm
- PostgreSQL or Neon
- A Render backend service and Render Redis service
- A HubSpot private app with the scopes in
  `hubsync-intern/src/app/app-hsmeta.json`
- PowerShell or Windows Terminal for the commands below

## Configuration

Create local environment files from the templates:

```powershell
Copy-Item .\backend\.env.example .\backend\.env
Copy-Item .\frontend\.env.example .\frontend\.env
```

The backend API and Redis use their Render environment variables. The local
worker must use the same `DATABASE_URL` and `REDIS_URL` values so it can read
jobs from Render Redis and write progress to the database.

```env
# backend/.env
HUBSPOT_REDIRECT_URI=https://hubsync-be.onrender.com/auth/hubspot/callback
FRONTEND_URL=https://hubsync-fe.vercel.app/

# frontend/.env
VITE_API_BASE_URL=https://hubsync-be.onrender.com
```

Generate an encryption key with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Keep secrets in `backend/.env`. Do not put tokens, database URLs, or HubSpot
credentials in frontend variables.

### Important variables

| Variable | Used by | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | API, worker | PostgreSQL connection |
| `REDIS_URL` | API, worker | BullMQ/Redis connection |
| `HUBSPOT_CLIENT_ID` | API | OAuth client ID |
| `HUBSPOT_CLIENT_SECRET` | API | OAuth client secret |
| `HUBSPOT_REDIRECT_URI` | API | OAuth callback URL |
| `FRONTEND_URL` | API | OAuth redirect and CORS origin |
| `TOKEN_ENCRYPTION_KEY` | API | AES-256-GCM token key |
| `HUBSPOT_NOTES_SYNC_ENABLED` | worker | Enable HubSpot note writes |
| `SYNC_WORKER_CONCURRENCY` | worker | Worker concurrency, max 10 |
| `VITE_API_BASE_URL` | frontend | Browser API base URL |

## Run the local worker

The backend API and Redis are already deployed on Render. Do not start another
local API or Redis instance for the deployed frontend. Run only the worker
locally and keep it running while using the app.

Install dependencies:

```powershell
Set-Location D:\hubsync\backend
npm install

Set-Location D:\hubsync\frontend
npm install
```

Prepare the database:

```powershell
Set-Location D:\hubsync\backend
npx prisma generate
npx prisma migrate deploy
```

### 1. Start the worker

Open a terminal in `backend/` and leave this process running:

```powershell
Set-Location D:\hubsync\backend
npm run worker
```

The worker processes contact sync and queued note jobs from Render Redis. If it
is not running, the Render API can accept a sync job but it will remain in
`QUEUED`.

### 2. Open the frontend

Open the deployed dashboard at:

<https://hubsync-fe.vercel.app/>

The Vercel frontend uses `VITE_API_BASE_URL=https://hubsync-be.onrender.com`.
The Render backend uses `FRONTEND_URL=https://hubsync-fe.vercel.app/` so
requests from Vercel pass CORS.

Check the deployed API with:

```powershell
Invoke-RestMethod https://hubsync-be.onrender.com/api/health
```

## API overview

All successful responses use `{ success: true, data }`. Known errors include a
safe `error.code` and `error.message`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Check that the API responds |
| `GET` | `/api/hubspot/status` | Read connection and sync state |
| `GET` | `/api/contacts` | List/search local contacts |
| `POST` | `/api/sync/contacts` | Queue a contact sync |
| `GET` | `/api/sync/jobs/:jobId` | Read sync progress |
| `POST` | `/api/contacts/:contactId/notes` | Save a note locally and queue optional provider sync |
| `GET` | `/api/contacts/:contactId/notes` | List contact notes |
| `GET` | `/auth/hubspot` | Start HubSpot OAuth |

Contact listing accepts `page`, `limit`, and `search`. Results are ordered by
local `createdAt` descending, so newer contacts appear first.

## How sync works

1. The frontend posts to `/api/sync/contacts`.
2. The API reuses an active job or creates a `QUEUED` job, then returns its ID.
3. The worker reads HubSpot contact pages of up to 100 records.
4. Each page is persisted with a bulk upsert and the cursor/counters are saved.
5. The frontend polls the job until `COMPLETED`, `PARTIAL`, or `FAILED`.
6. The contact list refreshes after a terminal result.

Notes are saved locally first. If note sync is enabled, a separate worker job
creates and associates the note in HubSpot. A local note remains available when
the queue or HubSpot is unavailable.

## Checks

Backend:

```powershell
Set-Location D:\hubsync\backend
npm run build
npm test
npx prisma validate
npx prisma migrate status
```

Frontend:

```powershell
Set-Location D:\hubsync\frontend
npm run build
npm run lint
node --check scripts/dev.mjs
```

## Troubleshooting

- **API unavailable:** check `https://hubsync-be.onrender.com/api/health` and confirm
  `VITE_API_BASE_URL` points to the Render backend.
- **Sync stuck in `QUEUED`:** start the worker and confirm it uses the same
  `DATABASE_URL` and `REDIS_URL` as the API.
- **Queue errors:** check the Render Redis service and confirm the local worker
  uses the same `REDIS_URL` as the Render backend.
- **OAuth redirect error:** use
  `https://hubsync-be.onrender.com/auth/hubspot/callback` in
  `HUBSPOT_REDIRECT_URI` and the HubSpot app settings.
- **CORS error:** use the configured frontend port. Local `localhost`,
  `127.0.0.1`, and `::1` aliases are accepted on that port.

Do not use `prisma migrate reset` against a populated database.

## Deployment note

The current setup uses Vercel for the frontend, Render for the backend API and
Redis, and a locally running worker. The worker must use the same database and
Render Redis configuration as the deployed services. Authentication and
per-user connection ownership still need to be added before treating this as a
multi-tenant production service.
