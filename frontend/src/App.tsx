import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Archive,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Cloud,
  Download,
  Film,
  Folder,
  ImagePlus,
  Images,
  LayoutGrid,
  Menu,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings2,
  SlidersHorizontal,
  Star,
  Tag as TagIcon,
  Trash2,
  Upload,
  X,
  Zap,
} from 'lucide-react'
import { createMediaItem } from './media'
import { useTheme } from './hooks/useTheme'
import { usePolling } from './hooks/usePolling'
import { ThemeToggle } from './components/ThemeToggle'
import { addMediaToAlbum, addTagToMedia, createAlbum, createTag, deleteMedia, disconnectTelegram, getTelegramStatus, listAlbums, listMedia, listTags, mediaUrl, retryMedia, updateMedia, startTelegramAuth, uploadMedia, verifyTelegramAuth } from './api'
import type { Album, ApiMedia, Tag, TelegramAuthResponse, TelegramStatus } from './api'
import type { MediaItem, MediaType, UploadStatus } from './types'

type Filter = 'all' | MediaType
type LibraryView = 'library' | 'favorites' | 'archive' | 'trash' | 'album'

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
    fileState: media.file_state,
    uploadError: media.upload_error,
    telegramMessageId: media.telegram_message_id,
    checksum: media.checksum,
    isFavorite: media.is_favorite,
    isArchived: media.is_archived,
    isTrashed: media.is_trashed,
    description: media.description,
    folderPath: media.folder_path,
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
  const { theme, toggleTheme } = useTheme()
  const [items, setItems] = useState<MediaItem[]>([])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem('infinityvault-sidebar') === 'collapsed')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [sortDirection, setSortDirection] = useState<'desc' | 'asc'>('desc')
  const [libraryView, setLibraryView] = useState<LibraryView>('library')
  const [activeAlbumId, setActiveAlbumId] = useState<string>()
  const [albums, setAlbums] = useState<Album[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [query, setQuery] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [isTelegramOpen, setIsTelegramOpen] = useState(false)
  const [viewingItem, setViewingItem] = useState<MediaItem | null>(null)
  const [editingItem, setEditingItem] = useState<MediaItem | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [notice, setNotice] = useState('')
  const [telegramStatus, setTelegramStatus] = useState<TelegramStatus>({
    configured: false,
    connected: false,
    display_name: null,
    username: null,
  })

  // Guards against a slow response from an older view overwriting a newer one.
  const requestSeq = useRef(0)

  async function refreshLibrary(showError = true) {
    const seq = ++requestSeq.current
    try {
      const mediaView = libraryView === 'album' ? 'library' : libraryView
      const [savedMedia, savedTelegramStatus, savedAlbums, savedTags] = await Promise.all([
        listMedia(mediaView, searchTerm, activeAlbumId),
        getTelegramStatus(),
        listAlbums(),
        listTags(),
      ])
      if (seq !== requestSeq.current) return

      const remote = savedMedia.map(itemFromApi)
      setItems((current) => {
        // A local item exists only in this tab until its upload finishes, and
        // it carries a temporary id (`name-size-timestamp-uuid`) that never
        // matches the server UUID. Reconcile on name+size instead, and drop
        // the placeholder the moment the authoritative row arrives — keeping
        // it shadowed the real record and pinned the tile at "Queued".
        const remoteKeys = new Set(remote.map((item) => `${item.name}|${item.size}`))
        const stillLocalOnly = current.filter((item) => {
          if (item.uploadStatus !== 'local' && item.uploadStatus !== 'queued') return false
          return !remoteKeys.has(`${item.name}|${item.size}`)
        })
        return [...stillLocalOnly, ...remote]
      })
      setTelegramStatus(savedTelegramStatus)
      setAlbums(savedAlbums)
      setTags(savedTags)
    } catch (error) {
      if (showError && seq === requestSeq.current) {
        setNotice(error instanceof Error ? error.message : 'The local service is not available yet.')
      }
    }
  }

  useEffect(() => {
    void refreshLibrary()
    setSelectedIds(new Set())
  }, [libraryView, activeAlbumId])

  // Debounced server-backed search. Typing previously filtered only the
  // already-loaded page in memory, so matches in descriptions and folder
  // paths never appeared and nothing beyond the current view was findable.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setSearchTerm(query.trim())
    }, 250)
    return () => window.clearTimeout(handle)
  }, [query])

  useEffect(() => {
    void refreshLibrary(false)
  }, [searchTerm])

  const hasActiveWork = items.some((item) =>
    ['queued', 'waiting_for_telegram', 'uploading', 'local'].includes(item.uploadStatus),
  )

  // Idle libraries still poll, just slowly: a backup finishing in another tab
  // must eventually show as backed up here.
  usePolling({
    onPoll: () => refreshLibrary(false),
    isActive: hasActiveWork,
    activeMs: 2000,
    idleMs: 15000,
    paused: Boolean(viewingItem) || isTelegramOpen || Boolean(editingItem),
  })

  const filteredItems = useMemo(() => {
    // Server search already narrowed the set (name, description, folder path).
    // This only applies the media-type filter and local ordering, so it can
    // never hide a row the server deliberately returned.
    return items
      .filter((item) => filter === 'all' || item.type === filter)
      .sort((first, second) => sortDirection === 'desc'
        ? second.capturedAt.getTime() - first.capturedAt.getTime()
        : first.capturedAt.getTime() - second.capturedAt.getTime())
  }, [filter, items, sortDirection])

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

  async function updateSelectedItems(payload: Parameters<typeof updateMedia>[1], successMessage: string) {
    try {
      await Promise.all(selectedItems.map((item) => updateMedia(item.id, payload)))
      await refreshLibrary(false)
      clearSelection()
      setNotice(successMessage)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Some selected items could not be updated.')
    }
  }

  async function toggleFavorite(item: MediaItem) {
    try {
      const saved = await updateMedia(item.id, { favorite: !item.isFavorite })
      setItems((current) => current.map((currentItem) => currentItem.id === item.id ? itemFromApi(saved) : currentItem))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Favorite state could not be updated.')
    }
  }

  async function saveDetails(item: MediaItem, description: string, folderPath: string, capturedAt: string) {
    try {
      await updateMedia(item.id, { description, folder_path: folderPath, captured_at: new Date(capturedAt).toISOString() })
      setEditingItem(null)
      await refreshLibrary(false)
      setNotice('Media details updated.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Media details could not be updated.')
    }
  }

  async function createNewAlbum() {
    const name = window.prompt('Album name')?.trim()
    if (!name) return
    try {
      const album = await createAlbum(name)
      setAlbums((current) => [album, ...current])
      if (selectedIds.size > 0) {
        await addMediaToAlbum(album.id, Array.from(selectedIds))
        clearSelection()
        setNotice(`${name} created with selected media.`)
      } else {
        setNotice(`${name} created.`)
      }
      setActiveAlbumId(album.id)
      setLibraryView('album')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'The album could not be created.')
    }
  }

  async function addSelectionToAlbum() {
    if (!selectedIds.size) return
    const name = window.prompt(`Add ${selectedIds.size} item${selectedIds.size === 1 ? '' : 's'} to which album?`, albums[0]?.name)?.trim()
    if (!name) return
    try {
      const album = albums.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase()) ?? await createAlbum(name)
      await addMediaToAlbum(album.id, Array.from(selectedIds))
      await refreshLibrary(false)
      clearSelection()
      setNotice(`Added media to ${album.name}.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Media could not be added to the album.')
    }
  }

  async function addSelectionTag() {
    if (!selectedIds.size) return
    const name = window.prompt('Tag name')?.trim()
    if (!name) return
    try {
      const tag = tags.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase()) ?? await createTag(name)
      await addTagToMedia(tag.id, Array.from(selectedIds))
      await refreshLibrary(false)
      clearSelection()
      setNotice(`Tagged ${selectedIds.size} item${selectedIds.size === 1 ? '' : 's'} as ${tag.name}.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'The tag could not be applied.')
    }
  }

  async function deleteSelectedForever() {
    if (!selectedIds.size || !window.confirm('Permanently delete the selected originals from Telegram and this library?')) return
    try {
      await Promise.all(selectedItems.map((item) => deleteMedia(item.id)))
      await refreshLibrary(false)
      clearSelection()
      setNotice('Selected media permanently deleted.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Media could not be permanently deleted.')
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

  function openView(view: LibraryView, albumId?: string) {
    setLibraryView(view)
    setActiveAlbumId(albumId)
    setFilter('all')
    // A view switch keeps the scroll position by default, which lands the user
    // mid-timeline in a library they have never seen. Ease back to the top;
    // the reduced-motion query makes this an instant jump.
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const pageTitle = libraryView === 'favorites'
    ? 'Favorites'
    : libraryView === 'archive'
      ? 'Archive'
      : libraryView === 'trash'
        ? 'Trash'
        : libraryView === 'album'
          ? albums.find((album) => album.id === activeAlbumId)?.name ?? 'Album'
          : filter === 'video' ? 'Videos' : filter === 'photo' ? 'Photos' : 'Your photos'

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
    <div className="app-shell" data-collapsed={sidebarCollapsed} data-drawer={drawerOpen}>
      {drawerOpen && <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />}
      <aside className="sidebar" data-collapsed={sidebarCollapsed}>
        <div className="brand">
          <div className="brand-mark"><Images size={18} strokeWidth={2.5} /></div>
          <div className="brand-copy"><strong>infinityvault</strong><span>Private memories</span></div>
        </div>

        <div className="sidebar-section">
          <p className="eyebrow">Library</p>
          <button className={libraryView === 'library' && filter === 'all' ? 'nav-item active' : 'nav-item'} type="button" onClick={() => openView('library')} title="Photos">
            <Images size={18} />
            <span>Photos</span>
            <span className="nav-count">{items.length}</span>
          </button>
          <button className={libraryView === 'album' ? 'nav-item active' : 'nav-item'} type="button" onClick={createNewAlbum}>
            <Archive size={18} />
            <span>Albums</span>
            <Plus size={14} className="nav-count" />
          </button>
          {albums.map((album) => <button className={libraryView === 'album' && activeAlbumId === album.id ? 'nav-item nested active' : 'nav-item nested'} type="button" key={album.id} onClick={() => openView('album', album.id)}><Folder size={16} /><span>{album.name}</span><span className="nav-count">{album.media_count}</span></button>)}
          <button className={libraryView === 'favorites' ? 'nav-item active' : 'nav-item'} type="button" onClick={() => openView('favorites')}>
            <Star size={18} />
            <span>Favorites</span><span className="nav-count">{items.filter((item) => item.isFavorite).length}</span>
          </button>
          <button className={libraryView === 'archive' ? 'nav-item active' : 'nav-item'} type="button" onClick={() => openView('archive')}>
            <Archive size={18} /><span>Archive</span>
          </button>
          <button className={libraryView === 'trash' ? 'nav-item active' : 'nav-item'} type="button" onClick={() => openView('trash')}>
            <Trash2 size={18} /><span>Trash</span>
          </button>
        </div>

        <div className="sidebar-section sidebar-filters">
          <p className="eyebrow">Quick filters</p>
          <button className={libraryView === 'library' && filter === 'photo' ? 'nav-item active' : 'nav-item'} type="button" onClick={() => { openView('library'); setFilter('photo') }}>
            <ImagePlus size={17} /><span>Photos only</span><span className="nav-count">{photoCount}</span>
          </button>
          <button className={libraryView === 'library' && filter === 'video' ? 'nav-item active' : 'nav-item'} type="button" onClick={() => { openView('library'); setFilter('video') }}>
            <Film size={17} /><span>Videos only</span><span className="nav-count">{videoCount}</span>
          </button>
        </div>

        <div className="sidebar-section sidebar-bottom">
          <p className="eyebrow">Storage</p>
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
            <span>Connect Telegram</span>
          </button>
        </div>

        <div className="sidebar-footer">
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          <button
            className="collapse-button"
            type="button"
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => setSidebarCollapsed((current) => {
              window.localStorage.setItem('infinityvault-sidebar', current ? 'expanded' : 'collapsed')
              return !current
            })}
          >
            {sidebarCollapsed ? <ChevronsRight size={15} /> : <ChevronsLeft size={15} />}
          </button>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <button className="mobile-menu" type="button" aria-label="Open navigation" onClick={() => setDrawerOpen(true)}><Menu size={19} /></button>
          <div className="topbar-title">
            <h1>{pageTitle}</h1>
            <span>{items.length} {items.length === 1 ? 'asset' : 'assets'}</span>
          </div>
          <div className="topbar-actions">
            <label className="search-field">
              <Search size={17} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your library" />
              <kbd>⌘ K</kbd>
            </label>
            <button className="icon-button header-tool" type="button" aria-label="Library filters"><SlidersHorizontal size={17} /></button>
            <button className="upload-button" type="button" onClick={() => fileInputRef.current?.click()}>
              <Upload size={17} />
              <span>Add photos & videos</span>
            </button>
            <input ref={fileInputRef} className="hidden-input" type="file" accept="image/*,video/*" multiple onChange={handleFileChange} />
          </div>
        </header>

        <div className="content-wrap">
          <section className="library-heading">
            <div>
              <span className="overline">Library</span>
              <h2>{pageTitle}</h2>
            </div>
            <div className="library-heading-meta"><span><Cloud size={14} /> {telegramStatus.connected ? 'Backed up privately' : 'Backup not connected'}</span><strong>{items.length} {items.length === 1 ? 'asset' : 'assets'}</strong></div>
          </section>

          {selectedIds.size === 0 && (
            <div className="toolbar">
              <div className="toolbar-leading">
                <div className="filter-tabs" role="tablist" aria-label="Media filters">
                  {filters.map((option) => (
                    <button key={option.value} type="button" className={filter === option.value ? 'filter-tab selected' : 'filter-tab'} onClick={() => setFilter(option.value)}>
                      {option.label}
                      {option.value === 'all' && <span>{items.length}</span>}
                    </button>
                  ))}
                </div>
                <span className="results-count">{filteredItems.length} {filteredItems.length === 1 ? 'asset' : 'assets'}</span>
              </div>
              <div className="toolbar-tools">
                <button className="view-mode-button active" type="button" aria-label="Grid view"><LayoutGrid size={15} /></button>
                <button className="sort-button" type="button" onClick={() => setSortDirection((current) => current === 'desc' ? 'asc' : 'desc')}>
                  <span>{sortDirection === 'desc' ? 'Newest first' : 'Oldest first'}</span>
                  <ChevronDown size={15} />
                </button>
              </div>
            </div>
          )}

          {selectedIds.size > 0 && (
            <div className="selection-toolbar" role="toolbar" aria-label="Selected media actions">
              <strong>{selectedIds.size} selected</strong>
              <div className="selection-actions">
                {libraryView === 'trash' ? (
                  <button type="button" onClick={() => void updateSelectedItems({ trashed: false }, 'Selected media restored.')}><RotateCcw size={14} /> Restore</button>
                ) : (
                  <>
                    <button type="button" onClick={() => void updateSelectedItems({ favorite: !selectedItems.every((item) => item.isFavorite) }, 'Favorites updated.')}><Star size={14} /> Favorite</button>
                    <button type="button" onClick={() => void updateSelectedItems({ archived: true }, 'Selected media archived.')}><Archive size={14} /> Archive</button>
                    <button type="button" onClick={() => void updateSelectedItems({ trashed: true }, 'Selected media moved to trash.')}><Trash2 size={14} /> Trash</button>
                  </>
                )}
                <button type="button" onClick={addSelectionToAlbum}><Folder size={14} /> Album</button>
                <button type="button" onClick={addSelectionTag}><TagIcon size={14} /> Tag</button>
                <button type="button" onClick={downloadSelected} disabled={!selectedItems.some((item) => item.downloadUrl)}><Download size={14} /> Download</button>
                {libraryView === 'trash' && (
                  <button type="button" className="danger" onClick={() => void deleteSelectedForever()}><Trash2 size={14} /> Delete forever</button>
                )}
                <span className="selection-divider" />
                <button type="button" onClick={clearSelection}>Clear</button>
              </div>
            </div>
          )}

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
                  {group.items.map((item) => <MediaCard key={item.id} item={item} selected={selectedIds.has(item.id)} onSelect={() => toggleSelected(item.id)} onRetry={handleRetry} onConnect={() => setIsTelegramOpen(true)} onView={setViewingItem} onFavorite={() => void toggleFavorite(item)} onEdit={() => setEditingItem(item)} />)}
                </div>
              </section>
            )) : (
              <EmptyState onUpload={() => fileInputRef.current?.click()} />
            )}
          </div>
        </div>
      </main>

      {isTelegramOpen && <TelegramModal status={telegramStatus} onConnected={handleTelegramConnected} onDisconnected={handleTelegramDisconnected} onClose={() => setIsTelegramOpen(false)} />}
      {editingItem && <MediaDetailsModal item={editingItem} onSave={saveDetails} onClose={() => setEditingItem(null)} />}
      {viewingItem && <MediaViewer item={viewingItem} items={filteredItems} onChange={setViewingItem} onClose={() => setViewingItem(null)} />}
    </div>
  )
}

function MediaCard({ item, selected, onSelect, onRetry, onConnect, onView, onFavorite, onEdit }: { item: MediaItem; selected: boolean; onSelect: () => void; onRetry: (item: MediaItem) => void; onConnect: () => void; onView: (item: MediaItem) => void; onFavorite: () => void; onEdit: () => void }) {
  const statusIcon = item.uploadStatus === 'uploaded'
    ? <Check size={11} />
    : item.uploadStatus === 'failed'
      ? <AlertCircle size={11} />
      : item.uploadStatus === 'waiting_for_telegram'
        ? <Send size={11} />
        : <Cloud size={11} />

  const canView = item.uploadStatus === 'uploaded' && Boolean(item.telegramUrl)
  // Start failed if the server already told us the local copy is gone, so we
  // do not fire a request that is guaranteed to 404.
  const [previewFailed, setPreviewFailed] = useState(item.fileState === 'missing')

  return (
    <article className={selected ? 'media-card selected' : 'media-card'}>
      <div
        className="media-preview"
        role="button"
        tabIndex={0}
        aria-label={`Open ${item.name}`}
        onClick={() => (canView ? onView(item) : onSelect())}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            if (canView) onView(item)
            else onSelect()
          }
        }}
      >
        {previewFailed
          ? <div className="preview-missing">
              <AlertCircle size={16} />
              <span>{item.fileState === 'missing' ? 'File missing' : 'Preview unavailable'}</span>
            </div>
          : item.type === 'photo'
            ? <img src={item.url} alt={item.name} loading="lazy" onError={() => setPreviewFailed(true)} />
            : <video src={item.url} muted playsInline preload="metadata" onError={() => setPreviewFailed(true)} />}
        {item.type === 'video' && <div className="video-overlay"><Play size={14} fill="currentColor" /></div>}
        {item.type === 'video' && item.duration !== undefined && <span className="duration-chip">{formatDuration(item.duration)}</span>}
        {item.uploadStatus !== 'uploaded' && <span className={`backup-chip status-${item.uploadStatus}`}>{statusIcon} {statusLabel(item.uploadStatus)}</span>}
        <button
          className={selected ? 'select-button selected' : 'select-button'}
          type="button"
          aria-label={selected ? `Deselect ${item.name}` : `Select ${item.name}`}
          onClick={(event) => { event.stopPropagation(); onSelect() }}
        >
          {selected && <Check size={12} strokeWidth={3} />}
        </button>
        <div className="media-scrim">
          <button
            className={item.isFavorite ? 'tile-action active' : 'tile-action'}
            type="button"
            aria-label={item.isFavorite ? `Remove ${item.name} from favorites` : `Favorite ${item.name}`}
            onClick={(event) => { event.stopPropagation(); onFavorite() }}
          >
            <Star size={13} fill={item.isFavorite ? 'currentColor' : 'none'} />
          </button>
          <button
            className="tile-action"
            type="button"
            aria-label={`Edit details for ${item.name}`}
            onClick={(event) => { event.stopPropagation(); onEdit() }}
          >
            <Pencil size={13} />
          </button>
        </div>
      </div>
      {(item.uploadStatus === 'failed' || item.uploadStatus === 'local' || item.uploadStatus === 'waiting_for_telegram') && (
        <div className="asset-status-action">
          {item.uploadStatus === 'failed' && <button className="media-action" type="button" onClick={() => onRetry(item)}><RefreshCw size={11} /> Retry</button>}
          {item.uploadStatus === 'local' && item.file && <button className="media-action" type="button" onClick={() => void onRetry(item)}><RefreshCw size={11} /> Try again</button>}
          {item.uploadStatus === 'waiting_for_telegram' && <button className="media-action" type="button" onClick={onConnect}><Send size={11} /> Connect</button>}
        </div>
      )}
    </article>
  )
}

function MediaDetailsModal({ item, onSave, onClose }: { item: MediaItem; onSave: (item: MediaItem, description: string, folderPath: string, capturedAt: string) => Promise<void>; onClose: () => void }) {
  const [description, setDescription] = useState(item.description)
  const [folderPath, setFolderPath] = useState(item.folderPath ?? '')
  const [capturedAt, setCapturedAt] = useState(item.capturedAt.toISOString().slice(0, 16))
  const [busy, setBusy] = useState(false)
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="details-modal" role="dialog" aria-modal="true" aria-labelledby="details-title">
      <button className="icon-button modal-close" type="button" aria-label="Close details" onClick={onClose}><X size={17} /></button>
      <p className="section-kicker"><Pencil size={13} /> Media details</p>
      <h2 id="details-title">Edit {item.name}</h2>
      <label className="modal-label">Capture date and time<input type="datetime-local" value={capturedAt} onChange={(event) => setCapturedAt(event.target.value)} /></label>
      <label className="modal-label">Folder path<input value={folderPath} onChange={(event) => setFolderPath(event.target.value)} placeholder="e.g. Trips/2026" /></label>
      <label className="modal-label">Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} placeholder="Add a description" /></label>
      <div className="form-actions"><button className="back-button" type="button" onClick={onClose}>Cancel</button><button className="modal-secondary primary-modal-button" type="button" disabled={busy || !capturedAt} onClick={() => { setBusy(true); void onSave(item, description, folderPath, capturedAt).finally(() => setBusy(false)) }}>{busy ? 'Saving…' : 'Save details'}</button></div>
    </section>
  </div>
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
            <p className="modal-copy">Telegram backup needs the app credentials from <strong>my.telegram.org</strong>. Run the InfinityVault setup command once in your terminal; it saves them privately and starts both services.</p>
            <div className="setup-note"><AlertCircle size={17} /><span>Run <code>npm run infinityvault -- setup</code> from the InfinityVault project folder. Your API hash is hidden while you type and never enters the browser.</span></div>
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
