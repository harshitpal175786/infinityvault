import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Shows a spinner and blocks interaction while work is in flight. */
  loading?: boolean
  /** Square icon-only button. Requires aria-label (enforced by callers). */
  icon?: boolean
  block?: boolean
  children?: ReactNode
}

/**
 * The single button primitive.
 *
 * Existing screens keep using .ghost-button and .primary-button, which remain
 * unchanged, so adopting this is opt-in per screen rather than a sweeping
 * rewrite that could alter completed screens.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, icon = false, block = false, children, className = '', disabled, ...rest },
  ref,
) {
  const classes = [
    'btn',
    `btn--${variant}`,
    size !== 'md' ? `btn--${size}` : '',
    icon ? 'btn--icon' : '',
    block ? 'btn--block' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      ref={ref}
      type="button"
      className={classes}
      // A loading button must stay focusable but not re-fire.
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  )
})
