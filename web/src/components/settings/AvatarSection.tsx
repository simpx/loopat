import { useCallback, useEffect, useRef, useState } from "react"
import { avatarUrl, uploadAvatar, deleteAvatar } from "../../api"
import { avatarChanged } from "../UserAvatar"
import { Button } from "@/components/ui/button"
import { useWorkspace } from "@/ctx"
import { Upload, Trash2, ZoomIn, ZoomOut, Check, AlertCircle } from "lucide-react"

const MAX_SIZE = 640
const CROP_UI_SIZE = 320

export function AvatarSection({ disabled }: { disabled?: boolean }) {
  const ws = useWorkspace()
  const userId = ws.currentUser?.id ?? ""
  const fileRef = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [avatarLoaded, setAvatarLoaded] = useState(false)
  const [avatarFailed, setAvatarFailed] = useState(false)
  const [avatarKey, setAvatarKey] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Crop dialog state
  const [cropOpen, setCropOpen] = useState(false)
  const [cropImg, setCropImg] = useState<HTMLImageElement | null>(null)
  const [cropScale, setCropScale] = useState(1)
  const [cropOffX, setCropOffX] = useState(0)
  const [cropOffY, setCropOffY] = useState(0)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number }>({ sx: 0, sy: 0, ox: 0, oy: 0 })

  // Reset loading state when avatar URL changes
  useEffect(() => {
    setAvatarLoaded(false)
    setAvatarFailed(false)
  }, [userId, avatarKey])

  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) {
      setErr("Please select an image file")
      return
    }
    const reader = new FileReader()
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string
      const img = new Image()
      img.onload = () => {
        // Init crop: fit image into CROP_UI_SIZE square
        const minDim = Math.min(img.naturalWidth, img.naturalHeight)
        const s = CROP_UI_SIZE / minDim
        setCropScale(s)
        setCropOffX(0)
        setCropOffY(0)
        setCropImg(img)
        setCropOpen(true)
        setErr(null)
      }
      img.src = dataUrl
    }
    reader.readAsDataURL(file)
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const f = e.dataTransfer.files[0]
    if (f) handleFile(f)
  }, [handleFile])

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  // Draw crop preview canvas
  useEffect(() => {
    if (!cropOpen || !cropImg) return
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = CROP_UI_SIZE * dpr
    canvas.height = CROP_UI_SIZE * dpr
    canvas.style.width = `${CROP_UI_SIZE}px`
    canvas.style.height = `${CROP_UI_SIZE}px`
    const ctx = canvas.getContext("2d")!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // Background
    ctx.fillStyle = "#e5e7eb"
    ctx.fillRect(0, 0, CROP_UI_SIZE, CROP_UI_SIZE)

    // Draw image
    const iw = cropImg.naturalWidth * cropScale
    const ih = cropImg.naturalHeight * cropScale
    const dx = (CROP_UI_SIZE - iw) / 2 + cropOffX
    const dy = (CROP_UI_SIZE - ih) / 2 + cropOffY
    ctx.drawImage(cropImg, dx, dy, iw, ih)

    // Darken area outside circle
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, CROP_UI_SIZE, CROP_UI_SIZE)
    const r = CROP_UI_SIZE / 2
    ctx.arc(r, r, r, 0, Math.PI * 2, true)
    ctx.fillStyle = "rgba(0,0,0,0.45)"
    ctx.fill()
    ctx.restore()

    // Circle border
    ctx.beginPath()
    ctx.arc(r, r, r - 1, 0, Math.PI * 2)
    ctx.strokeStyle = "rgba(255,255,255,0.9)"
    ctx.lineWidth = 2
    ctx.stroke()
  }, [cropOpen, cropImg, cropScale, cropOffX, cropOffY])

  const handleSave = async () => {
    if (!cropImg) return
    // Render final avatar at max 640x640
    const size = Math.min(MAX_SIZE, Math.min(cropImg.naturalWidth, cropImg.naturalHeight))
    const finalCanvas = document.createElement("canvas")
    finalCanvas.width = size
    finalCanvas.height = size
    const ctx = finalCanvas.getContext("2d")!

    // Calculate source rect from the crop state:
    // In the crop UI, we have an image scaled by cropScale, centered in CROP_UI_SIZE with offset.
    // The circle = CROP_UI_SIZE / 2 radius at center.
    // Source scale = 1/cropScale maps from UI px to source px.
    const srcScale = 1 / cropScale
    const srcCenterX = cropImg.naturalWidth / 2 - (cropOffX * srcScale)
    const srcCenterY = cropImg.naturalHeight / 2 - (cropOffY * srcScale)
    const srcSize = CROP_UI_SIZE * srcScale
    const srcX = srcCenterX - srcSize / 2
    const srcY = srcCenterY - srcSize / 2

    ctx.drawImage(cropImg, srcX, srcY, srcSize, srcSize, 0, 0, size, size)

    const dataUrl = finalCanvas.toDataURL("image/png")
    setUploading(true)
    setErr(null)
    const r = await uploadAvatar(dataUrl)
    setUploading(false)
    if (!r.ok) { setErr(r.error ?? "upload failed"); return }
    setCropOpen(false)
    setCropImg(null)
    avatarChanged()
    setAvatarKey(Date.now())
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  const handleDelete = async () => {
    await deleteAvatar()
    avatarChanged()
    setAvatarKey(Date.now())
  }

  // Drag handlers for crop
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    setDragging(true)
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: cropOffX, oy: cropOffY }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return
    setCropOffX(dragRef.current.ox + (e.clientX - dragRef.current.sx))
    setCropOffY(dragRef.current.oy + (e.clientY - dragRef.current.sy))
  }
  const onPointerUp = () => setDragging(false)

  return (
    <div className="flex flex-col gap-4">
      {err && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-[12px] text-red-700 flex items-center gap-2">
          <AlertCircle size={14} /> {err}
        </div>
      )}

      <div className="flex items-start gap-5">
        {/* Current avatar */}
        <div
          className="relative shrink-0 size-24 rounded-full overflow-hidden bg-gray-200 border-2 border-gray-200"
          onDrop={onDrop}
          onDragOver={onDragOver}
        >
          {userId && (
            <img
              src={avatarUrl(userId, avatarKey || undefined)}
              alt="avatar"
              className={`size-full object-cover ${avatarLoaded && !avatarFailed ? "" : "hidden"}`}
              onLoad={() => setAvatarLoaded(true)}
              onError={() => setAvatarFailed(true)}
            />
          )}
          {(!avatarLoaded || avatarFailed) && (
            <div className="size-full flex items-center justify-center text-gray-400 text-2xl font-semibold select-none">
              {userId ? userId[0]?.toUpperCase() ?? "?" : "?"}
            </div>
          )}
          {avatarLoaded && !avatarFailed && (
            <button
              type="button"
              onClick={handleDelete}
              className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 hover:opacity-100 transition-opacity"
              title="remove avatar"
            >
              <Trash2 size={20} className="text-white" />
            </button>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-[13px] font-medium text-gray-900">Avatar</p>
          <p className="text-[11px] text-gray-500 max-w-sm">
            Upload a square profile picture. The image will be cropped to a circle. Max size {MAX_SIZE}×{MAX_SIZE}px. Drag and drop an image onto the preview, or click the button below.
          </p>
          <div className="flex items-center gap-2 mt-1">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = "" }}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => fileRef.current?.click()}
              disabled={disabled || uploading}
            >
              <Upload size={13} className="mr-1" />
              upload photo
            </Button>
            {saved && <span className="text-[11px] text-emerald-700 flex items-center gap-1"><Check size={12} /> saved</span>}
          </div>
        </div>
      </div>

      {/* Crop dialog */}
      {cropOpen && cropImg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setCropOpen(false)}>
          <div
            className="bg-white rounded-xl shadow-2xl p-5 flex flex-col items-center gap-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-[15px] font-semibold text-gray-900">Crop avatar</h3>
            <p className="text-[12px] text-gray-500 -mt-3">Drag to reposition. Use slider to zoom.</p>

            <div className="relative select-none" style={{ width: CROP_UI_SIZE, height: CROP_UI_SIZE }}>
              <canvas
                ref={canvasRef}
                className={`block rounded-lg ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={onPointerUp}
              />
            </div>

            {/* Zoom control */}
            <div className="flex items-center gap-2 w-72">
              <ZoomOut size={14} className="text-gray-400 shrink-0" />
              <input
                type="range"
                min={0.1}
                max={3}
                step={0.01}
                value={cropScale}
                onChange={(e) => setCropScale(parseFloat(e.target.value))}
                className="flex-1 h-1 accent-gray-900"
              />
              <ZoomIn size={14} className="text-gray-400 shrink-0" />
            </div>

            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => { setCropOpen(false); setCropImg(null) }}>
                cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={uploading}>
                {uploading ? "saving…" : "save avatar"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
