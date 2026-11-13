import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Clock, HardDrive, KeyRound, Send, ShieldCheck, Sun } from 'lucide-react'
import {
  getAuthStatus,
  getBackupStatus,
  getIntegrityStatus,
  getTelegramStatus,
  type AuthStatus,
  type BackupState,
  type IntegritySummary,
  type TelegramStatus,
} from '../api'
import { Spinner } from './Spinner'
import type { Theme } from '../hooks/useTheme'

type Props = {
  theme: Theme
  onThemeChange: (mode: Theme) => void
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
  onOpenTelegram: () => void
  onOpenUtilities: () => void
}

/**
 * Settings surfaces state that already exists elsewhere in the app but was
 * scattered across a sidebar badge, a Utilities tab and nothing at all for
 * backup. Everything here is read-only except appearance, because the backup
 * threshold and model choices live in the env file and a control that appeared
 * to change them without affecting the running process would be dishonest.
 */
export function SettingsPage({
  theme,
  onThemeChange,
  sidebarCollapsed,
  onToggleSidebar,
  onOpenTelegram,
  onOpenUtilities,
}: Props) {
  const [telegram, setTelegram] = useState<TelegramStatus | null>(null)
  const [backup, setBackup] = useState<BackupState | null>(null)
  const [integrity, setIntegrity] = useState<IntegritySummary | null>(null)
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [savedTelegram, savedBackup, savedIntegrity, savedAuth] = await Promise.all([
        getTelegramStatus(),
        getBackupStatus(),
        getIntegrityStatus(),
        getAuthStatus(),
      ])
      setTelegram(savedTelegram)
      setBackup(savedBackup)
      setIntegrity(savedIntegrity)
      setAuth(savedAuth)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The status could not be read.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  function formatWhen(value: string | null): string {
    if (!value) return 'never'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return 'never'
    const minutes = Math.round((Date.now() - date.getTime()) / 60000)
    if (minutes < 1) return 'just now'
    if (minutes < 60) return `${minutes} minutes ago`
    const hours = Math.round(minutes / 60)
    if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
    const days = Math.round(hours / 24)
    return `${days} ${days === 1 ? 'day' : 'days'} ago`
  }

  if (loading) {
    return (
      <div className="settings-page">
        <div className="settings-loading"><Spinner label="Reading status" /></div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="settings-page">
        <div className="grid-error" role="alert">
          <AlertCircle size={22} />
          <h3>Settings could not be loaded</h3>
          <p>{error}</p>
          <button className="ghost-button" type="button" onClick={() => void load()}>Try again</button>
        </div>
      </div>
    )
  }

  const missing = integrity?.missing ?? 0

  return (
    <div className="settings-page">
      <section className="settings-section">
        <h2>Status</h2>
        <p className="settings-hint">Read from the local service just now.</p>

        <div className="settings-row">
          <div className="settings-row-icon"><Send size={17} /></div>
          <div className="settings-row-body">
            <strong>Telegram</strong>
            <span>
              {telegram?.connected
                ? `Connected as ${telegram.display_name ?? telegram.username ?? 'your account'}.`
                : telegram?.configured
                  ? 'Configured but not connected yet.'
                  : 'No Telegram account is configured.'}
            </span>
          </div>
          <button className="ghost-button" type="button" onClick={onOpenTelegram}>
            {telegram?.connected ? 'Manage' : 'Set up'}
          </button>
        </div>

        <div className="settings-row">
          <div className="settings-row-icon"><Clock size={17} /></div>
          <div className="settings-row-body">
            <strong>Backup</strong>
            <span>
              {backup
                ? `Last backed up ${formatWhen(backup.last_backup_at)}. ${backup.changes_since_backup} change${backup.changes_since_backup === 1 ? '' : 's'} since.`
                : 'Backup status is unavailable.'}
            </span>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-icon">
            {missing === 0 ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}
          </div>
          <div className="settings-row-body">
            <strong>Library integrity</strong>
            <span>
              {integrity
                ? missing === 0
                  ? `${integrity.ok} items verified. Every local file matches its record.`
                  : `${integrity.ok} verified, ${missing} missing${integrity.unchecked > 0 ? `, ${integrity.unchecked} not yet checked` : ''}.`
                : 'Integrity status is unavailable.'}
              {integrity?.last_checked_at ? ` Last checked ${formatWhen(integrity.last_checked_at)}.` : ''}
            </span>
          </div>
          <button className="ghost-button" type="button" onClick={onOpenUtilities}>Utilities</button>
        </div>

        <div className="settings-row">
          <div className="settings-row-icon"><KeyRound size={17} /></div>
          <div className="settings-row-body">
            <strong>Access token</strong>
            <span>
              {auth?.required
                ? 'Required. This vault asks for a token before showing media.'
                : 'Not required. Requests are accepted from this machine only.'}
            </span>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2>Appearance</h2>

        <div className="settings-row">
          <div className="settings-row-icon"><Sun size={17} /></div>
          <div className="settings-row-body">
            <strong>Theme</strong>
            {/* No "system" option: the app reads prefers-color-scheme only until
                you pick a theme, and stores the explicit choice. Offering a
                System button that could not restore that behaviour would be a
                control that does nothing. */}
            <span>Your system setting is used until you choose here.</span>
          </div>
          <div className="segmented" role="group" aria-label="Theme">
            {(['light', 'dark'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={theme === mode ? 'segmented-item active' : 'segmented-item'}
                onClick={() => onThemeChange(mode)}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-icon"><HardDrive size={17} /></div>
          <div className="settings-row-body">
            <strong>Sidebar</strong>
            <span>Collapse the sidebar to widen the photo grid.</span>
          </div>
          <button className="ghost-button" type="button" onClick={onToggleSidebar}>
            {sidebarCollapsed ? 'Expand' : 'Collapse'}
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h2>Maintenance</h2>
        <p className="settings-hint">
          Rebuilding, verifying and thumbnail backfill all live on the Utilities page,
          next to the actions that repair them.
        </p>
        <div className="settings-row">
          <div className="settings-row-icon"><ShieldCheck size={17} /></div>
          <div className="settings-row-body">
            <strong>Repair tools</strong>
            <span>Verify files, rebuild the index from Telegram, refill thumbnails.</span>
          </div>
          <button className="ghost-button" type="button" onClick={onOpenUtilities}>Open Utilities</button>
        </div>
      </section>
    </div>
  )
}
