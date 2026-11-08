import { useEffect, useRef, useState } from 'react'
import { Folder, Images, MoreVertical, Pencil, Plus, Trash2, X } from 'lucide-react'
import type { Album } from '../api'
import { mediaUrl } from '../api'

/** Cover thumbnails reuse the same endpoint the grid uses. */
function coverUrl(mediaId: string) {
  return mediaUrl(`/api/media/${mediaId}/thumbnail`)
}

interface AlbumsPageProps {
  albums: Album[]
  onOpen: (album: Album) => void
  onCreate: (name: string) => Promise<void>
  onRename: (album: Album, name: string) => Promise<void>
  onDelete: (album: Album) => Promise<void>
  onNotice: (message: string) => void
}

/**
 * Album browser.
 *
 * Albums were previously only a flat list of buttons in the sidebar, so there
 * was no cover, no count beyond a number, and no way to rename or delete one
 * even though delete already existed in the API and was never called.
 */
export function AlbumsPage({ albums, onOpen, onCreate, onRename, onDelete, onNotice }: AlbumsPageProps) {
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState('')
  const [renaming, setRenaming] = useState<Album | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<Album | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [brokenCovers, setBrokenCovers] = useState<Set<string>>(new Set())
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!menuFor) return
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuFor(null)
    }
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [menuFor])

  async function submitCreate() {
    const name = draft.trim()
    if (!name) {
      onNotice('Give the album a name first.')
      return
    }
    setBusy(true)
    try {
      await onCreate(name)
      setCreating(false)
      setDraft('')
    } finally {
      setBusy(false)
    }
  }

  async function submitRename() {
    if (!renaming) return
    const name = renameDraft.trim()
    if (!name) {
      onNotice('An album needs a name.')
      return
    }
    if (name === renaming.name) {
      setRenaming(null)
      return
    }
    setBusy(true)
    try {
      await onRename(renaming, name)
      setRenaming(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="albums-page">
      <header className="albums-head">
        <div>
          <h2>Albums</h2>
          <p>{albums.length} {albums.length === 1 ? 'album' : 'albums'} in this vault</p>
        </div>
        <button type="button" className="btn btn--primary" onClick={() => { setCreating(true); setDraft('') }}>
          <Plus size={15} /> New album
        </button>
      </header>

      {creating && (
        <div className="album-create">
          <input
            className="text-input"
            placeholder="Album name"
            value={draft}
            maxLength={200}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submitCreate()
              if (event.key === 'Escape') { setCreating(false); setDraft('') }
            }}
          />
          <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => void submitCreate()}>Create</button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setCreating(false); setDraft('') }}>Cancel</button>
        </div>
      )}

      {albums.length === 0 && !creating ? (
        <div className="albums-empty">
          <Folder size={26} />
          <h3>No albums yet</h3>
          <p>Group photos into albums to keep trips and events together. Albums never duplicate the files.</p>
        </div>
      ) : (
        <div className="album-grid">
          {albums.map((album) => (
            <article className="album-card" key={album.id}>
              <button
                type="button"
                className="album-cover"
                onClick={() => onOpen(album)}
                aria-label={`Open ${album.name}`}
              >
                {album.cover_media_id && !brokenCovers.has(album.id) ? (
                  <img
                    src={coverUrl(album.cover_media_id)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    /* A cover whose thumbnail was skipped as oversized or
                       corrupt 404s. Fall back to the placeholder instead of
                       showing a broken-image icon. */
                    onError={() => setBrokenCovers((current) => new Set(current).add(album.id))}
                  />
                ) : (
                  <span className="album-cover-empty"><Images size={22} /></span>
                )}
                <span className="album-count">
                  <Images size={12} /> {album.media_count}
                </span>
              </button>

              <div className="album-meta">
                <button type="button" className="album-name" onClick={() => onOpen(album)}>{album.name}</button>
                <div className="album-menu-wrap">
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Actions for ${album.name}`}
                    aria-expanded={menuFor === album.id}
                    onClick={() => setMenuFor(menuFor === album.id ? null : album.id)}
                  >
                    <MoreVertical size={15} />
                  </button>
                  {menuFor === album.id && (
                    <div className="menu album-menu" role="menu" ref={menuRef}>
                      <button type="button" role="menuitem" className="menu-item" onClick={() => { setRenaming(album); setRenameDraft(album.name); setMenuFor(null) }}>
                        <Pencil size={14} /><span>Rename</span>
                      </button>
                      <button type="button" role="menuitem" className="menu-item menu-item--danger" onClick={() => { setConfirmDelete(album); setMenuFor(null) }}>
                        <Trash2 size={14} /><span>Delete album</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {renaming && (
        <div className="modal-scrim" onMouseDown={(event) => { if (event.currentTarget === event.target) setRenaming(null) }}>
          <div className="modal-panel" role="dialog" aria-modal="true" aria-label="Rename album">
            <div className="modal-head">
              <h2 className="modal-title">Rename album</h2>
              <button type="button" className="icon-button" aria-label="Close" onClick={() => setRenaming(null)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <input
                className="text-input"
                value={renameDraft}
                maxLength={200}
                autoFocus
                onChange={(event) => setRenameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submitRename()
                  if (event.key === 'Escape') setRenaming(null)
                }}
              />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn--ghost" onClick={() => setRenaming(null)}>Cancel</button>
              <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void submitRename()}>Save</button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="modal-scrim" onMouseDown={(event) => { if (event.currentTarget === event.target) setConfirmDelete(null) }}>
          <div className="modal-panel" role="dialog" aria-modal="true" aria-label="Delete album">
            <div className="modal-head">
              <h2 className="modal-title">Delete “{confirmDelete.name}”?</h2>
              <button type="button" className="icon-button" aria-label="Close" onClick={() => setConfirmDelete(null)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              {/* Deleting an album must never be mistaken for deleting photos. */}
              <p>The album is removed. Its {confirmDelete.media_count} {confirmDelete.media_count === 1 ? 'item stays' : 'items stay'} in your library.</p>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn--ghost" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button
                type="button"
                className="btn btn--danger"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    await onDelete(confirmDelete)
                    setConfirmDelete(null)
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                Delete album
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
