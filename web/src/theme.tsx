import { createContext, useContext, useLayoutEffect, useState, useCallback, type ReactNode } from "react"

type Theme = "light" | "dark"

interface ThemeCtxValue {
  theme: Theme
  toggle: () => void
}

const ThemeCtx = createContext<ThemeCtxValue>({ theme: "light", toggle: () => {} })

export function useTheme() {
  return useContext(ThemeCtx)
}

const STORAGE_KEY = "loopat:theme"

function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === "dark" || stored === "light") return stored
  } catch {}
  if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) return "dark"
  return "light"
}

function applyTheme(theme: Theme) {
  const root = document.documentElement
  if (theme === "dark") {
    root.classList.add("dark")
  } else {
    root.classList.remove("dark")
  }
}

// Apply theme synchronously before first paint to avoid flash
applyTheme(getStoredTheme())

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(getStoredTheme)

  // Sync on mount in case the module-level call raced
  useLayoutEffect(() => {
    applyTheme(theme)
  }, [theme])

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "light" ? "dark" : "light"
      applyTheme(next)
      try {
        localStorage.setItem(STORAGE_KEY, next)
      } catch {}
      return next
    })
  }, [])

  return (
    <ThemeCtx.Provider value={{ theme, toggle }}>
      {children}
    </ThemeCtx.Provider>
  )
}
