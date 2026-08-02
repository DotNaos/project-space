import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
} from "lucide-react";

import {
  mockTaskNeedsAttention,
  mockTaskWorkflowState,
  type MockTask,
} from "./task-model";

export function TaskStatusIcon({ className = "", task }: { className?: string; task: MockTask }) {
  const state = mockTaskWorkflowState(task);
  const needsAttention = mockTaskNeedsAttention(task);
  const Icon = needsAttention
    ? CircleAlert
    : state === "Backlog"
      ? CircleDashed
      : state === "Done"
        ? CircleCheck
        : CircleDot;
  const label = needsAttention ? "Error" : state;
  const color = needsAttention
    ? "text-red-400"
    : state === "Backlog"
      ? "text-current/30"
      : state === "Started"
        ? "text-blue-400"
        : state === "In progress"
          ? "text-emerald-400"
          : "text-violet-400";

  return <Icon aria-label={label} className={`size-4 shrink-0 ${color} ${className}`} />;
}
