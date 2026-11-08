import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  /** Footer actions, usually Buttons. */
  actions?: ReactNode
  wide?: boolean
  /** Hide the default header close button when the caller renders its own. */
  hideClose?: boolean
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Shared dialog shell.
 *
 * Focus is moved into the panel on open, cycled inside it while open, and
 * returned to whatever opened it on close. Without that, a keyboard user who
 * opened a dialog was left tabbing through the page behind it, which Phase 9
 * requires to work.
 */
export function Modal({ title, onClose, children, actions, wide = false, hideClose = false }: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  // Remember the opener so focus can go back to it.
  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null
    return () => {
      previouslyFocused.current?.focus?.()
    }
  }, [])

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const first = panel.querySelector<HTMLElement>(FOCUSABLE)
    // The panel itself is focusable so a dialog with no controls still traps.
    ;(first ?? panel).focus()
  }, [])

  // Lock background scrolling while the dialog is open.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return

      const panel = panelRef.current
      if (!panel) return
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (node) => node.offsetParent !== null,
      )
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    },
    [onClose],
  )

  return (
    <div
      className="modal-scrim"
      // Clicking the scrim closes, but a click that starts inside the panel and
      // drags out must not, so compare the target rather than using a bubble.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        className={wide ? 'modal-panel modal-panel--wide' : 'modal-panel'}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="modal-head">
          <h2 className="modal-title">{title}</h2>
          {hideClose ? null : (
            <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label="Close dialog" onClick={onClose}>
              <X size={15} />
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {actions ? <div className="modal-actions">{actions}</div> : null}
      </div>
    </div>
  )
}
