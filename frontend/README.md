# HubSync frontend

This is the React + Vite frontend for the HubSync backend. It uses TypeScript,
Tailwind CSS, Lucide icons, and the browser Fetch API.

## Prerequisites

- Node.js 20+
- The HubSync backend running from `backend/`
- A PostgreSQL/Redis-backed backend environment if you want to run real syncs
- A configured HubSpot test app for OAuth testing

## Environment variables

Create `frontend/.env` from `.env.example`:

```env
VITE_API_BASE_URL=http://localhost:4000
```

Only the backend base URL belongs in the frontend environment. Do not put
HubSpot client secrets, database credentials, access tokens, refresh tokens, or
`TOKEN_ENCRYPTION_KEY` in this file.

## Run locally

From `backend/` in Terminal 1:

```bash
npm install
npm run dev
```

From `backend/` in Terminal 2, when Redis is configured:

```bash
npm run worker
```

From `frontend/`:

```bash
npm install
npm run dev
```

The frontend runs at `http://localhost:5173`. The backend API runs at
`http://localhost:4000`.

## Backend flows exposed in the UI

- `GET /api/health` - API status page.
- `GET /api/hubspot/status` - safe HubSpot connection status.
- `GET /auth/hubspot` - the Connect HubSpot button starts OAuth here.
- `POST /api/sync/contacts` - the Sync Contacts button queues a BullMQ job.
- `GET /api/sync/jobs/:jobId` - the UI polls this endpoint while a sync is
  queued or running, then refreshes contacts.
- `GET /api/contacts?page=1&limit=25&search=` - contacts table, search, and
  pagination.
- `POST /api/contacts/:contactId/notes` - local note creation.
- `GET /api/contacts/:contactId/notes` - local note retrieval.

The UI does not implement unsupported note edit/delete operations because the
backend does not expose those endpoints. Local notes remain available even
when HubSpot note synchronization is disabled or unavailable.

## HubSpot OAuth testing

1. Configure the backend HubSpot environment variables and redirect URI.
2. Make sure the backend `FRONTEND_URL` is `http://localhost:5173`.
3. Open the frontend and click **Connect HubSpot**.
4. Approve the HubSpot test account authorization.
5. The backend redirects back to the frontend with a safe status indicator.
6. The dashboard reloads the actual connection status.

The browser never exchanges OAuth codes and never receives or stores HubSpot
tokens.

## Contact synchronization testing

1. Connect a HubSpot test account.
2. Click **Sync contacts**.
3. The UI reads the returned `jobId` and polls the job-status endpoint.
4. Progress counters come from the backend: processed, created, updated, and
   failed.
5. Contacts are refreshed only after the job reaches a terminal status.

If Redis is unavailable, the backend returns a queue error and the UI displays
the error instead of showing a fake success state. If the worker is not
running, the job can remain queued; start `npm run worker` in the backend.

## Checks

```bash
npm run build
npm run lint
```

The frontend currently has no separate test-runner script. Build and lint are
the configured frontend checks.
