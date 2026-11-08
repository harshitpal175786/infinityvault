/**
 * Library browsing state: which view is open, how the timeline is filtered,
 * and the album/tag/camera lists that populate the filter and sidebar menus.
 *
 * This was 15 separate `useState` calls threaded through App.tsx, which made it
 * hard to see which fields actually affect a request and which are just chrome.
 * Grouping them here keeps the rule explicit: buildFilterParams() is the single
 * source of truth for what the server is asked for, so the timeline, the
 * "load more" cursor and the poll can never disagree about the filter.
 */

import { useState } from 'react'

import type { Album, CameraOption, MediaFilterParams, Tag } from '../api'
import type { MediaType } from '../types'

export type Filter = 'all' | MediaType
export type LibraryView =
  | 'library'
  | 'favorites'
  | 'archive'
  | 'trash'
  | 'album'
  | 'utilities'
  | 'people'
  | 'explore'

export const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All media' },
  { value: 'photo', label: 'Photos' },
  { value: 'video', label: 'Videos' },
]

export function useLibraryFilters() {
  const [libraryView, setLibraryView] = useState<LibraryView>('library')
  const [filter, setFilter] = useState<Filter>('all')
  const [sortDirection, setSortDirection] = useState<'desc' | 'asc'>('desc')

  const [filtersOpen, setFiltersOpen] = useState(false)
  const [advancedFilters, setAdvancedFilters] = useState<MediaFilterParams>({})

  const [activeAlbumId, setActiveAlbumId] = useState<string>()
  const [albums, setAlbums] = useState<Album[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [cameras, setCameras] = useState<CameraOption[]>([])

  const [query, setQuery] = useState('')
  const [searchTerm, setSearchTerm] = useState('')

  /**
   * What to send to /api/media.
   *
   * Only the advanced dropdowns reach the server. The sidebar All/Photos/Videos
   * tab is deliberately *not* included: it has always been applied on the
   * already-fetched page in App.tsx, and sending it here would change behaviour
   * (Videos-only would then stop paginating while photos remain). Fixing that
   * is a real improvement but a separate change, not a refactor.
   *
   * `sortDirection` is likewise absent: ordering is applied client-side in the
   * timeline memo, matching the sidebar toggle. The Order dropdown lives in
   * advancedFilters and does reach the server.
   */
  function buildFilterParams(): MediaFilterParams {
    return { ...advancedFilters }
  }

  /** How many advanced filters are active, for the badge on the Filter button. */
  function activeFilterCount(): number {
    return Object.entries(advancedFilters).filter(([, value]) => value !== undefined && value !== '').length
  }

  function clearAdvancedFilters() {
    setAdvancedFilters({})
  }

  /**
   * Switch the main view.
   *
   * Kept here because it touches four pieces of this state at once and every
   * entry point (sidebar, drawer, keyboard) must do exactly the same thing.
   */
  function openView(view: LibraryView, albumId?: string) {
    setLibraryView(view)
    setActiveAlbumId(albumId)
    setFilter('all')
    // A view switch keeps the scroll position by default, which lands the user
    // mid-timeline in a library they have never seen. Ease back to the top;
    // the reduced-motion query makes this an instant jump.
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return {
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
    activeFilterCount,
    clearAdvancedFilters,
    openView,
  }
}
