export type ToolCallGroupPart = {
  type?: string;
  toolCallId?: string;
  status?: {
    type?: "running" | "complete" | "incomplete" | "requires-action" | string;
  };
};

export type ToolCallGroupState = {
  count: number;
  shouldGroup: boolean;
  hasRunning: boolean;
  needsAttention: boolean;
  forceOpen: boolean;
  label: string;
};

export function getToolCallGroupState(
  messageParts: ToolCallGroupPart[],
  indices: number[],
  permissionPromptToolUseId?: string,
): ToolCallGroupState {
  const count = indices.length;
  const groupedParts = indices
    .map((index) => messageParts[index])
    .filter((part): part is ToolCallGroupPart => part?.type === "tool-call");

  const hasRunning = groupedParts.some((part) => part.status?.type === "running");
  const needsAttention = groupedParts.some(
    (part) =>
      part.status?.type === "requires-action" ||
      (permissionPromptToolUseId !== undefined &&
        part.toolCallId === permissionPromptToolUseId),
  );

  const state = needsAttention ? "action needed" : hasRunning ? "running" : "";

  return {
    count,
    shouldGroup: count > 1,
    hasRunning,
    needsAttention,
    forceOpen: hasRunning || needsAttention,
    label: state ? `${count} tool calls · ${state}` : `${count} tool calls`,
  };
}
