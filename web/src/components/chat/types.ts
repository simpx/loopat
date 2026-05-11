export type ToolCategory =
  | "edit"
  | "bash"
  | "search"
  | "todo"
  | "task"
  | "agent"
  | "plan"
  | "question"
  | "default";

export interface ThinkingMode {
  id: string;
  name: string;
  description: string;
  icon: React.ElementType | null;
  prefix: string;
  color: string;
}

export const THINKING_MODES: ThinkingMode[] = [
  {
    id: "none",
    name: "Standard",
    description: "Regular Claude response",
    icon: null,
    prefix: "",
    color: "text-gray-600",
  },
  {
    id: "think",
    name: "Think",
    description: "Basic extended thinking",
    icon: "brain" as unknown as React.ElementType,
    prefix: "think",
    color: "text-blue-600",
  },
  {
    id: "think-hard",
    name: "Think Hard",
    description: "More thorough evaluation",
    icon: "zap" as unknown as React.ElementType,
    prefix: "think hard",
    color: "text-purple-600",
  },
  {
    id: "think-harder",
    name: "Think Harder",
    description: "Deep analysis with alternatives",
    icon: "sparkles" as unknown as React.ElementType,
    prefix: "think harder",
    color: "text-indigo-600",
  },
  {
    id: "ultrathink",
    name: "Ultrathink",
    description: "Maximum thinking budget",
    icon: "atom" as unknown as React.ElementType,
    prefix: "ultrathink",
    color: "text-red-600",
  },
];
