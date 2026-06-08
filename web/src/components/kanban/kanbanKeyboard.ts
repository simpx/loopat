export type KanbanTextInputKeyAction = "submit" | "cancel" | "none"

export function kanbanTextInputKeyAction(key: string, isComposing: boolean): KanbanTextInputKeyAction {
  if (isComposing) return "none"
  if (key === "Enter") return "submit"
  if (key === "Escape") return "cancel"
  return "none"
}
