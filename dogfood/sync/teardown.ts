/**
 * dogfood/sync teardown — reap everything setup brought up: the shared fixture
 * sshd, BOTH backends, BOTH per-server podman networks, all loop containers
 * spawned across either server, and both temp LOOPAT_HOMEs. Test-only resources.
 */
import { readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { execSync, execFileSync } from "node:child_process";

const META = join(import.meta.dirname, ".test-meta.json");

async function globalTeardown() {
  try {
    const meta = JSON.parse(readFileSync(META, "utf8"));

    // fixture container
    if (meta.fixtureContainer) {
      try { execFileSync("podman", ["rm", "-f", meta.fixtureContainer], { stdio: "ignore" }); } catch {}
    }

    // both backends (SIGTERM + port-kill safety net; ports are always 24000+)
    for (const [pid, port] of [[meta.pidA, meta.aBack], [meta.pidB, meta.bBack]]) {
      if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} }
      if (port) { try { execSync(`fuser -k ${port}/tcp 2>/dev/null || true`, { stdio: "ignore" }); } catch {} }
    }

    // per-server podman networks + temp HOMEs
    for (const home of [meta.homeA, meta.homeB]) {
      if (!home) continue;
      const network = `loopat-${basename(home).replace(/^\.+/, "") || "loopat"}`;
      try { execFileSync("podman", ["network", "rm", "-f", network], { stdio: "ignore" }); } catch {}
      rmSync(home, { recursive: true, force: true });
    }
    console.log("[dogfood:sync] teardown complete");
  } catch (e) {
    console.log(`[dogfood:sync] cleanup skipped: ${e}`);
  }
}

export default globalTeardown;
