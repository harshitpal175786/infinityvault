import { useCallback, useEffect, useMemo, useState } from 'react'
import { Camera, Copy, Loader2, MapPin, MapPinned, RefreshCw, Sparkles, Tag, Users } from 'lucide-react'
import { backfillCameras, backfillGeo, resolveDuplicates, listDuplicates, listGeoPoints, listMemories, listPersonGroups, listPlaceGroups, listRecentlyAdded, listTagGroups, mediaUrl } from '../api'
import type { PersonGroup, PlaceGroup, TagGroup } from '../api'
import type { ApiMedia, DuplicateGroup, GeoPoint } from '../api'

type ExplorePageProps = {
  onNotice: (message: string) => void
  onOpenMedia: (item: ApiMedia) => void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * Map points projected with a plain equirectangular projection.
 *
 * Deliberately no tile server: the library is private, and fetching map tiles
 * from a third party would leak locations of the user's photos to that party.
 * Without tiles this is a relative-arrangement view, not a street map, and the
 * copy says so rather than implying more than it can show.
 */
type MapCluster = {
  key: string
  left: number
  top: number
  points: GeoPoint[]
}

/**
 * Group points that project closer together than `cell` percent.
 *
 * Without this, a library shot in one city stacks dozens of pins on the same
 * pixel: only the last one is clickable and the map reads as a single blob.
 * A grid is enough here because the map is a relative arrangement, not a
 * projected geography, so pixel distance is the only thing that matters.
 */
function clusterPoints(
  projected: { point: GeoPoint; left: number; top: number }[],
  cell = 7,
): MapCluster[] {
  const buckets = new Map<string, MapCluster>()
  for (const { point, left, top } of projected) {
    const key = `${Math.floor(left / cell)}:${Math.floor(top / cell)}`
    const existing = buckets.get(key)
    if (existing) {
      existing.points.push(point)
      // Recentre on the running mean so a cluster sits on its members.
      const n = existing.points.length
      existing.left += (left - existing.left) / n
      existing.top += (top - existing.top) / n
    } else {
      buckets.set(key, { key, left, top, points: [point] })
    }
  }
  return Array.from(buckets.values())
}

function ProjectedMap({ points, onOpen }: { points: GeoPoint[]; onOpen: (point: GeoPoint) => void }) {
  const { markers } = useMemo(() => {
    if (points.length === 0) return { markers: [] }
    const lats = points.map((p) => p.latitude)
    const lons = points.map((p) => p.longitude)
    const minLat = Math.min(...lats)
    const maxLat = Math.max(...lats)
    const minLon = Math.min(...lons)
    const maxLon = Math.max(...lons)
    // A single point (or a very tight cluster) would divide by zero; give the
    // span a floor so the pin lands in the middle instead of NaN.
    const latSpan = Math.max(maxLat - minLat, 0.01)
    const lonSpan = Math.max(maxLon - minLon, 0.01)
    // Map the span into 6%..94% rather than 0..100 so the outermost pins are
    // fully visible: a pin centred at 0% would hang half outside the box.
    const inset = (fraction: number) => 6 + fraction * 88
    const projected = points.map((point) => ({
      point,
      left: inset((point.longitude - minLon) / lonSpan),
      top: inset(1 - (point.latitude - minLat) / latSpan),
    }))
    return { markers: clusterPoints(projected) }
  }, [points])

  return (
    <div className="explore-map">
      {markers.map((cluster) => {
        const single = cluster.points[0]
        const count = cluster.points.length
        return (
          <button
            key={cluster.key}
            type="button"
            className={count > 1 ? 'map-pin map-cluster' : 'map-pin'}
            style={{ left: `${cluster.left}%`, top: `${cluster.top}%` }}
            onClick={() => onOpen(count > 1 ? cluster.points[0] : single)}
            title={
              count > 1
                ? `${count} photos near here — showing the newest`
                : `${single.name} · ${single.captured_at.slice(0, 10)}`
            }
          >
            {count > 1 ? (
              <span className="map-cluster-count">{count}</span>
            ) : single.thumb_ready ? (
              <img src={mediaUrl(single.preview_url)} alt="" loading="lazy" />
            ) : (
              <MapPin size={11} />
            )}
          </button>
        )
      })}
    </div>
  )
}

export function ExplorePage({ onNotice, onOpenMedia }: ExplorePageProps) {
  const [points, setPoints] = useState<GeoPoint[]>([])
  const [memories, setMemories] = useState<ApiMedia[]>([])
  const [recent, setRecent] = useState<ApiMedia[]>([])
  const [duplicates, setDuplicates] = useState<DuplicateGroup[]>([])
  const [places, setPlaces] = useState<PlaceGroup[]>([])
  const [tagGroups, setTagGroups] = useState<TagGroup[]>([])
  const [personGroups, setPersonGroups] = useState<PersonGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'geo' | 'camera' | 'duplicates' | null>(null)

  const load = useCallback(async () => {
    const [nextPoints, nextMemories, nextRecent, nextDuplicates, nextPlaces, nextTags, nextPeople] = await Promise.all([
      listGeoPoints().catch(() => []),
      listMemories().then((r) => r.items).catch(() => []),
      listRecentlyAdded(24).catch(() => []),
      listDuplicates().catch(() => []),
      listPlaceGroups().catch(() => []),
      listTagGroups().catch(() => []),
      listPersonGroups().catch(() => []),
    ])
    setPoints(nextPoints)
    setMemories(nextMemories)
    setRecent(nextRecent)
    setDuplicates(nextDuplicates)
    setPlaces(nextPlaces)
    setTagGroups(nextTags)
    setPersonGroups(nextPeople)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function runBackfill() {
    setBusy('geo')
    try {
      const result = await backfillGeo()
      onNotice(
        result.located > 0
          ? `Recovered locations for ${result.located} photo${result.located === 1 ? '' : 's'}.`
          : result.checked === 0
            ? 'No photos are waiting for a location.'
            : `Checked ${result.checked} photo${result.checked === 1 ? '' : 's'} — none carried a location.`,
      )
      await load()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Locations could not be recovered.')
    } finally {
      setBusy(null)
    }
  }

  async function resolveGroup(checksum: string) {
    setBusy('duplicates')
    try {
      const result = await resolveDuplicates(checksum)
      onNotice(
        result.trashed > 0
          ? `Moved ${result.trashed} duplicate${result.trashed === 1 ? '' : 's'} to Trash. You can restore them from there.`
          : 'Nothing to remove in that group.',
      )
      await load()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Duplicates could not be resolved.')
    } finally {
      setBusy(null)
    }
  }

  async function runCameraBackfill() {
    setBusy('camera')
    try {
      const result = await backfillCameras()
      onNotice(
        result.labeled > 0
          ? `Recorded the camera for ${result.labeled} photo${result.labeled === 1 ? '' : 's'}.`
          : 'No photos are waiting for a camera label.',
      )
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Camera details could not be read.')
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <div className="empty-state">
        <Loader2 size={22} className="spinning" />
        <p>Loading…</p>
      </div>
    )
  }

  const wasted = duplicates.reduce((total, group) => total + group.wasted_bytes, 0)

  return (
    <div className="explore-page">
      <section className="explore-section">
        <header className="explore-head">
          <h2 className="explore-title"><Sparkles size={17} /> Memories</h2>
          <p className="explore-sub">Photos from this day in earlier years.</p>
        </header>
        {memories.length === 0 ? (
          <p className="explore-empty">Nothing from this day in previous years.</p>
        ) : (
          <div className="explore-strip">
            {memories.map((item) => (
              <button key={item.id} type="button" className="explore-thumb" onClick={() => onOpenMedia(item)} title={item.name}>
                <img src={mediaUrl(item.preview_url)} alt={item.name} loading="lazy" />
                <span className="explore-thumb-year">{item.captured_at.slice(0, 4)}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="explore-section">
        <header className="explore-head">
          <h2 className="explore-title"><MapPin size={17} /> Places</h2>
          <p className="explore-sub">
            {points.length === 0
              ? 'No photos carry a location yet.'
              : `${points.length} photo${points.length === 1 ? '' : 's'} with a location.`}{' '}
            Positions are relative to each other — no map tiles are downloaded, so your locations stay on this machine.
          </p>
          <div className="explore-head-actions">
            <button type="button" className="ghost-button" onClick={() => void runBackfill()} disabled={busy !== null}>
              <RefreshCw size={13} /> {busy === 'geo' ? 'Reading…' : 'Find locations in existing photos'}
            </button>
            <button type="button" className="ghost-button" onClick={() => void runCameraBackfill()} disabled={busy !== null}>
              <Camera size={13} /> {busy === 'camera' ? 'Reading…' : 'Find cameras in existing photos'}
            </button>
          </div>
        </header>
        {points.length > 0 && (
          <ProjectedMap
            points={points}
            onOpen={(point) => {
              const match = recent.find((item) => item.id === point.id)
              if (match) onOpenMedia(match)
              else onNotice(`Open ${point.name} from the library — it has a location recorded.`)
            }}
          />
        )}
      </section>

      <section className="explore-section">
        <header className="explore-head">
          <h2 className="explore-title"><Camera size={17} /> Recently added</h2>
          <p className="explore-sub">Newest arrivals in the library, by when they were added.</p>
        </header>
        {recent.length === 0 ? (
          <p className="explore-empty">Nothing has been added yet.</p>
        ) : (
          <div className="explore-strip">
            {recent.map((item) => (
              <button key={item.id} type="button" className="explore-thumb" onClick={() => onOpenMedia(item)} title={item.name}>
                <img src={mediaUrl(item.preview_url)} alt={item.name} loading="lazy" />
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="explore-section">
        <header className="explore-head">
          <h2 className="explore-title"><Tag size={17} /> Tags</h2>
          <p className="explore-sub">Jump into anything you have tagged.</p>
        </header>
        {tagGroups.length === 0 ? (
          <p className="explore-empty">No tags yet. Tag a photo and it appears here.</p>
        ) : (
          <div className="explore-chips">
            {tagGroups.map((group) => (
              <span key={group.id} className="explore-chip">
                {group.name}
                <span className="explore-chip-count">{group.count}</span>
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="explore-section">
        <header className="explore-head">
          <h2 className="explore-title"><Users size={17} /> People</h2>
          <p className="explore-sub">Faces grouped by person, most photographed first.</p>
        </header>
        {personGroups.length === 0 ? (
          <p className="explore-empty">No people clustered yet. Run face detection on the People page.</p>
        ) : (
          <div className="explore-chips">
            {personGroups.map((group) => (
              <span key={group.id} className="explore-chip">
                {group.name}
                <span className="explore-chip-count">{group.count}</span>
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="explore-section">
        <header className="explore-head">
          <h2 className="explore-title"><MapPinned size={17} /> Areas</h2>
          {/* Deliberately not called "Cities": these are coordinate buckets.
              Naming them would mean reverse geocoding, which sends photo
              locations to a third party. */}
          <p className="explore-sub">
            Where your photos cluster. Labelled by coordinates, not city names —
            resolving a name would mean sending every photo location to someone else.
          </p>
        </header>
        {places.length === 0 ? (
          <p className="explore-empty">No photo has a location yet.</p>
        ) : (
          <div className="explore-chips">
            {places.map((place) => (
              <span key={`${place.latitude}:${place.longitude}`} className="explore-chip">
                {place.latitude.toFixed(2)}, {place.longitude.toFixed(2)}
                <span className="explore-chip-count">{place.count}</span>
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="explore-section">
        <header className="explore-head">
          <h2 className="explore-title"><Copy size={17} /> Duplicates</h2>
          <p className="explore-sub">
            {duplicates.length === 0
              ? 'No duplicates found — each file is stored once.'
              : `${duplicates.length} group${duplicates.length === 1 ? '' : 's'} of identical files, ${formatBytes(wasted)} duplicated.`}
          </p>
        </header>
        {duplicates.length > 0 && (
          <div className="duplicate-list">
            {duplicates.map((group) => (
              <div key={group.checksum} className="duplicate-group">
                <div className="duplicate-thumbs">
                  {group.items.map((item) => (
                    <img key={item.id} src={mediaUrl(item.preview_url)} alt={item.name} title={item.name} loading="lazy" />
                  ))}
                </div>
                <div className="duplicate-meta">
                  <span>{group.copies} copies</span>
                  <span className="duplicate-wasted">{formatBytes(group.wasted_bytes)} reclaimable</span>
                  {/* Moves to Trash, not deleted: reversible, and the oldest
                      copy is always the one kept. */}
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={busy !== null}
                    onClick={() => void resolveGroup(group.checksum)}
                  >
                    Keep oldest, trash the rest
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
