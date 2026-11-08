export type MediaType = 'photo' | 'video'

export type UploadStatus = 'local' | 'queued' | 'waiting_for_telegram' | 'uploading' | 'uploaded' | 'failed'

export type MediaItem = {
  id: string
  name: string
  type: MediaType
  url: string
  telegramUrl?: string
  downloadUrl?: string
  size: number
  capturedAt: Date
  sourceLabel: string
  width?: number
  height?: number
  duration?: number
  file?: File
  uploadStatus: UploadStatus
  /** 'missing' means the local copy is gone; metadata is still intact. */
  fileState?: 'present' | 'missing' | 'recovering'
  uploadError?: string
  telegramMessageId?: number
  checksum?: string
  isFavorite: boolean
  isArchived: boolean
  isTrashed: boolean
  description: string
  folderPath?: string
}
