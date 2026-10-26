import {
  Activity,
  AlertCircle,
  ArrowLeft,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  CloudDownload,
  Command,
  Database,
  ExternalLink,
  FileText,
  HeartPulse,
  HelpCircle,
  LayoutDashboard,
  Link2,
  Loader2,
  Menu,
  MessageSquareText,
  RefreshCw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
  X,
  XCircle,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, FormEvent, ReactNode, SVGProps } from 'react'
import {
  ApiError,
  apiFetch,
  getApiBaseUrl,
  isTerminalSyncStatus,
} from './lib/api'
import type {
  Contact,
  ContactsResponse,
  CreateNoteResponse,
  HubspotStatus,
  Note,
  SyncEnqueueResponse,
  SyncJob,
} from './lib/api'

type View = 'overview' | 'contacts' | 'notes' | 'connection' | 'status'
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'dark'

const INITIAL_POLL_INTERVAL_MS = 900
const MAX_POLL_INTERVAL_MS = 3500

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Polling cancelled', 'AbortError'))
      return
    }

    let timeout = 0
    const onAbort = () => {
      window.clearTimeout(timeout)
      reject(new DOMException('Polling cancelled', 'AbortError'))
    }
    const finish = () => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }

    timeout = window.setTimeout(finish, milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
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

function initials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?'
}

function statusLabel(status: string | undefined): string {
  if (!status) return 'Unknown'
  return status.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (character) => character.toUpperCase())
}

function statusTone(status: string | undefined): 'success' | 'pending' | 'error' | 'neutral' {
  switch (status) {
    case 'COMPLETED':
    case 'SYNCED':
    case 'IDLE':
      return 'success'
    case 'QUEUED':
    case 'RUNNING':
    case 'PENDING':
      return 'pending'
    case 'PARTIAL':
    case 'FAILED':
    case 'AUTH_REQUIRED':
      return 'error'
    default:
      return 'neutral'
  }
}

function StatusBadge({ status }: { status?: string }) {
  const tone = statusTone(status)
  return (
    <span className={`status-badge status-badge--${tone}`}>
      <CircleDot />
      {statusLabel(status)}
    </span>
  )
}

function Button({
  children,
  icon: Icon,
  variant = 'secondary',
  size = 'md',
  className = '',
  ...props
}: {
  children: ReactNode
  icon?: LucideIcon
  variant?: ButtonVariant
  size?: 'md' | 'lg'
  className?: string
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`btn btn--${variant} btn--${size} ${className}`} {...props}>
      {Icon ? <Icon /> : null}
      {children}
    </button>
  )
}

function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="page-header">
      <div>
        <div className="page-header__eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  )
}

function AlertBanner({
  type,
  text,
  onClose,
}: {
  type: 'success' | 'error'
  text: string
  onClose: () => void
}) {
  const success = type === 'success'
  return (
    <div className={`alert-banner alert-banner--${success ? 'success' : 'error'}`}>
      <div className="alert-banner__body">
        {success ? <CheckCircle2 /> : <AlertCircle />}
        <span>{text}</span>
      </div>
      <button className="icon-button" onClick={onClose} aria-label="Dismiss message">
        <X />
      </button>
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

  const loadConnection = useCallback(async (signal?: AbortSignal, reportError = true) => {
    setConnectionLoading(true)
    try {
      const result = await apiFetch<HubspotStatus>('/api/hubspot/status', { signal })
      setConnection(result)
      setConnectionError(null)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (reportError) setConnectionError(errorMessage(error))
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

  const loadContacts = useCallback(async (targetPage: number, targetSearch: string, signal?: AbortSignal, reportError = true) => {
    setContactsLoading(true)
    try {
      const params = new URLSearchParams({ page: String(targetPage), limit: '25' })
      if (targetSearch) params.set('search', targetSearch)
      const result = await apiFetch<ContactsResponse>(`/api/contacts?${params.toString()}`, { signal })
      setContacts(result.contacts)
      setContactsPagination(result.pagination)
      setContactsError(null)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (error instanceof ApiError && error.code === 'HUBSPOT_NOT_CONNECTED') {
        if (!reportError) return
        setContacts([])
        setContactsPagination({ page: 1, limit: 25, total: 0, totalPages: 0 })
        setContactsError('Connect HubSpot to load synchronized contacts.')
      } else {
        if (reportError) setContactsError(errorMessage(error))
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
    if (oauthBanner) window.setTimeout(() => setBanner(oauthBanner), 0)
    if (hubspotResult === 'success') window.setTimeout(() => void loadConnection(controller.signal), 0)
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
    let pollInterval = INITIAL_POLL_INTERVAL_MS

    while (true) {
      await delay(pollInterval, controller.signal)
      const current = await apiFetch<SyncJob>(`/api/sync/jobs/${jobId}`, { signal: controller.signal })
      setSyncJob(current)
      if (isTerminalSyncStatus(current.status)) return current
      pollInterval = Math.min(pollInterval + 500, MAX_POLL_INTERVAL_MS)
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
      setConnectionError(null)
      setContactsError(null)
      setHealth({ message: 'HubSync API is running' })
      const finished = isTerminalSyncStatus(queued.status) ? null : await pollJob(queued.jobId, controller)

      if (finished?.status === 'COMPLETED') {
        setBanner({ type: 'success', text: 'Contact synchronization completed successfully.' })
        setConnectionError(null)
        setContactsError(null)
        setHealth({ message: 'HubSync API is running' })
      } else if (finished?.status === 'PARTIAL') {
        setBanner({ type: 'error', text: 'Synchronization completed with partial failures.' })
      } else if (finished?.status === 'FAILED' || finished?.status === 'AUTH_REQUIRED') {
        setBanner({ type: 'error', text: finished.error ?? 'Contact synchronization failed.' })
      }

      await Promise.allSettled([
        loadConnection(controller.signal, false),
        loadHealth(controller.signal),
        loadContacts(page, search, controller.signal, false),
      ])
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
      setNoteMessage(result.sync.queued ? 'Saved locally and queued for HubSpot sync.' : 'Saved locally. HubSpot sync is currently unavailable.')
      if (result.sync.jobId) {
        noteControllerRef.current?.abort()
        const controller = new AbortController()
        noteControllerRef.current = controller
        void pollJob(result.sync.jobId, controller)
          .then(() => loadNotes(selectedContact.id, controller.signal))
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
    <div className="app-shell">
      <aside className={`sidebar ${mobileNavOpen ? 'sidebar--open' : ''}`}>
        <div className="sidebar__brand">
          <div className="brand-mark"><Sparkles /></div>
          <div>
            <div className="brand-name">HubSync</div>
            <div className="brand-caption">CRM workspace</div>
          </div>
          <button className="icon-button ml-auto !border-0 !bg-transparent !text-slate-400 lg:hidden" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation"><X /></button>
        </div>

        <div className="workspace-switcher">
          <div>
            <div className="workspace-switcher__label">Workspace</div>
            <div className="workspace-switcher__name">HubSync operations</div>
          </div>
        </div>

        <nav>
          <div className="nav-section">
            <div className="nav-section__title">Workspace</div>
            <NavItem icon={LayoutDashboard} label="Overview" active={activeView === 'overview'} onClick={() => navigate('overview')} />
            <NavItem icon={Users} label="Contacts" active={activeView === 'contacts'} onClick={() => navigate('contacts')} />
            <NavItem icon={MessageSquareText} label="Notes" active={activeView === 'notes'} onClick={() => navigate('notes')} />
          </div>
          <div className="nav-section">
            <div className="nav-section__title">Manage</div>
            <NavItem icon={Link2} label="HubSpot connection" active={activeView === 'connection'} onClick={() => navigate('connection')} />
            <NavItem icon={Settings} label="API status" active={activeView === 'status'} onClick={() => navigate('status')} />
          </div>
        </nav>

        <div className="sidebar__footer">
          <div className="system-status">
            <span className={`status-dot ${health ? 'status-dot--online' : ''}`} />
            Backend {health ? 'online' : 'unavailable'}
          </div>
          <div className="profile-chip">
            <div className="avatar avatar--small">AJ</div>
            <div>
              <div className="profile-chip__name">Workspace owner</div>
              <div className="profile-chip__role">Local development account</div>
            </div>
          </div>
        </div>
      </aside>

      {mobileNavOpen ? <button className="fixed inset-0 z-30 bg-slate-950/40 lg:hidden" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation overlay" /> : null}

      <div className="app-main">
        <header className="topbar">
          <div className="topbar__inner">
            <div className="flex min-w-0 items-center gap-3">
              <button className="icon-button lg:hidden" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation"><Menu /></button>
              <div className="breadcrumb">
                <span className="breadcrumb__eyebrow">Workspace</span>
                <span className="text-slate-300">/</span>
                <span className="breadcrumb__current">{viewTitle(activeView)}</span>
              </div>
            </div>
            <div className="topbar__actions">
              {connection?.connected ? <StatusBadge status={connection.syncStatus ?? 'IDLE'} /> : <StatusBadge status="FAILED" />}
              <Button icon={CloudDownload} variant="primary" onClick={() => void startContactSync()} disabled={syncLoading || !connection?.connected}>{syncButtonLabel}</Button>
            </div>
          </div>
        </header>

        <main className="content">
          <div className="space-y-4">
            {banner ? <AlertBanner type={banner.type} text={banner.text} onClose={() => setBanner(null)} /> : null}
            {connectionError ? <AlertBanner type="error" text={connectionError} onClose={() => setConnectionError(null)} /> : null}
          </div>

          {activeView === 'overview' ? (
            <OverviewView
              connection={connection}
              connectionLoading={connectionLoading}
              contactsTotal={contactsPagination.total}
              health={health}
              syncStart={syncStart}
              syncJob={syncJob}
              syncLoading={syncLoading}
              syncError={syncError}
              onConnect={() => { window.location.href = `${getApiBaseUrl()}/auth/hubspot` }}
              onSync={() => void startContactSync()}
              onContacts={() => navigate('contacts')}
              onConnection={() => navigate('connection')}
              onStatus={() => navigate('status')}
              onDismissSyncError={() => setSyncError(null)}
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
              onDismissError={() => setContactsError(null)}
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
        </main>
      </div>
    </div>
  )
}

function NavItem({ icon: Icon, label, active, onClick }: { icon: LucideIcon; label: string; active: boolean; onClick: () => void }) {
  return (
    <button className={`nav-item ${active ? 'nav-item--active' : ''}`} onClick={onClick}>
      <Icon />
      <span>{label}</span>
    </button>
  )
}

function viewTitle(view: View): string {
  return { overview: 'Overview', contacts: 'Contacts', notes: 'Notes', connection: 'HubSpot connection', status: 'API status' }[view]
}

function OverviewView({
  connection,
  connectionLoading,
  contactsTotal,
  health,
  syncStart,
  syncJob,
  syncLoading,
  syncError,
  onConnect,
  onSync,
  onContacts,
  onConnection,
  onStatus,
  onDismissSyncError,
}: {
  connection: HubspotStatus | null
  connectionLoading: boolean
  contactsTotal: number
  health: { message: string } | null
  syncStart: SyncEnqueueResponse | null
  syncJob: SyncJob | null
  syncLoading: boolean
  syncError: string | null
  onConnect: () => void
  onSync: () => void
  onContacts: () => void
  onConnection: () => void
  onStatus: () => void
  onDismissSyncError: () => void
}) {
  const currentStatus = syncJob?.status ?? syncStart?.status ?? connection?.syncStatus

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Workspace overview"
        title="Keep your CRM in sync."
        description="Monitor your HubSpot connection, import contacts, and keep every customer note connected to the right record."
        action={<Button icon={RefreshCw} variant="secondary" onClick={onSync} disabled={syncLoading || !connection?.connected}>{syncLoading ? 'Sync in progress' : 'Run sync now'}</Button>}
      />

      <section className="overview-hero">
        <div>
          <div className="hero-kicker"><Sparkles /> CRM control center</div>
          <h2>A clearer view of every customer relationship.</h2>
          <p>HubSync gives your team one calm place to inspect real backend state, synchronize contacts, and add notes that follow the customer record.</p>
          <div className="hero-actions">
            {connection?.connected ? <Button icon={CloudDownload} variant="primary" size="lg" onClick={onSync} disabled={syncLoading}>{syncLoading ? 'Syncing contacts…' : 'Sync contacts'}</Button> : <Button icon={ExternalLink} variant="primary" size="lg" onClick={onConnect}>Connect HubSpot</Button>}
            <Button icon={Users} variant="secondary" size="lg" onClick={onContacts}>Browse contacts</Button>
          </div>
        </div>
        <div className="hero-summary">
          <div className="hero-summary__heading"><span>Connection health</span><span>{connection?.connected ? 'Live' : 'Action needed'}</span></div>
          <div className="hero-summary__value">{connectionLoading ? 'Checking…' : connection?.connected ? 'HubSpot connected' : 'Not connected'}</div>
          <div className="hero-summary__meta">{connection?.portalId ? `Portal ${connection.portalId}` : 'Connect an account to unlock sync workflows.'}</div>
          <div className="mt-5 flex items-center justify-between border-t border-white/10 pt-4 text-[11px] text-indigo-100">
            <span>Last sync</span>
            <span>{connection?.lastSyncAt ? formatDate(connection.lastSyncAt) : 'No completed run'}</span>
          </div>
        </div>
      </section>

      <section className="metric-grid">
        <MetricCard icon={Users} label="Contacts stored" value={contactsTotal.toLocaleString()} detail="Local records from HubSpot" tone="indigo" />
        <MetricCard icon={ShieldCheck} label="Connection" value={connectionLoading ? 'Checking…' : connection?.connected ? 'Connected' : 'Needs setup'} detail={connection?.portalId ? `Portal ${connection.portalId}` : 'OAuth connection required'} tone={connection?.connected ? 'green' : 'amber'} />
        <MetricCard icon={Activity} label="Sync status" value={statusLabel(currentStatus)} detail={syncJob?.completedAt ? formatDate(syncJob.completedAt) : 'Ready for your next run'} tone="amber" />
        <MetricCard icon={HeartPulse} label="Backend health" value={health ? 'Operational' : 'Unavailable'} detail={health?.message ?? 'Check the API status page'} tone={health ? 'blue' : 'amber'} />
      </section>

      {syncError ? <div className="mt-5"><AlertBanner type="error" text={syncError} onClose={onDismissSyncError} /></div> : null}

      <section className="overview-grid">
        <SyncActivityPanel job={syncJob} start={syncStart} loading={syncLoading} />
        <WorkspacePanel
          connection={connection}
          onConnect={onConnect}
          onContacts={onContacts}
          onConnection={onConnection}
          onStatus={onStatus}
        />
      </section>
    </div>
  )
}

function MetricCard({ icon: Icon, label, value, detail, tone }: { icon: LucideIcon; label: string; value: string; detail: string; tone: 'green' | 'indigo' | 'amber' | 'blue' }) {
  return (
    <div className="surface-card metric-card">
      <div className="metric-card__top">
        <span className={`metric-card__icon metric-card__icon--${tone}`}><Icon /></span>
      </div>
      <div className="metric-card__value">{value}</div>
      <div className="metric-card__label">{label}</div>
      <div className="metric-card__detail">{detail}</div>
    </div>
  )
}

function SyncActivityPanel({ job, start, loading }: { job: SyncJob | null; start: SyncEnqueueResponse | null; loading: boolean }) {
  const status = job?.status ?? start?.status
  const isActive = loading || status === 'QUEUED' || status === 'RUNNING'
  const isCompleted = status === 'COMPLETED'
  const hasRun = Boolean(job || start || loading)
  return (
    <section className="surface-card panel">
      <div className="panel-heading">
        <div>
          <div className="panel-heading__eyebrow">Live activity</div>
          <h3>Contact synchronization</h3>
          <p>Track the latest background job without leaving the workspace.</p>
        </div>
        <div className="panel-heading__icon"><Zap /></div>
      </div>
      {hasRun ? (
        <div className="progress-card">
          <div className="progress-card__row">
            <span className="progress-card__label">{status === 'COMPLETED' ? 'Latest run completed' : 'Pipeline stage'}</span>
            <span className="progress-card__value">{statusLabel(status)}</span>
          </div>
          {isActive || isCompleted ? (
            <div className="progress-track" aria-label={isCompleted ? 'Synchronization completed' : 'Synchronization in progress'}>
              <div className={`progress-track__bar ${isActive ? 'progress-track__bar--indeterminate' : ''}`} style={isCompleted ? { width: '100%' } : undefined} />
            </div>
          ) : null}
          <div className="progress-stats">
            <ProgressStat label="Processed" value={job?.processed ?? 0} />
            <ProgressStat label="Created" value={job?.createdCount ?? 0} />
            <ProgressStat label="Updated" value={job?.updatedCount ?? 0} />
          </div>
          {job?.error ? <div className="mt-4 text-xs font-bold text-rose-600">{job.error}</div> : null}
        </div>
      ) : (
        <div className="empty-state min-h-0 px-0 pb-2 pt-10">
          <div className="empty-state__icon"><CloudDownload /></div>
          <h3>No sync activity yet</h3>
          <p>Run a contact sync to see real-time processing and result counters here.</p>
        </div>
      )}
      {job ? <div className="activity-list"><ActivityItem icon={CheckCircle2} title={`Job ${statusLabel(job.status)}`} meta={job.completedAt ? formatDate(job.completedAt) : 'Running now'} /><ActivityItem icon={Database} title={`${job.processed.toLocaleString()} records processed`} meta={`${job.createdCount} created · ${job.updatedCount} updated · ${job.failedCount} failed`} /></div> : null}
    </section>
  )
}

function ProgressStat({ label, value }: { label: string; value: number }) {
  return <div><div className="progress-stat__label">{label}</div><div className="progress-stat__value">{value.toLocaleString()}</div></div>
}

function ActivityItem({ icon: Icon, title, meta }: { icon: LucideIcon; title: string; meta: string }) {
  return <div className="activity-item"><div className="activity-item__icon"><Icon /></div><div><div className="activity-item__title">{title}</div><div className="activity-item__meta">{meta}</div></div></div>
}

function WorkspacePanel({ connection, onConnect, onContacts, onConnection, onStatus }: { connection: HubspotStatus | null; onConnect: () => void; onContacts: () => void; onConnection: () => void; onStatus: () => void }) {
  return (
    <section className="surface-card panel">
      <div className="panel-heading">
        <div><div className="panel-heading__eyebrow">Workspace shortcuts</div><h3>What do you want to do?</h3><p>Jump directly into the next useful action.</p></div>
        <div className="panel-heading__icon"><Command /></div>
      </div>
      <div className="mt-5 grid gap-2.5">
        <QuickAction icon={Users} title="Inspect contacts" description="Search records and add notes" onClick={onContacts} />
        <QuickAction icon={Link2} title={connection?.connected ? 'Review connection' : 'Connect HubSpot'} description={connection?.connected ? 'Check portal and sync state' : 'Authorize your CRM workspace'} onClick={connection?.connected ? onConnection : onConnect} />
        <QuickAction icon={HelpCircle} title="Need a health check?" description="Open API diagnostics" onClick={onStatus} />
      </div>
    </section>
  )
}

function QuickAction({ icon: Icon, title, description, onClick }: { icon: LucideIcon; title: string; description: string; onClick: () => void }) {
  return <button className="group flex items-center gap-3 rounded-xl border border-transparent p-3 text-left transition hover:border-indigo-100 hover:bg-indigo-50/60" onClick={onClick}><span className="grid size-9 shrink-0 place-items-center rounded-xl bg-slate-100 text-indigo-600 transition group-hover:bg-white"><Icon className="size-4" /></span><span className="min-w-0"><span className="block text-xs font-extrabold text-slate-700">{title}</span><span className="mt-1 block truncate text-[11px] text-slate-400">{description}</span></span><ArrowUpRight className="ml-auto size-4 text-slate-300 transition group-hover:text-indigo-500" /></button>
}

function ContactsView({
  contacts,
  loading,
  error,
  page,
  pagination,
  searchInput,
  selectedContact,
  notes,
  notesLoading,
  notesError,
  noteBody,
  noteSubmitting,
  noteMessage,
  selectedProperties,
  onSearchChange,
  onPageChange,
  onRefresh,
  onDismissError,
  onSelectContact,
  onCloseDetails,
  onNoteBodyChange,
  onCreateNote,
}: {
  contacts: Contact[]
  loading: boolean
  error: string | null
  page: number
  pagination: ContactsResponse['pagination']
  searchInput: string
  selectedContact: Contact | null
  notes: Note[]
  notesLoading: boolean
  notesError: string | null
  noteBody: string
  noteSubmitting: boolean
  noteMessage: string | null
  selectedProperties: [string, unknown][]
  onSearchChange: (value: string) => void
  onPageChange: (page: number) => void
  onRefresh: () => void
  onDismissError: () => void
  onSelectContact: (contact: Contact) => void
  onCloseDetails: () => void
  onNoteBodyChange: (value: string) => void
  onCreateNote: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <div>
      <PageHeader
        eyebrow="CRM records"
        title="Contacts"
        description="Search, inspect, and annotate the contacts synchronized from your HubSpot portal."
        action={<Button icon={RefreshCw} variant="secondary" onClick={onRefresh}>Refresh records</Button>}
      />

      <div className="surface-card table-card">
        <div className="table-toolbar">
          <div className="search-field"><Search /><input value={searchInput} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search by name or email…" aria-label="Search contacts" /></div>
          <div className="table-count"><strong>{pagination.total.toLocaleString()}</strong> contacts in workspace</div>
        </div>
        {error ? <div className="p-4"><AlertBanner type="error" text={error} onClose={onDismissError} /></div> : null}
        {loading ? <ContactsSkeleton /> : contacts.length === 0 ? <EmptyState icon={Users} title="No contacts found" message={error ?? (searchInput ? 'Try a different search term.' : 'Connect HubSpot and run a contact synchronization to populate this list.')} /> : <ContactsTable contacts={contacts} onSelect={onSelectContact} />}
        {!loading && contacts.length > 0 ? <Pagination page={page} pagination={pagination} onPageChange={onPageChange} /> : null}
      </div>

      {selectedContact ? <ContactDrawer contact={selectedContact} notes={notes} notesLoading={notesLoading} notesError={notesError} noteBody={noteBody} noteSubmitting={noteSubmitting} noteMessage={noteMessage} selectedProperties={selectedProperties} onClose={onCloseDetails} onNoteBodyChange={onNoteBodyChange} onCreateNote={onCreateNote} /> : null}
    </div>
  )
}

function ContactsTable({ contacts, onSelect }: { contacts: Contact[]; onSelect: (contact: Contact) => void }) {
  return (
    <div className="table-scroll">
      <table className="contacts-table">
        <thead><tr><th>Contact</th><th>Email</th><th>HubSpot record</th><th>Updated</th><th aria-label="Open contact" /></tr></thead>
        <tbody>
          {contacts.map((contact, index) => (
            <tr
              key={contact.id}
              tabIndex={0}
              role="button"
              aria-label={`Open ${displayName(contact)}`}
              onClick={() => onSelect(contact)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelect(contact)
                }
              }}
            >
              <td><div className="contact-cell"><div className={`avatar ${index % 3 === 1 ? 'bg-amber-100 text-amber-700' : index % 3 === 2 ? 'bg-emerald-100 text-emerald-700' : ''}`}>{initials(displayName(contact))}</div><div><div className="contact-cell__name">{displayName(contact)}</div><div className="contact-cell__meta">Contact record</div></div></div></td>
              <td>{contact.email ?? <span className="text-slate-300">No email</span>}</td>
              <td><span className="table-link">{contact.hubspotContactId}</span></td>
              <td>{formatDate(contact.updatedAt)}</td>
              <td><ChevronRight className="size-4 text-slate-300" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ContactsSkeleton() {
  return <div className="space-y-3 p-5">{Array.from({ length: 6 }).map((_, index) => <div key={index} className="skeleton h-12" />)}</div>
}

function EmptyState({ icon: Icon, title, message, action }: { icon: LucideIcon; title: string; message: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-state__icon"><Icon /></div><h3>{title}</h3><p>{message}</p>{action ? <div className="mt-5">{action}</div> : null}</div>
}

function Pagination({ page, pagination, onPageChange }: { page: number; pagination: ContactsResponse['pagination']; onPageChange: (page: number) => void }) {
  return <div className="pagination"><span className="pagination__label">Page {page} of {Math.max(pagination.totalPages, 1)}</span><div className="pagination__actions"><button className="icon-button" disabled={page <= 1} onClick={() => onPageChange(page - 1)} aria-label="Previous page"><ChevronLeft /></button><button className="icon-button" disabled={page >= pagination.totalPages} onClick={() => onPageChange(page + 1)} aria-label="Next page"><ChevronRight /></button></div></div>
}

function ContactDrawer({
  contact,
  notes,
  notesLoading,
  notesError,
  noteBody,
  noteSubmitting,
  noteMessage,
  selectedProperties,
  onClose,
  onNoteBodyChange,
  onCreateNote,
}: {
  contact: Contact
  notes: Note[]
  notesLoading: boolean
  notesError: string | null
  noteBody: string
  noteSubmitting: boolean
  noteMessage: string | null
  selectedProperties: [string, unknown][]
  onClose: () => void
  onNoteBodyChange: (value: string) => void
  onCreateNote: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <section className="drawer" onClick={(event) => event.stopPropagation()}>
        <div className="drawer__header">
          <div><div className="drawer__eyebrow">Contact detail</div><h2>{displayName(contact)}</h2><div className="drawer__email">{contact.email ?? 'No email available'}</div></div>
          <button className="icon-button" onClick={onClose} aria-label="Close contact details"><X /></button>
        </div>

        <div className="drawer-section">
          <div className="drawer-section__heading"><h3>Contact properties</h3><span className="drawer-section__count">HubSpot record</span></div>
          <div className="properties-list">
            {selectedProperties.length ? selectedProperties.map(([key, value]) => <div className="property-row" key={key}><span className="property-row__key">{key}</span><span className="property-row__value">{String(value)}</span></div>) : <div className="p-4 text-xs text-slate-400">No additional properties returned.</div>}
          </div>
        </div>

        <div className="drawer-section">
          <div className="drawer-section__heading"><h3>Notes</h3><span className="drawer-section__count">{notes.length} local</span></div>
          <NoteComposer noteBody={noteBody} submitting={noteSubmitting} message={noteMessage} error={notesError} onBodyChange={onNoteBodyChange} onSubmit={onCreateNote} />
          <div className="notes-list">{notesLoading ? <div className="skeleton h-24" /> : notes.length ? notes.map((note) => <NoteCard key={note.id} note={note} />) : <div className="rounded-xl border border-dashed border-slate-200 p-5 text-center text-xs text-slate-400">No notes yet. Add the first customer touchpoint above.</div>}</div>
        </div>
      </section>
    </div>
  )
}

function NoteComposer({ noteBody, submitting, message, error, onBodyChange, onSubmit }: { noteBody: string; submitting: boolean; message: string | null; error: string | null; onBodyChange: (value: string) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return (
    <form className="note-composer" onSubmit={onSubmit}>
      <textarea value={noteBody} onChange={(event) => onBodyChange(event.target.value)} maxLength={65536} placeholder="Write a note for this contact…" aria-label="Note body" />
      <div className="note-composer__footer"><span className="note-composer__hint">Saved locally first, then synced to HubSpot.</span><Button type="submit" icon={submitting ? Loader2 : FileText} variant="dark" size="md" disabled={submitting || !noteBody.trim()}>{submitting ? 'Saving…' : 'Save note'}</Button></div>
      {message ? <div className="mt-2 text-[11px] font-bold text-emerald-600">{message}</div> : null}
      {error ? <div className="mt-2 text-[11px] font-bold text-rose-600">{error}</div> : null}
    </form>
  )
}

function NoteCard({ note }: { note: Note }) {
  return <article className="note-card"><div className="note-card__top"><p className="note-card__body">{note.body}</p><StatusBadge status={note.syncStatus} /></div><div className="note-card__meta"><span>{formatDate(note.createdAt)}</span>{note.hubspotNoteId ? <span>HubSpot ID {note.hubspotNoteId}</span> : null}{note.lastSyncError ? <span className="note-card__error">{note.lastSyncError}</span> : null}</div></article>
}

function NotesView({ contacts, selectedContact, notes, loading, error, noteBody, noteSubmitting, noteMessage, onSelectContact, onNoteBodyChange, onCreateNote, onContacts }: { contacts: Contact[]; selectedContact: Contact | null; notes: Note[]; loading: boolean; error: string | null; noteBody: string; noteSubmitting: boolean; noteMessage: string | null; onSelectContact: (contact: Contact) => void; onNoteBodyChange: (value: string) => void; onCreateNote: (event: FormEvent<HTMLFormElement>) => void; onContacts: () => void }) {
  return (
    <div>
      <PageHeader eyebrow="Customer activity" title="Notes" description="Capture context once and keep it attached to the official HubSpot contact record." action={<Button icon={Users} variant="secondary" onClick={onContacts}>Choose a contact</Button>} />
      {selectedContact ? <div className="notes-layout"><section className="surface-card selected-contact-card"><div className="selected-contact-card__avatar">{initials(displayName(selectedContact))}</div><div><h2>{displayName(selectedContact)}</h2><p>{selectedContact.email ?? 'No email available'}</p></div><div className="selected-contact-card__stat"><div className="selected-contact-card__stat-label">Notes on this contact</div><div className="selected-contact-card__stat-value">{notes.length}</div></div><Button className="mt-4 w-full" icon={ArrowLeft} variant="ghost" onClick={onContacts}>Back to contacts</Button></section><section className="surface-card panel"><div className="panel-heading"><div><div className="panel-heading__eyebrow">Contact timeline</div><h3>Add context that stays useful.</h3><p>Every note is saved locally and queued for HubSpot synchronization.</p></div><div className="panel-heading__icon"><MessageSquareText /></div></div><NoteComposer noteBody={noteBody} submitting={noteSubmitting} message={noteMessage} error={error} onBodyChange={onNoteBodyChange} onSubmit={onCreateNote} /><div className="notes-list">{loading ? <div className="skeleton h-28" /> : notes.length ? notes.map((note) => <NoteCard key={note.id} note={note} />) : <EmptyState icon={FileText} title="No notes for this contact" message="Start the timeline with a concise call summary, follow-up, or customer insight." />}</div></section></div> : <ContactPicker contacts={contacts} onSelect={onSelectContact} />}
    </div>
  )
}

function ContactPicker({ contacts, onSelect }: { contacts: Contact[]; onSelect: (contact: Contact) => void }) {
  return <section className="surface-card panel"><div className="panel-heading"><div><div className="panel-heading__eyebrow">Choose a contact</div><h3>Start from a customer record</h3><p>Select a contact to view or create notes.</p></div><div className="panel-heading__icon"><Users /></div></div>{contacts.length ? <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{contacts.slice(0, 9).map((contact) => <button key={contact.id} className="flex items-center gap-3 rounded-xl border border-slate-200 p-3 text-left transition hover:border-indigo-200 hover:bg-indigo-50/50" onClick={() => onSelect(contact)}><div className="avatar avatar--small">{initials(displayName(contact))}</div><div className="min-w-0"><div className="truncate text-xs font-extrabold text-slate-700">{displayName(contact)}</div><div className="mt-1 truncate text-[11px] text-slate-400">{contact.email ?? 'No email'}</div></div></button>)}</div> : <EmptyState icon={Users} title="No contacts available" message="Run a HubSpot contact sync before creating notes." />}</section>
}

function ConnectionView({ connection, loading, onConnect, onRefresh }: { connection: HubspotStatus | null; loading: boolean; onConnect: () => void; onRefresh: () => void }) {
  const connected = Boolean(connection?.connected)
  return (
    <div>
      <PageHeader eyebrow="Integration" title="HubSpot connection" description="Keep your OAuth connection visible, secure, and ready for contact and note synchronization." action={<Button icon={RefreshCw} variant="secondary" onClick={onRefresh}>Refresh status</Button>} />
      <section className="surface-card connection-card"><div className="connection-card__identity"><div className={`connection-card__icon ${connected ? '' : 'connection-card__icon--off'}`}><ShieldCheck /></div><div><StatusBadge status={loading ? 'RUNNING' : connected ? 'COMPLETED' : 'FAILED'} /><h2>{loading ? 'Checking connection…' : connected ? 'HubSpot is connected' : 'Connect your HubSpot portal'}</h2><p>{connected ? `Portal ${connection?.portalId ?? '—'} is authorized for this workspace.` : 'Authorize HubSync to begin importing contacts and syncing notes.'}</p></div></div><div className="connection-card__actions">{!connected ? <Button icon={ExternalLink} variant="primary" onClick={onConnect}>Connect HubSpot</Button> : <Button icon={Check} variant="secondary" disabled>Authorized</Button>}</div></section>
      <div className="info-grid"><InfoCard label="Portal" value={connection?.portalId ?? 'Not connected'} detail="HubSpot account identifier" /><InfoCard label="Sync state" value={statusLabel(connection?.syncStatus)} detail={connection?.lastSyncAt ? `Last sync ${formatDate(connection.lastSyncAt)}` : 'No completed contact sync yet'} /><InfoCard label="Data flow" value="Contacts + notes" detail="Notes are associated with the official contact record" /></div>
      <section className="surface-card panel mt-5"><div className="panel-heading"><div><div className="panel-heading__eyebrow">How the connection works</div><h3>Secure by default</h3><p>OAuth tokens stay on the backend and are never returned to the browser.</p></div><div className="panel-heading__icon"><ShieldCheck /></div></div><div className="mt-5 grid gap-3 md:grid-cols-3"><FeatureRow icon={KeyIcon} label="Encrypted tokens" detail="Stored securely by the backend" available /><FeatureRow icon={Users} label="Contact sync" detail="Pulls records from HubSpot" available /><FeatureRow icon={MessageSquareText} label="Official notes" detail="Associates notes to contacts" available /></div></section>
    </div>
  )
}

function KeyIcon(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><circle cx="7.5" cy="15.5" r="5.5" /><path d="m21 2-9.6 9.6M15 5l4 4M18 2l4 4" /></svg>
}

function InfoCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="surface-card info-card"><div className="info-card__label">{label}</div><div className="info-card__value">{value}</div><div className="info-card__detail">{detail}</div></div>
}

function FeatureRow({ icon: Icon, label, detail, available }: { icon: LucideIcon | typeof KeyIcon; label: string; detail: string; available: boolean }) {
  return <div className="flex items-start gap-3 rounded-xl border border-slate-100 bg-slate-50/80 p-3"><div className={`grid size-8 shrink-0 place-items-center rounded-lg ${available ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-200 text-slate-400'}`}>{available ? <Icon className="size-4" /> : <XCircle className="size-4" />}</div><div><div className="text-xs font-extrabold text-slate-700">{label}</div><div className="mt-1 text-[11px] leading-4 text-slate-400">{detail}</div></div></div>
}

function StatusView({ health, connection, onRefresh }: { health: { message: string } | null; connection: HubspotStatus | null; onRefresh: () => void }) {
  return <div><PageHeader eyebrow="Diagnostics" title="API status" description="A quick, honest view of the services powering this workspace." action={<Button icon={RefreshCw} variant="secondary" onClick={onRefresh}>Run checks</Button>} /><div className="status-grid"><StatusPanel icon={HeartPulse} label="Backend health" ok={Boolean(health)} value={health?.message ?? 'Backend unavailable'} /><StatusPanel icon={Server} label="HubSpot connection" ok={Boolean(connection?.connected)} value={connection?.connected ? `Connected to portal ${connection.portalId ?? '—'}` : 'Disconnected'} /><StatusPanel icon={Activity} label="Synchronization" ok={Boolean(connection?.syncStatus && ['IDLE', 'COMPLETED'].includes(connection.syncStatus))} value={connection?.syncStatus ? statusLabel(connection.syncStatus) : 'Unavailable'} /><StatusPanel icon={Database} label="API base URL" ok value={getApiBaseUrl()} /></div><section className="surface-card panel mt-5"><div className="panel-heading"><div><div className="panel-heading__eyebrow">Operational notes</div><h3>Know what the status means.</h3><p>These checks reflect the actual backend response, not simulated UI state.</p></div><div className="panel-heading__icon"><Activity /></div></div><div className="mt-5 grid gap-3 md:grid-cols-3"><InfoCard label="Healthy" value="Ready" detail="The API responds to health checks." /><InfoCard label="Syncing" value="In progress" detail="A background worker is processing records." /><InfoCard label="Action needed" value="Reconnect" detail="OAuth authorization must be restored." /></div></section></div>
}

function StatusPanel({ icon: Icon, label, ok, value }: { icon: LucideIcon; label: string; ok: boolean; value: string }) {
  return <div className="surface-card status-panel"><div className="status-panel__top"><div className="status-panel__label"><Icon />{label}</div><span className={`status-dot ${ok ? 'status-dot--online' : ''}`} /></div><div className="status-panel__value">{value}</div></div>
}

export default App
