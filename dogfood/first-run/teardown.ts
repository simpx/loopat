/**
 * dogfood/first-run global teardown — reap everything setup brought up:
 * fixture sshd container, backend, podman network, and the temp LOOPAT_HOME.
 * Only touches recorded test resources (container id + PID + temp dir).
 */
import { readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { execSync, execFileSync } from "node:child_process";

const META = join(import.meta.dirname, ".test-meta.json");

async function globalTeardown() {
  try {
    const meta = JSON.parse(readFileSync(META, "utf8"));

    if (meta.fixtureContainer) {
      try {
        execFileSync("podman", ["rm", "-f", meta.fixtureContainer], { stdio: "ignore" });
        console.log(`[first-run:teardown] removed fixture ${String(meta.fixtureContainer).slice(0, 12)}`);
      } catch (e) {
        console.log(`[first-run:teardown] fixture rm skipped: ${e}`);
      }
    }

    if (meta.serverPid) {
      try { process.kill(meta.serverPid, "SIGTERM"); } catch {}
      console.log(`[first-run:teardown] killed server pid=${meta.serverPid}`);
    }
    if (meta.testServerPort) {
      try { execSync(`fuser -k ${meta.testServerPort}/tcp 2>/dev/null || true`, { stdio: "ignore" }); } catch {}
    }

    if (meta.loopatHome) {
      const network = `loopat-${basename(meta.loopatHome).replace(/^\.+/, "") || "loopat"}`;
      try {
        execFileSync("podman", ["network", "rm", "-f", network], { stdio: "ignore" });
        console.log(`[first-run:teardown] removed network ${network}`);
      } catch {}
    }

    if (meta.loopatHome) {
      rmSync(meta.loopatHome, { recursive: true, force: true });
      console.log(`[first-run:teardown] removed ${meta.loopatHome}`);
    }
  } catch (e) {
    console.log(`[first-run:teardown] cleanup skipped: ${e}`);
  }
}

export default globalTeardown;
