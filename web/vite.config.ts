import { defineConfig } from "vite"
import { fileURLToPath, URL } from "node:url"
import { execSync } from "node:child_process"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

function git(key: string, fallback = "unknown") {
  try { return execSync(`git rev-parse ${key}`, { encoding: "utf8" }).trim() } catch { return fallback }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __BUILD_COMMIT__: JSON.stringify(git("HEAD")),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: true,
        chunkFileNames: "assets/[name]-[hash].js",
      },
    },
  },
  server: {
    host: process.env.HOST ?? "localhost",
    port: 5173,
    allowedHosts: [".ngrok-free.app"],
    proxy: {
      "/api": { target: `http://${process.env.HOST ?? "localhost"}:${process.env.PORT ?? 10001}` },
      // A2A endpoints live at root paths (not under /api): proxy them to the
      // bun server so the agent card + JSON-RPC work in vite-dev-served envs.
      "/a2a": { target: `http://${process.env.HOST ?? "localhost"}:${process.env.PORT ?? 10001}` },
      "/.well-known": { target: `http://${process.env.HOST ?? "localhost"}:${process.env.PORT ?? 10001}` },
      "/ws": {
        target: `ws://${process.env.HOST ?? "localhost"}:${process.env.PORT ?? 10001}`,
        ws: true,
      },
    },
  },
})
