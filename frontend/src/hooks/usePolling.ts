import { useCallback, useEffect, useRef, useState } from 'react'

type PollOptions = {
  /** Run one refresh. */
  onPoll: () => Promise<void>
  /** Poll cadence while something is in flight (uploads, downloads). */
  activeMs?: number
  /** Poll cadence when the library is idle. */
  idleMs?: number
  /** True when there is work in progress that warrants the fast cadence. */
  isActive: boolean
  /** Pausing prevents overlapping requests while a modal / upload owns the UI. */
  paused?: boolean
}

/**
 * Polls the backend on a fixed cadence.
 *
 * The previous implementation recreated its interval whenever `items`
 * changed, which meant the timer restarted on every refresh — so the
 * effective cadence drifted and idle libraries stopped updating entirely
 * once uploads finished. This keeps exactly one timer and never overlaps
 * requests.
 */
export function usePolling({ onPoll, activeMs = 2000, idleMs = 15000, isActive, paused = false }: PollOptions): void {
  const [inFlight, setInFlight] = useState(false)
  const pollRef = useRef(onPoll)
  const busyRef = useRef(false)

  pollRef.current = onPoll
  busyRef.current = inFlight

  const runOnce = useCallback(async () => {
    if (busyRef.current) return
    setInFlight(true)
    try {
      await pollRef.current()
    } catch {
      // Errors are surfaced by the caller's refresh; polling must survive them.
    } finally {
      setInFlight(false)
    }
  }, [])

  useEffect(() => {
    if (paused) return undefined

    let cancelled = false
    let timer: number | undefined

    // A self-rescheduling timeout (rather than setInterval) keeps a slow
    // request from queueing a burst of overlapping calls behind it.
    const tick = async () => {
      await runOnce()
      if (cancelled) return
      timer = window.setTimeout(tick, isActive ? activeMs : idleMs)
    }

    timer = window.setTimeout(tick, isActive ? activeMs : idleMs)

    // Refresh immediately when the tab regains focus; a backgrounded tab
    // should not show yesterday's library when the user returns.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !busyRef.current) void runOnce()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [activeMs, idleMs, isActive, paused, runOnce])
}
