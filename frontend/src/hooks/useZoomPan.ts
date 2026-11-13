import { useCallback, useEffect, useRef, useState } from 'react'

export const MIN_SCALE = 1
export const MAX_SCALE = 8

interface Point {
  x: number
  y: number
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

/**
 * Zoom and pan for the image stage.
 *
 * Offsets are clamped against the stage size so the image can never be dragged
 * completely out of view — unclamped panning is how zoomable viewers end up
 * showing a blank screen at 8x with no way back.
 *
 * Panning is disabled at 1x because there is nothing off-screen to reveal, and
 * a draggable-at-rest image reads as a bug.
 */
export function useZoomPan(resetKey: unknown) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [scale, setScale] = useState(MIN_SCALE)
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 })
  const dragRef = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null)

  const clampOffset = useCallback((next: Point, atScale: number): Point => {
    const stage = stageRef.current
    if (!stage || atScale <= MIN_SCALE) return { x: 0, y: 0 }
    // How far the scaled image overflows the stage on each axis.
    const boundsX = (stage.clientWidth * (atScale - 1)) / 2
    const boundsY = (stage.clientHeight * (atScale - 1)) / 2
    return {
      x: clamp(next.x, -boundsX, boundsX),
      y: clamp(next.y, -boundsY, boundsY),
    }
  }, [])

  const reset = useCallback(() => {
    setScale(MIN_SCALE)
    setOffset({ x: 0, y: 0 })
  }, [])

  // A new photo must never open already magnified and panned.
  useEffect(() => {
    reset()
  }, [resetKey, reset])

  const zoomTo = useCallback(
    (nextScaleRaw: number, anchor?: Point) => {
      const nextScale = clamp(nextScaleRaw, MIN_SCALE, MAX_SCALE)
      setScale(nextScale)
      setOffset((current) => {
        if (nextScale <= MIN_SCALE) return { x: 0, y: 0 }
        if (!anchor) return clampOffset(current, nextScale)
        // Keep the point under the cursor stationary while zooming by scaling
        // the existing offset toward that anchor.
        const stage = stageRef.current
        if (!stage) return current
        const centreX = stage.clientWidth / 2
        const centreY = stage.clientHeight / 2
        const ratio = nextScale / Math.max(scale, MIN_SCALE)
        const anchorOffsetX = (anchor.x - centreX - current.x) * ratio
        const anchorOffsetY = (anchor.y - centreY - current.y) * ratio
        return clampOffset(
          { x: anchor.x - centreX - anchorOffsetX, y: anchor.y - centreY - anchorOffsetY },
          nextScale,
        )
      })
    },
    [clampOffset, scale],
  )

  const zoomBy = useCallback(
    (factor: number) => {
      setScale((current) => {
        const next = clamp(current * factor, MIN_SCALE, MAX_SCALE)
        setOffset((existing) => clampOffset(existing, next))
        return next
      })
    },
    [clampOffset],
  )

  const toggle = useCallback(() => {
    setScale((current) => {
      const next = current > MIN_SCALE ? MIN_SCALE : 2
      setOffset((existing) => clampOffset(existing, next))
      return next
    })
  }, [clampOffset])

  const onWheel = useCallback(
    (event: React.WheelEvent) => {
      // Wheel is how a trackpad pinch arrives, so it must zoom rather than
      // scroll the page behind the overlay.
      event.preventDefault()
      const stage = stageRef.current
      if (!stage) return
      const rect = stage.getBoundingClientRect()
      const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15
      setScale((current) => {
        const next = clamp(current * factor, MIN_SCALE, MAX_SCALE)
        setOffset((existing) => {
          if (next <= MIN_SCALE) return { x: 0, y: 0 }
          const ratio = next / Math.max(current, MIN_SCALE)
          const centreX = rect.width / 2
          const centreY = rect.height / 2
          const anchorX = event.clientX - rect.left
          const anchorY = event.clientY - rect.top
          return clampOffset(
            { x: anchorX - centreX - (anchorX - centreX - existing.x) * ratio,
              y: anchorY - centreY - (anchorY - centreY - existing.y) * ratio },
            next,
          )
        })
        return next
      })
    },
    [clampOffset],
  )

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (scale <= MIN_SCALE) return
      dragRef.current = { x: event.clientX, y: event.clientY, startX: offset.x, startY: offset.y }
      ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
    },
    [offset.x, offset.y, scale],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      setOffset(
        clampOffset(
          { x: drag.startX + (event.clientX - drag.x), y: drag.startY + (event.clientY - drag.y) },
          scale,
        ),
      )
    },
    [clampOffset, scale],
  )

  const endDrag = useCallback(() => {
    dragRef.current = null
  }, [])

  return {
    stageRef,
    scale,
    offset,
    isZoomed: scale > MIN_SCALE,
    zoomIn: () => zoomBy(1.4),
    zoomOut: () => zoomBy(1 / 1.4),
    zoomTo,
    toggle,
    reset,
    onWheel,
    onPointerDown,
    onPointerMove,
    endDrag,
  }
}
