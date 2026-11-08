import { useEffect, useRef } from 'react'

interface Options {
  /** Called when the sentinel comes into view and a page is available. */
  onLoad: () => void
  /** False when there is nothing left to fetch. */
  hasMore: boolean
  /** True while a page is in flight, to avoid stacking requests. */
  loading: boolean
  /**
   * How far below the viewport to start loading, in pixels. Preloading a screen
   * ahead means the next page is usually already there by the time the user
   * reaches the end, so the grid does not visibly stall.
   */
  rootMargin?: string
}

/**
 * Loads more content as the user scrolls towards the bottom.
 *
 * Watches a sentinel element rather than the scroll position: IntersectionObserver
 * fires off the compositor, so it stays smooth with hundreds of image tiles and
 * costs nothing between events. A scroll listener would run on every frame and
 * force layout while images are still decoding.
 *
 * The observer is torn down and rebuilt whenever `hasMore` or `loading` changes,
 * because a page that has just finished needs a *new* check against the current
 * layout — otherwise a short page never triggers a second load.
 */
export function useInfiniteScroll({ onLoad, hasMore, loading, rootMargin = '600px' }: Options) {
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  // Kept in a ref so changing the callback does not re-subscribe every render.
  const onLoadRef = useRef(onLoad)
  onLoadRef.current = onLoad

  useEffect(() => {
    const node = sentinelRef.current
    if (!node || !hasMore || loading) return

    // Older browsers without IntersectionObserver fall back to the manual
    // button, which is still rendered, so nothing breaks.
    if (typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadRef.current()
        }
      },
      { rootMargin },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, loading, rootMargin])

  return sentinelRef
}
