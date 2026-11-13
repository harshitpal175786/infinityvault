import { Calendar, Camera, Download, Hash, MapPin, Maximize2, Ruler, Send, Star, Tag } from 'lucide-react'
import type { MediaItem } from '../types'
import { formatDuration, formatSize } from '../lib/format'

interface ViewerInfoProps {
  item: MediaItem
  /** Tags resolved for this item, when the caller has them. */
  tags?: string[]
  onFavorite: () => void
  onDownload?: () => void
}

function distance(value?: number) {
  return typeof value === 'number' && value !== 0
}

interface Row {
  icon: React.ReactNode
  label: string
  value: string
}

/**
 * Metadata panel for the viewer.
 *
 * Every row is derived from data the backend actually stores. Fields without a
 * value are omitted entirely rather than rendered as "Unknown", so the panel
 * never implies knowledge the vault does not have — in particular there is no
 * place name, because reverse geocoding was explicitly rejected.
 */
export function ViewerInfo({ item, tags, onFavorite, onDownload }: ViewerInfoProps) {
  const rows: Row[] = []

  const captured = item.capturedAt instanceof Date && !Number.isNaN(item.capturedAt.getTime())
    ? item.capturedAt
    : null
  if (captured) {
    rows.push({
      icon: <Calendar size={14} />,
      label: 'Taken',
      value: captured.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      }),
    })
  }

  if (item.width && item.height) {
    rows.push({
      icon: <Ruler size={14} />,
      label: 'Dimensions',
      value: `${item.width} × ${item.height}`,
    })
  }

  if (item.size) {
    rows.push({ icon: <Download size={14} />, label: 'Size', value: formatSize(item.size) })
  }

  // A photo carries duration 0, which is not the same as "no duration"; only
  // show the row when there is a real length to report.
  const duration = item.duration && item.duration > 0 ? formatDuration(item.duration) : undefined
  if (duration) {
    rows.push({ icon: <Maximize2 size={14} />, label: 'Duration', value: duration })
  }

  if (item.cameraMake || item.cameraModel) {
    rows.push({
      icon: <Camera size={14} />,
      label: 'Camera',
      value: [item.cameraMake, item.cameraModel].filter(Boolean).join(' '),
    })
  }

  if (item.lensModel) {
    rows.push({ icon: <Camera size={14} />, label: 'Lens', value: item.lensModel })
  }

  if (distance(item.latitude) && distance(item.longitude)) {
    // Coordinates only. Resolving them to a name would need an external
    // service, which this vault deliberately does not call.
    rows.push({
      icon: <MapPin size={14} />,
      label: 'Location',
      value: `${item.latitude!.toFixed(4)}, ${item.longitude!.toFixed(4)}`,
    })
  }

  if (item.telegramMessageId) {
    rows.push({
      icon: <Hash size={14} />,
      label: 'Telegram message',
      value: String(item.telegramMessageId),
    })
  }

  return (
    <aside className="viewer-info" aria-label="Item details">
      <div className="viewer-info-head">
        <h3>{item.name}</h3>
        <div className="viewer-info-actions">
          <button
            type="button"
            className={item.isFavorite ? 'icon-button is-active' : 'icon-button'}
            aria-pressed={item.isFavorite}
            aria-label={item.isFavorite ? 'Remove from favourites' : 'Add to favourites'}
            onClick={onFavorite}
          >
            <Star size={16} fill={item.isFavorite ? 'currentColor' : 'none'} />
          </button>
          {onDownload && (
            <button type="button" className="icon-button" aria-label="Download original" onClick={onDownload}>
              <Download size={16} />
            </button>
          )}
        </div>
      </div>

      {item.description && <p className="viewer-info-desc">{item.description}</p>}

      <dl className="viewer-info-list">
        {rows.map((row) => (
          <div className="viewer-info-row" key={row.label}>
            <dt>{row.icon}{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>

      {tags && tags.length > 0 && (
        <div className="viewer-info-tags">
          <span className="viewer-info-tags-label"><Tag size={13} /> Tags</span>
          <div className="viewer-info-tag-list">
            {tags.map((tag) => <span className="tag-pill" key={tag}>{tag}</span>)}
          </div>
        </div>
      )}

      <p className="viewer-info-source"><Send size={12} /> Backed up to Telegram Saved Messages</p>
    </aside>
  )
}
