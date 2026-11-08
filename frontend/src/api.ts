import type { MediaItem, UploadStatus } from './types'

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:8000'
const CLIENT_ID_KEY = 'infinityvault-client-id'
const LEGACY_CLIENT_ID_KEY = 'chronicle-client-id'

export type TelegramStatus = {
  configured: boolean
  connected: boolean
  display_name: string | null
  username: string | null
}

export type TelegramAuthResponse = {
  status: 'code_required' | 'password_required' | 'connected'
  display_name?: string
  username?: string | null
  telegram_user_id?: number
}

export type ApiMedia = {
  id: string
  name: string
  type: 'photo' | 'video'
  mime_type: string
  size: number
  captured_at: string
  source_label: string
  width?: number
  height?: number
  duration?: number
  preview_url: string
  file_state?: 'present' | 'missing' | 'recovering'
  content_url?: string
  thumb_state?: 'pending' | 'running' | 'ready' | 'failed'
  telegram_url?: string
  telegram_download_url?: string
  upload_status: UploadStatus
  upload_error?: string
  telegram_message_id?: number
  checksum?: string
  is_favorite: boolean
  is_archived: boolean
  is_trashed: boolean
  description: string
  folder_path?: string
  duplicate?: boolean
}

export type Album = {
  id: string
  client_id: string
  name: string
  description: string
  media_count: number
}

export type Tag = {
  id: string
  client_id: string
  name: string
  media_count: number
}

function getClientId(): string {
  const existing = window.localStorage.getItem(CLIENT_ID_KEY)
  if (existing) return existing
  const legacy = window.localStorage.getItem(LEGACY_CLIENT_ID_KEY)
  if (legacy) {
    window.localStorage.setItem(CLIENT_ID_KEY, legacy)
    return legacy
  }
  const clientId = crypto.randomUUID()
  window.localStorage.setItem(CLIENT_ID_KEY, clientId)
  return clientId
}

export const clientId = getClientId()

export function mediaUrl(path: string): string {
  const separator = path.includes('?') ? '&' : '?'
  return `${path.startsWith('http') ? path : `${API_BASE}${path}`}${separator}client_id=${encodeURIComponent(clientId)}`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('X-Client-ID', clientId)
  if (!(init?.body instanceof FormData)) headers.set('Content-Type', 'application/json')

  const response = await fetch(`${API_BASE}${path}`, { ...init, headers })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload.detail ?? 'The server could not complete that request.')
  }
  return payload as T
}

export function getTelegramStatus(): Promise<TelegramStatus> {
  return request<TelegramStatus>('/api/telegram/status')
}

export function startTelegramAuth(phoneNumber: string): Promise<TelegramAuthResponse> {
  return request<TelegramAuthResponse>('/api/telegram/auth/start', {
    method: 'POST',
    body: JSON.stringify({ phone_number: phoneNumber }),
  })
}

export function verifyTelegramAuth(code: string, password?: string): Promise<TelegramAuthResponse> {
  return request<TelegramAuthResponse>('/api/telegram/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ code, password }),
  })
}

export function disconnectTelegram(): Promise<{ connected: false }> {
  return request<{ connected: false }>('/api/telegram/disconnect', { method: 'POST' })
}

export interface MediaPage {
  items: ApiMedia[]
  nextCursor: string | null
}

/** One page of media. Cursors are opaque; pass `nextCursor` to continue. */
export async function listMediaPage(
  view = 'library',
  search = '',
  albumId?: string,
  cursor?: string | null,
  limit = 200,
): Promise<MediaPage> {
  const params = new URLSearchParams({ view, limit: String(limit) })
  if (search.trim()) params.set('search', search.trim())
  if (albumId) params.set('album_id', albumId)
  if (cursor) params.set('cursor', cursor)
  const page = await request<{ items: ApiMedia[]; next_cursor: string | null }>(
    `/api/media?${params.toString()}`,
  )
  return { items: page.items, nextCursor: page.next_cursor }
}

export async function listMedia(view = 'library', search = '', albumId?: string): Promise<ApiMedia[]> {
  const params = new URLSearchParams({ view })
  if (search.trim()) params.set('search', search.trim())
  if (albumId) params.set('album_id', albumId)
  return request<ApiMedia[]>(`/api/media?${params.toString()}`)
}

export async function uploadMedia(item: MediaItem): Promise<ApiMedia> {
  if (!item.file) throw new Error('The selected file is no longer available. Please choose it again.')
  const form = new FormData()
  form.append('file', item.file)
  form.append('captured_at', item.capturedAt.toISOString())
  form.append('capture_source', item.sourceLabel)
  form.append('media_type', item.type)
  if (item.width) form.append('width', String(item.width))
  if (item.height) form.append('height', String(item.height))
  if (item.duration !== undefined) form.append('duration', String(item.duration))
  return request<ApiMedia>('/api/media', { method: 'POST', body: form })
}

export function retryMedia(id: string): Promise<ApiMedia> {
  return request<ApiMedia>(`/api/media/${id}/retry`, { method: 'POST' })
}

export type MediaUpdate = {
  favorite?: boolean
  archived?: boolean
  trashed?: boolean
  description?: string
  captured_at?: string
  folder_path?: string
}

export function updateMedia(id: string, payload: MediaUpdate): Promise<ApiMedia> {
  return request<ApiMedia>(`/api/media/${id}`, { method: 'PATCH', body: JSON.stringify(payload) })
}

export function deleteMedia(id: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/api/media/${id}`, { method: 'DELETE' })
}

export function listAlbums(): Promise<Album[]> {
  return request<Album[]>('/api/albums')
}

export function createAlbum(name: string, description = ''): Promise<Album> {
  return request<Album>('/api/albums', { method: 'POST', body: JSON.stringify({ name, description }) })
}

export function deleteAlbum(id: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/api/albums/${id}`, { method: 'DELETE' })
}

export function addMediaToAlbum(id: string, mediaIds: string[]): Promise<{ added: number }> {
  return request<{ added: number }>(`/api/albums/${id}/media`, { method: 'POST', body: JSON.stringify({ media_ids: mediaIds }) })
}

export function listTags(): Promise<Tag[]> {
  return request<Tag[]>('/api/tags')
}

export function createTag(name: string): Promise<Tag> {
  return request<Tag>('/api/tags', { method: 'POST', body: JSON.stringify({ name }) })
}

export function addTagToMedia(id: string, mediaIds: string[]): Promise<{ added: number }> {
  return request<{ added: number }>(`/api/tags/${id}/media`, { method: 'POST', body: JSON.stringify({ media_ids: mediaIds }) })
}

export interface IntegritySummary {
  ok: number
  missing: number
  unchecked: number
  last_checked_at: string | null
}

export function getIntegrityStatus(): Promise<IntegritySummary> {
  return request<IntegritySummary>('/api/integrity/status')
}

export function checkIntegrity(limit = 500): Promise<IntegritySummary & { total: number }> {
  return request(`/api/integrity/check?limit=${limit}`, { method: 'POST' })
}

export function listBrokenMedia(): Promise<ApiMedia[]> {
  return request<ApiMedia[]>('/api/integrity/broken')
}

export interface RestoreScan {
  scanned: number
  media_found: number
  has_metadata_backup: boolean
}

export interface MetadataBackupResult {
  message_id: number
  filename: string
  media: number
  albums: number
  tags: number
}

export function backupMetadata(): Promise<MetadataBackupResult> {
  return request<MetadataBackupResult>('/api/backup/metadata', { method: 'POST' })
}

export function scanForRestore(): Promise<RestoreScan> {
  return request<RestoreScan>('/api/restore/scan')
}

export function applyRestore(): Promise<{
  restored_media: number
  scanned: number
  found: number
  metadata_backup: { media: number; albums: number; tags: number } | null
}> {
  return request('/api/restore/apply', { method: 'POST' })
}
