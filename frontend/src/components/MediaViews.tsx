/**
 * Presentational components lifted out of App.tsx.
 *
 * They take everything through props and hold only local UI state (loading,
 * hover, the viewer's preview/original toggle), so they can be reasoned about
 * without the timeline, filters or auth that App owns. App.tsx had grown past
 * 1200 lines with these inline; keeping them here is what makes the remaining
 * app state small enough to follow.
 */

import { useEffect, useState } from 'react'
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Download,
  ImagePlus,
  MapPin,
  Pencil,
  Play,
  RefreshCw,
  Send,
  Star,
  Upload,
  X,
  Zap,
} from 'lucide-react'

import type { MediaItem } from '../types'
import type { TelegramStatus } from '../api'
import { mediaUrl, startTelegramAuth, verifyTelegramAuth, disconnectTelegram, type TelegramAuthResponse } from '../api'
import {
  formatDateHeading,
  formatDuration,
  formatSize,
  formatTime,
  statusLabel,
} from '../lib/format'

export function MediaCard({ item, selected, onSelect, onRetry, onConnect, onView, onFavorite, onEdit, onContextMenu }: {
  item: MediaItem
  selected: boolean
  /** Receives the event so shift-click ranges and plain clicks can differ. */
  onSelect: (event: React.MouseEvent) => void
  onRetry: (item: MediaItem) => void
  onConnect: () => void
  onView: (item: MediaItem) => void
  onFavorite: () => void
  onEdit: () => void
  onContextMenu: (event: React.MouseEvent) => void
}) {
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
  // Only show the blur-up once the real thumbnail has decoded, otherwise the
  // tile would flash blurry and then fade to the same blurry image.
  const [loaded, setLoaded] = useState(false)

  return (
    <article
      className={selected ? 'media-card selected' : 'media-card'}
      data-id={item.id}
      onContextMenu={onContextMenu}
    >
      <div
        className={`media-preview${loaded ? ' loaded' : ''}`}
        style={item.microUrl && !previewFailed ? { backgroundImage: `url(${item.microUrl})` } : undefined}
        role="button"
        tabIndex={0}
        aria-label={`Open ${item.name}`}
        onClick={(event) => (canView ? onView(item) : onSelect(event))}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            // A keyboard activation has no pointer position, so it is always a
            // plain toggle rather than a shift range.
            if (canView) onView(item)
            else onSelect(event as unknown as React.MouseEvent)
          }
        }}
      >
        {previewFailed
          ? <div className="preview-missing">
              <AlertCircle size={16} />
              <span>{item.fileState === 'missing' ? 'File missing' : 'Preview unavailable'}</span>
            </div>
          : <img
              src={item.url}
              alt={item.name}
              loading="lazy"
              decoding="async"
              onLoad={() => setLoaded(true)}
              onError={() => setPreviewFailed(true)}
            />}
        {item.type === 'video' && <div className="video-overlay"><Play size={14} fill="currentColor" /></div>}
        {item.type === 'video' && item.duration !== undefined && <span className="duration-chip">{formatDuration(item.duration)}</span>}
        {item.uploadStatus !== 'uploaded' && <span className={`backup-chip status-${item.uploadStatus}`}>{statusIcon} {statusLabel(item.uploadStatus)}</span>}
        <button
          className={selected ? 'select-button selected' : 'select-button'}
          type="button"
          aria-label={selected ? `Deselect ${item.name}` : `Select ${item.name}`}
          onClick={(event) => { event.stopPropagation(); onSelect(event) }}
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

export function MediaDetailsModal({ item, onSave, onClose }: { item: MediaItem; onSave: (item: MediaItem, description: string, folderPath: string, capturedAt: string) => Promise<void>; onClose: () => void }) {
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

export function EmptyState({ onUpload }: { onUpload: () => void }) {
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

export function TelegramModal({ status, onConnected, onDisconnected, onClose }: { status: TelegramStatus; onConnected: () => Promise<void>; onDisconnected: () => Promise<void>; onClose: () => void }) {
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

export function MediaViewer({ item, items, onChange, onClose }: { item: MediaItem; items: MediaItem[]; onChange: (item: MediaItem) => void; onClose: () => void }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  // Videos default to the small proxy; this flips to the Telegram original on
  // request or when the proxy fails.
  const [playingOriginal, setPlayingOriginal] = useState(false)
  const currentIndex = items.findIndex((candidate) => candidate.id === item.id)
  const hasPrevious = currentIndex > 0
  const hasNext = currentIndex >= 0 && currentIndex < items.length - 1

  useEffect(() => {
    setLoading(true)
    setError('')
    // Each video starts on its proxy again rather than inheriting the previous
    // clip's "play original" choice.
    setPlayingOriginal(false)
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
            {item.type === 'video' && item.proxyUrl && (
              <button
                className="download-button"
                type="button"
                onClick={() => setPlayingOriginal((v) => !v)}
                title={
                  playingOriginal
                    ? 'Full quality, downloads the whole file first'
                    : 'A smaller copy that starts instantly'
                }
              >
                {playingOriginal ? 'Playing original' : 'Playing preview'}
              </button>
            )}
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
            <video
              key={`${item.id}-${attempt}-${playingOriginal ? 'orig' : 'proxy'}`}
              src={playingOriginal ? item.telegramUrl : item.proxyUrl ?? item.telegramUrl}
              controls
              autoPlay
              playsInline
              preload="metadata"
              onLoadedData={() => setLoading(false)}
              onError={() => {
                setLoading(false)
                // Falling back automatically matters: an old library predates
                // proxies, and a proxy can fail on an exotic codec. The
                // original always exists if the file survived.
                if (!playingOriginal && item.telegramUrl) {
                  setPlayingOriginal(true)
                  setLoading(true)
                } else {
                  setError('This video format cannot be played here. The original file is still in Telegram.')
                }
              }}
            />
          )}
          {hasNext && <button className="viewer-nav viewer-nav-right" type="button" aria-label="Next item" onClick={() => onChange(items[currentIndex + 1])}><ChevronRight size={25} /></button>}
        </div>
        <footer className="viewer-footer"><span>{currentIndex + 1} of {items.length} · {formatDateHeading(item.capturedAt)} · {formatTime(item.capturedAt)}</span><span>{formatSize(item.size)} · Original file</span></footer>
      </section>
    </div>
  )
}
