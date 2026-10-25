# HubSync backend architecture

## Runtime processes

HubSync runs as two independently deployable Node.js processes:

1. **API process** (`npm run dev` / `npm start`)
   - Serves Express routes.
   - Starts OAuth.
   - Persists OAuth connections.
   - Enqueues contact synchronization jobs.
   - Reads job status and local contacts.

2. **Worker process** (`npm run worker`)
   - Consumes the BullMQ `contact-sync` queue.
   - Calls HubSpot's Contacts API.
   - Upserts contacts with Prisma.
   - Processes opt-in local note synchronization jobs.
   - Updates durable job and connection status.
   - Handles graceful shutdown and BullMQ stalled-job recovery.

The API does not perform a full contact synchronization inside the HTTP
request. It returns `202 Accepted` after a durable job record and queue message
have been created.

## OAuth flow

1. `GET /auth/hubspot` creates a 32-byte random state value.
2. The state is held for ten minutes and is single-use.
3. The browser is redirected to HubSpot's authorization URL.
4. HubSpot redirects to `/auth/hubspot/callback` with `code` and `state`.
5. The backend consumes and validates the state.
6. The authorization code is exchanged at HubSpot's OAuth v3 token endpoint.
7. The portal ID is taken from the token response, with introspection as a
   fallback.
8. Access and refresh tokens are encrypted with AES-256-GCM before persistence.
9. The connection is upserted by portal ID.
10. A contact synchronization job is queued automatically.

Tokens are never included in API responses, queue payloads, redirect URLs, or
structured log fields.

### Multi-user limitation

The current schema has no application user table and the API supports only one
stored connection at a time. If more than one connection exists, private
connection-dependent routes return a controlled conflict. A production
multi-user release must add authenticated users, connection ownership, and a
session-bound OAuth state store.

## Database

Prisma 7 uses PostgreSQL through `@prisma/adapter-pg`.

### Existing models

- `HubSpotConnection` stores encrypted token values, portal ID, expiration, and
  the current contact sync cursor/status.
- `Contact` stores the local HubSpot contact representation.
- `Note` stores local notes. HubSpot note synchronization is not implemented
  unless `HUBSPOT_NOTES_SYNC_ENABLED=true` and the required HubSpot permission
  has been confirmed for the app.

### `SyncJob`

`SyncJob` is the durable application record for a queue job. It stores:

- `QUEUED`, `RUNNING`, `COMPLETED`, `PARTIAL`, or `FAILED` status
- connection ID
- pagination cursor
- processed, created, updated, and failed counters
- worker attempt count
- safe error text
- started/completed timestamps

The `dedupeKey` unique value is set while a contact job is active and cleared
when it reaches a terminal state. The existing compound contact uniqueness
constraint remains the final duplicate-prevention boundary.

Note jobs use `SyncJobType.NOTES` and a `notes:<noteId>` dedupe key. The note
itself remains the source of truth for local availability. A note is marked
`SYNCED` only after HubSpot returns a note ID. Permission failures and
ambiguous create outcomes are not retried indefinitely.

## Redis and BullMQ

The queue name is `contact-sync`. Queue payloads contain only:

```text
syncJobId
connectionId
```

They do not contain OAuth credentials or access/refresh tokens. Note jobs carry
only `syncJobId`, `connectionId`, and `noteId`.

Default queue behavior:

- 4 total attempts
- exponential backoff starting at 2 seconds
- completed jobs retained for one day, bounded by count
- failed jobs retained for seven days, bounded by count

The worker concurrency is controlled by `SYNC_WORKER_CONCURRENCY` and clamped
to a maximum of 10 in code. It defaults to 1 for predictable local behavior.

BullMQ keeps jobs in Redis while the worker is unavailable. Its stalled-job
checks can requeue work after a worker crash. The database cursor and contact
upsert make a retried page safe to process again.

The worker uses a fail-fast Redis connection at startup. If Redis is missing or
unreachable, it exits with a configuration/connectivity error so deployment
supervision can restart it or alert instead of leaving a misleading half-started
worker process.

## Contact synchronization

1. The API verifies that exactly one HubSpot connection is available.
2. It finds an active `QUEUED` or `RUNNING` job for that connection.
3. If one exists, the API returns its ID instead of creating another job.
4. Otherwise it creates a `SyncJob` and adds a BullMQ job with the same ID.
5. The worker marks the job and connection as running.
6. It obtains a valid access token, refreshing the encrypted token pair when
   the access token is close to expiry.
7. It fetches up to 100 contacts per HubSpot request and follows
   `paging.next.after`.
8. Each contact is upserted using `(connectionId, hubspotContactId)`.
9. The cursor and counters are persisted after every page.
10. The job becomes `COMPLETED` only after the final page succeeds.
11. A page with individual persistence failures becomes `PARTIAL`; it is never
    reported as fully successful.

## Notes

`POST /api/contacts/:contactId/notes` validates the body, verifies that the
contact belongs to the currently selected connection, and writes the local note
first. The local note remains readable if Redis is unavailable, HubSpot rejects
the request, or notes synchronization is disabled.

The backend currently leaves `HUBSPOT_NOTES_SYNC_ENABLED=false` unless the app
has confirmed notes write permission. When enabled, the worker creates a note
through HubSpot's `POST /crm/v3/objects/notes` API and associates it with the
contact using the note-to-contact association type `202`. A successful response ID is stored in
`hubspotNoteId`, and only then does `syncStatus` become `SYNCED`.

Transient HTTP failures such as rate limits are retried by BullMQ. A network
failure during note creation is treated as ambiguous because the request may
have reached HubSpot; it is not automatically retried to avoid duplicate notes.
Permission failures become `FAILED` with `lastSyncError`, while the local note
body remains available.

## Retry and failure recovery

HubSpot API retries handle rate limits and temporary service failures using
`Retry-After` when available and bounded exponential delays. BullMQ adds a
second durable retry boundary for failures that escape the API wrapper or for
worker/process interruptions.

Authentication failures are not treated as temporary rate limits. A revoked
refresh token produces `AUTH_REQUIRED`; transient failures are retried, and
only the final exhausted attempt becomes `FAILED`.

If a worker crashes after a page is fetched but before the page completion
write, BullMQ can retry the job. The same page is fetched again from the last
durable cursor and contact upserts remain idempotent.

## API contracts

- `POST /api/sync/contacts` returns `202` and `{ jobId, status, duplicate }`.
- `GET /api/sync/jobs/:jobId` returns job status and safe counters.
- `GET /api/contacts` validates `page`, `limit`, and `search` and never returns
  encrypted token fields.
- `POST /api/contacts/:contactId/notes` creates local notes with `PENDING`,
  `SYNCED`, or `FAILED` synchronization state.
- `GET /api/contacts/:contactId/notes` returns only notes belonging to that
  contact and the active connection.
- Unknown routes return a JSON `404` response.

## Operational limits and remaining gaps

- No application authentication/authorization exists yet.
- OAuth state is process-local; a multi-instance deployment needs Redis-backed
  state or a session store.
- The API currently supports one connection safely rather than pretending to
  support multiple users.
- Contact writes are currently one upsert at a time. The worker boundary is in
  place, but 100,000 contacts per minute has not been measured or claimed.
- Metrics, distributed tracing, and a dedicated structured logging package are
  not yet included.

## Frontend interaction

The React/Vite frontend uses `VITE_API_BASE_URL` to call this API from the
browser. It starts OAuth by navigating to `GET /auth/hubspot`; OAuth tokens and
authorization-code exchange remain entirely on the backend.

For contact synchronization, the frontend calls `POST /api/sync/contacts`,
reads the returned `jobId`, polls `GET /api/sync/jobs/:jobId` while the job is
`QUEUED` or `RUNNING`, and refreshes `GET /api/contacts` after the job reaches a
terminal state. It displays the returned counters rather than simulating
progress.

The notes UI uses `POST /api/contacts/:contactId/notes` and
`GET /api/contacts/:contactId/notes`. Editing and deleting notes are not exposed
because the backend has no corresponding endpoints. Notes remain local and
`PENDING` when `HUBSPOT_NOTES_SYNC_ENABLED=false`.
