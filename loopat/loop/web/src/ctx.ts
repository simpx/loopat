import { createContext, useContext } from "react"
import type { WorkspaceState } from "./state"

export const WorkspaceCtx = createContext<WorkspaceState | null>(null)

export function useWorkspace(): WorkspaceState {
  const v = useContext(WorkspaceCtx)
  if (!v) throw new Error("useWorkspace outside provider")
  return v
}
