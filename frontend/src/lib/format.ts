/**
 * Formatting helpers shared by the timeline, the viewer and the cards.
 *
 * These lived inside App.tsx and were reached from components defined in the
 * same file. Extracting them keeps the presentational components testable and
 * stops App.tsx from being the only place they can be used from.
 */

export function formatDateHeading(date: Date): string {
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

export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

export function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function formatSize(size: number): string {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function formatDuration(seconds?: number): string | undefined {
  if (seconds === undefined) return undefined
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.floor(seconds % 60)
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
}

export function statusLabel(status: string): string {
  if (status === 'uploaded') return 'Backed up'
  if (status === 'uploading') return 'Uploading'
  if (status === 'waiting_for_telegram') return 'Waiting for Telegram'
  if (status === 'failed') return 'Retry needed'
  if (status === 'local') return 'Local only'
  return 'Queued'
}


import type { MediaItem, UploadStatus } from '../types'

type ApiMediaLike = {
  id: string
  name: string
  type: 'photo' | 'video'
  preview_url: string
  content_url?: string | null
  telegram_url?: string | null
  telegram_download_url?: string | null
  proxy_url?: string | null
  thumb_state?: string
  size: number
  captured_at: string
  source_label: string
  width?: number
  height?: number
  duration?: number
  upload_status: string
  file_state?: 'present' | 'missing' | 'recovering'
  upload_error?: string | null
  telegram_message_id?: number | null
  checksum?: string | null
  is_favorite?: boolean
  is_archived?: boolean
  is_trashed?: boolean
  description?: string | null
  folder_path?: string | null
}

/**
 * Map the API shape onto the UI model.
 *
 * Takes the URL builder as an argument rather than importing it, so this stays
 * free of React state (the token is read at call time) and stays testable.
 */
export function itemFromApi(media: ApiMediaLike, mediaUrl: (path: string) => string): MediaItem {
  return {
    id: media.id,
    name: media.name,
    type: media.type,
    url: mediaUrl(media.preview_url),
    microUrl:
      media.thumb_state === 'ready'
        ? mediaUrl(`${media.preview_url.replace('/thumbnail', '/micro-thumbnail')}`)
        : undefined,
    contentUrl: media.content_url ? mediaUrl(media.content_url) : undefined,
    telegramUrl: media.telegram_url ? mediaUrl(media.telegram_url) : undefined,
    proxyUrl: media.proxy_url ? mediaUrl(media.proxy_url) : undefined,
    downloadUrl: media.telegram_download_url ? mediaUrl(media.telegram_download_url) : undefined,
    size: media.size,
    capturedAt: new Date(media.captured_at),
    sourceLabel: media.source_label,
    width: media.width,
    height: media.height,
    duration: media.duration,
    uploadStatus: media.upload_status as UploadStatus,
    fileState: media.file_state,
    uploadError: media.upload_error ?? undefined,
    telegramMessageId: media.telegram_message_id ?? undefined,
    checksum: media.checksum ?? undefined,
    isFavorite: Boolean(media.is_favorite),
    isArchived: Boolean(media.is_archived),
    isTrashed: Boolean(media.is_trashed),
    description: media.description as string,
    folderPath: media.folder_path ?? undefined,
  }
}
