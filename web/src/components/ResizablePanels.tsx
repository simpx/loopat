import { useState, useCallback } from "react"
import { Panel, Group, Separator } from "react-resizable-panels"

type PanelId = "chat" | "workdir" | "editor" | "terminal" | "info" | "git"

interface PanelConfig {
  id: PanelId
  label: string
  minSize?: number
  defaultSize?: number
}

interface ResizablePanelsProps {
  panels: PanelConfig[]
  renderPanel: (id: PanelId) => React.ReactNode
  direction?: "horizontal" | "vertical"
}

export function ResizablePanels({ panels, renderPanel, direction = "horizontal" }: ResizablePanelsProps) {
  const [sizes, setSizes] = useState<Record<string, number>>({})
  const isVert = direction === "vertical"

  const onLayout = useCallback((layout: Record<string, number>) => {
    setSizes(layout)
  }, [])

  if (panels.length === 0) return null
  if (panels.length === 1) return <>{renderPanel(panels[0].id)}</>

  return (
    <Group
      orientation={isVert ? "vertical" : "horizontal"}
      className="flex-1 min-w-0 min-h-0"
      onLayoutChange={onLayout}
    >
      {panels.map((panel) => (
        <Panel
          key={panel.id}
          id={panel.id}
          minSize={panel.minSize ?? 15}
          defaultSize={sizes[panel.id] ?? panel.defaultSize ?? undefined}
          className="flex flex-col min-h-0 min-w-0"
        >
          {renderPanel(panel.id)}
        </Panel>
      ))}
      {panels.slice(0, -1).map((_, i) => (
        <Separator
          key={`handle-${i}`}
          className={isVert
            ? "relative h-1.5 cursor-row-resize group flex items-center justify-center after:absolute after:left-0 after:right-0 after:top-1/2 after:h-px after:-translate-y-1/2 after:bg-gray-200 after:transition-colors hover:after:bg-blue-400"
            : "relative w-1.5 cursor-col-resize group flex items-center justify-center after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-gray-200 after:transition-colors hover:after:bg-blue-400"
          }
        >
          <div className={`absolute ${isVert ? "left-1/2 -translate-x-1/2 w-4 h-1.5 rounded-full bg-gray-300 group-hover:bg-blue-400" : "top-1/2 -translate-y-1/2 h-4 w-1.5 rounded-full bg-gray-300 group-hover:bg-blue-400"}`} />
        </Separator>
      ))}
    </Group>
  )
}
