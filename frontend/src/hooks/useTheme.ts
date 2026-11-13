import { useCallback, useEffect, useState } from 'react'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'infinityvault-theme'

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function storedTheme(): Theme | undefined {
  const value = window.localStorage.getItem(STORAGE_KEY)
  return value === 'light' || value === 'dark' ? value : undefined
}

const TRANSITION_ATTR = 'data-theme-transition'
let transitionTimer: number | undefined

/**
 * Adds the transition attribute, swaps the theme, then removes it once the
 * animation has finished. Doing this in an attribute keeps the transition
 * scoped to the switch instead of animating the initial paint.
 */
function applyTheme(theme: Theme, animate = false): void {
  const root = document.documentElement

  if (animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    root.setAttribute(TRANSITION_ATTR, '')
    window.clearTimeout(transitionTimer)
    transitionTimer = window.setTimeout(() => root.removeAttribute(TRANSITION_ATTR), 360)
  }

  root.dataset.theme = theme
}

/**
 * Resolves the starting theme. The initial paint is handled by the inline
 * script in index.html; this mirrors the same precedence so the first React
 * render never disagrees with what is already on screen.
 */
function initialTheme(): Theme {
  return storedTheme() ?? (document.documentElement.dataset.theme as Theme | undefined) ?? systemTheme()
}

export function useTheme(): { theme: Theme; toggleTheme: () => void; setTheme: (theme: Theme) => void } {
  const [theme, setThemeState] = useState<Theme>(initialTheme)

  const setTheme = useCallback((next: Theme) => {
    applyTheme(next, true)
    window.localStorage.setItem(STORAGE_KEY, next)
    setThemeState(next)
  }, [])

  const toggleTheme = useCallback(() => {
    setThemeState((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark'
      applyTheme(next, true)
      window.localStorage.setItem(STORAGE_KEY, next)
      return next
    })
  }, [])

  // Follow the OS only while the user has expressed no preference.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    function onChange(event: MediaQueryListEvent) {
      if (storedTheme()) return
      const next: Theme = event.matches ? 'dark' : 'light'
      applyTheme(next, true)
      setThemeState(next)
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  return { theme, toggleTheme, setTheme }
}
