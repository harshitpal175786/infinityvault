import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, CloudUpload, DatabaseBackup, HardDrive, RefreshCw, ShieldCheck } from 'lucide-react'
import { applyRestore, backupMetadata, buildVideoProxies, checkIntegrity, getBackupStatus, getIntegrityStatus, getVideoStatus, listBrokenMedia, scanForRestore, type VideoStatus } from '../api'
import type { ApiMedia, BackupState, IntegritySummary, RestoreScan } from '../api'

function formatChecked(value: string | null): string {
  if (!value) return 'Never checked'
  const when = new Date(value)
  const minutes = Math.max(0, Math.round((Date.now() - when.getTime()) / 60000))
  if (minutes < 1) return 'Checked just now'
  if (minutes < 60) return `Checked ${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `Checked ${hours}h ago`
  return `Checked ${Math.round(hours / 24)}d ago`
}

/**
 * Utilities: library health.
 *
 * The integrity check proves that each backed-up original still exists in
 * Telegram. It does NOT verify byte-for-byte equality, because that would
 * require re-downloading every file. The copy here says so plainly rather
 * than implying a stronger guarantee than we can make.
 */
export function UtilitiesPage({ onNotice }: { onNotice: (message: string) => void }) {
  const [summary, setSummary] = useState<IntegritySummary | null>(null)
  const [broken, setBroken] = useState<ApiMedia[]>([])
  const [running, setRunning] = useState(false)
  const [scan, setScan] = useState<RestoreScan | null>(null)
  const [busy, setBusy] = useState<'scan' | 'restore' | 'backup' | null>(null)
  const [backupState, setBackupState] = useState<BackupState | null>(null)
  const [videos, setVideos] = useState<VideoStatus | null>(null)

  const load = useCallback(async () => {
    try {
      const [nextSummary, nextBroken, nextBackup, nextVideos] = await Promise.all([
        getIntegrityStatus(),
        listBrokenMedia(),
        getBackupStatus().catch(() => null),
        getVideoStatus().catch(() => null),
      ])
      setSummary(nextSummary)
      setBroken(nextBroken)
      if (nextBackup) setBackupState(nextBackup)
      if (nextVideos) setVideos(nextVideos)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Could not read library health.')
    }
  }, [onNotice])

  useEffect(() => {
    void load()
  }, [load])

  async function runCheck() {
    setRunning(true)
    try {
      const result = await checkIntegrity()
      setSummary(result)
      setBroken(await listBrokenMedia())
      onNotice(
        result.missing
          ? `${result.missing} ${result.missing === 1 ? 'original is' : 'originals are'} missing from Telegram.`
          : `All ${result.ok} originals are present in Telegram.`,
      )
    } catch (error) {
      // The usual cause is Telegram not being connected, which the server
      // reports with an actionable message.
      onNotice(error instanceof Error ? error.message : 'The check could not run.')
    } finally {
      setRunning(false)
    }
  }

  async function runBackup() {
    setBusy('backup')
    try {
      const result = await backupMetadata()
      setBackupState(await getBackupStatus().catch(() => backupState))
      onNotice(`Metadata backed up to Telegram: ${result.media} media, ${result.albums} albums, ${result.tags} tags.`)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'The backup could not be uploaded.')
    } finally {
      setBusy(null)
    }
  }

  async function runScan() {
    setBusy('scan')
    try {
      const result = await scanForRestore()
      setScan(result)
      onNotice(
        result.media_found
          ? `Found ${result.media_found} backed-up item${result.media_found === 1 ? '' : 's'} in Telegram.`
          : 'No InfinityVault backups were found in your Saved Messages.',
      )
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Saved Messages could not be scanned.')
    } finally {
      setBusy(null)
    }
  }

  async function runRestore() {
    setBusy('restore')
    try {
      const result = await applyRestore()
      setScan(await scanForRestore().catch(() => scan))
      await load()
      const parts = [`${result.restored_media} restored`]
      if (result.metadata_backup) {
        parts.push(`${result.metadata_backup.albums} albums`, `${result.metadata_backup.tags} tags`)
      }
      onNotice(`Restore finished: ${parts.join(', ')}.`)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'The restore could not be completed.')
    } finally {
      setBusy(null)
    }
  }

  const total = summary ? summary.ok + summary.missing + summary.unchecked : 0

  return (
    <div className="utilities-page">
      <section className="utility-card">
        <div className="utility-card-head">
          <span className="utility-icon"><ShieldCheck size={18} /></span>
          <div>
            <h3>Video previews</h3>
            <p className="utility-copy">
              A preview is a small copy of each video, built once so playback starts
              immediately and the timeline can be scrubbed. The original is untouched
              and still downloads in full.
            </p>
            {videos && (
              <p className="utility-meta">
                {videos.ready} of {videos.total} ready
                {videos.pending > 0 ? ` · ${videos.pending} waiting` : ''}
                {videos.failed > 0 ? ` · ${videos.failed} failed` : ''}
              </p>
            )}
            {videos && !videos.available && (
              <p className="utility-warning">ffmpeg is not installed, so previews cannot be built.</p>
            )}
            <button
              className="primary-button"
              type="button"
              // Only meaningful when something is actually missing: a button
              // that does nothing is worse than a disabled one.
              disabled={
                busy !== null ||
                !videos?.available ||
                videos.pending > 0 ||
                (videos.total > 0 && videos.ready === videos.total)
              }
              onClick={async () => {
                setBusy('scan')
                try {
                  const result = await buildVideoProxies()
                  setVideos(result)
                  onNotice(
                    result.queued > 0
                      ? `Building ${result.queued} video preview${result.queued === 1 ? '' : 's'} in the background.`
                      : 'Every video already has a preview.',
                  )
                } catch (error) {
                  onNotice(error instanceof Error ? error.message : 'Previews could not be queued.')
                } finally {
                  setBusy(null)
                }
              }}
            >
              Build missing previews
            </button>
            {videos && videos.total > 0 && videos.ready === videos.total && (
              <p className="utility-meta">Every video already has a preview.</p>
            )}
            <h3>Library integrity</h3>
            <p className="utility-sub">
              Confirms each backed-up original still exists in Telegram. This checks presence,
              not a byte-for-byte comparison — originals stay in Telegram and are never
              re-downloaded for verification.
            </p>
          </div>
        </div>

        <div className="utility-stats">
          <div className="utility-stat">
            <span className="utility-stat-value">{summary?.ok ?? 0}</span>
            <span className="utility-stat-label"><CheckCircle2 size={13} /> Present</span>
          </div>
          <div className={summary?.missing ? 'utility-stat danger' : 'utility-stat'}>
            <span className="utility-stat-value">{summary?.missing ?? 0}</span>
            <span className="utility-stat-label"><AlertCircle size={13} /> Missing</span>
          </div>
          <div className="utility-stat">
            <span className="utility-stat-value">{summary?.unchecked ?? 0}</span>
            <span className="utility-stat-label"><HardDrive size={13} /> Not yet checked</span>
          </div>
        </div>

        <div className="utility-actions">
          <button type="button" className="primary-button" onClick={() => void runCheck()} disabled={running || total === 0}>
            <RefreshCw size={14} className={running ? 'spinning' : ''} />
            {running ? 'Checking…' : 'Check library'}
          </button>
          <span className="utility-meta">{formatChecked(summary?.last_checked_at ?? null)}</span>
        </div>
      </section>

      <section className="utility-card">
        <div className="utility-card-head">
          <span className="utility-icon"><CloudUpload size={18} /></span>
          <div>
            <h3>Metadata backup</h3>
            <p className="utility-sub">
              Saves albums, tags, favourites and descriptions to Telegram as a small JSON file.
              Your photos already live in Telegram, but this organisation exists only on this
              machine — without it, reinstalling would lose it permanently.
            </p>
          </div>
        </div>
        {backupState && (
          <p className="utility-sub utility-backup-state">
            {backupState.last_backup_at
              ? `Last backed up ${new Date(backupState.last_backup_at).toLocaleString()}.`
              : 'Never backed up — your albums and tags exist only on this machine.'}
            {backupState.changes_since_backup > 0 &&
              ` ${backupState.changes_since_backup} change${
                backupState.changes_since_backup === 1 ? '' : 's'
              } since then; it backs up automatically every ${backupState.threshold}.`}
          </p>
        )}
        <div className="utility-actions">
          <button type="button" className="primary-button" onClick={() => void runBackup()} disabled={busy !== null}>
            <DatabaseBackup size={14} />
            {busy === 'backup' ? 'Uploading…' : 'Back up metadata'}
          </button>
        </div>
      </section>

      <section className="utility-card">
        <div className="utility-card-head">
          <span className="utility-icon"><RefreshCw size={18} /></span>
          <div>
            <h3>Restore from Telegram</h3>
            <p className="utility-sub">
              Rebuilds this library from your Saved Messages. If a metadata backup is found it is
              applied first, so albums and tags come back with the photos. Without one, only the
              photos themselves can be recovered.
            </p>
          </div>
        </div>

        {scan && (
          <div className="utility-stats">
            <div className="utility-stat">
              <span className="utility-stat-value">{scan.media_found}</span>
              <span className="utility-stat-label">Backed-up items</span>
            </div>
            <div className="utility-stat">
              <span className="utility-stat-value">{scan.has_metadata_backup ? 'Yes' : 'No'}</span>
              <span className="utility-stat-label">Metadata backup found</span>
            </div>
            <div className="utility-stat">
              <span className="utility-stat-value">{scan.scanned}</span>
              <span className="utility-stat-label">Messages scanned</span>
            </div>
          </div>
        )}

        <div className="utility-actions">
          <button type="button" className="ghost-button" onClick={() => void runScan()} disabled={busy !== null}>
            {busy === 'scan' ? 'Scanning…' : 'Scan Saved Messages'}
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => void runRestore()}
            disabled={busy !== null || !scan || scan.media_found === 0}
          >
            {busy === 'restore' ? 'Restoring…' : 'Restore library'}
          </button>
          {scan && !scan.has_metadata_backup && scan.media_found > 0 && (
            <span className="utility-meta">No metadata backup: albums and tags cannot be recovered.</span>
          )}
        </div>
      </section>

      {broken.length > 0 && (
        <section className="utility-card">
          <div className="utility-card-head">
            <span className="utility-icon danger"><AlertCircle size={18} /></span>
            <div>
              <h3>Missing originals</h3>
              <p className="utility-sub">
                These files no longer exist in Telegram. Their details are kept so you can
                re-upload them from another copy.
              </p>
            </div>
          </div>
          <ul className="utility-list">
            {broken.map((item) => (
              <li key={item.id}>
                <span className="utility-list-name">{item.name}</span>
                <span className="utility-list-meta">
                  {new Date(item.captured_at).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
