import { useEffect, useRef } from "react"
import { Terminal as XTerm } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"

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

export function Terminal({ loopId, currentUserId }: { loopId: string; currentUserId: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

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
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()
    xtermRef.current = term
    fitRef.current = fit

    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/loop/${loopId}/term`
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      const { cols, rows } = term
      ws.send(JSON.stringify({ type: "resize", cols, rows }))
    }
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data)
        if (m.type === "data") term.write(m.data)
        else if (m.type === "exit") term.write(`\r\n\x1b[2m[process exited ${m.code}]\x1b[0m\r\n`)
        else if (m.type === "error") term.write(`\r\n\x1b[31m[error] ${m.message}\x1b[0m\r\n`)
      } catch {}
    }
    ws.onclose = () => term.write("\r\n\x1b[2m[disconnected]\x1b[0m\r\n")

    const dispose = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "data", data }))
    })

    const onResize = () => {
      try {
        fit.fit()
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }))
      } catch {}
    }
    window.addEventListener("resize", onResize)
    const ro = new ResizeObserver(onResize)
    if (containerRef.current) ro.observe(containerRef.current)

    // focus on mount so user can type immediately
    term.focus()

    return () => {
      window.removeEventListener("resize", onResize)
      ro.disconnect()
      dispose.dispose()
      try {
        ws.close()
      } catch {}
      term.dispose()
      xtermRef.current = null
      fitRef.current = null
      wsRef.current = null
    }
  }, [loopId, currentUserId])

  return (
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
  )
}
