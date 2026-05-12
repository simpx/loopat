import { defineConfig } from "vite"
import { fileURLToPath, URL } from "node:url"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
    host: true,
    port: 5173,
    allowedHosts: [".ngrok-free.app"],
    proxy: {
      "/api": "http://localhost:7787",
      "/ws": {
        target: "ws://localhost:7787",
        ws: true,
      },
    },
  },
})
