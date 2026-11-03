import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Archive,
  CheckSquare,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Download,
  Eye,
  Film,
  ImagePlus,
  Images,
  LockKeyhole,
  Menu,
  MoreHorizontal,
  Play,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Star,
  Upload,
  X,
  Zap,
} from 'lucide-react'
import { createMediaItem } from './media'
import { disconnectTelegram, getTelegramStatus, listMedia, mediaUrl, retryMedia, startTelegramAuth, uploadMedia, verifyTelegramAuth } from './api'
import type { ApiMedia, TelegramAuthResponse, TelegramStatus } from './api'
import type { MediaItem, MediaType, UploadStatus } from './types'

type Filter = 'all' | MediaType

const filters: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All media' },
  { value: 'photo', label: 'Photos' },
  { value: 'video', label: 'Videos' },
]

function formatDateHeading(date: Date): string {
  const today = new Date()
  const day = new Date(date)
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
  const difference = Math.round((todayStart - dayStart) / 86_400_000)

  if (difference === 0) return 'Today'
  if (difference === 1) return 'Yesterday'

  return date.toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatSize(size: number): string {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function formatDuration(seconds?: number): string | undefined {
  if (seconds === undefined) return undefined
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.floor(seconds % 60)
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
}

function itemFromApi(media: ApiMedia): MediaItem {
  return {
    id: media.id,
    name: media.name,
    type: media.type,
    url: mediaUrl(media.preview_url),
    telegramUrl: media.telegram_url ? mediaUrl(media.telegram_url) : undefined,
    downloadUrl: media.telegram_download_url ? mediaUrl(media.telegram_download_url) : undefined,
    size: media.size,
    capturedAt: new Date(media.captured_at),
    sourceLabel: media.source_label,
    width: media.width,
    height: media.height,
    duration: media.duration,
    uploadStatus: media.upload_status,
    uploadError: media.upload_error,
    telegramMessageId: media.telegram_message_id,
  }
}

function statusLabel(status: UploadStatus): string {
  if (status === 'uploaded') return 'Backed up'
  if (status === 'uploading') return 'Uploading'
  if (status === 'waiting_for_telegram') return 'Waiting for Telegram'
  if (status === 'failed') return 'Retry needed'
  if (status === 'local') return 'Local only'
  return 'Queued'
}

function App() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [items, setItems] = useState<MediaItem[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [sortDirection, setSortDirection] = useState<'desc' | 'asc'>('desc')
  const [query, setQuery] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [isTelegramOpen, setIsTelegramOpen] = useState(false)
  const [viewingItem, setViewingItem] = useState<MediaItem | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [notice, setNotice] = useState('')
  const [telegramStatus, setTelegramStatus] = useState<TelegramStatus>({
    configured: false,
    connected: false,
    display_name: null,
    username: null,
  })

  async function refreshLibrary(showError = true) {
    try {
      const [savedMedia, savedTelegramStatus] = await Promise.all([listMedia(), getTelegramStatus()])
      setItems(savedMedia.map(itemFromApi))
      setTelegramStatus(savedTelegramStatus)
    } catch (error) {
      if (showError) setNotice(error instanceof Error ? error.message : 'The local service is not available yet.')
    }
  }

  useEffect(() => {
    void refreshLibrary()
  }, [])

  useEffect(() => {
    const hasActiveUploads = items.some((item) => ['queued', 'waiting_for_telegram', 'uploading'].includes(item.uploadStatus))
    if (!hasActiveUploads) return undefined

    const timer = window.setInterval(() => {
      void refreshLibrary(false)
    }, 2500)
    return () => window.clearInterval(timer)
  }, [items])

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()

    return items
      .filter((item) => filter === 'all' || item.type === filter)
      .filter((item) => !normalizedQuery || item.name.toLowerCase().includes(normalizedQuery))
      .sort((first, second) => sortDirection === 'desc'
        ? second.capturedAt.getTime() - first.capturedAt.getTime()
        : first.capturedAt.getTime() - second.capturedAt.getTime())
  }, [filter, items, query, sortDirection])

  const groupedItems = useMemo(() => {
    const groups = new Map<string, { label: string; date: Date; items: MediaItem[] }>()

    filteredItems.forEach((item) => {
      const key = dateKey(item.capturedAt)
      const group = groups.get(key)
      if (group) {
        group.items.push(item)
      } else {
        groups.set(key, {
          label: formatDateHeading(item.capturedAt),
          date: item.capturedAt,
          items: [item],
        })
      }
    })

    return Array.from(groups.values()).sort((first, second) => sortDirection === 'desc'
      ? second.date.getTime() - first.date.getTime()
      : first.date.getTime() - second.date.getTime())
  }, [filteredItems, sortDirection])

  const totalSize = items.reduce((total, item) => total + item.size, 0)
  const photoCount = items.filter((item) => item.type === 'photo').length
  const videoCount = items.filter((item) => item.type === 'video').length
  const selectedItems = items.filter((item) => selectedIds.has(item.id))

  async function addFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList)
    const createdItems = await Promise.all(files.map((file) => createMediaItem(file)))
    const validItems = createdItems.filter((item): item is MediaItem => Boolean(item))

    if (validItems.length === 0) {
      setNotice('Choose image or video files to add them to your timeline.')
      return
    }

    setItems((current) => [...current, ...validItems])
    setNotice(`${validItems.length} ${validItems.length === 1 ? 'item' : 'items'} added. Preparing a private backup…`)
    validItems.forEach((item) => void syncItem(item))
  }

  async function syncItem(item: MediaItem) {
    setItems((current) => current.map((currentItem) => currentItem.id === item.id ? { ...currentItem, uploadStatus: 'queued' } : currentItem))
    try {
      const saved = await uploadMedia(item)
      if (item.url.startsWith('blob:')) URL.revokeObjectURL(item.url)
      setItems((current) => current.map((currentItem) => currentItem.id === item.id ? itemFromApi(saved) : currentItem))
    } catch (error) {
      setItems((current) => current.map((currentItem) => currentItem.id === item.id ? {
        ...currentItem,
        uploadStatus: 'local',
        uploadError: error instanceof Error ? error.message : 'The backup service is unavailable.',
      } : currentItem))
      setNotice('The media is visible locally, but the backup service could not be reached. You can try again after starting the backend.')
    }
  }

  async function handleRetry(item: MediaItem) {
    if (item.uploadStatus === 'local') {
      await syncItem(item)
      return
    }
    try {
      setItems((current) => current.map((currentItem) => currentItem.id === item.id ? { ...currentItem, uploadStatus: 'queued', uploadError: undefined } : currentItem))
      const saved = await retryMedia(item.id)
      setItems((current) => current.map((currentItem) => currentItem.id === item.id ? itemFromApi(saved) : currentItem))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'This item could not be queued again.')
    }
  }

  async function handleTelegramConnected() {
    const status = await getTelegramStatus()
    setTelegramStatus(status)
    setIsTelegramOpen(false)
    setNotice(status.display_name ? `Telegram connected as ${status.display_name}. Waiting media will upload now.` : 'Telegram connected. Waiting media will upload now.')
    void refreshLibrary(false)
  }

  async function handleTelegramDisconnected() {
    const status = await getTelegramStatus()
    setTelegramStatus(status)
    setIsTelegramOpen(false)
    setNotice('Telegram disconnected. New media will stay queued until you connect again.')
    void refreshLibrary(false)
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) void addFiles(event.target.files)
    event.target.value = ''
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setIsDragging(false)
    if (event.dataTransfer.files.length > 0) void addFiles(event.dataTransfer.files)
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function clearSelection() {
    setSelectedIds(new Set())
  }

  function downloadSelected() {
    selectedItems.filter((item) => item.downloadUrl).forEach((item, index) => {
      window.setTimeout(() => {
        const anchor = document.createElement('a')
        anchor.href = item.downloadUrl!
        anchor.download = item.name
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
      }, index * 250)
    })
    setNotice(`${selectedItems.filter((item) => item.downloadUrl).length} original ${selectedItems.length === 1 ? 'file' : 'files'} queued for download.`)
    clearSelection()
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Images size={18} strokeWidth={2.5} /></div>
          <span>infinityvault</span>
        </div>

        <div className="sidebar-section">
          <p className="eyebrow">Library</p>
          <button className="nav-item active" type="button">
            <Images size={18} />
            <span>Photos</span>
            <span className="nav-count">{items.length}</span>
          </button>
          <button className="nav-item" type="button" onClick={() => setFilter('photo')}>
            <ImagePlus size={18} />
            <span>All photos</span>
            <span className="nav-count">{photoCount}</span>
          </button>
          <button className="nav-item" type="button" onClick={() => setFilter('video')}>
            <Film size={18} />
            <span>Videos</span>
            <span className="nav-count">{videoCount}</span>
          </button>
          <button className="nav-item" type="button" onClick={() => setNotice('Albums are coming soon. Your timeline remains sorted by capture time.') }>
            <Archive size={18} />
            <span>Albums</span>
          </button>
          <button className="nav-item" type="button" onClick={() => setNotice('Favorites are coming soon. You can still search and filter your library.') }>
            <Star size={18} />
            <span>Favorites</span>
          </button>
        </div>

        <div className="sidebar-section sidebar-bottom">
          <p className="eyebrow">Backup</p>
          <div className="telegram-status">
            <div className="status-icon"><Send size={17} /></div>
            <div>
              <strong>Telegram</strong>
              <span className="status-copy"><i className={telegramStatus.connected ? 'status-dot connected' : 'status-dot'} /> {telegramStatus.connected ? 'Connected' : telegramStatus.configured ? 'Ready to connect' : 'Setup needed'}</span>
            </div>
            <button className="icon-button subtle" type="button" aria-label="Open Telegram setup" onClick={() => setIsTelegramOpen(true)}>
              <Settings2 size={16} />
            </button>
          </div>
          <button className="connect-button" type="button" onClick={() => setIsTelegramOpen(true)}>
            <Send size={16} />
            Connect Telegram
          </button>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <button className="mobile-menu icon-button" type="button" aria-label="Open menu"><Menu size={19} /></button>
          <div className="topbar-title">
            <span className="overline">InfinityVault</span>
            <h1>{filter === 'video' ? 'Videos' : filter === 'photo' ? 'Photos' : 'Your photos'}</h1>
          </div>
          <div className="topbar-actions">
            <label className="search-field">
              <Search size={17} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search files" />
            </label>
            <button className="upload-button" type="button" onClick={() => fileInputRef.current?.click()}>
              <Upload size={17} />
              <span>Add photos & videos</span>
            </button>
            <input ref={fileInputRef} className="hidden-input" type="file" accept="image/*,video/*" multiple onChange={handleFileChange} />
          </div>
        </header>

        <div className="content-wrap">
          <section className="welcome-row">
            <div>
              <p className="section-kicker"><span className="live-dot" /> Private library</p>
              <h2>Your memories, beautifully organized.</h2>
              <p className="section-description">Browse every photo and video by the moment it was captured. InfinityVault keeps the original files safe in your Telegram Saved Messages.</p>
            </div>
            <div className="privacy-badge"><LockKeyhole size={16} /> Private by design</div>
          </section>

          <section className="stats-grid" aria-label="Library summary">
            <div className="stat-card">
              <div className="stat-icon lavender"><Images size={18} /></div>
              <div><span>Total memories</span><strong>{items.length}</strong></div>
              <small>{photoCount} photos · {videoCount} videos</small>
            </div>
            <div className="stat-card">
              <div className="stat-icon peach"><Cloud size={18} /></div>
              <div><span>Library size</span><strong>{formatSize(totalSize)}</strong></div>
              <small>Original files and previews</small>
            </div>
            <div className="stat-card backup-card">
              <div className="stat-icon mint"><ShieldCheck size={18} /></div>
              <div><span>Backup</span><strong>{telegramStatus.connected ? 'Protected' : 'Not connected'}</strong></div>
              <small>{telegramStatus.connected ? `Telegram · ${telegramStatus.display_name}` : 'Connect Telegram to protect your files'}</small>
            </div>
          </section>

          <div className={selectedIds.size > 0 ? 'toolbar selection-toolbar' : 'toolbar'}>
            <div className="filter-tabs" role="tablist" aria-label="Media filters">
              {filters.map((option) => (
                <button key={option.value} type="button" className={filter === option.value ? 'filter-tab selected' : 'filter-tab'} onClick={() => setFilter(option.value)}>
                  {option.label}
                  {option.value === 'all' && <span>{items.length}</span>}
                </button>
              ))}
            </div>
            {selectedIds.size > 0 ? (
              <div className="selection-actions">
                <strong>{selectedIds.size} selected</strong>
                <button type="button" onClick={downloadSelected} disabled={!selectedItems.some((item) => item.downloadUrl)}><Download size={15} /> Download</button>
                <button type="button" onClick={clearSelection}>Clear</button>
              </div>
            ) : (
              <button className="sort-button" type="button" onClick={() => setSortDirection((current) => current === 'desc' ? 'asc' : 'desc')}><span>{sortDirection === 'desc' ? 'Newest first' : 'Oldest first'}</span><ChevronDown size={15} /></button>
            )}
          </div>

          {notice && (
            <div className="notice" role="status">
              <Check size={16} />
              <span>{notice}</span>
              <button className="notice-close" type="button" aria-label="Dismiss notice" onClick={() => setNotice('')}><X size={15} /></button>
            </div>
          )}

          <div className={isDragging ? 'drop-zone dragging' : 'drop-zone'} onDragOver={(event) => { event.preventDefault(); setIsDragging(true) }} onDragLeave={() => setIsDragging(false)} onDrop={handleDrop}>
            {groupedItems.length > 0 ? groupedItems.map((group) => (
              <section className="date-group" key={dateKey(group.date)}>
                <div className="date-heading"><h3>{group.label}</h3><span>{group.items.length} {group.items.length === 1 ? 'item' : 'items'}</span></div>
                <div className="media-grid">
                  {group.items.map((item) => <MediaCard key={item.id} item={item} selected={selectedIds.has(item.id)} onSelect={() => toggleSelected(item.id)} onRetry={handleRetry} onConnect={() => setIsTelegramOpen(true)} onView={setViewingItem} />)}
                </div>
              </section>
            )) : (
              <EmptyState onUpload={() => fileInputRef.current?.click()} />
            )}
          </div>
        </div>
      </main>

      {isTelegramOpen && <TelegramModal status={telegramStatus} onConnected={handleTelegramConnected} onDisconnected={handleTelegramDisconnected} onClose={() => setIsTelegramOpen(false)} />}
      {viewingItem && <MediaViewer item={viewingItem} items={filteredItems} onChange={setViewingItem} onClose={() => setViewingItem(null)} />}
    </div>
  )
}

function MediaCard({ item, selected, onSelect, onRetry, onConnect, onView }: { item: MediaItem; selected: boolean; onSelect: () => void; onRetry: (item: MediaItem) => void; onConnect: () => void; onView: (item: MediaItem) => void }) {
  const statusIcon = item.uploadStatus === 'uploaded'
    ? <Check size={12} />
    : item.uploadStatus === 'failed'
      ? <AlertCircle size={12} />
      : item.uploadStatus === 'waiting_for_telegram'
        ? <Send size={12} />
        : <Cloud size={12} />

  return (
    <article className={selected ? 'media-card selected' : 'media-card'}>
      <div className="media-preview" onClick={() => item.uploadStatus === 'uploaded' && item.telegramUrl ? onView(item) : undefined}>
        {item.type === 'photo' ? <img src={item.url} alt={item.name} /> : <video src={item.url} muted playsInline preload="metadata" />}
        {item.type === 'video' && <div className="video-overlay"><Play size={15} fill="currentColor" /></div>}
        {item.type === 'video' && item.duration !== undefined && <span className="duration-chip">{formatDuration(item.duration)}</span>}
        <span className={`backup-chip status-${item.uploadStatus}`}>{statusIcon} {statusLabel(item.uploadStatus)}</span>
        <button className={selected ? 'select-button selected' : 'select-button'} type="button" aria-label={selected ? `Deselect ${item.name}` : `Select ${item.name}`} onClick={(event) => { event.stopPropagation(); onSelect() }}>
          {selected && <Check size={14} strokeWidth={3} />}
        </button>
        {item.uploadStatus === 'uploaded' && item.telegramUrl && <button className="view-button" type="button" onClick={(event) => { event.stopPropagation(); onView(item) }}><Eye size={13} /> View original</button>}
      </div>
      <div className="media-meta">
        <div><strong>{formatTime(item.capturedAt)}</strong><span>{item.name}</span></div>
        <span className="media-size">{formatSize(item.size)}</span>
      </div>
      <div className="capture-source"><span className="source-dot" />{item.sourceLabel}</div>
      {item.uploadStatus === 'failed' && <button className="media-action" type="button" onClick={() => onRetry(item)}><RefreshCw size={12} /> Retry backup</button>}
      {item.uploadStatus === 'local' && item.file && <button className="media-action" type="button" onClick={() => void onRetry(item)}><RefreshCw size={12} /> Try backup again</button>}
      {item.uploadStatus === 'waiting_for_telegram' && <button className="media-action" type="button" onClick={onConnect}><Send size={12} /> Connect Telegram</button>}
      {item.uploadError && <p className="media-error" title={item.uploadError}>{item.uploadError}</p>}
    </article>
  )
}

function EmptyState({ onUpload }: { onUpload: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-icon"><ImagePlus size={25} /></div>
      <h3>Your timeline starts here</h3>
      <p>Drop photos and videos here, or choose them from your device gallery. Their original capture times will be used for sorting.</p>
      <button className="empty-upload" type="button" onClick={onUpload}><Upload size={16} /> Choose media</button>
      <span className="empty-hint">JPG, PNG, HEIC, MP4 and more</span>
    </div>
  )
}

function TelegramModal({ status, onConnected, onDisconnected, onClose }: { status: TelegramStatus; onConnected: () => Promise<void>; onDisconnected: () => Promise<void>; onClose: () => void }) {
  const [step, setStep] = useState<'intro' | 'phone' | 'code' | 'password'>('intro')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function beginConnection() {
    setError('')
    if (!phone.trim().startsWith('+')) {
      setError('Enter your phone number with the country code, for example +14155552671.')
      return
    }
    setBusy(true)
    try {
      await startTelegramAuth(phone.trim())
      setStep('code')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Telegram could not send a code.')
    } finally {
      setBusy(false)
    }
  }

  async function finishConnection() {
    setError('')
    if (!code.trim()) {
      setError('Enter the code Telegram sent you.')
      return
    }
    setBusy(true)
    try {
      const response: TelegramAuthResponse = await verifyTelegramAuth(code.trim(), password || undefined)
      if (response.status === 'password_required') {
        setStep('password')
      } else {
        await onConnected()
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Telegram could not verify the code.')
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    setBusy(true)
    setError('')
    try {
      await disconnectTelegram()
      await onDisconnected()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Telegram could not be disconnected.')
    } finally {
      setBusy(false)
    }
  }

  const title = step === 'intro' ? 'Connect your Telegram' : step === 'phone' ? 'Your Telegram number' : step === 'code' ? 'Enter your Telegram code' : 'Enter your Telegram password'

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
      <section className="telegram-modal" role="dialog" aria-modal="true" aria-labelledby="telegram-title">
        <button className="modal-close icon-button" type="button" aria-label="Close Telegram setup" onClick={onClose}><X size={18} /></button>
        <div className="modal-hero"><Send size={25} /></div>
        <p className="section-kicker">Private backup</p>
        <h2 id="telegram-title">{status.connected ? 'Telegram is connected' : title}</h2>

        {status.connected ? (
          <>
            <p className="modal-copy">InfinityVault is connected to <strong>{status.display_name}</strong>{status.username ? ` (@${status.username})` : ''}. New media will be sent to this account’s Saved Messages.</p>
            <div className="setup-note success-note"><Check size={17} /><span>Your encrypted session stays on the backend. Disconnecting removes it from InfinityVault.</span></div>
            <button className="modal-secondary danger-button" type="button" onClick={() => void disconnect()} disabled={busy}>{busy ? 'Disconnecting…' : 'Disconnect Telegram'}</button>
          </>
        ) : !status.configured ? (
          <>
            <p className="modal-copy">Telegram backup needs the app credentials from <strong>my.telegram.org</strong>. Add them to the backend environment before connecting an account.</p>
            <div className="setup-note"><AlertCircle size={17} /><span>Set <code>TELEGRAM_API_ID</code> and <code>TELEGRAM_API_HASH</code> in <code>backend/.env</code>, then restart the backend.</span></div>
            <button className="modal-secondary" type="button" onClick={onClose}>Close setup</button>
          </>
        ) : step === 'intro' ? (
          <>
            <p className="modal-copy">InfinityVault backs up your original files to your own Saved Messages. Telegram will send a one-time sign-in code to your Telegram app or phone.</p>
            <div className="setup-steps">
              <div><span>1</span><p>Enter the phone number connected to Telegram.</p></div>
              <div><span>2</span><p>Enter the one-time code Telegram sends you.</p></div>
              <div><span>3</span><p>InfinityVault uploads queued media privately in the background.</p></div>
            </div>
            <button className="modal-secondary primary-modal-button" type="button" onClick={() => setStep('phone')}>Start secure connection</button>
          </>
        ) : (
          <form className="telegram-form" onSubmit={(event) => { event.preventDefault(); if (step === 'phone') void beginConnection(); else void finishConnection() }}>
            <p className="modal-copy">{step === 'phone' ? 'Use international format. Example: +14155552671.' : step === 'code' ? 'Check your Telegram app first. Codes are often delivered there instead of by SMS.' : 'Your Telegram account has two-step verification enabled. Enter that password to finish connecting.'}</p>
            {step === 'phone' && <label className="modal-label">Phone number<input autoFocus value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+1 415 555 2671" inputMode="tel" /></label>}
            {step === 'code' && <label className="modal-label">Verification code<input autoFocus value={code} onChange={(event) => setCode(event.target.value)} placeholder="12345" inputMode="numeric" autoComplete="one-time-code" /></label>}
            {step === 'password' && <label className="modal-label">Telegram password<input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Your Telegram 2-step password" /></label>}
            {error && <div className="form-error"><AlertCircle size={15} />{error}</div>}
            <div className="form-actions">
              <button className="back-button" type="button" onClick={() => { setError(''); setStep(step === 'phone' ? 'intro' : step === 'code' ? 'phone' : 'code') }}>Back</button>
              <button className="modal-secondary primary-modal-button" type="submit" disabled={busy}>{busy ? 'Working…' : step === 'phone' ? 'Send code' : step === 'password' ? 'Finish connection' : 'Verify code'}</button>
            </div>
          </form>
        )}
        <p className="modal-footnote"><Zap size={13} /> Telegram MTProto · encrypted session storage</p>
      </section>
    </div>
  )
}

function MediaViewer({ item, items, onChange, onClose }: { item: MediaItem; items: MediaItem[]; onChange: (item: MediaItem) => void; onClose: () => void }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const currentIndex = items.findIndex((candidate) => candidate.id === item.id)
  const hasPrevious = currentIndex > 0
  const hasNext = currentIndex >= 0 && currentIndex < items.length - 1

  useEffect(() => {
    setLoading(true)
    setError('')
  }, [item.id])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowLeft' && hasPrevious) onChange(items[currentIndex - 1])
      if (event.key === 'ArrowRight' && hasNext) onChange(items[currentIndex + 1])
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [currentIndex, hasNext, hasPrevious, items, onChange, onClose])

  function retry() {
    setError('')
    setLoading(true)
    setAttempt((current) => current + 1)
  }

  return (
    <div className="viewer-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
      <section className="media-viewer" role="dialog" aria-modal="true" aria-labelledby="viewer-title">
        <header className="viewer-header">
          <div>
            <p className="viewer-source"><Send size={12} /> Original from Telegram Saved Messages</p>
            <h2 id="viewer-title">{item.name}</h2>
          </div>
          <div className="viewer-actions">
            {item.downloadUrl && <a className="download-button" href={item.downloadUrl} download={item.name}><Download size={15} /> Download original</a>}
            <button className="modal-close icon-button" type="button" aria-label="Close viewer" onClick={onClose}><X size={18} /></button>
          </div>
        </header>
        <div className="viewer-stage">
          {hasPrevious && <button className="viewer-nav viewer-nav-left" type="button" aria-label="Previous item" onClick={() => onChange(items[currentIndex - 1])}><ChevronLeft size={25} /></button>}
          {loading && !error && <div className="viewer-loading"><Cloud size={20} />Loading original…</div>}
          {error ? <div className="viewer-error"><AlertCircle size={22} /><strong>Telegram media unavailable</strong><span>{error}</span><button className="viewer-retry" type="button" onClick={retry}><RefreshCw size={13} /> Try again</button></div> : item.type === 'photo' ? (
            <img key={`${item.id}-${attempt}`} src={item.telegramUrl} alt={item.name} onLoad={() => setLoading(false)} onError={() => { setLoading(false); setError('Reconnect Telegram and try viewing it again.') }} />
          ) : (
            <video key={`${item.id}-${attempt}`} src={item.telegramUrl} controls autoPlay playsInline onLoadedData={() => setLoading(false)} onError={() => { setLoading(false); setError('This video format cannot be played here. The original file is still in Telegram.') }} />
          )}
          {hasNext && <button className="viewer-nav viewer-nav-right" type="button" aria-label="Next item" onClick={() => onChange(items[currentIndex + 1])}><ChevronRight size={25} /></button>}
        </div>
        <footer className="viewer-footer"><span>{currentIndex + 1} of {items.length} · {formatDateHeading(item.capturedAt)} · {formatTime(item.capturedAt)}</span><span>{formatSize(item.size)} · Original file</span></footer>
      </section>
    </div>
  )
}

export default App
