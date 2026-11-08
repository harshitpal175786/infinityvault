interface SpinnerProps {
  size?: 'md' | 'lg'
  /** Accessible label. Omit when a nearby visible label already describes it. */
  label?: string
}

/**
 * Indeterminate progress. Colour is inherited via currentColor, so it works on
 * any surface without a variant.
 */
export function Spinner({ size = 'md', label }: SpinnerProps) {
  return (
    <span
      className={size === 'lg' ? 'spinner spinner--lg' : 'spinner'}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  )
}

interface SkeletonProps {
  /** Shape of the placeholder: a text line, a square tile, or free-form. */
  variant?: 'text' | 'tile' | 'block'
  width?: string
  height?: string
  className?: string
}

/**
 * Placeholder for content with a known shape but unknown data.
 *
 * Used instead of a blank area so the layout does not jump when content
 * arrives — the Phase 2 completion criteria call for no layout shift.
 */
export function Skeleton({ variant = 'block', width, height, className = '' }: SkeletonProps) {
  const classes = ['skeleton', variant !== 'block' ? `skeleton--${variant}` : '', className]
    .filter(Boolean)
    .join(' ')
  return <span className={classes} style={{ width, height }} aria-hidden="true" />
}

interface SkeletonGridProps {
  /** Roughly one screenful of tiles. */
  count?: number
}

/**
 * First-load placeholder for the timeline.
 *
 * Matches the real grid's tile size and gap so the layout does not shift when
 * data arrives — a blank area that becomes a grid is exactly the kind of jump
 * the Phase 2 criteria forbid.
 */
export function SkeletonGrid({ count = 24 }: SkeletonGridProps) {
  return (
    <div className="skeleton-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} variant="tile" />
      ))}
    </div>
  )
}
