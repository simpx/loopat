/**
 * e2e helper: provision a throwaway workspace (taken from $LOOPAT_HOME) with a
 * user, a loop, and a real running sandbox container — the SAME code path the
 * server uses on terminal/session attach. Driven by install-uninstall.sh.
 *
 * Prints `ws=<workspace> loop=<id>` so the harness can assert on it.
 */
import { ensureWorkspaceDirs, createLoop, provisionUserPersonal } from "../../server/src/loops"
import { createUser } from "../../server/src/auth"
import { ensureContainer } from "../../server/src/podman"
import { WORKSPACE } from "../../server/src/paths"

await ensureWorkspaceDirs()
await createUser({ id: "e2e", password: "test1234" })
await provisionUserPersonal("e2e")
const loop = await createLoop({ title: "e2e-loop", createdBy: "e2e" })
await ensureContainer({ loopId: loop.id, createdBy: "e2e" })
console.log(`ws=${WORKSPACE} loop=${loop.id}`)
