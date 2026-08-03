import { Button } from "@heroui/react";
import { AlertTriangle, Check, GitBranch, Laptop, Trash2 } from "lucide-react";

import type { MockTask, MockTaskAction } from "./task-model";

export function TaskCleanup({
  onAction,
  task,
}: {
  onAction(action: MockTaskAction): void;
  task: MockTask;
}) {
  const cleanup = task.cleanup;
  if (!cleanup || !["merged", "deploying", "deployed"].includes(task.stage)) return null;

  return (
    <section className="mt-5 border-t border-current/[.08] pt-4">
      <h2 className="text-xs font-semibold text-current/55">Cleanup</h2>
      <div className="mt-2 divide-y divide-current/[.07]">
        <CleanupRow
          detail={cleanup.remoteBranch === "deleted" ? "Deleted on GitHub" : "Still on GitHub"}
          icon={GitBranch}
          label="Remote branch"
          tone={cleanup.remoteBranch === "deleted" ? "success" : "warning"}
        >
          {cleanup.remoteBranch === "exists" ? (
            <Button size="sm" variant="tertiary" onPress={() => onAction({ type: "delete-remote-branch" })}>
              <Trash2 className="size-3.5" /> Delete
            </Button>
          ) : null}
        </CleanupRow>

        {cleanup.worktrees.map((worktree) => (
          <CleanupRow
            detail={worktree.safeToDelete ? "Clean · safe to remove" : "Modified · inspect first"}
            icon={Laptop}
            key={worktree.machine}
            label={worktree.machine}
            tone={worktree.safeToDelete ? "success" : "danger"}
          >
            {worktree.safeToDelete ? (
              <Button size="sm" variant="tertiary" onPress={() => onAction({ machine: worktree.machine, type: "remove-worktree" })}>
                <Trash2 className="size-3.5" /> Remove
              </Button>
            ) : null}
          </CleanupRow>
        ))}

        {cleanup.remoteBranch === "deleted" && cleanup.worktrees.length === 0 ? (
          <p className="flex min-h-11 items-center gap-2 text-xs text-emerald-300/80">
            <Check className="size-3.5" /> Branch and worktrees are cleaned up.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function CleanupRow({
  children,
  detail,
  icon: Icon,
  label,
  tone,
}: {
  children?: React.ReactNode;
  detail: string;
  icon: typeof GitBranch;
  label: string;
  tone: "danger" | "success" | "warning";
}) {
  const toneClass = tone === "success"
    ? "text-emerald-300"
    : tone === "danger"
      ? "text-red-300"
      : "text-amber-300";

  return (
    <div className="flex min-h-12 items-center gap-3 py-1.5">
      <Icon className="size-3.5 shrink-0 text-current/30" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-current/65">{label}</span>
        <span className={`mt-0.5 flex items-center gap-1 text-[10px] ${toneClass}`}>
          {tone === "danger" ? <AlertTriangle className="size-3" /> : null}
          {detail}
        </span>
      </span>
      {children}
    </div>
  );
}
