export type MediaType = 'photo' | 'video'

export type UploadStatus = 'local' | 'queued' | 'waiting_for_telegram' | 'uploading' | 'uploaded' | 'failed'

export type MediaItem = {
  id: string
  name: string
  type: MediaType
  /** Cached 400px preview used by the grid and viewer. */
  url: string
  /** Small blurred placeholder; undefined until generated. */
  microUrl?: string
  /** Full-size original, only fetched on explicit download. */
  contentUrl?: string
  telegramUrl?: string
  downloadUrl?: string
  size: number
  capturedAt: Date
  sourceLabel: string
  width?: number
  height?: number
  duration?: number
  /** EXIF GPS, when the original carried it. 0,0 is treated as unknown. */
  latitude?: number
  longitude?: number
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
