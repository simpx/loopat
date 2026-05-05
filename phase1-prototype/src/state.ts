/**
 * Module-level signals for the prototype. Pure mock — no backend, no
 * persistence. Mutations (fork, transfer, etc.) update signals and the
 * UI re-renders.
 */
import { createSignal } from "solid-js"

export type Loop = {
  id: string
  title: string
  driver: string
  branch?: string
  forkedFrom?: string
  closed?: boolean
  ago: string
}

const initialLoops: Loop[] = [
  { id: "gateway-launch", title: "上线 gateway", driver: "阿尔萨斯", branch: "feat/gateway", ago: "14m" },
  { id: "rdma-fix", title: "rdma_register 失败排查", driver: "simpx", branch: "fix/rdma-register", ago: "2h" },
  { id: "1001-design", title: "1001 系统设计", driver: "simpx", ago: "26m" },
  { id: "loopctl", title: "loopctl Runtime 命令", driver: "simpx", ago: "3h" },
  { id: "llama-research", title: "调研 llama-3", driver: "simpx", ago: "1d" },
]

export const [loops, setLoops] = createSignal<Loop[]>(initialLoops)
export const [currentLoopId, setCurrentLoopId] = createSignal<string>("gateway-launch")

export function forkLoop(sourceId: string): string {
  const source = loops().find((l) => l.id === sourceId)
  if (!source) return sourceId
  const newId = `${source.id}-fork-${Date.now().toString(36).slice(-4)}`
  const newLoop: Loop = {
    id: newId,
    title: `${source.title} (fork)`,
    driver: source.driver,
    branch: source.branch ? `${source.branch}-fork` : undefined,
    forkedFrom: source.id,
    ago: "just now",
  }
  setLoops([newLoop, ...loops()])
  setCurrentLoopId(newId)
  return newId
}
