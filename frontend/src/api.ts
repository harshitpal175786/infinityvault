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
  telegram_url?: string
  telegram_download_url?: string
  upload_status: UploadStatus
  upload_error?: string
  telegram_message_id?: number
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

export async function listMedia(): Promise<ApiMedia[]> {
  return request<ApiMedia[]>('/api/media')
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
