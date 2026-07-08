import { AlertTriangle, GitBranch, Monitor, Trash2, X } from 'lucide-react';
import { Button, Chip, Surface, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { ProjectBranchUsage } from './project-branch-usage';
import type { GitBranchOption } from './git-graph-browser';

function changeLabel(usage: ProjectBranchUsage) {
  const parts = [
    usage.staged ? `${usage.staged} staged` : '',
    usage.unstaged ? `${usage.unstaged} unstaged` : '',
    usage.untracked ? `${usage.untracked} untracked` : ''
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(' · ') : 'clean';
}

export function GitBranchDeleteDialog({
  branch,
  isDeleting,
  message,
  onClose,
  onDelete,
  onOpenMachine,
  usages
}: {
  branch: GitBranchOption;
  isDeleting: boolean;
  message?: string;
  onClose(): void;
  onDelete(): void;
  onOpenMachine(machineId: string): void;
  usages: ProjectBranchUsage[];
}) {
  const mergedPullRequest = branch.prs.find((pullRequest) => pullRequest.state === 'merged');
  const hasChangedCheckout = usages.some((usage) => usage.hasUncommittedChanges);

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70 px-3 py-4 sm:items-center sm:px-4 sm:py-6">
      <Surface
        variant="tertiary"
        className="flex max-h-[min(42rem,calc(100vh-2rem))] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl shadow-black/60"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-neutral-800 px-4 py-3">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <Trash2 className="size-4 shrink-0 text-red-300" />
              <Text className="truncate text-sm font-semibold text-neutral-100">
                Delete merged branch
              </Text>
            </div>
            <Text className="mt-1 block text-xs text-neutral-500">
              This deletes the remote GitHub branch. Local worktrees are listed below.
            </Text>
          </div>
          <Button aria-label="Close" isIconOnly size="sm" variant="ghost" onPress={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Chip
              size="sm"
              className="max-w-full gap-1 rounded-full border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-neutral-100"
            >
              <GitBranch className="size-3 shrink-0" />
              <span className="truncate">{branch.label}</span>
            </Chip>
            {mergedPullRequest ? (
              <Chip
                size="sm"
                className="rounded-full border border-violet-400/25 bg-violet-400/10 px-2 py-0.5 text-violet-200"
              >
                merged PR #{mergedPullRequest.number}
              </Chip>
            ) : null}
          </div>

          {hasChangedCheckout ? (
            <div className="mt-4 flex gap-2 rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-amber-100">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <Text className="text-xs leading-5">
                At least one machine still has local changes on this branch. Check it before
                deleting the remote branch.
              </Text>
            </div>
          ) : null}

          <div className="mt-4 grid gap-2">
            {usages.length > 0 ? (
              usages.map((usage) => (
                <button
                  key={`${usage.machineId}:${usage.path}`}
                  type="button"
                  className="flex min-w-0 items-start gap-3 rounded-lg border border-neutral-800 bg-neutral-950/70 px-3 py-3 text-left transition hover:border-neutral-700 hover:bg-neutral-900/50"
                  onClick={() => onOpenMachine(usage.machineId)}
                >
                  <Monitor className="mt-0.5 size-4 shrink-0 text-neutral-500" />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-semibold text-neutral-100">
                        {usage.machineName}
                      </span>
                      <span className="rounded-full bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-400">
                        {usage.kind}
                      </span>
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[11px]',
                          usage.hasUncommittedChanges
                            ? 'bg-amber-400/10 text-amber-200'
                            : 'bg-emerald-400/10 text-emerald-200'
                        )}
                      >
                        {changeLabel(usage)}
                      </span>
                    </span>
                    <span className="mt-1 block truncate font-mono text-xs text-neutral-500">
                      {usage.path}
                    </span>
                  </span>
                </button>
              ))
            ) : (
              <Text className="rounded-lg border border-neutral-800 bg-neutral-950/70 px-3 py-3 text-sm text-neutral-500">
                No local checkout for this branch was found on registered machines.
              </Text>
            )}
          </div>

          {message ? (
            <div className="mt-4 flex gap-2 rounded-lg border border-red-400/25 bg-red-400/10 px-3 py-2 text-red-100">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <Text className="text-xs leading-5">{message}</Text>
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-neutral-800 px-4 py-3">
          <Button size="sm" variant="ghost" onPress={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="border-red-400/30 bg-red-400/10 text-red-100 hover:bg-red-400/15"
            isDisabled={isDeleting}
            onPress={onDelete}
          >
            <Trash2 className="size-4" />
            {isDeleting ? 'Deleting...' : 'Delete GitHub branch'}
          </Button>
        </div>
      </Surface>
    </div>
  );
}
