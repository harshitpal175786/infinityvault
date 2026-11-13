import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'

export type ToastKind = 'success' | 'error' | 'info'

export interface Toast {
  id: number
  kind: ToastKind
  message: string
}

interface ToastApi {
  /** Show a success toast. */
  success: (message: string) => void
  /** Show an error toast. Errors persist longer because they need reading. */
  error: (message: string) => void
  info: (message: string) => void
  dismiss: (id: number) => void
}

const ToastContext = createContext<ToastApi | null>(null)

// Errors stay up far longer than successes: a success is confirmation, an error
// is something the user has to act on.
const DISMISS_MS: Record<ToastKind, number> = {
  success: 3500,
  info: 4000,
  error: 8000,
}

const MAX_VISIBLE = 4

/**
 * Queue of transient messages.
 *
 * Replaces the single `notice` string App.tsx used to hold. That string meant a
 * new message silently overwrote the previous one, so a failed step could be
 * erased by a success that arrived a moment later, and nothing was announced to
 * assistive tech as it appeared.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)
  // Timers are tracked so dismissing early does not leave one to fire later
  // against an id that has already been reused.
  const timers = useRef(new Map<number, number>())

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer) {
      window.clearTimeout(timer)
      timers.current.delete(id)
    }
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextId.current++
      setToasts((current) => {
        // Keep the newest N so a burst of errors cannot cover the screen.
        const next = [...current, { id, kind, message }]
        return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next
      })
      const timer = window.setTimeout(() => dismiss(id), DISMISS_MS[kind])
      timers.current.set(id, timer)
    },
    [dismiss],
  )

  useEffect(() => {
    const pending = timers.current
    return () => {
      pending.forEach((timer) => window.clearTimeout(timer))
      pending.clear()
    }
  }, [])

  const api = useMemo<ToastApi>(
    () => ({
      success: (message: string) => push('success', message),
      error: (message: string) => push('error', message),
      info: (message: string) => push('info', message),
      dismiss,
    }),
    [push, dismiss],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast toast--${toast.kind}`}
            // Errors are assertive so they interrupt; confirmations are polite.
            role={toast.kind === 'error' ? 'alert' : 'status'}
            aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}
          >
            <span className="toast-icon" aria-hidden="true">
              {toast.kind === 'success' ? (
                <CheckCircle2 size={15} />
              ) : toast.kind === 'error' ? (
                <AlertCircle size={15} />
              ) : (
                <Info size={15} />
              )}
            </span>
            <span className="toast-text">{toast.message}</span>
            <button
              type="button"
              className="toast-close"
              aria-label="Dismiss notification"
              onClick={() => dismiss(toast.id)}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used inside a ToastProvider')
  }
  return context
}
