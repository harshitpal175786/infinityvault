import { useCallback, useEffect, useRef, type ReactNode } from 'react'

export interface MenuAction {
  label: string
  icon?: ReactNode
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  /** Renders a divider above this item. */
  separated?: boolean
}

interface ContextMenuProps {
  /** Viewport coordinates of the click that opened the menu. */
  x: number
  y: number
  actions: MenuAction[]
  onClose: () => void
}

const EDGE_PADDING = 8

/**
 * Right-click menu.
 *
 * Positioned in viewport coordinates and flipped back inside the window when it
 * would overflow the right or bottom edge — a menu opened on the last tile in
 * the bottom-right corner would otherwise be cut off entirely.
 *
 * Closes on Escape, on any outside click, and on scroll or resize, because a
 * fixed-position menu left behind at stale coordinates is worse than no menu.
 */
export function ContextMenu({ x, y, actions, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    restoreFocus.current = document.activeElement as HTMLElement | null
    const first = ref.current?.querySelector<HTMLElement>('button:not([disabled])')
    first?.focus()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        restoreFocus.current?.focus?.()
        return
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const items = [...(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])]
      if (items.length === 0) return
      event.preventDefault()
      const index = items.indexOf(document.activeElement as HTMLElement)
      const next =
        event.key === 'ArrowDown'
          ? items[(index + 1) % items.length]
          : items[(index - 1 + items.length) % items.length]
      next?.focus()
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    // A fixed menu must not survive the page moving under it.
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      ref.current = node
      if (!node) return
      // Measure after mount, then pull the menu back inside the viewport.
      const rect = node.getBoundingClientRect()
      let left = x
      let top = y
      if (left + rect.width > window.innerWidth - EDGE_PADDING) {
        left = Math.max(EDGE_PADDING, window.innerWidth - rect.width - EDGE_PADDING)
      }
      if (top + rect.height > window.innerHeight - EDGE_PADDING) {
        top = Math.max(EDGE_PADDING, window.innerHeight - rect.height - EDGE_PADDING)
      }
      node.style.left = `${left}px`
      node.style.top = `${top}px`
    },
    [x, y],
  )

  return (
    <div ref={setRef} className="menu" role="menu" aria-label="Item actions">
      {actions.map((action, index) => (
        <div key={`${action.label}-${index}`}>
          {action.separated && index > 0 ? <hr className="menu-separator" /> : null}
          <button
            type="button"
            role="menuitem"
            className={action.danger ? 'menu-item menu-item--danger' : 'menu-item'}
            disabled={action.disabled}
            onClick={() => {
              action.onSelect()
              onClose()
            }}
          >
            {action.icon}
            <span>{action.label}</span>
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * Tracks where a context menu should appear. Kept separate from the menu so a
 * screen can own the open/close state without repeating coordinate plumbing.
 */
export function useContextMenu() {
  const position = useRef<{ x: number; y: number } | null>(null)
  const open = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    position.current = { x: event.clientX, y: event.clientY }
    return position.current
  }, [])
  return { open, position }
}
