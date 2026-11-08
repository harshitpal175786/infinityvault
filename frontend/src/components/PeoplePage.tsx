import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Loader2, Merge, Pencil, ScanFace, Sparkles, UserRound, X } from 'lucide-react'
import {
  clusterFaces,
  getFaceStatus,
  listPeople,
  listPersonMedia,
  mediaUrl,
  mergePeople,
  renamePerson,
  scanFaces,
} from '../api'
import type { ApiMedia, FaceStatus, Person } from '../api'

type PeoplePageProps = {
  onNotice: (message: string) => void
  onOpenMedia: (item: ApiMedia) => void
}

/** "unnamed" is how the clusterer marks a face it has not been told about. */
function displayName(person: Person): string {
  return person.name?.trim() || 'Unnamed'
}

export function PeoplePage({ onNotice, onOpenMedia }: PeoplePageProps) {
  const [people, setPeople] = useState<Person[]>([])
  const [status, setStatus] = useState<FaceStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'scan' | 'cluster' | null>(null)

  const [selected, setSelected] = useState<Person | null>(null)
  const [personMedia, setPersonMedia] = useState<ApiMedia[]>([])
  const [mediaLoading, setMediaLoading] = useState(false)

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState('')

  const [mergeSource, setMergeSource] = useState<Person | null>(null)

  const load = useCallback(async () => {
    try {
      const [nextPeople, nextStatus] = await Promise.all([
        listPeople(),
        getFaceStatus().catch(() => null),
      ])
      setPeople(nextPeople)
      setStatus(nextStatus)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Could not load people.')
    } finally {
      setLoading(false)
    }
  }, [onNotice])

  useEffect(() => {
    void load()
  }, [load])

  // Face analysis runs on a background worker, so the counts are only useful
  // if they refresh. Polling stops once the queue is empty.
  useEffect(() => {
    if (!status || (status.queued === 0 && status.running === 0)) return
    const handle = window.setInterval(() => void load(), 3000)
    return () => window.clearInterval(handle)
  }, [status, load])

  async function runScan() {
    setBusy('scan')
    try {
      const result = await scanFaces()
      onNotice(
        result.queued === 0
          ? 'Every photo has already been analysed.'
          : `Analysing ${result.queued} photo${result.queued === 1 ? '' : 's'}. Face counts update as it goes.`,
      )
      await load()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Could not start face analysis.')
    } finally {
      setBusy(null)
    }
  }

  async function runCluster() {
    setBusy('cluster')
    try {
      const result = await clusterFaces()
      onNotice(
        result.people
          ? `Grouped faces into ${result.people} ${result.people === 1 ? 'person' : 'people'}.`
          : 'No new people found — every face is already grouped.',
      )
      await load()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Could not group faces.')
    } finally {
      setBusy(null)
    }
  }

  async function openPerson(person: Person) {
    setSelected(person)
    setMediaLoading(true)
    setPersonMedia([])
    try {
      setPersonMedia(await listPersonMedia(person.id))
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Could not load this person.')
    } finally {
      setMediaLoading(false)
    }
  }

  function startRename(person: Person) {
    setRenamingId(person.id)
    setNameDraft(person.name ?? '')
  }

  async function commitRename(person: Person) {
    const name = nameDraft.trim()
    setRenamingId(null)
    if (!name || name === (person.name ?? '')) return
    try {
      const updated = await renamePerson(person.id, name)
      setPeople((current) =>
        current.map((entry) => (entry.id === person.id ? { ...entry, name: updated.name } : entry)),
      )
      onNotice(`Renamed to ${name}.`)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'That name could not be saved.')
    }
  }

  async function commitMerge(target: Person) {
    if (!mergeSource || mergeSource.id === target.id) return
    try {
      const result = await mergePeople(mergeSource.id, target.id)
      onNotice(
        `Merged ${displayName(mergeSource)} into ${displayName(target)} (${result.merged_faces} face${
          result.merged_faces === 1 ? '' : 's'
        } moved).`,
      )
      setMergeSource(null)
      if (selected?.id === mergeSource.id) setSelected(null)
      await load()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Those people could not be merged.')
    }
  }

  const unnamedCount = useMemo(() => people.filter((p) => !p.name?.trim()).length, [people])
  const faceModelMissing = status && status.available === false

  if (loading) {
    return (
      <div className="empty-state">
        <Loader2 size={22} className="spinning" />
        <p>Loading people…</p>
      </div>
    )
  }

  return (
    <div className="people-page">
      <header className="people-head">
        <div>
          <h2 className="people-title">People</h2>
          <p className="people-sub">
            {people.length === 0
              ? 'No faces grouped yet.'
              : `${people.length} ${people.length === 1 ? 'person' : 'people'} found${
                  unnamedCount && unnamedCount > 0 ? ` · ${unnamedCount} still unnamed` : ''
                }`}
          </p>
        </div>
        <div className="people-actions">
          <button type="button" className="ghost-button" onClick={() => void runScan()} disabled={busy !== null}>
            <ScanFace size={14} />
            {busy === 'scan' ? 'Analysing…' : 'Analyse photos'}
          </button>
          <button type="button" className="primary-button" onClick={() => void runCluster()} disabled={busy !== null}>
            <Sparkles size={14} />
            {busy === 'cluster' ? 'Grouping…' : 'Group faces'}
          </button>
        </div>
      </header>

      {faceModelMissing && (
        <p className="people-banner">
          Face recognition is not installed. Run <code>npm run infinityvault -- faces</code> to enable it.
        </p>
      )}

      {status && (status.queued > 0 || status.running > 0) && (
        <p className="people-progress">
          <Loader2 size={13} className="spinning" />
          Analysing {status.running > 0 ? status.running : status.queued} photo
          {(status.running || status.queued) === 1 ? '' : 's'} · {status.faces} faces found so far
        </p>
      )}

      {mergeSource && (
        <div className="people-merge-bar">
          <Merge size={15} />
          <span>
            Pick the person <strong>{displayName(mergeSource)}</strong> should be merged into.
          </span>
          <button type="button" className="ghost-button" onClick={() => setMergeSource(null)}>
            <X size={13} /> Cancel
          </button>
        </div>
      )}

      {people.length === 0 ? (
        <div className="empty-state">
          <UserRound size={26} />
          <p>No people yet</p>
          <span>Analyse your photos, then group the faces to see them here.</span>
        </div>
      ) : (
        <div className="people-grid">
          {people.map((person) => {
            const isMergeTarget = Boolean(mergeSource) && mergeSource?.id !== person.id
            return (
              <article
                key={person.id}
                className={`person-card${isMergeTarget ? ' merge-target' : ''}`}
                onClick={() => { if (isMergeTarget) void commitMerge(person) }}
              >
                <button
                  type="button"
                  className="person-cover"
                  onClick={(event) => {
                    event.stopPropagation()
                    if (isMergeTarget) void commitMerge(person)
                    else void openPerson(person)
                  }}
                  title={isMergeTarget ? `Merge into ${displayName(person)}` : `Open ${displayName(person)}`}
                >
                  {person.cover_url ? (
                    <img src={mediaUrl(person.cover_url)} alt="" loading="lazy" />
                  ) : (
                    <UserRound size={26} />
                  )}
                </button>

                <div className="person-meta">
                  {renamingId === person.id ? (
                    <form
                      className="person-rename"
                      onSubmit={(event) => { event.preventDefault(); void commitRename(person) }}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <input
                        className="person-rename-input"
                        value={nameDraft}
                        onChange={(event) => setNameDraft(event.target.value)}
                        placeholder="Name this person"
                        autoFocus
                        maxLength={100}
                      />
                      <button type="submit" className="icon-button" title="Save name"><Check size={13} /></button>
                      <button
                        type="button"
                        className="icon-button"
                        title="Cancel"
                        onClick={() => setRenamingId(null)}
                      >
                        <X size={13} />
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="person-name"
                      onClick={(event) => { event.stopPropagation(); startRename(person) }}
                      title="Rename"
                    >
                      <span className={person.name ? '' : 'person-name-empty'}>{displayName(person)}</span>
                      <Pencil size={11} />
                    </button>
                  )}
                  <span className="person-count">
                    {person.face_count} face{person.face_count === 1 ? '' : 's'}
                  </span>
                </div>

                {!mergeSource && (
                  <button
                    type="button"
                    className="person-merge"
                    onClick={(event) => { event.stopPropagation(); setMergeSource(person) }}
                    title="Merge this person into another"
                  >
                    <Merge size={12} /> Merge
                  </button>
                )}
              </article>
            )
          })}
        </div>
      )}

      {selected && (
        <section className="person-detail">
          <header className="person-detail-head">
            <h3>{displayName(selected)}</h3>
            <button type="button" className="ghost-button" onClick={() => setSelected(null)}>
              <X size={13} /> Close
            </button>
          </header>
          {mediaLoading ? (
            <div className="empty-state"><Loader2 size={18} className="spinning" /><p>Loading photos…</p></div>
          ) : personMedia.length === 0 ? (
            <p className="people-sub">No photos to show for this person yet.</p>
          ) : (
            <div className="person-photo-grid">
              {personMedia.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="person-photo"
                  onClick={() => onOpenMedia(item)}
                  title={item.name}
                >
                  <img src={mediaUrl(item.preview_url)} alt={item.name} loading="lazy" />
                </button>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
