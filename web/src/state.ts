import { useEffect, useState, useCallback } from "react"
import {
  listLoops,
  createLoop as apiCreateLoop,
  getMe,
  login as apiLogin,
  register as apiRegister,
  logout as apiLogout,
  type LoopMeta,
  type User,
} from "./api"

export type WorkspaceState = {
  loops: LoopMeta[]
  refresh: () => Promise<void>
  createLoop: (opts: { title: string; repo?: string }) => Promise<LoopMeta>
  newLoopDialogOpen: boolean
  setNewLoopDialogOpen: (b: boolean) => void

  // auth
  currentUser: User | null
  authLoading: boolean
  login: (username: string, password: string) => Promise<{ error?: string }>
  register: (input: { username: string; password: string; personalRepo?: string }) => Promise<{ error?: string }>
  logout: () => Promise<void>
}

export function useWorkspaceState(): WorkspaceState {
  const [loops, setLoops] = useState<LoopMeta[]>([])
  const [newLoopDialogOpen, setNewLoopDialogOpen] = useState(false)
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [authLoading, setAuthLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoops(await listLoops())
  }, [])

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

  const login = useCallback(async (username: string, password: string) => {
    const r = await apiLogin(username, password)
    if (r.user) setCurrentUser(r.user)
    return { error: r.error }
  }, [])

  const register = useCallback(
    async (input: { username: string; password: string; personalRepo?: string }) => {
      const r = await apiRegister(input)
      if (r.user) setCurrentUser(r.user)
      return { error: r.error }
    },
    [],
  )

  const logout = useCallback(async () => {
    await apiLogout()
    setCurrentUser(null)
  }, [])

  return {
    loops,
    refresh,
    createLoop,
    newLoopDialogOpen,
    setNewLoopDialogOpen,
    currentUser,
    authLoading,
    login,
    register,
    logout,
  }
}
