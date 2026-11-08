import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Real browser fullscreen, tracked from the `fullscreenchange` event.
 *
 * Listening rather than assuming matters because the browser can leave
 * fullscreen without going through us — the user pressing the platform's own
 * Escape, or the OS switching away — and a local boolean would then be stuck
 * believing we are still fullscreen.
 */
export function useFullscreen<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    function sync() {
      setIsFullscreen(Boolean(document.fullscreenElement))
    }
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  const toggle = useCallback(async () => {
    const element = ref.current
    if (!element) return
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await element.requestFullscreen()
    } catch {
      // Some browsers refuse without a user gesture or in embedded contexts.
      // Nothing useful to show here; the viewer stays usable either way.
    }
  }, [])

  return { ref, isFullscreen, toggle }
}
