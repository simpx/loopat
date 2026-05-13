import { useEffect, useState, useCallback } from "react"
import {
  listLoops,
  createLoop as apiCreateLoop,
  setLoopArchived as apiSetLoopArchived,
  getMe,
  login as apiLogin,
  register as apiRegister,
  logout as apiLogout,
  type LoopMeta,
  type User,
} from "./api"

export type WorkspaceState = {
  loops: LoopMeta[]
  showArchived: boolean
  setShowArchived: (b: boolean) => void
  refresh: () => Promise<void>
  createLoop: (opts: { title: string; repo?: string }) => Promise<LoopMeta>
  setLoopArchived: (id: string, archived: boolean) => Promise<void>
  newLoopDialogOpen: boolean
  setNewLoopDialogOpen: (b: boolean) => void

  // auth
  currentUser: User | null
  authLoading: boolean
  login: (username: string, password: string) => Promise<{ error?: string }>
  register: (input: { username: string; password: string; personalRepo?: string }) => Promise<{
    error?: string
    publicKey?: string | null
    personalRepo?: string | null
    needsImport?: boolean
  }>
  logout: () => Promise<void>
}

export function useWorkspaceState(): WorkspaceState {
  const [loops, setLoops] = useState<LoopMeta[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const [newLoopDialogOpen, setNewLoopDialogOpen] = useState(false)
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [authLoading, setAuthLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoops(await listLoops(showArchived ? "all" : "active"))
  }, [showArchived])

  // bootstrap: who am I?
  useEffect(() => {
    let cancelled = false
    getMe().then((u) => {
      if (cancelled) return
      setCurrentUser(u)
      setAuthLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // load loops on mount (public read)
  useEffect(() => {
    refresh()
  }, [refresh])

  // re-load loops when auth state changes (so newly-visible items show up if needed)
  useEffect(() => {
    refresh()
  }, [currentUser, refresh])

  const createLoop = useCallback(async (opts: { title: string; repo?: string }) => {
    const m = await apiCreateLoop(opts)
    setLoops((prev) => [m, ...prev])
    return m
  }, [])

  const setLoopArchived = useCallback(async (id: string, archived: boolean) => {
    const updated = await apiSetLoopArchived(id, archived)
    if (!updated) return
    setLoops((prev) => {
      // If we're not showing archived and we just archived, drop from list.
      if (!showArchived && updated.archived) return prev.filter((l) => l.id !== id)
      return prev.map((l) => (l.id === id ? updated : l))
    })
  }, [showArchived])

  const login = useCallback(async (username: string, password: string) => {
    const r = await apiLogin(username, password)
    if (r.user) setCurrentUser(r.user)
    return { error: r.error }
  }, [])

  const register = useCallback(
    async (input: { username: string; password: string; personalRepo?: string }) => {
      const r = await apiRegister(input)
      if (r.user) setCurrentUser(r.user)
      return {
        error: r.error,
        publicKey: r.publicKey,
        personalRepo: r.personalRepo,
        needsImport: r.needsImport,
      }
    },
    [],
  )

  const logout = useCallback(async () => {
    await apiLogout()
    setCurrentUser(null)
  }, [])

  return {
    loops,
    showArchived,
    setShowArchived,
    refresh,
    createLoop,
    setLoopArchived,
    newLoopDialogOpen,
    setNewLoopDialogOpen,
    currentUser,
    authLoading,
    login,
    register,
    logout,
  }
}
