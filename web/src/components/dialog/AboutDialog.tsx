import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { getVersion, getBuildInfo } from "@/api"

export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [server, setServer] = useState({ branch: "…", commit: "…" })
  const build = getBuildInfo()

  useEffect(() => {
    if (open) {
      getVersion().then((v) => setServer(v))
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-center">
            <span className="text-5xl block mb-3">🧶</span>
            loopat
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div>
            <div className="text-gray-400 text-xs mb-0.5">Server</div>
            <div className="font-mono text-gray-700">
              {server.branch}@{server.commit.slice(0, 7)}
            </div>
          </div>
          <div>
            <div className="text-gray-400 text-xs mb-0.5">Build</div>
            <div className="font-mono text-gray-700">
              {build.commit.slice(0, 7)}
            </div>
            <div className="font-mono text-gray-400 text-xs">
              {build.time}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
