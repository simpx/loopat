import { useCallback, useEffect, useState } from "react"
import { avatarUrl } from "../api"
import { cn } from "@/lib/utils"

/** Cache-busting counter — incremented by AvatarSection on upload/delete
 *  so all UserAvatar instances reload. */
let globalBust = 0

/** Bump the global bust and re-fetch. Called from AvatarSection. */
export function avatarChanged() {
  globalBust++
  window.dispatchEvent(new CustomEvent("loopat:avatar-changed", { detail: globalBust }))
}

/** Small reusable avatar that loads from the personal repo. Falls back to
 *  the first letter of userId when no avatar is set or loading fails. */
export function UserAvatar({
  userId,
  size = "default",
  className,
}: {
  userId: string
  size?: "xs" | "sm" | "default" | "lg"
  className?: string
}) {
  const [bust, setBust] = useState(globalBust)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)

  const sizeClass = {
    xs: "size-4 text-[8px]",
    sm: "size-5 text-[10px]",
    default: "size-6 text-[11px]",
    lg: "size-8 text-xs",
  }[size]

  // Listen for global avatar changes
  useEffect(() => {
    const handler = (e: Event) => {
      const v = (e as CustomEvent).detail as number
      setBust(v)
      setLoaded(false)
      setFailed(false)
    }
    window.addEventListener("loopat:avatar-changed", handler)
    return () => window.removeEventListener("loopat:avatar-changed", handler)
  }, [])

  // Reset on userId change
  useEffect(() => {
    setLoaded(false)
    setFailed(false)
  }, [userId])

  const onLoad = useCallback(() => setLoaded(true), [])
  const onError = useCallback(() => setFailed(true), [])

  const imgCls = cn(sizeClass, "rounded-full shrink-0 object-cover", className)
  const fallbackCls = cn(
    sizeClass,
    "rounded-full shrink-0 flex items-center justify-center font-medium bg-gray-200 text-gray-700",
    className,
  )

  if (!userId) {
    return <span className={fallbackCls}>?</span>
  }

  return (
    <>
      <img
        src={avatarUrl(userId, bust || undefined)}
        alt={userId}
        className={cn(imgCls, loaded && !failed ? "" : "hidden")}
        onLoad={onLoad}
        onError={onError}
      />
      {(!loaded || failed) && (
        <span className={fallbackCls} title={userId}>
          {userId.charAt(0).toUpperCase()}
        </span>
      )}
    </>
  )
}
