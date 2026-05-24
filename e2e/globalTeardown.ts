/**
 * Global teardown — kill the test backend and remove the temp LOOPAT_HOME.
 * Only touches test resources (specific PID + temp dir), never dev.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const META = join(import.meta.dirname, ".test-meta.json");

async function globalTeardown() {
  try {
    const meta = JSON.parse(readFileSync(META, "utf8"));

    // Best-effort kill by PID, then ensure the port is free.
    if (meta.serverPid) {
      try { process.kill(meta.serverPid, "SIGTERM"); } catch {}
      console.log(`[e2e:teardown] killed server pid=${meta.serverPid}`);
    }
    // Safety net: if the backend survived SIGTERM, force-kill by port.
    // The test port is always in the 20000+ range, never a dev port.
    if (meta.testServerPort) {
      try { execSync(`fuser -k ${meta.testServerPort}/tcp 2>/dev/null || true`, { stdio: "ignore" }); } catch {}
    }

    if (meta.loopatHome) {
      rmSync(meta.loopatHome, { recursive: true, force: true });
      console.log(`[e2e:teardown] removed ${meta.loopatHome}`);
    }
  } catch (e) {
    console.log(`[e2e:teardown] cleanup skipped: ${e}`);
  }
}

export default globalTeardown;
