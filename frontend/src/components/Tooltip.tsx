import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'

interface TooltipProps {
  label: string
  children: ReactNode
  /** Where the bubble sits relative to the trigger. */
  side?: 'top' | 'bottom'
}

const SHOW_DELAY_MS = 320
const GAP_PX = 7

/**
 * Labelled hover/focus hint for icon-only controls.
 *
 * Rendered into a portal at document level so an ancestor's `overflow: hidden`
 * cannot clip it — the topbar and toolbar rows both clip, and an in-flow bubble
 * was disappearing behind them.
 *
 * Focus opens the tooltip too, so keyboard users get the same labels as pointer
 * users; the trigger is wired with aria-describedby rather than a title
 * attribute, which is unreadable to some screen readers and cannot be styled.
 */
export function Tooltip({ label, children, side = 'top' }: TooltipProps) {
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLSpanElement | null>(null)
  const timer = useRef<number | null>(null)
  const id = useId()

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const show = useCallback(() => {
    clearTimer()
    // A short delay stops a bubble flashing as the pointer sweeps a toolbar.
    timer.current = window.setTimeout(() => {
      const node = triggerRef.current
      if (!node) return
      const rect = node.getBoundingClientRect()
      setCoords({
        top: side === 'top' ? rect.top - GAP_PX : rect.bottom + GAP_PX,
        left: rect.left + rect.width / 2,
      })
      setOpen(true)
    }, SHOW_DELAY_MS)
  }, [clearTimer, side])

  const hide = useCallback(() => {
    clearTimer()
    setOpen(false)
  }, [clearTimer])

  useEffect(() => clearTimer, [clearTimer])

  // Escape closes it, matching every other transient surface in the app.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, hide])

  return (
    <>
      <span
        ref={triggerRef}
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        style={{ display: 'inline-flex' }}
      >
        {children}
      </span>
      {open && coords ? (
        <span
          id={id}
          role="tooltip"
          className="tooltip"
          style={{
            top: coords.top,
            left: coords.left,
            transform:
              side === 'top'
                ? 'translate(-50%, -100%)'
                : 'translate(-50%, 0)',
          }}
        >
          {label}
        </span>
      ) : null}
    </>
  )
}
