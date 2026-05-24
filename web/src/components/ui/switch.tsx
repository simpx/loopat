import * as React from "react"

/**
 * Toggle switch styled like a minimal on/off slider.
 * Adapted from patterns observed in cc-switch.
 */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  size = "default",
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  size?: "default" | "sm"
}) {
  const h = size === "sm" ? "h-4 w-[28px]" : "h-5 w-[36px]"
  const thumbH = size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5"
  const translateX = size === "sm" ? "translate-x-[13px]" : "translate-x-[17px]"
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={`
        ${h} rounded-full shrink-0 transition-colors duration-150
        ${checked ? "bg-gray-900" : "bg-gray-200"}
        ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer hover:" + (checked ? "bg-gray-800" : "bg-gray-300")}
      `}
    >
      <span
        className={`
          ${thumbH} block rounded-full bg-white shadow-sm
          transform transition-transform duration-150
          ${checked ? translateX : "translate-x-[2px]"}
        `}
      />
    </button>
  )
}
