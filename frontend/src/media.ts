import exifr from 'exifr'
import type { MediaItem, MediaType } from './types'

type ExifData = {
  DateTimeOriginal?: Date | string
  CreateDate?: Date | string
  OffsetTimeOriginal?: string
  OffsetTime?: string
  latitude?: number
  longitude?: number
  Make?: string
  Model?: string
  LensModel?: string
}

type MediaMetadata = {
  capturedAt?: Date
  width?: number
  height?: number
  duration?: number
  latitude?: number
  longitude?: number
  cameraMake?: string
  cameraModel?: string
  lensModel?: string
}

/** EXIF pads these with NULs and spaces; drop the empties entirely. */
function cleanTag(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.replace(/\0/g, ' ').trim()
  return cleaned || undefined
}

/**
 * EXIF can report 0,0 for photos with no GPS fix at all, which would drop a pin
 * in the Gulf of Guinea. Treat an exact zero pair as "unknown" instead.
 */
function readCoordinates(exif: ExifData): { latitude?: number; longitude?: number } {
  const latitude = exif.latitude
  const longitude = exif.longitude
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return {}
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return {}
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return {}
  if (latitude === 0 && longitude === 0) return {}
  return { latitude, longitude }
}

function asDate(value: Date | string | undefined, offset?: string): Date | undefined {
  if (!value) return undefined
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value

  const exifDate = value.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T')
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(exifDate)
  const date = new Date(offset && !hasTimezone ? `${exifDate}${offset}` : exifDate)
  return Number.isNaN(date.getTime()) ? undefined : date
}

async function readImageMetadata(file: File): Promise<MediaMetadata> {
  let exif: ExifData = {}

  try {
    exif = await exifr.parse(file, [
      'DateTimeOriginal', 'CreateDate', 'OffsetTimeOriginal', 'OffsetTime',
      'latitude', 'longitude', 'Make', 'Model', 'LensModel',
    ])
  } catch {
    // Some images do not contain readable EXIF data. The file timestamp is used below.
  }

  const capturedAt = asDate(exif?.DateTimeOriginal, exif?.OffsetTimeOriginal ?? exif?.OffsetTime)
    ?? asDate(exif?.CreateDate, exif?.OffsetTime)
  const coordinates = readCoordinates(exif ?? {})
  const camera = {
    cameraMake: cleanTag(exif?.Make),
    cameraModel: cleanTag(exif?.Model),
    lensModel: cleanTag(exif?.LensModel),
  }

  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(image.src)
      resolve({ capturedAt, width: image.naturalWidth, height: image.naturalHeight, ...coordinates, ...camera })
    }
    image.onerror = () => {
      URL.revokeObjectURL(image.src)
      resolve({ capturedAt, ...coordinates, ...camera })
    }
    image.src = URL.createObjectURL(file)
  })
}

function readVideoMetadata(file: File): Promise<MediaMetadata> {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    const url = URL.createObjectURL(file)
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url)
      resolve({
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
        duration: Number.isFinite(video.duration) ? video.duration : undefined,
      })
    }
    video.onerror = () => {
      URL.revokeObjectURL(url)
      resolve({})
    }
    video.src = url
  })
}

function mediaType(file: File): MediaType | undefined {
  if (file.type.startsWith('image/')) return 'photo'
  if (file.type.startsWith('video/')) return 'video'
  return undefined
}

export async function createMediaItem(file: File): Promise<MediaItem | undefined> {
  const type = mediaType(file)
  if (!type) return undefined

  const metadata = type === 'photo' ? await readImageMetadata(file) : await readVideoMetadata(file)

  return {
    id: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`,
    name: file.name,
    type,
    url: URL.createObjectURL(file),
    size: file.size,
    capturedAt: metadata.capturedAt ?? new Date(file.lastModified),
    sourceLabel: metadata.capturedAt ? 'Original capture time' : 'File date fallback',
    width: metadata.width,
    height: metadata.height,
    duration: type === 'video' ? metadata.duration : undefined,
    latitude: metadata.latitude,
    longitude: metadata.longitude,
    cameraMake: metadata.cameraMake,
    cameraModel: metadata.cameraModel,
    lensModel: metadata.lensModel,
    file,
    uploadStatus: 'local',
    isFavorite: false,
    isArchived: false,
    isTrashed: false,
    description: '',
  }
}
