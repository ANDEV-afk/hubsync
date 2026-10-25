export type SyncStatus =
  | 'IDLE'
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'PARTIAL'
  | 'FAILED'
  | 'AUTH_REQUIRED'

export interface ApiErrorPayload {
  code?: string
  message?: string
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, payload: ApiErrorPayload = {}) {
    super(payload.message ?? `Request failed with status ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.code = payload.code ?? 'API_ERROR'
  }
}

export interface HubspotStatus {
  connected: boolean
  connectionCount: number
  portalId?: string
  syncStatus?: SyncStatus | string
  lastSyncAt?: string | null
}

export interface Contact {
  id: string
  hubspotContactId: string
  email: string | null
  firstName: string | null
  lastName: string | null
  properties: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

export interface ContactsResponse {
  contacts: Contact[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

export interface SyncEnqueueResponse {
  jobId: string
  status: SyncStatus | string
  duplicate: boolean
}

export interface SyncJob {
  id: string
  type: 'CONTACTS' | 'NOTES' | string
  status: SyncStatus | string
  processed: number
  createdCount: number
  updatedCount: number
  failedCount: number
  attempts: number
  cursor: string | null
  error: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface Note {
  id: string
  contactId: string
  body: string
  hubspotNoteId: string | null
  syncStatus: 'PENDING' | 'SYNCED' | 'FAILED' | string
  lastSyncError: string | null
  syncedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateNoteResponse {
  note: Note
  sync: {
    status: string
    queued: boolean
    jobId?: string
    duplicate?: boolean
    reason?: string
  }
}

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000').replace(/\/$/, '')

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined

  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function extractErrorPayload(body: unknown): ApiErrorPayload {
  if (!body || typeof body !== 'object') {
    return {}
  }

  const record = body as { error?: ApiErrorPayload }
  return record.error ?? {}
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response

  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    })
  } catch {
    throw new ApiError(0, {
      code: 'NETWORK_ERROR',
      message: 'Unable to reach the backend. Check that the API is running on port 4000.',
    })
  }

  const body = await parseResponseBody(response)
  if (!response.ok) {
    throw new ApiError(response.status, extractErrorPayload(body))
  }

  if (!body || typeof body !== 'object') {
    throw new ApiError(response.status, {
      code: 'INVALID_RESPONSE',
      message: 'The backend returned an invalid response.',
    })
  }

  const record = body as Record<string, unknown>
  return ('data' in record ? record.data : record) as T
}

export function getApiBaseUrl(): string {
  return API_BASE_URL
}

export function isTerminalSyncStatus(status: string): boolean {
  return ['COMPLETED', 'PARTIAL', 'FAILED', 'AUTH_REQUIRED'].includes(status)
}
