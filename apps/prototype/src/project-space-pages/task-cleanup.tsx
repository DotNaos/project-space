import { AlertTriangle, Check, GitBranch, Laptop } from "lucide-react";

import type { MockTask } from "./task-model";

export function TaskCleanup({
  task,
}: {
  task: MockTask;
}) {
  const cleanup = task.cleanup;
  if (!cleanup || !["merged", "deploying", "deployed"].includes(task.stage)) return null;

  return (
    <section className="mt-5 border-t border-current/[.08] pt-4" data-testid="closed-task-checkouts">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold text-current/55">Branch checkouts</h2>
        <span className="text-[10px] tabular-nums text-current/30">{cleanup.worktrees.length} machine{cleanup.worktrees.length === 1 ? "" : "s"}</span>
      </div>
      <div className="mt-2 divide-y divide-current/[.07]">
        <CleanupRow
          detail={cleanup.remoteBranch === "deleted" ? "Deleted on GitHub" : "Still on GitHub"}
          icon={GitBranch}
          label="Remote branch"
          tone={cleanup.remoteBranch === "deleted" ? "success" : "warning"}
        />

        {cleanup.worktrees.map((worktree) => (
          <CleanupRow
            detail={worktree.safeToDelete
              ? "Clean"
              : `${worktree.uncommittedChanges} uncommitted · ${worktree.unstagedChanges} unstaged`}
            icon={Laptop}
            key={worktree.machine}
            label={worktree.machine}
            tone={worktree.safeToDelete ? "success" : "danger"}
          />
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
  detail,
  icon: Icon,
  label,
  tone,
}: {
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
    </div>
  );
}
