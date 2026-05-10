import { useEffect, useState, useCallback } from "react"
import { listLoops, createLoop as apiCreateLoop, type LoopMeta } from "./api"

export type WorkspaceState = {
  loops: LoopMeta[]
  refresh: () => Promise<void>
  createLoop: (opts: { title: string; repo?: string }) => Promise<LoopMeta>
  newLoopDialogOpen: boolean
  setNewLoopDialogOpen: (b: boolean) => void
}

export function useWorkspaceState(): WorkspaceState {
  const [loops, setLoops] = useState<LoopMeta[]>([])
  const [newLoopDialogOpen, setNewLoopDialogOpen] = useState(false)

  const refresh = useCallback(async () => {
    setLoops(await listLoops())
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const createLoop = useCallback(async (opts: { title: string; repo?: string }) => {
    const m = await apiCreateLoop(opts)
    setLoops((prev) => [m, ...prev])
    return m
  }, [])

  return { loops, refresh, createLoop, newLoopDialogOpen, setNewLoopDialogOpen }
}
