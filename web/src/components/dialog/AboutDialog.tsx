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
      <DialogContent className="sm:max-w-sm bg-white">
        <DialogHeader>
          <DialogTitle className="text-center">
            <img src="/logo.png" alt="loopat" className="w-full max-w-[240px] mx-auto mb-2" />
            loopat
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-gray-400 text-xs mb-1">Server</div>
            <div className="font-mono text-gray-700">
              {server.branch}@{server.commit.slice(0, 7)}
            </div>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-gray-400 text-xs mb-1">Build</div>
            <div className="font-mono text-gray-700">
              {build.commit.slice(0, 7)}
            </div>
            <div className="font-mono text-gray-400 text-xs mt-0.5">
              {new Date(build.time).toLocaleString()}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
