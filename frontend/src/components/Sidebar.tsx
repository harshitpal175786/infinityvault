/**
 * The library sidebar: navigation, quick filters, albums and storage status.
 *
 * Lifted out of App.tsx, which had grown past 1200 lines. It is presentational
 * -- every action arrives as a callback, and it reads only the counts and
 * status it displays -- so it can be changed without touching timeline or
 * upload logic. Collapsing and the mobile drawer stay in App, because they
 * interact with layout outside this element.
 */

import { Archive, ChevronsLeft, ChevronsRight, Compass, Film, Images, ImagePlus, ScanFace, Send, Settings2, ShieldCheck, Sparkles, Star, Trash2 } from 'lucide-react'
import { ThemeToggle } from './ThemeToggle'

import type { Album } from '../api'
import type { TelegramStatus } from '../api'
import type { LibraryView } from '../hooks/useLibraryFilters'
import type { MediaItem } from '../types'

type SidebarProps = {
  collapsed: boolean
  libraryView: LibraryView
  filter: 'all' | 'photo' | 'video'
  photoCount: number
  videoCount: number
  albums: Album[]
  items: MediaItem[]
  activeAlbumId?: string
  telegramStatus: TelegramStatus
  openView: (view: LibraryView, albumId?: string) => void
  setFilter: (filter: 'all' | 'photo' | 'video') => void
  onOpenTelegram: () => void
  onCreateAlbum: () => void
  onOpenAlbums: () => void
  onSetDrawerOpen: (open: boolean) => void
  onToggleCollapse: () => void
  theme: 'light' | 'dark'
  onToggleTheme: () => void
}

export function Sidebar({
  collapsed,
  libraryView,
  filter,
  photoCount,
  videoCount,
  albums,
  items,
  activeAlbumId,
  telegramStatus,
  openView,
  setFilter,
  onOpenTelegram,
  onCreateAlbum,
  onOpenAlbums,
  onSetDrawerOpen,
  onToggleCollapse,
  theme,
  onToggleTheme,
}: SidebarProps) {
  return (
      <aside className="sidebar" data-collapsed={collapsed}>
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
          <button
            className={libraryView === 'albums' || libraryView === 'album' ? 'nav-item active' : 'nav-item'}
            type="button"
            onClick={onOpenAlbums}
          >
            <Archive size={18} />
            <span>Albums</span>
            <span className="nav-count">{albums.length}</span>
          </button>
          {/* Individual albums deliberately stay out of the sidebar: with 37 of
              them the navigation became a wall of rows. The Albums page is the
              single place to browse them. */}
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
          <button className={libraryView === 'explore' ? 'nav-item active' : 'nav-item'} type="button" onClick={() => openView('explore')}>
            <Compass size={18} /><span>Explore</span>
          </button>
          <button className={libraryView === 'people' ? 'nav-item active' : 'nav-item'} type="button" onClick={() => openView('people')}>
            <ScanFace size={18} /><span>People</span>
          </button>
          <button className={libraryView === 'utilities' ? 'nav-item active' : 'nav-item'} type="button" onClick={() => openView('utilities')}>
            <ShieldCheck size={18} /><span>Utilities</span>
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
            <button className="icon-button subtle" type="button" aria-label="Open Telegram setup" onClick={() => onOpenTelegram()}>
              <Settings2 size={16} />
            </button>
          </div>
          <button className="connect-button" type="button" onClick={() => onOpenTelegram()}>
            <Send size={16} />
            <span>Connect Telegram</span>
          </button>
        </div>

        <div className="sidebar-footer">
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <button
            className="collapse-button"
            type="button"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={onToggleCollapse}
          >
            {collapsed ? <ChevronsRight size={15} /> : <ChevronsLeft size={15} />}
          </button>
        </div>
      </aside>
  )
}
