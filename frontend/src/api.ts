import type { MediaItem, UploadStatus } from './types'

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:8000'
const CLIENT_ID_KEY = 'infinityvault-client-id'
const LEGACY_CLIENT_ID_KEY = 'chronicle-client-id'
const ACCESS_TOKEN_KEY = 'infinityvault-access-token'

let accessToken: string | null = readStoredToken()
let onUnauthorized: (() => void) | null = null

function readStoredToken(): string | null {
  try {
    return window.localStorage.getItem(ACCESS_TOKEN_KEY)
  } catch {
    return null
  }
}

export function getAccessToken(): string | null {
  return accessToken
}

export function setAccessToken(token: string | null): void {
  accessToken = token && token.trim() ? token.trim() : null
  try {
    if (accessToken) window.localStorage.setItem(ACCESS_TOKEN_KEY, accessToken)
    else window.localStorage.removeItem(ACCESS_TOKEN_KEY)
  } catch {
    /* storage can be unavailable in private modes; the in-memory copy still works */
  }
}

/** Let the app show a token prompt whenever the API rejects a request. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler
}

export type AuthStatus = {
  required: boolean
  configured: boolean
  problem: string | null
}

export function getAuthStatus(): Promise<AuthStatus> {
  return request<AuthStatus>('/api/auth/status')
}

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
  proxy_url?: string | null
  proxy_state?: string
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
  /** Newest item in the album, used as its thumbnail. Null when empty. */
  cover_media_id?: string | null
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
  const base = `${path.startsWith('http') ? path : `${API_BASE}${path}`}${separator}client_id=${encodeURIComponent(clientId)}`
  // <img>, <video> and download anchors cannot set an Authorization header, so
  // the token has to travel in the query string here. Same reason as client_id.
  return accessToken ? `${base}&access_token=${encodeURIComponent(accessToken)}` : base
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('X-Client-ID', clientId)
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  if (!(init?.body instanceof FormData)) headers.set('Content-Type', 'application/json')

  const response = await fetch(`${API_BASE}${path}`, { ...init, headers })
  const payload = await response.json().catch(() => ({}))
  if (response.status === 401) {
    // Only clear a token that was actually rejected; the prompt then asks for
    // a new one instead of silently retrying with the same bad value.
    if (accessToken) setAccessToken(null)
    onUnauthorized?.()
    throw new Error(payload.detail ?? 'This request needs the InfinityVault access token.')
  }
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
  filters: MediaFilterParams = {},
): Promise<MediaPage> {
  const params = new URLSearchParams({ view, limit: String(limit) })
  const extra = filterQuery(filters)
  if (extra) new URLSearchParams(extra).forEach((v, k) => params.set(k, v))
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
  if (item.latitude !== undefined) form.append('latitude', String(item.latitude))
  if (item.longitude !== undefined) form.append('longitude', String(item.longitude))
  if (item.cameraMake) form.append('camera_make', item.cameraMake)
  if (item.cameraModel) form.append('camera_model', item.cameraModel)
  if (item.lensModel) form.append('lens_model', item.lensModel)
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

export function renameAlbum(id: string, name: string): Promise<Album> {
  return request<Album>(`/api/albums/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
}

/** Unlinks items from an album. The media itself is untouched. */
export function removeMediaFromAlbum(id: string, mediaIds: string[]): Promise<{ removed: number }> {
  return request<{ removed: number }>(`/api/albums/${id}/media`, { method: 'DELETE', body: JSON.stringify({ media_ids: mediaIds }) })
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
  /** Media InfinityVault itself uploaded (these carry captions). */
  own_backups?: number
  /** Media saved to Telegram directly, which can be adopted as-is. */
  adoptable?: number
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

export interface BackupState {
  changes_since_backup: number
  last_backup_at: string | null
  threshold: number
  due: boolean
}

export function getBackupStatus(): Promise<BackupState> {
  return request<BackupState>('/api/backup/status')
}

export type Person = {
  id: string
  name: string | null
  face_count: number
  cover_face_id: string | null
  cover_url: string | null
}

export type FaceStatus = {
  available?: boolean
  load_error?: string | null
  model?: string | null
  queued: number
  running: number
  done: number
  failed: number
  faces: number
  people: number
}

export function listPeople(): Promise<Person[]> {
  return request<Person[]>('/api/people')
}

export function getFaceStatus(): Promise<FaceStatus> {
  return request<FaceStatus>('/api/faces/status')
}

export function scanFaces(): Promise<{ queued: number }> {
  return request<{ queued: number }>('/api/faces/scan', { method: 'POST' })
}

export function clusterFaces(): Promise<{ people: number; assigned: number }> {
  return request('/api/faces/cluster', { method: 'POST' })
}

export function renamePerson(personId: string, name: string): Promise<Person> {
  return request<Person>(`/api/people/${personId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: name.trim() }),
  })
}

export function mergePeople(sourceId: string, targetId: string): Promise<{ merged_faces: number }> {
  return request('/api/people/merge', {
    method: 'POST',
    body: JSON.stringify({ source_id: sourceId, target_id: targetId }),
  })
}

export function listPersonMedia(personId: string): Promise<ApiMedia[]> {
  return request<ApiMedia[]>(`/api/people/${personId}/media`)
}

export type GeoPoint = {
  id: string
  name: string
  captured_at: string
  latitude: number
  longitude: number
  thumb_ready: boolean
  preview_url: string
}

export type DuplicateGroup = {
  checksum: string
  copies: number
  wasted_bytes: number
  items: { id: string; name: string; captured_at: string; size: number; preview_url: string }[]
}

export function listGeoPoints(): Promise<GeoPoint[]> {
  return request<GeoPoint[]>('/api/geo/points')
}

export function backfillGeo(): Promise<{ checked: number; located: number; remaining: number }> {
  return request('/api/geo/backfill', { method: 'POST' })
}

export function listDuplicates(): Promise<DuplicateGroup[]> {
  return request<DuplicateGroup[]>('/api/duplicates')
}

export function listMemories(): Promise<{ month: number; day: number; items: ApiMedia[] }> {
  return request('/api/memories')
}

export function listRecentlyAdded(limit = 60): Promise<ApiMedia[]> {
  return request<ApiMedia[]>(`/api/recently-added?limit=${limit}`)
}

export type MediaFilterParams = {
  dateFrom?: string
  dateTo?: string
  mediaType?: 'photo' | 'video'
  hasFaces?: boolean
  hasLocation?: boolean
  camera?: string
  personId?: string
  tagId?: string
  place?: string
  favorite?: boolean
  sort?: 'newest' | 'oldest'
}

export function filterQuery(filters: MediaFilterParams): string {
  const params = new URLSearchParams()
  if (filters.dateFrom) params.set('date_from', filters.dateFrom)
  if (filters.dateTo) params.set('date_to', filters.dateTo)
  if (filters.mediaType) params.set('media_type', filters.mediaType)
  if (filters.hasFaces !== undefined) params.set('has_faces', String(filters.hasFaces))
  if (filters.hasLocation !== undefined) params.set('has_location', String(filters.hasLocation))
  if (filters.camera) params.set('camera', filters.camera)
  if (filters.personId) params.set('person_id', filters.personId)
  if (filters.tagId) params.set('tag_id', filters.tagId)
  if (filters.place) params.set('place', filters.place)
  if (filters.favorite !== undefined) params.set('favorite', String(filters.favorite))
  if (filters.sort) params.set('sort', filters.sort)
  return params.toString()
}

export type CameraOption = { label: string; make: string | null; model: string | null; count: number }

export function listCameras(): Promise<CameraOption[]> {
  return request<CameraOption[]>('/api/cameras')
}

export function backfillCameras(): Promise<{ checked: number; labeled: number; remaining: number }> {
  return request('/api/cameras/backfill', { method: 'POST' })
}

export type VideoStatus = {
  available: boolean
  ffmpeg: string | null
  error: string | null
  total: number
  ready: number
  pending: number
  failed: number
}

export function getVideoStatus(): Promise<VideoStatus> {
  return request<VideoStatus>('/api/videos/status')
}

export function buildVideoProxies(): Promise<VideoStatus & { queued: number }> {
  return request('/api/videos/proxies', { method: 'POST' })
}

export type PlaceGroup = { latitude: number; longitude: number; count: number }
export type TagGroup = { id: string; name: string; count: number }
export type PersonGroup = { id: string; name: string; count: number }

export function listPlaceGroups(): Promise<PlaceGroup[]> {
  return request<PlaceGroup[]>('/api/explore/places')
}

export function listTagGroups(): Promise<TagGroup[]> {
  return request<TagGroup[]>('/api/explore/tags')
}

export function listPersonGroups(): Promise<PersonGroup[]> {
  return request<PersonGroup[]>('/api/explore/people')
}

export type LargeFiles = { total_bytes: number; min_bytes: number; items: ApiMedia[] }
export type LocationGaps = { total: number; located: number; missing: number; percent_located: number }

export function getLargeFiles(): Promise<LargeFiles> {
  return request<LargeFiles>('/api/utilities/large-files')
}

export function getLocationGaps(): Promise<LocationGaps> {
  return request<LocationGaps>('/api/utilities/location-gaps')
}

export function resolveDuplicates(checksum: string): Promise<{ trashed: number; remaining: number }> {
  return request('/api/duplicates/resolve?checksum=' + encodeURIComponent(checksum), { method: 'POST' })
}
