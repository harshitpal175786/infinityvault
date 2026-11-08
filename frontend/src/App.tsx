import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  ScanFace,
  Compass,
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
  ShieldCheck,
} from 'lucide-react'
import { createMediaItem } from './media'
import { useTheme } from './hooks/useTheme'
import { usePolling } from './hooks/usePolling'
import { ThemeToggle } from './components/ThemeToggle'
import { UtilitiesPage } from './components/UtilitiesPage'
import { TokenGate } from './components/TokenGate'
import { PeoplePage } from './components/PeoplePage'
import { ExplorePage } from './components/ExplorePage'
import { Sidebar } from './components/Sidebar'
import { EmptyState, MediaCard, MediaDetailsModal, MediaViewer, TelegramModal } from './components/MediaViews'
import { useLibraryFilters, FILTERS, type Filter, type LibraryView } from './hooks/useLibraryFilters'
import { useInfiniteScroll } from './hooks/useInfiniteScroll'
import { useToast } from './components/Toast'
import { ContextMenu, type MenuAction } from './components/ContextMenu'
import { AlbumsPage } from './components/AlbumsPage'
import { SkeletonGrid } from './components/Spinner'
import { dateKey, formatDateHeading, formatDuration, formatSize, formatTime, itemFromApi, statusLabel } from './lib/format'
import { addMediaToAlbum, addTagToMedia, createAlbum, createTag, deleteAlbum, deleteMedia, disconnectTelegram, getAccessToken, getAuthStatus, getTelegramStatus, listAlbums, listCameras, listMedia, listMediaPage, listPeople, listTags, mediaUrl, removeMediaFromAlbum, renameAlbum, retryMedia, setUnauthorizedHandler, startTelegramAuth, updateMedia, uploadMedia, verifyTelegramAuth } from './api'
import type { Album, ApiMedia, CameraOption, MediaFilterParams, Tag, TelegramAuthResponse, TelegramStatus } from './api'
import type { MediaItem, MediaType, UploadStatus } from './types'

/** Sidebar tabs. Alias kept so existing JSX reads naturally. */
const filters = FILTERS


function App() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { theme, toggleTheme } = useTheme()
  const [authRejected, setAuthRejected] = useState(false)
  const [authReady, setAuthReady] = useState(false)
  const [authChecking, setAuthChecking] = useState(false)
  const [items, setItems] = useState<MediaItem[]>([])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem('infinityvault-sidebar') === 'collapsed')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const {
    libraryView,
    setLibraryView,
    filter,
    setFilter,
    sortDirection,
    setSortDirection,
    filtersOpen,
    setFiltersOpen,
    advancedFilters,
    setAdvancedFilters,
    activeAlbumId,
    setActiveAlbumId,
    albums,
    setAlbums,
    tags,
    setTags,
    cameras,
    setCameras,
    query,
    setQuery,
    searchTerm,
    setSearchTerm,
    buildFilterParams,
    clearAdvancedFilters,
    openView,
  } = useLibraryFilters()
  const [isDragging, setIsDragging] = useState(false)
  const [isTelegramOpen, setIsTelegramOpen] = useState(false)
  const [people, setPeople] = useState<{ id: string; name: string | null; face_count: number }[]>([])
  const [viewingItem, setViewingItem] = useState<MediaItem | null>(null)
  const [editingItem, setEditingItem] = useState<MediaItem | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // Kept as a single helper so the ~20 existing call sites do not change, but
  // messages now go through the toast queue: they stack instead of overwriting
  // each other, and errors are announced assertively to screen readers.
  // Anchor for shift-click range selection.
  const lastSelectedRef = useRef<string | null>(null)
  // Open context menu: which item, and where.
  const [menu, setMenu] = useState<{ item: MediaItem; x: number; y: number } | null>(null)
  const toast = useToast()
  const [notice, setNotice] = useState('')

  // Anything containing "could", "cannot", "failed" or "not" is a problem the
  // user has to act on, so it is surfaced as an error rather than a success.
  const notify = useCallback((message: string) => {
    setNotice(message)
    if (/could not|cannot|failed|not available|unable|error/i.test(message)) {
      toast.error(message)
    } else {
      toast.success(message)
    }
  }, [toast])
  const [telegramStatus, setTelegramStatus] = useState<TelegramStatus>({
    configured: false,
    connected: false,
    display_name: null,
    username: null,
  })

  // Pagination. The first page is fetched on every refresh (cheap, keeps the
  // newest photos live); later pages are appended only when the user asks.
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  // True only until the first page resolves. Without it the timeline painted a
  // blank area on load, which is indistinguishable from an empty library.
  const [initialLoading, setInitialLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  // 1 = only the first page is loaded. Guards the cursor from being rewound by
  // the 2s poll once the user has appended more.
  const loadedPagesRef = useRef(1)

  // Guards against a slow response from an older view overwriting a newer one.
  const requestSeq = useRef(0)

  // Appends the next page. Deliberately does NOT run through the refresh
  // merge logic: that path reconciles local placeholders and would drop
  // already-loaded pages.
  async function loadMore() {
    if (!nextCursor || loadingMore) return
    const seq = requestSeq.current
    setLoadingMore(true)
    try {
      const mediaView = libraryView === 'album' ? 'library' : libraryView
      const page = await listMediaPage(mediaView, searchTerm, activeAlbumId, nextCursor, 200, advancedFilters)
      // A view change mid-flight invalidates this page.
      if (seq !== requestSeq.current) return
      const known = new Set(items.map((item) => item.id))
      const additions = page.items.map((media) => itemFromApi(media, mediaUrl)).filter((item) => !known.has(item.id))
      setItems((current) => [...current, ...additions])
      setNextCursor(page.nextCursor)
      loadedPagesRef.current += 1
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not load more photos.')
    } finally {
      setLoadingMore(false)
    }
  }

  // Fires as the end of the grid comes into view, so scrolling just keeps
  // going instead of stopping at a button. The button stays below as a manual
  // fallback and as a visible "there is more" cue.
  const loadMoreSentinelRef = useInfiniteScroll({
    onLoad: () => void loadMore(),
    hasMore: Boolean(nextCursor),
    loading: loadingMore,
  })

  // Actions for the right-click menu. Each one calls a handler that already
  // exists; the menu adds reach, not behaviour.
  function menuActions(item: MediaItem): MenuAction[] {
    const canView = item.uploadStatus === 'uploaded' && Boolean(item.telegramUrl)
    return [
      { label: 'Open', onSelect: () => setViewingItem(item), disabled: !canView },
      { label: 'Details', onSelect: () => setEditingItem(item) },
      {
        label: item.isFavorite ? 'Remove from favourites' : 'Add to favourites',
        onSelect: () => void toggleFavorite(item),
      },
      {
        label: selectedIds.has(item.id) ? 'Deselect' : 'Select',
        onSelect: () => toggleSelected(item.id),
      },
      {
        label: 'Copy name',
        separated: true,
        onSelect: () => {
          void navigator.clipboard?.writeText(item.name).then(
            () => notify(`Copied “${item.name}”.`),
            () => notify('The clipboard is not available.'),
          )
        },
      },
      {
        label: item.uploadStatus === 'failed' ? 'Retry upload' : 'Re-upload',
        onSelect: () => handleRetry(item),
      },
    ]
  }

  async function refreshLibrary(showError = true) {
    setLoadError('')
    const seq = ++requestSeq.current
    try {
      const mediaView = libraryView === 'album' ? 'library' : libraryView
      const [page, savedTelegramStatus, savedAlbums, savedTags, savedCameras, savedPeople] = await Promise.all([
        listMediaPage(mediaView, searchTerm, activeAlbumId, null, 200, advancedFilters),
        getTelegramStatus(),
        listAlbums(),
        listTags(),
        listCameras().catch(() => []),
        listPeople().catch(() => []),
      ])
      if (seq !== requestSeq.current) return

      const remote = page.items.map((media) => itemFromApi(media, mediaUrl))
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

        // Preserve pages the user already loaded with "Load more". The poll
        // runs every 2s and only fetches page 1, so replacing the list here
        // would silently discard everything beyond the first page.
        //
        // Exception: a filter change is a new result set, so carrying rows over
        // would keep ones the filter excluded. loadedPagesRef is reset to 1 in
        // that case, so only the first page is authoritative.
        const firstPageIds = new Set(remote.map((item) => item.id))
        const beyondFirstPage = loadedPagesRef.current <= 1
          ? []
          : current.filter(
            (item) => item.uploadStatus !== 'local' && item.uploadStatus !== 'queued'
              && !firstPageIds.has(item.id),
          )

        return [...stillLocalOnly, ...remote, ...beyondFirstPage]
      })

      // Only advance the cursor when nothing extra is loaded; otherwise the
      // stored cursor would skip past rows the user already appended.
      // setState updaters must stay pure, so this lives outside setItems.
      if (loadedPagesRef.current <= 1) {
        setNextCursor(page.nextCursor)
      }
      setTelegramStatus(savedTelegramStatus)
      setAlbums(savedAlbums)
      setTags(savedTags)
      setCameras(savedCameras)
      setPeople(savedPeople)
      setLoadError('')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The local service is not available yet.'
      // A failed first load must leave something actionable on screen, not a
      // blank timeline that looks like an empty library.
      if (seq === requestSeq.current) setLoadError(message)
      if (showError && seq === requestSeq.current) notify(message)
    } finally {
      if (seq === requestSeq.current) setInitialLoading(false)
    }
  }

  // Ask once whether this instance is protected. If it is not (no token
  // configured) we must not block the user behind a prompt they cannot satisfy
  // -- but if a stored token gets rejected later, the gate reappears.
  useEffect(() => {
    let cancelled = false
    void getAuthStatus()
      .then((status) => {
        if (cancelled) return
        // An unprotected instance never shows the gate. A protected one always
        // does until a token has been proven, so a stale token cannot slip past.
        if (!status.required) {
          setAuthReady(true)
          return
        }
        const stored = getAccessToken()
        if (!stored) return
        // A stored token still has to be proven; otherwise a rotated token
        // would render the shell and then fail on every request.
        void listMediaPage('library', '', undefined, undefined, 1)
          .then(() => setAuthReady(true))
          .catch(() => setAuthRejected(true))
      })
      .catch(() => {
        if (!cancelled) setAuthReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAuthRejected(true)
      setAuthReady(false)
    })
    return () => setUnauthorizedHandler(null)
  }, [])

  useEffect(() => {
    if (!authReady) return
    loadedPagesRef.current = 1
    setNextCursor(null)
    void refreshLibrary()
    setSelectedIds(new Set())
  }, [libraryView, activeAlbumId, authReady, advancedFilters])

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
    // A new search is a new result set: drop back to a single page so the
    // cursor and depth cannot leak across queries.
    loadedPagesRef.current = 1
    setNextCursor(null)
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
    //
    // The advanced "Order" filter sorts server-side *before* pagination, so it
    // must win here; sorting again would reverse it and make "oldest first"
    // show only the oldest page in newest-first order.
    const useServerOrder = advancedFilters.sort === 'oldest'
    return items
      .filter((item) => filter === 'all' || item.type === filter)
      .sort((first, second) => {
        if (useServerOrder) return first.capturedAt.getTime() - second.capturedAt.getTime()
        return sortDirection === 'desc'
          ? second.capturedAt.getTime() - first.capturedAt.getTime()
          : first.capturedAt.getTime() - second.capturedAt.getTime()
      })
  }, [filter, items, sortDirection, advancedFilters.sort])

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

    // Group order must follow the same rule as the items inside them, or
    // "oldest first" would still render its date headings newest-first.
    const ascending = advancedFilters.sort === 'oldest'
      ? true
      : sortDirection === 'asc'
    return Array.from(groups.values()).sort((first, second) => ascending
      ? first.date.getTime() - second.date.getTime()
      : second.date.getTime() - first.date.getTime())
  }, [filteredItems, sortDirection, advancedFilters.sort])

  const totalSize = items.reduce((total, item) => total + item.size, 0)
  const photoCount = items.filter((item) => item.type === 'photo').length
  const videoCount = items.filter((item) => item.type === 'video').length
  const selectedItems = items.filter((item) => selectedIds.has(item.id))

  async function addFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList)
    const createdItems = await Promise.all(files.map((file) => createMediaItem(file)))
    const validItems = createdItems.filter((item): item is MediaItem => Boolean(item))

    if (validItems.length === 0) {
      notify('Choose image or video files to add them to your timeline.')
      return
    }

    setItems((current) => [...current, ...validItems])
    notify(`${validItems.length} ${validItems.length === 1 ? 'item' : 'items'} added. Preparing a private backup…`)
    validItems.forEach((item) => void syncItem(item))
  }

  async function syncItem(item: MediaItem) {
    setItems((current) => current.map((currentItem) => currentItem.id === item.id ? { ...currentItem, uploadStatus: 'queued' } : currentItem))
    try {
      const saved = await uploadMedia(item)
      if (item.url.startsWith('blob:')) URL.revokeObjectURL(item.url)
      setItems((current) => current.map((currentItem) => currentItem.id === item.id ? itemFromApi(saved, mediaUrl) : currentItem))
    } catch (error) {
      setItems((current) => current.map((currentItem) => currentItem.id === item.id ? {
        ...currentItem,
        uploadStatus: 'local',
        uploadError: error instanceof Error ? error.message : 'The backup service is unavailable.',
      } : currentItem))
      notify('The media is visible locally, but the backup service could not be reached. You can try again after starting the backend.')
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
      setItems((current) => current.map((currentItem) => currentItem.id === item.id ? itemFromApi(saved, mediaUrl) : currentItem))
    } catch (error) {
      notify(error instanceof Error ? error.message : 'This item could not be queued again.')
    }
  }

  async function updateSelectedItems(payload: Parameters<typeof updateMedia>[1], successMessage: string) {
    try {
      await Promise.all(selectedItems.map((item) => updateMedia(item.id, payload)))
      await refreshLibrary(false)
      clearSelection()
      notify(successMessage)
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Some selected items could not be updated.')
    }
  }

  async function toggleFavorite(item: MediaItem) {
    try {
      const saved = await updateMedia(item.id, { favorite: !item.isFavorite })
      const updated = itemFromApi(saved, mediaUrl)
      setItems((current) => current.map((currentItem) => currentItem.id === item.id ? updated : currentItem))
      // The viewer holds its own copy of the item, so without this the star and
      // the card behind it disagree until the viewer is reopened.
      setViewingItem((current) => (current && current.id === item.id ? updated : current))
      setEditingItem((current) => (current && current.id === item.id ? updated : current))
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Favorite state could not be updated.')
    }
  }

  async function saveDetails(item: MediaItem, description: string, folderPath: string, capturedAt: string) {
    try {
      await updateMedia(item.id, { description, folder_path: folderPath, captured_at: new Date(capturedAt).toISOString() })
      setEditingItem(null)
      await refreshLibrary(false)
      notify('Media details updated.')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Media details could not be updated.')
    }
  }

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      // Persisted so the choice survives a reload; read back in useState above.
      window.localStorage.setItem('infinityvault-sidebar', current ? 'expanded' : 'collapsed')
      return !current
    })
  }

  async function handleCreateAlbum(name: string) {
    const album = await createAlbum(name)
    setAlbums((current) => [album, ...current])
    notify(`“${name}” created.`)
  }

  async function handleRenameAlbum(album: Album, name: string) {
    const saved = await renameAlbum(album.id, name)
    setAlbums((current) => current.map((each) => each.id === album.id ? saved : each))
    notify(`Renamed to “${saved.name}”.`)
  }

  async function handleDeleteAlbum(album: Album) {
    await deleteAlbum(album.id)
    setAlbums((current) => current.filter((each) => each.id !== album.id))
    // The open album is gone, so fall back to the whole library rather than
    // leaving the user on a view that no longer exists.
    if (activeAlbumId === album.id) {
      setActiveAlbumId(undefined)
      setLibraryView('library')
    }
    notify(`“${album.name}” deleted. Its items are still in your library.`)
  }

  async function handleRemoveFromAlbum() {
    if (!activeAlbumId || selectedIds.size === 0) return
    const count = selectedIds.size
    try {
      await removeMediaFromAlbum(activeAlbumId, Array.from(selectedIds))
      clearSelection()
      await refreshLibrary(false)
      notify(`Removed ${count} ${count === 1 ? 'item' : 'items'} from the album.`)
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not remove those items.')
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
        notify(`${name} created with selected media.`)
      } else {
        notify(`${name} created.`)
      }
      setActiveAlbumId(album.id)
      setLibraryView('album')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The album could not be created.')
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
      notify(`Added media to ${album.name}.`)
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Media could not be added to the album.')
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
      notify(`Tagged ${selectedIds.size} item${selectedIds.size === 1 ? '' : 's'} as ${tag.name}.`)
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The tag could not be applied.')
    }
  }

  async function deleteSelectedForever() {
    if (!selectedIds.size || !window.confirm('Permanently delete the selected originals from Telegram and this library?')) return
    try {
      await Promise.all(selectedItems.map((item) => deleteMedia(item.id)))
      await refreshLibrary(false)
      clearSelection()
      notify('Selected media permanently deleted.')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Media could not be permanently deleted.')
    }
  }

  async function handleTelegramConnected() {
    const status = await getTelegramStatus()
    setTelegramStatus(status)
    setIsTelegramOpen(false)
    notify(status.display_name ? `Telegram connected as ${status.display_name}. Waiting media will upload now.` : 'Telegram connected. Waiting media will upload now.')
    void refreshLibrary(false)
  }

  async function handleTelegramDisconnected() {
    const status = await getTelegramStatus()
    setTelegramStatus(status)
    setIsTelegramOpen(false)
    notify('Telegram disconnected. New media will stay queued until you connect again.')
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
    lastSelectedRef.current = id
  }

  // Shift-click selects everything between the last click and this one, which
  // is how every file browser behaves and is the fastest way to pick a range
  // out of a 378-item timeline. Alt/Meta-click is treated the same as a plain
  // click so additive selection still works.
  function selectWithRange(id: string, event: React.MouseEvent) {
    const anchor = lastSelectedRef.current
    if (!event.shiftKey || !anchor || anchor === id) {
      toggleSelected(id)
      return
    }
    // Range is taken in display order, not insertion order.
    const ids = filteredItems.map((item) => item.id)
    const from = ids.indexOf(anchor)
    const to = ids.indexOf(id)
    if (from === -1 || to === -1) {
      toggleSelected(id)
      return
    }
    const [start, end] = from <= to ? [from, to] : [to, from]
    const range = ids.slice(start, end + 1)
    setSelectedIds((current) => {
      const next = new Set(current)
      range.forEach((each) => next.add(each))
      return next
    })
    lastSelectedRef.current = id
  }

  function clearSelection() {
    setSelectedIds(new Set())
  }

  const pageTitle = libraryView === 'favorites'
    ? 'Favorites'
    : libraryView === 'archive'
      ? 'Archive'
      : libraryView === 'trash'
        ? 'Trash'
        : libraryView === 'utilities'
          ? 'Utilities'
          : libraryView === 'people'
            ? 'People'
            : libraryView === 'explore'
              ? 'Explore'
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
    notify(`${selectedItems.filter((item) => item.downloadUrl).length} original ${selectedItems.length === 1 ? 'file' : 'files'} queued for download.`)
    clearSelection()
  }

  // The API tells us on the first rejected request that it needs a token.
  if (!authReady) {
    return (
      <TokenGate
        rejected={authRejected}
        checking={authChecking}
        onSubmit={() => {
          // Prove the token works before showing the app. Rendering the shell
          // optimistically would let a wrong token appear to succeed.
          setAuthChecking(true)
          void getAuthStatus()
            .catch(() => null)
            .then(async () => {
              try {
                await listMediaPage('library', '', undefined, undefined, 1)
                setAuthRejected(false)
                setAuthReady(true)
              } catch {
                setAuthRejected(true)
              } finally {
                setAuthChecking(false)
              }
            })
        }}
      />
    )
  }

  return (
    <div className="app-shell" data-collapsed={sidebarCollapsed} data-drawer={drawerOpen}>
      {drawerOpen && <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />}
      <Sidebar
        collapsed={sidebarCollapsed}
        libraryView={libraryView}
        filter={filter}
        photoCount={photoCount}
        videoCount={videoCount}
        albums={albums}
        items={items}
        activeAlbumId={activeAlbumId}
        telegramStatus={telegramStatus}
        openView={openView}
        setFilter={setFilter}
        onOpenTelegram={() => setIsTelegramOpen(true)}
        onCreateAlbum={() => void createNewAlbum()}
        onOpenAlbums={() => { setLibraryView('albums'); setActiveAlbumId(undefined) }}
        onSetDrawerOpen={setDrawerOpen}
        onToggleCollapse={toggleSidebar}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

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
            <button
              className={filtersOpen ? 'icon-button header-tool active' : 'icon-button header-tool'}
              type="button"
              aria-label="Library filters"
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen((open) => !open)}
            >
              <SlidersHorizontal size={17} />
            </button>
            <button className="upload-button" type="button" onClick={() => fileInputRef.current?.click()}>
              <Upload size={17} />
              <span>Add photos & videos</span>
            </button>
            <input ref={fileInputRef} className="hidden-input" type="file" accept="image/*,video/*" multiple onChange={handleFileChange} />
          </div>
        </header>

        {filtersOpen && (
          <div className="filter-bar">
            <label className="filter-field">
              <span>From</span>
              <input
                type="date"
                value={advancedFilters.dateFrom ?? ''}
                onChange={(event) => setAdvancedFilters((f) => ({ ...f, dateFrom: event.target.value || undefined }))}
              />
            </label>
            <label className="filter-field">
              <span>To</span>
              <input
                type="date"
                value={advancedFilters.dateTo ?? ''}
                onChange={(event) => setAdvancedFilters((f) => ({ ...f, dateTo: event.target.value || undefined }))}
              />
            </label>
            <label className="filter-field">
              <span>Type</span>
              <select
                value={advancedFilters.mediaType ?? ''}
                onChange={(event) => setAdvancedFilters((f) => ({
                  ...f,
                  mediaType: (event.target.value || undefined) as 'photo' | 'video' | undefined,
                }))}
              >
                <option value="">Any</option>
                <option value="photo">Photos</option>
                <option value="video">Videos</option>
              </select>
            </label>
            <label className="filter-field">
              <span>People</span>
              <select
                value={advancedFilters.hasFaces === undefined ? '' : String(advancedFilters.hasFaces)}
                onChange={(event) => setAdvancedFilters((f) => ({
                  ...f,
                  hasFaces: event.target.value === '' ? undefined : event.target.value === 'true',
                }))}
              >
                <option value="">Any</option>
                <option value="true">Has faces</option>
                <option value="false">No faces</option>
              </select>
            </label>
            <label className="filter-field">
              <span>Person</span>
              <select
                value={advancedFilters.personId ?? ''}
                onChange={(event) => setAdvancedFilters((f) => ({ ...f, personId: event.target.value || undefined }))}
                disabled={people.length === 0}
              >
                <option value="">{people.length === 0 ? 'No people yet' : 'Anyone'}</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name || 'Unnamed'} ({person.face_count})
                  </option>
                ))}
              </select>
            </label>
            <label className="filter-field">
              <span>Tag</span>
              <select
                value={advancedFilters.tagId ?? ''}
                onChange={(event) => setAdvancedFilters((f) => ({ ...f, tagId: event.target.value || undefined }))}
                disabled={tags.length === 0}
              >
                <option value="">{tags.length === 0 ? 'No tags yet' : 'Any tag'}</option>
                {tags.map((tag) => (
                  <option key={tag.id} value={tag.id}>{tag.name}</option>
                ))}
              </select>
            </label>
            <label className="filter-field">
              <span>Place</span>
              <input
                type="text"
                placeholder="Folder or caption"
                value={advancedFilters.place ?? ''}
                onChange={(event) => setAdvancedFilters((f) => ({ ...f, place: event.target.value || undefined }))}
              />
            </label>
            <label className="filter-field">
              <span>Favourites</span>
              <select
                value={advancedFilters.favorite === undefined ? '' : String(advancedFilters.favorite)}
                onChange={(event) => setAdvancedFilters((f) => ({
                  ...f,
                  favorite: event.target.value === '' ? undefined : event.target.value === 'true',
                }))}
              >
                <option value="">Any</option>
                <option value="true">Favourites only</option>
                <option value="false">Not favourited</option>
              </select>
            </label>
            <label className="filter-field">
              <span>Location</span>
              <select
                value={advancedFilters.hasLocation === undefined ? '' : String(advancedFilters.hasLocation)}
                onChange={(event) => setAdvancedFilters((f) => ({
                  ...f,
                  hasLocation: event.target.value === '' ? undefined : event.target.value === 'true',
                }))}
              >
                <option value="">Any</option>
                <option value="true">Has location</option>
                <option value="false">No location</option>
              </select>
            </label>
            <label className="filter-field">
              <span>Camera</span>
              <select
                value={advancedFilters.camera ?? ''}
                onChange={(event) => setAdvancedFilters((f) => ({ ...f, camera: event.target.value || undefined }))}
              >
                <option value="">Any</option>
                {cameras.map((option) => (
                  <option key={option.label} value={option.label}>
                    {option.label} ({option.count})
                  </option>
                ))}
              </select>
            </label>
            <label className="filter-field">
              <span>Order</span>
              <select
                value={advancedFilters.sort ?? 'newest'}
                onChange={(event) => setAdvancedFilters((f) => ({ ...f, sort: event.target.value as 'newest' | 'oldest' }))}
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
              </select>
            </label>
            <button
              type="button"
              className="ghost-button filter-clear"
              onClick={() => setAdvancedFilters({})}
              disabled={Object.keys(advancedFilters).length === 0}
            >
              Clear
            </button>
          </div>
        )}

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
                {/* Only meaningful inside an album: unlinks the items without
                    touching the media itself. */}
                {libraryView === 'album' && activeAlbumId && (
                  <button type="button" onClick={() => void handleRemoveFromAlbum()}><X size={14} /> Remove</button>
                )}
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
              <button className="notice-close" type="button" aria-label="Dismiss notice" onClick={() => notify('')}><X size={15} /></button>
            </div>
          )}

          <div className={isDragging ? 'drop-zone dragging' : 'drop-zone'} onDragOver={(event) => { event.preventDefault(); setIsDragging(true) }} onDragLeave={() => setIsDragging(false)} onDrop={handleDrop}>
            {libraryView === 'albums' ? (
              <AlbumsPage
                albums={albums}
                onOpen={(album) => { setActiveAlbumId(album.id); setLibraryView('album'); setSelectedIds(new Set()) }}
                onCreate={handleCreateAlbum}
                onRename={handleRenameAlbum}
                onDelete={handleDeleteAlbum}
                onNotice={notify}
              />
            ) : libraryView === 'utilities' ? (
              <UtilitiesPage onNotice={setNotice} />
            ) : libraryView === 'people' ? (
              <PeoplePage
                onNotice={notify}
                onOpenMedia={(item) => setViewingItem(itemFromApi(item, mediaUrl))}
                onPersonChanged={(person) => setPeople((current) => current.map((each) => each.id === person.id ? person : each))}
                onPersonDeleted={(personId) => setPeople((current) => current.filter((each) => each.id !== personId))}
              />
            ) : libraryView === 'explore' ? (
              <ExplorePage onNotice={setNotice} onOpenMedia={(item) => setViewingItem(itemFromApi(item, mediaUrl))} />
            ) : initialLoading ? (
              <SkeletonGrid />
            ) : loadError ? (
              <div className="grid-error" role="alert">
                <AlertCircle size={22} />
                <h3>The library could not be loaded</h3>
                <p>{loadError}</p>
                <button type="button" className="btn btn--secondary" onClick={() => { setInitialLoading(true); void refreshLibrary() }}>
                  Try again
                </button>
              </div>
            ) : groupedItems.length > 0 ? groupedItems.map((group) => (
              <section className="date-group" key={dateKey(group.date)}>
                <div className="date-heading"><h3>{group.label}</h3><span>{group.items.length} {group.items.length === 1 ? 'item' : 'items'}</span></div>
                <div className="media-grid">
                  {group.items.map((item) => <MediaCard key={item.id} item={item} selected={selectedIds.has(item.id)} onSelect={(event) => selectWithRange(item.id, event)} onRetry={handleRetry} onConnect={() => setIsTelegramOpen(true)} onView={setViewingItem} onFavorite={() => void toggleFavorite(item)} onEdit={() => setEditingItem(item)} onContextMenu={(event) => { event.preventDefault(); setMenu({ item, x: event.clientX, y: event.clientY }) }} />)}
                </div>
              </section>
            )) : (
              <EmptyState onUpload={() => fileInputRef.current?.click()} />
            )}
            {nextCursor && (
              <div className="load-more" ref={loadMoreSentinelRef}>
                <button type="button" className="ghost-button" onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore ? 'Loading more…' : 'Load more'}
                </button>
                <p className="load-more-hint">
                  {loadingMore ? 'Fetching the next page…' : 'Scroll down and more photos load on their own.'}
                </p>
              </div>
            )}
          </div>
        </div>
      </main>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          actions={menuActions(menu.item)}
          onClose={() => setMenu(null)}
        />
      )}
      {isTelegramOpen && <TelegramModal status={telegramStatus} onConnected={handleTelegramConnected} onDisconnected={handleTelegramDisconnected} onClose={() => setIsTelegramOpen(false)} />}
      {editingItem && <MediaDetailsModal item={editingItem} onSave={saveDetails} onClose={() => setEditingItem(null)} />}
      {viewingItem && <MediaViewer
        item={viewingItem}
        items={filteredItems}
        onChange={setViewingItem}
        onClose={() => setViewingItem(null)}
        onFavorite={() => void toggleFavorite(viewingItem)}
      />}
    </div>
  )
}

export default App
