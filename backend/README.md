# HubSync backend

The backend is an Express 5 API using TypeScript, Prisma 7, PostgreSQL, Redis,
BullMQ, and Node.js `fetch` for HubSpot API calls.

## Local setup

From `backend/`:

```bash
npm install
copy .env.example .env
npx prisma migrate deploy
npx prisma generate
```

On macOS/Linux, use `cp .env.example .env` instead of `copy`.

Generate the encryption key with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Put the generated value in `TOKEN_ENCRYPTION_KEY`. Never commit `.env` or print
the key in logs.

`REDIS_URL` is required by the API when queueing sync jobs and by the worker.
For local development, start Redis on `redis://localhost:6379`, or use a
managed Redis-compatible service.

If Docker Desktop is running, a simple local Redis command is:

```bash
docker run --name hubsync-redis -p 6379:6379 -d redis:7-alpine
```

If the container already exists, start it with:

```bash
docker start hubsync-redis
```

## HubSpot setup

1. Create a HubSpot developer app and configure its redirect URI as the exact
   value of `HUBSPOT_REDIRECT_URI`.
2. Enable the contact scopes requested by this MVP:
   `crm.objects.contacts.read` and `crm.objects.contacts.write`.
3. Install the app in a HubSpot test account using a Super Admin account.
4. Open `http://localhost:4000/auth/hubspot` in a browser.
5. Approve access. HubSpot redirects to the callback, the backend stores
   encrypted tokens, and a contact synchronization job is queued automatically.

The OAuth callback uses HubSpot's v3 token endpoints. Tokens are never returned
to the browser. The portal ID is taken from HubSpot's OAuth token response.

## Endpoints

- `GET /api/health` - API health check.
- `GET /auth/hubspot` - start HubSpot OAuth.
- `GET /auth/hubspot/callback` - OAuth callback; do not call manually except
  through HubSpot.
- `GET /api/hubspot/status` - connection and synchronization status.
- `POST /api/sync/contacts` - enqueue or reuse a contact synchronization job.
- `GET /api/sync/jobs/:jobId` - read synchronization job status and counters.
- `GET /api/contacts?page=1&limit=25&search=ada` - list local contacts.
- `POST /api/contacts/:contactId/notes` - create a local note for a contact.
- `GET /api/contacts/:contactId/notes` - list local notes for a contact.

The sync endpoint returns HTTP `202` with a `jobId`. Poll the job endpoint until
the status is `COMPLETED`, `PARTIAL`, or `FAILED`.

## Worker and troubleshooting

Run the API and worker as separate processes:

Terminal 1:

```bash
npm run dev
```

Terminal 2:

```bash
npm run worker
```

If `POST /api/sync/contacts` returns `QUEUE_UNAVAILABLE`, check `REDIS_URL`,
Redis connectivity, and that the Redis service accepts BullMQ connections.
The worker now fails fast with a clear startup error when Redis cannot be
reached instead of retrying indefinitely with noisy connection logs.
If a job remains `QUEUED`, confirm that `npm run worker` is running. BullMQ
retries temporary worker failures with bounded exponential backoff. Contact
upserts use the existing database uniqueness constraint, so retrying a page is
safe and does not intentionally create duplicate local contacts.

## Important limitation

This project does not yet have application-user authentication or sessions.
For that reason, the API refuses to choose between multiple stored HubSpot
connections. A production multi-user deployment must add authenticated users,
associate each connection with a user, and store OAuth state in a shared
short-lived store such as Redis. The current OAuth state store is process-local
and is suitable only for a single backend instance during the MVP.

Local notes are available independently of HubSpot note permissions. New notes
start with `PENDING` status and are persisted before any external work. Set
`HUBSPOT_NOTES_SYNC_ENABLED=true` only after the HubSpot app has confirmed the
required notes write permission. It is `false` by default, so the backend does
not request or assume notes write access. When enabled, note jobs use the same
BullMQ worker and keep the local note available if synchronization fails.

The HubSpot Notes API uses `POST /crm/v3/objects/notes` with `hs_timestamp` and
`hs_note_body`, and the note-to-contact association type is `202`. The current
HubSync OAuth scope list intentionally does not include a notes write scope
because that permission was rejected for the developer app. Therefore this
backend does not claim that HubSpot note creation is currently available.

## Verification

```bash
npm run build
npm test
npx prisma validate
npx prisma migrate status
```

The implementation has not been claimed as a real HubSpot integration until it
is run with valid HubSpot credentials and an authorized test account.
