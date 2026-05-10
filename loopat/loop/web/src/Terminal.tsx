import { useEffect, useRef } from "react"
import { Terminal as XTerm } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"

export function Terminal({ loopId }: { loopId: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
      cursorBlink: true,
      fontFamily: "ui-monospace, monospace",
      fontSize: 13,
      theme: { background: "#0e0e10", foreground: "#dcdcdc" },
      convertEol: true,
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
        else if (m.type === "exit") term.write(`\r\n[process exited ${m.code}]\r\n`)
        else if (m.type === "error") term.write(`\r\n[error] ${m.message}\r\n`)
      } catch {}
    }
    ws.onclose = () => term.write("\r\n[disconnected]\r\n")

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
  }, [loopId])

  return <div ref={containerRef} style={{ width: "100%", height: "100%", background: "#0e0e10" }} />
}
