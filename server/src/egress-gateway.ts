/**
 * Per-loop egress gateway. A small Bun.serve the loop's claude points its
 * ANTHROPIC_BASE_URL at; it forwards every call to the real provider and
 * records the full request/response to loops/<id>/trace.jsonl. The loop talks
 * to it in plaintext over the bridge (host.containers.internal:<port>), so no
 * MITM cert is needed; the gateway makes the real HTTPS call upstream.
 *
 * Lives and dies with the LoopSession. Always records — one extra hop, a few
 * MB; cheap, and trace is the point. Future home for usage / audit / authz /
 * cross-provider model-id remap; today it's transparent + traced.
 *
 * Keys are never written to disk: trace records only hasKey + a 4-char prefix.
 */
import { appendFile } from "node:fs/promises"
import { loopTracePath } from "./paths"

export type LoopGateway = { port: number; stop: () => void }

/** Start a gateway for one loop, forwarding to `upstream` (provider baseUrl). */
export function startLoopGateway(loopId: string, upstream: string): LoopGateway {
  const base = upstream.replace(/\/+$/, "")
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0, // ephemeral; container reaches it via host.containers.internal
    idleTimeout: 240,
    async fetch(req) {
      const t0 = Date.now()
      const url = new URL(req.url)
      const target = base + url.pathname + url.search
      const key = req.headers.get("x-api-key") || req.headers.get("authorization") || ""
      const turn = req.headers.get("x-loopat-turn") || null
      const reqBody = req.method === "POST" ? await req.clone().text() : ""
      // Drop hop headers — forwarding Host: host.containers.internal upstream
      // makes the provider 404. Let fetch set Host from the target.
      const fwd = new Headers(req.headers); fwd.delete("host"); fwd.delete("content-length"); fwd.delete("accept-encoding")
      let res: Response
      try {
        res = await fetch(target, { method: req.method, headers: fwd, body: req.method === "POST" ? reqBody : undefined, tls: { rejectUnauthorized: false } } as any)
      } catch (e: any) {
        await record(loopId, { turn, hasKey: !!key, keyPrefix: key.slice(0, 4), method: req.method, target, status: 0, durMs: Date.now() - t0, error: String(e?.message ?? e), reqBody: trunc(reqBody) })
        return new Response(JSON.stringify({ error: "gateway upstream failed" }), { status: 502 })
      }
      // Tee: clone for the trace (async, non-blocking), stream original to loop
      // so SSE passes through unbuffered. Drop content-encoding (we un-gzip'd).
      res.clone().text().then((b) => record(loopId, { turn, hasKey: !!key, keyPrefix: key.slice(0, 4), method: req.method, target, status: res.status, durMs: Date.now() - t0, reqBody: trunc(reqBody), respBody: trunc(b) })).catch(() => {})
      const out = new Headers(res.headers); out.delete("content-encoding"); out.delete("content-length")
      return new Response(res.body, { status: res.status, headers: out })
    },
  })
  return { port: server.port as number, stop: () => server.stop(true) }
}

function trunc(s: string): string { return s.length > 8192 ? s.slice(0, 8192) + "…[+" + (s.length - 8192) + "]" : s }

async function record(loopId: string, e: Record<string, unknown>): Promise<void> {
  try { await appendFile(loopTracePath(loopId), JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n") } catch {}
}
