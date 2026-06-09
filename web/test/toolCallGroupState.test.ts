import { describe, expect, test } from "bun:test";
import { getToolCallGroupState, type ToolCallGroupPart } from "../src/components/chat/toolCallGroupState";

function tool(
  toolCallId: string,
  status: NonNullable<ToolCallGroupPart["status"]>["type"] = "complete",
): ToolCallGroupPart {
  return {
    type: "tool-call",
    toolCallId,
    status: { type: status },
  };
}

describe("getToolCallGroupState", () => {
  test("leaves a single tool call ungrouped", () => {
    expect(getToolCallGroupState([tool("one")], [0])).toMatchObject({
      count: 1,
      shouldGroup: false,
      forceOpen: false,
    });
  });

  test("keeps multiple finished tool calls collapsed by default", () => {
    expect(getToolCallGroupState([tool("one"), tool("two")], [0, 1])).toEqual({
      count: 2,
      shouldGroup: true,
      hasRunning: false,
      needsAttention: false,
      forceOpen: false,
      label: "2 tool calls",
    });
  });

  test("forces the group open while any grouped tool is running", () => {
    expect(getToolCallGroupState([tool("one"), tool("two", "running")], [0, 1])).toMatchObject({
      count: 2,
      shouldGroup: true,
      hasRunning: true,
      needsAttention: false,
      forceOpen: true,
      label: "2 tool calls · running",
    });
  });

  test("forces the group open when any grouped tool needs user attention", () => {
    expect(
      getToolCallGroupState(
        [tool("one"), tool("two")],
        [0, 1],
        "two",
      ),
    ).toMatchObject({
      shouldGroup: true,
      hasRunning: false,
      needsAttention: true,
      forceOpen: true,
      label: "2 tool calls · action needed",
    });

    expect(getToolCallGroupState([tool("one", "requires-action"), tool("two")], [0, 1]))
      .toMatchObject({
        shouldGroup: true,
        needsAttention: true,
        forceOpen: true,
        label: "2 tool calls · action needed",
      });
  });
});
