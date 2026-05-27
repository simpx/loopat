import { useEffect, useRef, useState } from "react"
import { Terminal as XTerm } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebglAddon } from "@xterm/addon-webgl"
import { SearchAddon } from "@xterm/addon-search"
import { ClipboardAddon } from "@xterm/addon-clipboard"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import { LigaturesAddon } from "@xterm/addon-ligatures"
import "@xterm/xterm/css/xterm.css"

type ConnStatus = "connected" | "reconnecting" | "disconnected"

// One-Dark-ish theme. Calmer than xterm default; better contrast on bg.
const THEME = {
  background: "#1a1c20",
  foreground: "#dadbdc",
  cursor: "#e1e4e8",
  cursorAccent: "#1a1c20",
  selectionBackground: "#3e4451",
  black: "#3a3e44",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#dadbdc",
  brightBlack: "#5c6370",
  brightRed: "#e06c75",
  brightGreen: "#98c379",
  brightYellow: "#e5c07b",
  brightBlue: "#61afef",
  brightMagenta: "#c678dd",
  brightCyan: "#56b6c2",
  brightWhite: "#ffffff",
}

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000]

function buildWsUrl(loopId: string) {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/loop/${loopId}/term`
}

export function Terminal({
  loopId,
  currentUserId,
  onStatusChange,
}: {
  loopId: string
  currentUserId: string
  onStatusChange?: (status: ConnStatus) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const reconnectRef = useRef({ attempt: 0, timer: null as ReturnType<typeof setTimeout> | null })
  const [status, setStatus] = useState<ConnStatus>("connected")

  function setStatusBoth(s: ConnStatus) {
    setStatus(s)
    onStatusChange?.(s)
  }

  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily:
        '"JetBrains Mono", "Fira Code", "SF Mono", "Cascadia Code", Menlo, Consolas, "DejaVu Sans Mono", ui-monospace, monospace',
      fontSize: 12.5,
      lineHeight: 1.3,
      letterSpacing: 0,
      theme: THEME,
      convertEol: true,
      scrollback: 5000,
      smoothScrollDuration: 80,
      allowProposedApi: true,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 4,
      rightClickSelectsWord: true,
      ignoreBracketedPasteMode: true,
    })

    const fit = new FitAddon()
    const search = new SearchAddon()

    term.loadAddon(fit)
    term.loadAddon(search)

    // GPU-accelerated renderer; falls back to DOM silently on failure
    try { term.loadAddon(new WebglAddon()) } catch {}
    try { term.loadAddon(new ClipboardAddon()) } catch {}
    try { term.loadAddon(new Unicode11Addon()) } catch {}
    try { term.loadAddon(new LigaturesAddon()) } catch {}

    term.open(containerRef.current)
    fit.fit()
    term.focus()

    xtermRef.current = term
    fitRef.current = fit
    searchRef.current = search

    function connect() {
      const ws = new WebSocket(buildWsUrl(loopId))
      wsRef.current = ws

      ws.onopen = () => {
        reconnectRef.current.attempt = 0
        setStatusBoth("connected")
        sendResize()
      }

      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data)
          if (m.type === "data") term.write(m.data)
          else if (m.type === "exit") term.write(`\r\n\x1b[2m[process exited ${m.code}]\x1b[0m\r\n`)
          else if (m.type === "error") term.write(`\r\n\x1b[31m[error] ${m.message}\x1b[0m\r\n`)
        } catch {}
      }

      ws.onclose = () => {
        const { attempt } = reconnectRef.current
        if (attempt < RECONNECT_DELAYS.length) {
          const delay = RECONNECT_DELAYS[attempt]
          reconnectRef.current.attempt = attempt + 1
          setStatusBoth("reconnecting")
          term.write(`\r\n\x1b[33m[Disconnected, reconnecting in ${delay / 1000}s (${attempt + 1}/${RECONNECT_DELAYS.length})...]\x1b[0m\r\n`)
          reconnectRef.current.timer = setTimeout(connect, delay)
        } else {
          setStatusBoth("disconnected")
          term.write("\r\n\x1b[2m[Disconnected]\x1b[0m\r\n")
        }
      }

      ws.onerror = () => {
        // onclose fires after onerror, reconnect logic lives in onclose
      }
    }

    connect()

    const disposeData = term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "data", data }))
      }
    })

    const sendResize = () => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      const { cols, rows } = term
      // Skip when the container div hasn't been laid out yet (e.g. just
      // after panel open — the div starts at near-zero width). Sending
      // a resize with cols=2 causes the shell to redraw at that tiny
      // size, which wrecks the display when the real size kicks in later.
      if (cols < 10) return
      ws.send(JSON.stringify({ type: "resize", cols, rows }))
    }

    const onResize = () => {
      try {
        fit.fit()
        sendResize()
      } catch {}
    }
    window.addEventListener("resize", onResize)
    const ro = new ResizeObserver(onResize)
    if (containerRef.current) ro.observe(containerRef.current)

    // Ctrl+Shift+F triggers search via prompt (SearchAddon has no built-in UI bar)
    term.attachCustomKeyEventHandler((e) => {
      if (e.ctrlKey && e.shiftKey && e.key === "F") {
        const query = prompt("Terminal search:")
        if (query && searchRef.current) {
          searchRef.current.findNext(query)
        }
        return false
      }
      return true
    })

    return () => {
      window.removeEventListener("resize", onResize)
      ro.disconnect()
      disposeData.dispose()
      if (reconnectRef.current.timer) clearTimeout(reconnectRef.current.timer)
      try { wsRef.current?.close() } catch {}
      term.dispose()
      xtermRef.current = null
      fitRef.current = null
      searchRef.current = null
      wsRef.current = null
    }
  }, [loopId, currentUserId])

  const dotColor = status === "connected" ? "#98c379" : status === "reconnecting" ? "#e5c07b" : "#e06c75"

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "100%",
          background: THEME.background,
          padding: "10px 12px 4px",
          boxSizing: "border-box",
        }}
      />
      {/* connection indicator dot — overlaid top-right */}
      <div
        title={status === "connected" ? "Connected" : status === "reconnecting" ? "Reconnecting..." : "Disconnected"}
        style={{
          position: "absolute",
          top: 6,
          right: 8,
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: dotColor,
          boxShadow: `0 0 4px ${dotColor}`,
          transition: "background 0.3s, box-shadow 0.3s",
          zIndex: 10,
          pointerEvents: "none",
        }}
      />
    </div>
  )
}
