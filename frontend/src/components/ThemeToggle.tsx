import { Moon, Sun } from 'lucide-react'
import type { Theme } from '../hooks/useTheme'

type Props = {
  theme: Theme
  onToggle: () => void
}

export function ThemeToggle({ theme, onToggle }: Props) {
  const nextLabel = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'

  return (
    <button
      className="theme-toggle"
      type="button"
      onClick={onToggle}
      aria-label={nextLabel}
      title={nextLabel}
      aria-pressed={theme === 'dark'}
    >
      <span className="theme-toggle-icon" key={theme}>
        {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      </span>
      <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
    </button>
  )
}
