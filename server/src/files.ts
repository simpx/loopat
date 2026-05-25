import { readdir, readFile, writeFile, stat, mkdir, rm, unlink } from "node:fs/promises"
import { join, normalize, relative, sep, dirname } from "node:path"
import { loopDir } from "./paths"

export type FileEntry = {
  name: string
  path: string // relative to workdir, posix-style
  type: "file" | "dir"
  size?: number
}

function safeJoin(rootAbs: string, rel: string): string | null {
  const candidate = normalize(join(rootAbs, rel))
  const insideRel = relative(rootAbs, candidate)
  if (insideRel.startsWith("..") || insideRel.startsWith("/" + sep)) return null
  return candidate
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".bun", ".claude"])

export async function listDir(loopId: string, relPath: string): Promise<FileEntry[]> {
  const root = loopDir(loopId)
  const abs = safeJoin(root, relPath)
  if (!abs) throw new Error("path escapes workdir")
  let names: string[] = []
  try {
    names = await readdir(abs)
  } catch {
    return []
  }
  const out: FileEntry[] = []
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue
    if (name === ".git" || name === ".DS_Store") continue
    const childRel = relPath ? `${relPath}/${name}` : name
    let isDir = false
    let size: number | undefined
    try {
      // stat follows symlinks → symlinked-dir reports as dir
      const s = await stat(join(abs, name))
      isDir = s.isDirectory()
      if (!isDir) size = s.size
    } catch {
      continue
    }
    out.push({ name, path: childRel, type: isDir ? "dir" : "file", size })
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return out
}

const MAX_BYTES = 256 * 1024

export async function readWorkdirFile(loopId: string, relPath: string): Promise<{ content: string; truncated: boolean; size: number } | null> {
  const root = loopDir(loopId)
  const abs = safeJoin(root, relPath)
  if (!abs) return null
  try {
    const s = await stat(abs)
    if (!s.isFile()) return null
    const truncated = s.size > MAX_BYTES
    const buf = await readFile(abs)
    const slice = truncated ? buf.subarray(0, MAX_BYTES) : buf
    return { content: slice.toString("utf8"), truncated, size: s.size }
  } catch {
    return null
  }
}

export async function writeWorkdirFile(loopId: string, relPath: string, content: string): Promise<boolean> {
  const root = loopDir(loopId)
  const abs = safeJoin(root, relPath)
  if (!abs) return false
  try {
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content)
    return true
  } catch {
    return false
  }
}

export async function deleteWorkdirFile(loopId: string, relPath: string): Promise<boolean> {
  const root = loopDir(loopId)
  const abs = safeJoin(root, relPath)
  if (!abs) return false
  try {
    const s = await stat(abs)
    if (s.isDirectory()) {
      await rm(abs, { recursive: true, force: true })
    } else {
      await unlink(abs)
    }
    return true
  } catch {
    return false
  }
}

export async function createWorkdirFolder(loopId: string, relPath: string): Promise<boolean> {
  const root = loopDir(loopId)
  const abs = safeJoin(root, relPath)
  if (!abs) return false
  try {
    await mkdir(abs, { recursive: true })
    return true
  } catch {
    return false
  }
}

const MAX_RECURSIVE_ENTRIES = 5000
const MAX_RECURSIVE_DEPTH = 20

/**
 * Recursively list all files and directories under a root path within a loop.
 * Returns a flat array sorted dirs-first then alpha. One HTTP call replaces
 * the frontend's recursive fetchAllFiles waterfall.
 */
export async function listDirRecursive(
  loopId: string,
  relPath: string,
): Promise<FileEntry[]> {
  const root = loopDir(loopId)
  const abs = safeJoin(root, relPath)
  if (!abs) return []

  const result: FileEntry[] = []
  const skip = new Set(SKIP_DIRS)
  skip.add(".git").add(".DS_Store")

  async function walk(absPath: string, prefix: string, depth: number) {
    if (result.length >= MAX_RECURSIVE_ENTRIES) return
    if (depth > MAX_RECURSIVE_DEPTH) return

    let names: string[]
    try {
      names = await readdir(absPath)
    } catch {
      return
    }

    const entries: Array<{ name: string; isDir: boolean }> = []
    for (const name of names) {
      if (skip.has(name)) continue
      try {
        const s = await stat(join(absPath, name))
        entries.push({ name, isDir: s.isDirectory() })
      } catch {
        continue
      }
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    for (const { name, isDir } of entries) {
      if (result.length >= MAX_RECURSIVE_ENTRIES) break
      const childRel = prefix ? `${prefix}/${name}` : name
      result.push({ name, path: childRel, type: isDir ? "dir" : "file" })
      if (isDir) {
        await walk(join(absPath, name), childRel, depth + 1)
      }
    }
  }

  await walk(abs, relPath, 0)
  return result
}
