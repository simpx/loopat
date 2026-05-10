import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime"
import { homedir } from "node:os"
import {
  ME,
  loopWorkdir,
  loopClaudeDir,
  loopContextDir,
  workspaceKnowledgeDir,
  workspaceNotesDir,
  personalDir,
  LOOPAT_INSTALL_DIR,
} from "./paths"
import { resolvePersonalDeps } from "./personal-deps"

let initPromise: Promise<void> | null = null

function emptyConfig(): SandboxRuntimeConfig {
  return {
    network: { allowedDomains: ["*"], deniedDomains: [] },
    filesystem: { allowWrite: [], denyWrite: [], denyRead: [], allowRead: [] },
  } as SandboxRuntimeConfig
}

async function loopConfig(loopId: string): Promise<SandboxRuntimeConfig> {
  const home = homedir()
  const personalDeps = await resolvePersonalDeps()
  return {
    network: { allowedDomains: ["*"], deniedDomains: [] },
    filesystem: {
      denyRead: [home],
      allowRead: [
        LOOPAT_INSTALL_DIR,
        loopContextDir(loopId),
        workspaceKnowledgeDir(),
        ...personalDeps,
      ],
      allowWrite: [
        loopWorkdir(loopId),
        loopClaudeDir(loopId),
        workspaceNotesDir(),
        personalDir(ME),
        ...personalDeps,
      ],
      denyWrite: [],
    },
  } as SandboxRuntimeConfig
}

export async function ensureSandboxInitialized(): Promise<void> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    if (!SandboxManager.isSupportedPlatform()) {
      console.warn("[loopat] sandbox: unsupported platform, PTY will run unsandboxed")
      return
    }
    await SandboxManager.initialize(emptyConfig())
    const dep = SandboxManager.checkDependencies()
    if (dep.errors.length > 0) {
      console.warn("[loopat] sandbox missing deps:", dep.errors.join(", "))
    } else {
      console.log("[loopat] sandbox runtime initialized (bwrap + socat ok)")
      if (dep.warnings.length > 0) console.warn("[loopat] sandbox warnings:", dep.warnings.join(", "))
    }
  })()
  return initPromise
}

export async function wrapForLoop(command: string, loopId: string): Promise<string> {
  await ensureSandboxInitialized()
  if (!SandboxManager.isSandboxingEnabled()) return command
  return SandboxManager.wrapWithSandbox(command, "/bin/bash", await loopConfig(loopId))
}
