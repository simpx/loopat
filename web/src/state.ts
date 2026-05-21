import { useEffect, useState, useCallback } from "react"
import {
  listLoops,
  createLoop as apiCreateLoop,
  setLoopArchived as apiSetLoopArchived,
  setLoopPublic as apiSetLoopPublic,
  setLoopTitle as apiSetLoopTitle,
  requestDrive as apiRequestDrive,
  takeDrive as apiTakeDrive,
  getMe,
  login as apiLogin,
  register as apiRegister,
  logout as apiLogout,
  type LoopMeta,
  type User,
} from "./api"

export type KanbanCreateCtx = { board: string; filename: string; cid: string }

export type WorkspaceState = {
  loops: LoopMeta[]
  loopsLoading: boolean
  showArchived: boolean
  setShowArchived: (b: boolean) => void
  refresh: () => Promise<void>
  createLoop: (opts: { title: string; repo?: string; sandbox?: string; vault?: string; knowledgeRw?: boolean; mountAllLoops?: boolean }) => Promise<LoopMeta>
  setLoopArchived: (id: string, archived: boolean) => Promise<void>
  setLoopPublic: (id: string, isPublic: boolean) => Promise<void>
  setLoopTitle: (id: string, title: string) => Promise<LoopMeta | null>
  requestDrive: (id: string) => Promise<void>
  takeDrive: (id: string) => Promise<void>
  newLoopDialogOpen: boolean
  newLoopDialogTitle: string
  kanbanCreateCtx: KanbanCreateCtx | null
  setNewLoopDialogOpen: (open: boolean, title?: string, kanbanCtx?: KanbanCreateCtx) => void

  // auth
  currentUser: User | null
  authLoading: boolean
  login: (username: string, password: string) => Promise<{ error?: string }>
  register: (input: { username: string; password: string; personalRepo?: string }) => Promise<{
    error?: string
    user?: User
    publicKey?: string | null
    personalRepo?: string | null
    needsImport?: boolean
  }>
  logout: () => Promise<void>
}

export function useWorkspaceState(): WorkspaceState {
  const [loops, setLoops] = useState<LoopMeta[]>([])
  const [loopsLoading, setLoopsLoading] = useState(true)
  const [showArchived, setShowArchived] = useState(false)
  const [newLoopDialogOpen, setNewLoopDialogOpenRaw] = useState(false)
  const [newLoopDialogTitle, setNewLoopDialogTitle] = useState("")
  const [kanbanCreateCtx, setKanbanCreateCtx] = useState<KanbanCreateCtx | null>(null)
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [authLoading, setAuthLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoopsLoading(true)
    setLoops(await listLoops(showArchived ? "all" : "active"))
    setLoopsLoading(false)
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

  // load loops on mount; re-load when showArchived or auth state changes
  useEffect(() => {
    refresh()
  }, [showArchived, currentUser])

  const createLoop = useCallback(async (opts: { title: string; repo?: string; sandbox?: string; vault?: string; knowledgeRw?: boolean; mountAllLoops?: boolean }) => {
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

  const setLoopPublic = useCallback(async (id: string, isPublic: boolean) => {
    const updated = await apiSetLoopPublic(id, isPublic)
    if (!updated) return
    setLoops((prev) => prev.map((l) => (l.id === id ? updated : l)))
  }, [])

  const setLoopTitle = useCallback(async (id: string, title: string) => {
    const updated = await apiSetLoopTitle(id, title)
    if (!updated) return null
    setLoops((prev) => prev.map((l) => (l.id === id ? updated : l)))
    return updated
  }, [])

  const requestDrive = useCallback(async (id: string) => {
    const updated = await apiRequestDrive(id)
    if (!updated) return
    setLoops((prev) => prev.map((l) => (l.id === id ? updated : l)))
  }, [])

  const takeDrive = useCallback(async (id: string) => {
    const updated = await apiTakeDrive(id)
    if (!updated) return
    setLoops((prev) => prev.map((l) => (l.id === id ? updated : l)))
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    const r = await apiLogin(username, password)
    if (r.user) setCurrentUser(r.user)
    return { error: r.error }
  }, [])

  const register = useCallback(
    async (input: { username: string; password: string; personalRepo?: string }) => {
      const r = await apiRegister(input)
      // Only seed currentUser when registration actually established a session.
      // Pending accounts (everyone except the very first user) must wait for
      // an admin to activate before they can log in.
      if (r.user && r.user.status === "active") setCurrentUser(r.user)
      return {
        error: r.error,
        user: r.user,
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

  const setNewLoopDialogOpen = useCallback(
    (open: boolean, title?: string, kanbanCtx?: KanbanCreateCtx) => {
      setNewLoopDialogOpenRaw(open)
      setNewLoopDialogTitle(title ?? "")
      setKanbanCreateCtx(kanbanCtx ?? null)
    },
    [],
  )

  return {
    loops,
    loopsLoading,
    showArchived,
    setShowArchived,
    refresh,
    createLoop,
    setLoopArchived,
    setLoopPublic,
    setLoopTitle,
    requestDrive,
    takeDrive,
    newLoopDialogOpen,
    newLoopDialogTitle,
    kanbanCreateCtx,
    setNewLoopDialogOpen,
    currentUser,
    authLoading,
    login,
    register,
    logout,
  }
}
