/**
 * dogfood global teardown — tear down everything setup brought up:
 * the fixture sshd container, the backend, and the temp LOOPAT_HOME.
 * Only touches test resources (recorded container id + PID + temp dir),
 * never dev.
 */
import { readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { execSync, execFileSync } from "node:child_process";

const META = join(import.meta.dirname, ".test-meta.json");

async function globalTeardown() {
  try {
    const meta = JSON.parse(readFileSync(META, "utf8"));

    // ── fixture container ──
    if (meta.fixtureContainer) {
      try {
        execFileSync("podman", ["rm", "-f", meta.fixtureContainer], { stdio: "ignore" });
        console.log(`[dogfood:teardown] removed fixture ${String(meta.fixtureContainer).slice(0, 12)}`);
      } catch (e) {
        console.log(`[dogfood:teardown] fixture rm skipped: ${e}`);
      }
    }

    // ── backend ──
    if (meta.serverPid) {
      try { process.kill(meta.serverPid, "SIGTERM"); } catch {}
      console.log(`[dogfood:teardown] killed server pid=${meta.serverPid}`);
    }
    // Safety net: force-kill by port if SIGTERM didn't take. Test port is
    // always 22000+, never a dev port.
    if (meta.testServerPort) {
      try { execSync(`fuser -k ${meta.testServerPort}/tcp 2>/dev/null || true`, { stdio: "ignore" }); } catch {}
    }

    // ── podman network created by the backend's serve path ──
    // Named `loopat-<basename(LOOPAT_HOME)>` (see server paths.WORKSPACE /
    // podman.LOOPAT_NETWORK). The backend doesn't remove it on SIGTERM, so we
    // reap it here. `-f` also disconnects/removes any containers still on it.
    if (meta.loopatHome) {
      const network = `loopat-${basename(meta.loopatHome).replace(/^\.+/, "") || "loopat"}`;
      try {
        execFileSync("podman", ["network", "rm", "-f", network], { stdio: "ignore" });
        console.log(`[dogfood:teardown] removed network ${network}`);
      } catch {}
    }

    // ── temp LOOPAT_HOME ──
    if (meta.loopatHome) {
      rmSync(meta.loopatHome, { recursive: true, force: true });
      console.log(`[dogfood:teardown] removed ${meta.loopatHome}`);
    }
  } catch (e) {
    console.log(`[dogfood:teardown] cleanup skipped: ${e}`);
  }
}

export default globalTeardown;
