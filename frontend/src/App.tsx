import {
  Activity,
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  CloudDownload,
  Database,
  ExternalLink,
  FileText,
  HeartPulse,
  LayoutDashboard,
  Loader2,
  Menu,
  MessageSquareText,
  RefreshCw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Users,
  X,
  XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  ApiError,
  apiFetch,
  getApiBaseUrl,
  isTerminalSyncStatus,
} from './lib/api'
import type { Contact, ContactsResponse, CreateNoteResponse, HubspotStatus, Note, SyncEnqueueResponse, SyncJob } from './lib/api'

type View = 'overview' | 'contacts' | 'notes' | 'connection' | 'status'

const POLL_INTERVAL_MS = 1200

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(resolve, milliseconds)
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeout)
        reject(new DOMException('Polling cancelled', 'AbortError'))
      },
      { once: true },
    )
  })
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  return 'Something went wrong. Please try again.'
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'Not available'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Not available'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function displayName(contact: Contact): string {
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ')
  return name || contact.email || `Contact ${contact.hubspotContactId}`
}

function statusLabel(status: string | undefined): string {
  if (!status) return 'Unknown'
  return status.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (character) => character.toUpperCase())
}

function statusClasses(status: string | undefined): string {
  switch (status) {
    case 'COMPLETED':
    case 'SYNCED':
    case 'IDLE':
      return 'bg-emerald-50 text-emerald-700 ring-emerald-200'
    case 'QUEUED':
    case 'RUNNING':
    case 'PENDING':
      return 'bg-amber-50 text-amber-700 ring-amber-200'
    case 'PARTIAL':
      return 'bg-orange-50 text-orange-700 ring-orange-200'
    case 'FAILED':
    case 'AUTH_REQUIRED':
      return 'bg-rose-50 text-rose-700 ring-rose-200'
    default:
      return 'bg-slate-100 text-slate-600 ring-slate-200'
  }
}

function StatusBadge({ status }: { status?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${statusClasses(status)}`}>
      <CircleDot className="size-3" />
      {statusLabel(status)}
    </span>
  )
}

function LoadingBlock({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-xl bg-slate-100 ${className}`} />
}

function EmptyState({
  icon: Icon,
  title,
  message,
  action,
}: {
  icon: typeof Users
  title: string
  message: string
  action?: ReactNode
}) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center">
      <div className="mb-4 rounded-2xl bg-slate-100 p-3 text-slate-500">
        <Icon className="size-6" />
      </div>
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-slate-500">{message}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}

function App() {
  const [activeView, setActiveView] = useState<View>('overview')
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [connection, setConnection] = useState<HubspotStatus | null>(null)
  const [health, setHealth] = useState<{ message: string } | null>(null)
  const [connectionLoading, setConnectionLoading] = useState(true)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [contactsPagination, setContactsPagination] = useState<ContactsResponse['pagination']>({
    page: 1,
    limit: 25,
    total: 0,
    totalPages: 0,
  })
  const [contactsLoading, setContactsLoading] = useState(false)
  const [contactsError, setContactsError] = useState<string | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [notesLoading, setNotesLoading] = useState(false)
  const [notesError, setNotesError] = useState<string | null>(null)
  const [noteBody, setNoteBody] = useState('')
  const [noteSubmitting, setNoteSubmitting] = useState(false)
  const [noteMessage, setNoteMessage] = useState<string | null>(null)
  const [syncStart, setSyncStart] = useState<SyncEnqueueResponse | null>(null)
  const [syncJob, setSyncJob] = useState<SyncJob | null>(null)
  const [syncLoading, setSyncLoading] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const syncControllerRef = useRef<AbortController | null>(null)
  const syncRunningRef = useRef(false)
  const noteControllerRef = useRef<AbortController | null>(null)

  const loadConnection = useCallback(async (signal?: AbortSignal) => {
    setConnectionLoading(true)
    try {
      const result = await apiFetch<HubspotStatus>('/api/hubspot/status', { signal })
      setConnection(result)
      setConnectionError(null)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setConnectionError(errorMessage(error))
    } finally {
      if (!signal?.aborted) setConnectionLoading(false)
    }
  }, [])

  const loadHealth = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await apiFetch<{ message: string }>('/api/health', { signal })
      setHealth(result)
    } catch {
      setHealth(null)
    }
  }, [])

  const loadContacts = useCallback(async (targetPage: number, targetSearch: string, signal?: AbortSignal) => {
    setContactsLoading(true)
    try {
      const params = new URLSearchParams({
        page: String(targetPage),
        limit: '25',
      })
      if (targetSearch) params.set('search', targetSearch)
      const result = await apiFetch<ContactsResponse>(`/api/contacts?${params.toString()}`, { signal })
      setContacts(result.contacts)
      setContactsPagination(result.pagination)
      setContactsError(null)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (error instanceof ApiError && error.code === 'HUBSPOT_NOT_CONNECTED') {
        setContacts([])
        setContactsPagination({ page: 1, limit: 25, total: 0, totalPages: 0 })
        setContactsError('Connect HubSpot to load synchronized contacts.')
      } else {
        setContactsError(errorMessage(error))
      }
    } finally {
      if (!signal?.aborted) setContactsLoading(false)
    }
  }, [])

  const loadNotes = useCallback(async (contactId: string, signal?: AbortSignal) => {
    setNotesLoading(true)
    try {
      const result = await apiFetch<{ notes: Note[] }>(`/api/contacts/${contactId}/notes`, { signal })
      setNotes(result.notes)
      setNotesError(null)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setNotesError(errorMessage(error))
    } finally {
      if (!signal?.aborted) setNotesLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const initialLoad = window.setTimeout(() => {
      void Promise.all([loadConnection(controller.signal), loadHealth(controller.signal)])
    }, 0)

    const params = new URLSearchParams(window.location.search)
    const hubspotResult = params.get('hubspot')
    const reason = params.get('reason')
    const oauthBanner = hubspotResult === 'success'
      ? { type: 'success' as const, text: 'HubSpot connected. Contact synchronization was queued.' }
      : hubspotResult === 'error'
        ? { type: 'error' as const, text: reason === 'configuration_error' ? 'HubSpot configuration is incomplete.' : 'HubSpot connection could not be completed.' }
        : null
    if (oauthBanner) {
      window.setTimeout(() => setBanner(oauthBanner), 0)
    }
    if (hubspotResult === 'success') {
      window.setTimeout(() => void loadConnection(controller.signal), 0)
    }
    if (hubspotResult) window.history.replaceState({}, document.title, window.location.pathname)

    return () => {
      window.clearTimeout(initialLoad)
      controller.abort()
    }
  }, [loadConnection, loadHealth])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 350)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    const controller = new AbortController()
    const contactLoad = window.setTimeout(() => {
      void loadContacts(page, search, controller.signal)
    }, 0)
    return () => {
      window.clearTimeout(contactLoad)
      controller.abort()
    }
  }, [loadContacts, page, search])

  useEffect(() => {
    return () => {
      syncControllerRef.current?.abort()
      noteControllerRef.current?.abort()
    }
  }, [])

  const openContact = (contact: Contact) => {
    setSelectedContact(contact)
    setActiveView('contacts')
    setNoteMessage(null)
    setNotesError(null)
    noteControllerRef.current?.abort()
    const controller = new AbortController()
    noteControllerRef.current = controller
    void loadNotes(contact.id, controller.signal)
  }

  const pollJob = async (jobId: string, controller: AbortController): Promise<SyncJob> => {
    while (true) {
      await delay(POLL_INTERVAL_MS, controller.signal)
      const current = await apiFetch<SyncJob>(`/api/sync/jobs/${jobId}`, { signal: controller.signal })
      setSyncJob(current)
      if (isTerminalSyncStatus(current.status)) return current
    }
  }

  const startContactSync = async () => {
    if (syncRunningRef.current) return
    syncRunningRef.current = true
    syncControllerRef.current?.abort()
    const controller = new AbortController()
    syncControllerRef.current = controller
    setSyncLoading(true)
    setSyncError(null)
    setSyncStart(null)
    setSyncJob(null)

    try {
      const queued = await apiFetch<SyncEnqueueResponse>('/api/sync/contacts', {
        method: 'POST',
        signal: controller.signal,
      })
      setSyncStart(queued)
      const finished = isTerminalSyncStatus(queued.status)
        ? null
        : await pollJob(queued.jobId, controller)

      if (finished?.status === 'COMPLETED') {
        setBanner({ type: 'success', text: 'Contact synchronization completed.' })
      } else if (finished?.status === 'PARTIAL') {
        setBanner({ type: 'error', text: 'Synchronization completed with partial failures.' })
      } else if (finished?.status === 'FAILED' || finished?.status === 'AUTH_REQUIRED') {
        setBanner({ type: 'error', text: finished.error ?? 'Contact synchronization failed.' })
      }

      await Promise.all([loadConnection(), loadContacts(page, search)])
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setSyncError(errorMessage(error))
    } finally {
      syncRunningRef.current = false
      if (syncControllerRef.current === controller) syncControllerRef.current = null
      setSyncLoading(false)
    }
  }

  const createNote = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedContact || noteSubmitting || !noteBody.trim()) return
    setNoteSubmitting(true)
    setNoteMessage(null)
    try {
      const result = await apiFetch<CreateNoteResponse>(`/api/contacts/${selectedContact.id}/notes`, {
        method: 'POST',
        body: JSON.stringify({ body: noteBody }),
      })
      setNotes((current) => [result.note, ...current])
      setNoteBody('')
      setNoteMessage(result.sync.queued ? 'Note saved locally and queued for synchronization.' : 'Note saved locally. HubSpot note synchronization is not enabled.')
      if (result.sync.jobId) {
        noteControllerRef.current?.abort()
        const controller = new AbortController()
        noteControllerRef.current = controller
        void pollJob(result.sync.jobId, controller)
          .then(() => loadNotes(selectedContact.id))
          .catch((error: unknown) => {
            if (!(error instanceof DOMException && error.name === 'AbortError')) setNotesError(errorMessage(error))
          })
      }
    } catch (error) {
      setNotesError(errorMessage(error))
    } finally {
      setNoteSubmitting(false)
    }
  }

  const navigate = (view: View) => {
    setActiveView(view)
    setMobileNavOpen(false)
  }

  const selectedProperties = useMemo(() => {
    if (!selectedContact?.properties) return []
    return Object.entries(selectedContact.properties).filter(([, value]) => value !== null && value !== '')
  }, [selectedContact])

  const syncButtonLabel = syncLoading ? 'Syncing contacts…' : 'Sync contacts'

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="flex min-h-screen">
        <aside className={`${mobileNavOpen ? 'translate-x-0' : '-translate-x-full'} fixed inset-y-0 left-0 z-40 w-72 border-r border-slate-200 bg-white px-5 py-6 transition-transform lg:static lg:translate-x-0`}>
          <div className="flex items-center justify-between px-2">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.24em] text-indigo-600">HubSync</p>
              <h1 className="mt-1 text-xl font-bold tracking-tight text-slate-950">CRM workspace</h1>
            </div>
            <button className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 lg:hidden" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation">
              <X className="size-5" />
            </button>
          </div>

          <nav className="mt-10 space-y-1">
            <SidebarItem icon={LayoutDashboard} label="Overview" active={activeView === 'overview'} onClick={() => navigate('overview')} />
            <SidebarItem icon={Users} label="Contacts" active={activeView === 'contacts'} onClick={() => navigate('contacts')} />
            <SidebarItem icon={MessageSquareText} label="Notes" active={activeView === 'notes'} onClick={() => navigate('notes')} />
            <SidebarItem icon={ShieldCheck} label="HubSpot connection" active={activeView === 'connection'} onClick={() => navigate('connection')} />
            <SidebarItem icon={Settings} label="API status" active={activeView === 'status'} onClick={() => navigate('status')} />
          </nav>

          <div className="absolute inset-x-5 bottom-6 rounded-2xl bg-slate-950 p-4 text-white">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
              <span className={`size-2 rounded-full ${health ? 'bg-emerald-400' : 'bg-rose-400'}`} />
              Backend {health ? 'online' : 'unavailable'}
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-400">Development interface for testing the HubSync API.</p>
          </div>
        </aside>

        {mobileNavOpen ? <button className="fixed inset-0 z-30 bg-slate-950/30 lg:hidden" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation overlay" /> : null}

        <main className="min-w-0 flex-1">
          <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 px-4 py-4 backdrop-blur sm:px-8">
            <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <button className="rounded-xl border border-slate-200 p-2 text-slate-600 lg:hidden" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation">
                  <Menu className="size-5" />
                </button>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Backend console</p>
                  <h2 className="text-lg font-bold text-slate-950">{viewTitle(activeView)}</h2>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {connection?.connected ? <StatusBadge status={connection.syncStatus} /> : <span className="hidden text-sm text-slate-500 sm:inline">Not connected</span>}
                <button className="hidden rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-indigo-200 transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60 sm:inline-flex" onClick={() => void startContactSync()} disabled={syncLoading || !connection?.connected}>
                  <CloudDownload className="mr-2 size-4" />
                  {syncButtonLabel}
                </button>
              </div>
            </div>
          </header>

          <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-8 sm:py-8">
            {banner ? <AlertBanner type={banner.type} text={banner.text} onClose={() => setBanner(null)} /> : null}
            {connectionError ? <AlertBanner type="error" text={connectionError} onClose={() => setConnectionError(null)} /> : null}

            {activeView === 'overview' ? (
              <OverviewView
                connection={connection}
                connectionLoading={connectionLoading}
                contactsTotal={contactsPagination.total}
                syncStart={syncStart}
                syncJob={syncJob}
                syncLoading={syncLoading}
                syncError={syncError}
                onConnect={() => { window.location.href = `${getApiBaseUrl()}/auth/hubspot` }}
                onSync={() => void startContactSync()}
                onContacts={() => navigate('contacts')}
              />
            ) : null}

            {activeView === 'contacts' ? (
              <ContactsView
                contacts={contacts}
                loading={contactsLoading}
                error={contactsError}
                page={page}
                pagination={contactsPagination}
                searchInput={searchInput}
                selectedContact={selectedContact}
                notes={notes}
                notesLoading={notesLoading}
                notesError={notesError}
                noteBody={noteBody}
                noteSubmitting={noteSubmitting}
                noteMessage={noteMessage}
                selectedProperties={selectedProperties}
                onSearchChange={setSearchInput}
                onPageChange={setPage}
                onRefresh={() => void loadContacts(page, search)}
                onSelectContact={openContact}
                onCloseDetails={() => setSelectedContact(null)}
                onNoteBodyChange={setNoteBody}
                onCreateNote={createNote}
              />
            ) : null}

            {activeView === 'notes' ? (
              <NotesView
                contacts={contacts}
                selectedContact={selectedContact}
                notes={notes}
                loading={notesLoading}
                error={notesError}
                noteBody={noteBody}
                noteSubmitting={noteSubmitting}
                noteMessage={noteMessage}
                onSelectContact={openContact}
                onNoteBodyChange={setNoteBody}
                onCreateNote={createNote}
                onContacts={() => navigate('contacts')}
              />
            ) : null}

            {activeView === 'connection' ? (
              <ConnectionView connection={connection} loading={connectionLoading} onConnect={() => { window.location.href = `${getApiBaseUrl()}/auth/hubspot` }} onRefresh={() => void loadConnection()} />
            ) : null}

            {activeView === 'status' ? (
              <StatusView health={health} connection={connection} onRefresh={() => void Promise.all([loadHealth(), loadConnection()])} />
            ) : null}
          </div>
        </main>
      </div>
    </div>
  )
}

function SidebarItem({ icon: Icon, label, active, onClick }: { icon: typeof Users; label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold transition ${active ? 'bg-indigo-50 text-indigo-700' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'}`}>
      <Icon className="size-4" />
      {label}
    </button>
  )
}

function viewTitle(view: View): string {
  return { overview: 'Overview', contacts: 'Contacts', notes: 'Notes', connection: 'HubSpot connection', status: 'API status' }[view]
}

function AlertBanner({ type, text, onClose }: { type: 'success' | 'error'; text: string; onClose: () => void }) {
  const success = type === 'success'
  return (
    <div className={`flex items-start justify-between gap-4 rounded-2xl border px-4 py-3 text-sm ${success ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-800'}`}>
      <div className="flex items-start gap-2">
        {success ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <AlertCircle className="mt-0.5 size-4 shrink-0" />}
        <span>{text}</span>
      </div>
      <button onClick={onClose} className="shrink-0 rounded-md p-1 opacity-70 hover:bg-black/5" aria-label="Dismiss message"><X className="size-4" /></button>
    </div>
  )
}

function OverviewView({ connection, connectionLoading, contactsTotal, syncStart, syncJob, syncLoading, syncError, onConnect, onSync, onContacts }: {
  connection: HubspotStatus | null
  connectionLoading: boolean
  contactsTotal: number
  syncStart: SyncEnqueueResponse | null
  syncJob: SyncJob | null
  syncLoading: boolean
  syncError: string | null
  onConnect: () => void
  onSync: () => void
  onContacts: () => void
}) {
  return (
    <div className="space-y-6">
      <section className="rounded-3xl bg-slate-950 p-6 text-white shadow-xl shadow-slate-200 sm:p-8">
        <div className="flex flex-col justify-between gap-8 lg:flex-row lg:items-end">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold text-indigo-300">HubSpot CRM control center</p>
            <h3 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Keep contacts and notes in sync.</h3>
            <p className="mt-4 max-w-xl text-sm leading-6 text-slate-300">Use the real backend state to connect HubSpot, queue contact synchronization, inspect progress, and manage local notes.</p>
          </div>
          <div className="flex flex-wrap gap-3">
            {!connection?.connected ? <button onClick={onConnect} className="inline-flex items-center rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-slate-950 hover:bg-indigo-50"><ExternalLink className="mr-2 size-4" />Connect HubSpot</button> : null}
            <button onClick={onSync} disabled={syncLoading || !connection?.connected} className="inline-flex items-center rounded-xl bg-indigo-500 px-4 py-2.5 text-sm font-bold text-white hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"><CloudDownload className="mr-2 size-4" />{syncLoading ? 'Syncing…' : 'Sync contacts'}</button>
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={ShieldCheck} label="HubSpot connection" value={connectionLoading ? 'Loading…' : connection?.connected ? 'Connected' : 'Disconnected'} detail={connection?.portalId ? `Portal ${connection.portalId}` : 'No portal connected'} tone={connection?.connected ? 'green' : 'slate'} />
        <MetricCard icon={Users} label="Local contacts" value={contactsTotal.toLocaleString()} detail="Stored in PostgreSQL" tone="indigo" />
        <MetricCard icon={Activity} label="Sync status" value={syncJob ? statusLabel(syncJob.status) : statusLabel(syncStart?.status ?? connection?.syncStatus)} detail={syncStart?.duplicate ? 'An existing job is already active' : syncJob?.completedAt ? formatDate(syncJob.completedAt) : connection?.lastSyncAt ? `Last sync ${formatDate(connection.lastSyncAt)}` : 'No completed sync yet'} tone="amber" />
        <MetricCard icon={Database} label="Latest progress" value={syncJob ? `${syncJob.processed.toLocaleString()} processed` : 'Unavailable'} detail={syncJob ? `${syncJob.createdCount} created · ${syncJob.updatedCount} updated · ${syncJob.failedCount} failed` : 'Start a sync to see counters'} tone="violet" />
      </section>

      {syncError ? <AlertBanner type="error" text={syncError} onClose={() => undefined} /> : null}
      {syncJob ? <SyncProgressCard job={syncJob} /> : null}

      <section className="grid gap-6 lg:grid-cols-[1.25fr_0.75fr]">
        <div className="rounded-2xl border border-slate-200 bg-white p-6">
          <div className="flex items-start justify-between gap-4"><div><p className="text-sm font-semibold text-slate-400">Quick actions</p><h3 className="mt-1 text-lg font-bold text-slate-950">Test the backend flow</h3></div><Activity className="size-5 text-indigo-500" /></div>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <ActionButton icon={Users} label="Open contacts" description="Search and inspect synchronized records" onClick={onContacts} />
            <ActionButton icon={RefreshCw} label="Queue a sync" description="Use the BullMQ background worker" onClick={onSync} disabled={!connection?.connected || syncLoading} />
          </div>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6">
          <p className="text-sm font-semibold text-slate-400">What is available</p>
          <div className="mt-4 space-y-3 text-sm text-slate-600"><FeatureRow label="OAuth token storage" available /><FeatureRow label="Contact synchronization" available /><FeatureRow label="Local notes" available /><FeatureRow label="HubSpot note write sync" available={false} /></div>
        </div>
      </section>
    </div>
  )
}

function MetricCard({ icon: Icon, label, value, detail, tone }: { icon: typeof Users; label: string; value: string; detail: string; tone: 'green' | 'slate' | 'indigo' | 'amber' | 'violet' }) {
  const colors = { green: 'bg-emerald-50 text-emerald-600', slate: 'bg-slate-100 text-slate-500', indigo: 'bg-indigo-50 text-indigo-600', amber: 'bg-amber-50 text-amber-600', violet: 'bg-violet-50 text-violet-600' }
  return <div className="rounded-2xl border border-slate-200 bg-white p-5"><div className={`mb-5 inline-flex rounded-xl p-2.5 ${colors[tone]}`}><Icon className="size-5" /></div><p className="text-sm font-medium text-slate-500">{label}</p><p className="mt-1 truncate text-2xl font-bold tracking-tight text-slate-950">{value}</p><p className="mt-2 truncate text-xs text-slate-400">{detail}</p></div>
}

function ActionButton({ icon: Icon, label, description, onClick, disabled }: { icon: typeof Users; label: string; description: string; onClick: () => void; disabled?: boolean }) {
  return <button onClick={onClick} disabled={disabled} className="flex items-start gap-3 rounded-xl border border-slate-200 p-4 text-left transition hover:border-indigo-200 hover:bg-indigo-50/40 disabled:cursor-not-allowed disabled:opacity-50"><Icon className="mt-0.5 size-5 text-indigo-600" /><span><span className="block text-sm font-bold text-slate-900">{label}</span><span className="mt-1 block text-xs leading-5 text-slate-500">{description}</span></span></button>
}

function FeatureRow({ label, available }: { label: string; available: boolean }) {
  return <div className="flex items-center justify-between gap-3"><span>{label}</span>{available ? <CheckCircle2 className="size-4 text-emerald-500" /> : <XCircle className="size-4 text-slate-300" />}</div>
}

function SyncProgressCard({ job }: { job: SyncJob }) {
  return <div className="rounded-2xl border border-indigo-100 bg-indigo-50/60 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[0.16em] text-indigo-600">Synchronization job</p><p className="mt-1 text-sm text-slate-600">Job <code className="rounded bg-white px-1.5 py-0.5 text-xs">{job.id}</code></p></div><StatusBadge status={job.status} /></div><div className="mt-5 grid gap-3 sm:grid-cols-4"><ProgressMetric label="Processed" value={job.processed} /><ProgressMetric label="Created" value={job.createdCount} /><ProgressMetric label="Updated" value={job.updatedCount} /><ProgressMetric label="Failed" value={job.failedCount} /></div>{job.error ? <p className="mt-4 text-sm font-medium text-rose-700">{job.error}</p> : null}</div>
}

function ProgressMetric({ label, value }: { label: string; value: number }) { return <div className="rounded-xl bg-white/80 px-3 py-3"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-xl font-bold text-slate-950">{value.toLocaleString()}</p></div> }

function ContactsView({ contacts, loading, error, page, pagination, searchInput, selectedContact, notes, notesLoading, notesError, noteBody, noteSubmitting, noteMessage, selectedProperties, onSearchChange, onPageChange, onRefresh, onSelectContact, onCloseDetails, onNoteBodyChange, onCreateNote }: {
  contacts: Contact[]; loading: boolean; error: string | null; page: number; pagination: ContactsResponse['pagination']; searchInput: string; selectedContact: Contact | null; notes: Note[]; notesLoading: boolean; notesError: string | null; noteBody: string; noteSubmitting: boolean; noteMessage: string | null; selectedProperties: [string, unknown][]; onSearchChange: (value: string) => void; onPageChange: (page: number) => void; onRefresh: () => void; onSelectContact: (contact: Contact) => void; onCloseDetails: () => void; onNoteBodyChange: (value: string) => void; onCreateNote: (event: FormEvent<HTMLFormElement>) => void
}) {
  return <div className="space-y-6"><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><p className="text-sm font-semibold text-indigo-600">CRM records</p><h3 className="mt-1 text-2xl font-bold tracking-tight text-slate-950">Contacts</h3><p className="mt-2 text-sm text-slate-500">Search and inspect the contacts persisted by the backend.</p></div><button onClick={onRefresh} className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"><RefreshCw className="mr-2 size-4" />Refresh</button></div><div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:flex-row"><div className="relative flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" /><input value={searchInput} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search by name or email…" className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-10 pr-3 text-sm outline-none transition focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-50" /></div><span className="flex items-center justify-center rounded-xl bg-slate-100 px-4 text-sm font-semibold text-slate-600">{pagination.total.toLocaleString()} total</span></div>{error ? <AlertBanner type="error" text={error} onClose={() => undefined} /> : null}{loading ? <ContactsSkeleton /> : contacts.length === 0 ? <EmptyState icon={Users} title="No contacts found" message={error ?? (searchInput ? 'Try a different search term.' : 'Connect HubSpot and run a contact synchronization to populate this list.')} /> : <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white"><div className="overflow-x-auto"><table className="w-full min-w-[680px] text-left text-sm"><thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-5 py-3 font-semibold">Contact</th><th className="px-5 py-3 font-semibold">Email</th><th className="px-5 py-3 font-semibold">HubSpot ID</th><th className="px-5 py-3 font-semibold">Updated</th><th className="px-5 py-3" /></tr></thead><tbody className="divide-y divide-slate-100">{contacts.map((contact) => <tr key={contact.id} className="transition hover:bg-indigo-50/30"><td className="px-5 py-4"><button onClick={() => onSelectContact(contact)} className="flex items-center gap-3 text-left"><span className="flex size-9 items-center justify-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-700">{(contact.firstName?.[0] ?? contact.email?.[0] ?? '?').toUpperCase()}</span><span><span className="block font-semibold text-slate-900">{displayName(contact)}</span><span className="block text-xs text-slate-400">{contact.firstName || contact.lastName ? 'Contact record' : 'Email-only record'}</span></span></button></td><td className="px-5 py-4 text-slate-600">{contact.email ?? '—'}</td><td className="px-5 py-4 font-mono text-xs text-slate-500">{contact.hubspotContactId}</td><td className="px-5 py-4 text-slate-500">{formatDate(contact.updatedAt)}</td><td className="px-5 py-4 text-right"><button onClick={() => onSelectContact(contact)} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-indigo-600" aria-label={`Open ${displayName(contact)}`}><ChevronRight className="size-4" /></button></td></tr>)}</tbody></table></div><Pagination page={page} pagination={pagination} onPageChange={onPageChange} /></div>}{selectedContact ? <ContactDrawer contact={selectedContact} notes={notes} notesLoading={notesLoading} notesError={notesError} noteBody={noteBody} noteSubmitting={noteSubmitting} noteMessage={noteMessage} selectedProperties={selectedProperties} onClose={onCloseDetails} onNoteBodyChange={onNoteBodyChange} onCreateNote={onCreateNote} /> : null}</div>
}

function ContactsSkeleton() { return <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5">{Array.from({ length: 6 }).map((_, index) => <LoadingBlock key={index} className="h-12" />)}</div> }

function Pagination({ page, pagination, onPageChange }: { page: number; pagination: ContactsResponse['pagination']; onPageChange: (page: number) => void }) { return <div className="flex items-center justify-between border-t border-slate-100 px-5 py-4"><p className="text-xs text-slate-500">Page {page} of {Math.max(pagination.totalPages, 1)}</p><div className="flex gap-2"><button disabled={page <= 1} onClick={() => onPageChange(page - 1)} className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40" aria-label="Previous page"><ChevronLeft className="size-4" /></button><button disabled={page >= pagination.totalPages} onClick={() => onPageChange(page + 1)} className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40" aria-label="Next page"><ChevronRight className="size-4" /></button></div></div> }

function ContactDrawer({ contact, notes, notesLoading, notesError, noteBody, noteSubmitting, noteMessage, selectedProperties, onClose, onNoteBodyChange, onCreateNote }: { contact: Contact; notes: Note[]; notesLoading: boolean; notesError: string | null; noteBody: string; noteSubmitting: boolean; noteMessage: string | null; selectedProperties: [string, unknown][]; onClose: () => void; onNoteBodyChange: (value: string) => void; onCreateNote: (event: FormEvent<HTMLFormElement>) => void }) { return <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/30" onClick={onClose}><section className="h-full w-full max-w-xl overflow-y-auto bg-white p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[0.18em] text-indigo-600">Contact detail</p><h3 className="mt-2 text-2xl font-bold text-slate-950">{displayName(contact)}</h3><p className="mt-1 text-sm text-slate-500">{contact.email ?? 'No email available'}</p></div><button onClick={onClose} className="rounded-xl p-2 text-slate-400 hover:bg-slate-100" aria-label="Close contact details"><X className="size-5" /></button></div><div className="mt-8 space-y-6"><div><h4 className="text-sm font-bold text-slate-900">Contact properties</h4><div className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200">{selectedProperties.length ? selectedProperties.map(([key, value]) => <div key={key} className="flex justify-between gap-4 px-4 py-3 text-sm"><span className="text-slate-500">{key}</span><span className="max-w-[60%] break-words text-right font-medium text-slate-800">{String(value)}</span></div>) : <p className="px-4 py-4 text-sm text-slate-500">No additional properties returned.</p>}</div></div><div><div className="flex items-center justify-between"><h4 className="text-sm font-bold text-slate-900">Notes</h4><span className="text-xs text-slate-400">{notes.length} local</span></div><NoteComposer noteBody={noteBody} submitting={noteSubmitting} message={noteMessage} error={notesError} onBodyChange={onNoteBodyChange} onSubmit={onCreateNote} />{notesLoading ? <div className="mt-4 space-y-2"><LoadingBlock className="h-16" /><LoadingBlock className="h-16" /></div> : notes.length ? <div className="mt-4 space-y-3">{notes.map((note) => <NoteCard key={note.id} note={note} />)}</div> : <p className="mt-4 rounded-xl bg-slate-50 p-4 text-sm text-slate-500">No notes saved for this contact.</p>}</div></div></section></div> }

function NoteComposer({ noteBody, submitting, message, error, onBodyChange, onSubmit }: { noteBody: string; submitting: boolean; message: string | null; error: string | null; onBodyChange: (value: string) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) { return <form onSubmit={onSubmit} className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3"><textarea value={noteBody} onChange={(event) => onBodyChange(event.target.value)} maxLength={65536} placeholder="Write a local note…" className="min-h-24 w-full resize-y rounded-lg border border-slate-200 bg-white p-3 text-sm outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-50" /><div className="mt-2 flex items-center justify-between gap-3"><p className="text-xs text-slate-400">Saved locally before any sync attempt.</p><button disabled={submitting || !noteBody.trim()} className="inline-flex items-center rounded-lg bg-slate-950 px-3 py-2 text-xs font-bold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50">{submitting ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <FileText className="mr-1.5 size-3.5" />}Save note</button></div>{message ? <p className="mt-2 text-xs font-medium text-emerald-700">{message}</p> : null}{error ? <p className="mt-2 text-xs font-medium text-rose-700">{error}</p> : null}</form> }

function NoteCard({ note }: { note: Note }) { return <article className="rounded-xl border border-slate-200 p-4"><div className="flex items-start justify-between gap-3"><p className="whitespace-pre-wrap text-sm leading-6 text-slate-700">{note.body}</p><StatusBadge status={note.syncStatus} /></div><div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-400"><span>{formatDate(note.createdAt)}</span>{note.lastSyncError ? <span className="text-rose-600">{note.lastSyncError}</span> : null}</div></article> }

function NotesView({ contacts, selectedContact, notes, loading, error, noteBody, noteSubmitting, noteMessage, onSelectContact, onNoteBodyChange, onCreateNote, onContacts }: { contacts: Contact[]; selectedContact: Contact | null; notes: Note[]; loading: boolean; error: string | null; noteBody: string; noteSubmitting: boolean; noteMessage: string | null; onSelectContact: (contact: Contact) => void; onNoteBodyChange: (value: string) => void; onCreateNote: (event: FormEvent<HTMLFormElement>) => void; onContacts: () => void }) { return <div className="space-y-6"><div><p className="text-sm font-semibold text-indigo-600">Local activity</p><h3 className="mt-1 text-2xl font-bold tracking-tight text-slate-950">Notes</h3><p className="mt-2 text-sm text-slate-500">Notes are stored locally first. HubSpot note write sync is only shown when the backend confirms it is enabled.</p></div>{selectedContact ? <div className="grid gap-6 lg:grid-cols-[0.8fr_1.2fr]"><div className="rounded-2xl border border-slate-200 bg-white p-5"><button onClick={onContacts} className="mb-5 inline-flex items-center text-xs font-semibold text-indigo-600 hover:text-indigo-700"><ArrowLeft className="mr-1 size-3.5" />Back to contacts</button><p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Selected contact</p><h4 className="mt-2 text-lg font-bold text-slate-950">{displayName(selectedContact)}</h4><p className="mt-1 text-sm text-slate-500">{selectedContact.email ?? 'No email available'}</p><div className="mt-5 rounded-xl bg-slate-50 p-4 text-sm text-slate-600">{notes.length} local note{notes.length === 1 ? '' : 's'} available.</div></div><div className="rounded-2xl border border-slate-200 bg-white p-5"><NoteComposer noteBody={noteBody} submitting={noteSubmitting} message={noteMessage} error={error} onBodyChange={onNoteBodyChange} onSubmit={onCreateNote} /><div className="mt-5 space-y-3">{loading ? <LoadingBlock className="h-20" /> : notes.length ? notes.map((note) => <NoteCard key={note.id} note={note} />) : <EmptyState icon={MessageSquareText} title="No notes yet" message="Create the first local note for this contact." />}</div></div></div> : <div className="space-y-4"><div className="rounded-2xl border border-indigo-100 bg-indigo-50 p-5 text-sm text-indigo-800">Select a contact below to view or create its notes.</div>{contacts.length ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{contacts.map((contact) => <button key={contact.id} onClick={() => onSelectContact(contact)} className="rounded-2xl border border-slate-200 bg-white p-4 text-left hover:border-indigo-200 hover:bg-indigo-50/30"><p className="font-semibold text-slate-900">{displayName(contact)}</p><p className="mt-1 text-xs text-slate-500">{contact.email ?? 'No email available'}</p></button>)}</div> : <EmptyState icon={Users} title="No contacts available" message="Open Contacts after connecting HubSpot and synchronizing records." />}</div>}</div> }

function ConnectionView({ connection, loading, onConnect, onRefresh }: { connection: HubspotStatus | null; loading: boolean; onConnect: () => void; onRefresh: () => void }) { return <div className="space-y-6"><div><p className="text-sm font-semibold text-indigo-600">OAuth integration</p><h3 className="mt-1 text-2xl font-bold tracking-tight text-slate-950">HubSpot connection</h3><p className="mt-2 text-sm text-slate-500">OAuth and token storage stay on the backend. The browser only reads safe connection status.</p></div><div className="rounded-2xl border border-slate-200 bg-white p-6">{loading ? <LoadingBlock className="h-32" /> : <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-center"><div className="flex items-start gap-4"><div className={`rounded-2xl p-3 ${connection?.connected ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}><ShieldCheck className="size-7" /></div><div><StatusBadge status={connection?.connected ? 'COMPLETED' : 'FAILED'} /><h4 className="mt-3 text-lg font-bold text-slate-950">{connection?.connected ? 'HubSpot is connected' : 'No HubSpot account connected'}</h4><p className="mt-1 text-sm text-slate-500">{connection?.portalId ? `Portal ID: ${connection.portalId}` : 'Connect a test account to begin synchronization.'}</p>{connection?.lastSyncAt ? <p className="mt-2 text-xs text-slate-400">Last sync: {formatDate(connection.lastSyncAt)}</p> : null}</div></div><div className="flex gap-3"><button onClick={onRefresh} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">Refresh</button>{!connection?.connected ? <button onClick={onConnect} className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-indigo-700">Connect HubSpot</button> : null}</div></div>}</div></div> }

function StatusView({ health, connection, onRefresh }: { health: { message: string } | null; connection: HubspotStatus | null; onRefresh: () => void }) { return <div className="space-y-6"><div className="flex items-end justify-between gap-4"><div><p className="text-sm font-semibold text-indigo-600">Diagnostics</p><h3 className="mt-1 text-2xl font-bold tracking-tight text-slate-950">API status</h3><p className="mt-2 text-sm text-slate-500">Safe runtime checks for the local development environment.</p></div><button onClick={onRefresh} className="inline-flex items-center rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"><RefreshCw className="mr-2 size-4" />Refresh</button></div><div className="grid gap-4 md:grid-cols-2"><StatusPanel icon={HeartPulse} label="Backend health" ok={Boolean(health)} value={health?.message ?? 'Backend unavailable'} /><StatusPanel icon={Server} label="HubSpot connection" ok={Boolean(connection?.connected)} value={connection?.connected ? `Connected to portal ${connection.portalId ?? '—'}` : 'Disconnected'} /><StatusPanel icon={Activity} label="Synchronization" ok={Boolean(connection?.syncStatus && ['IDLE', 'COMPLETED'].includes(connection.syncStatus))} value={connection?.syncStatus ? statusLabel(connection.syncStatus) : 'Unavailable'} /><StatusPanel icon={Database} label="API base URL" ok value={getApiBaseUrl()} /></div></div> }

function StatusPanel({ icon: Icon, label, ok, value }: { icon: typeof Users; label: string; ok: boolean; value: string }) { return <div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex items-center justify-between"><div className="flex items-center gap-2 text-sm font-semibold text-slate-700"><Icon className="size-4 text-indigo-500" />{label}</div><span className={`size-2.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-rose-500'}`} /></div><p className="mt-4 break-words text-sm text-slate-500">{value}</p></div> }

export default App
