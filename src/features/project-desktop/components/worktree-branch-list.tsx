import { Download, GitBranch } from 'lucide-react';
import { Button, Chip } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';

export interface CloneTargetInfo {
  exists: boolean;
  path: string;
}

export interface WorktreeBranchLocal {
  branchName?: string;
  id: string;
  isBase: boolean;
  name: string;
  path: string;
}

export interface WorktreeBranchOption {
  branchName: string;
  expectedPath: string;
  target?: CloneTargetInfo;
  worktree?: WorktreeBranchLocal;
}

function normalizeKey(value: string) {
  return value.trim().replace(/^refs\/heads\//, '').toLowerCase();
}

function compactHomePath(path: string | undefined) {
  if (!path) {
    return '';
  }

  return path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

function isDefaultBranch(branchName: string, defaultBranch: string) {
  return normalizeKey(branchName) === normalizeKey(defaultBranch);
}

function ColoredProjectPath({
  branchName,
  path,
  projectName
}: {
  branchName: string;
  path: string;
  projectName: string;
}) {
  const branchSuffix = branchName ? `/${branchName}` : '';
  const branchStart =
    branchSuffix && path.endsWith(branchSuffix) ? path.length - branchName.length : -1;
  const pathBeforeBranch = branchStart >= 0 ? path.slice(0, branchStart) : path;
  const branchPart = branchStart >= 0 ? path.slice(branchStart) : '';

  return (
    <>
      {pathBeforeBranch.split(projectName).map((part, index, parts) => (
        <span key={`${part}-${index}`}>
          {part}
          {index < parts.length - 1 ? (
            <span className="font-semibold text-sky-200">{projectName}</span>
          ) : null}
        </span>
      ))}
      {branchPart ? <span className="font-semibold text-cyan-200">{branchPart}</span> : null}
    </>
  );
}

export function WorktreeBranchList({
  busyBranchName,
  canClone,
  cloneMessage,
  defaultBranch,
  localPathLabel = 'Inspecting',
  onCloneBranch,
  onSelectBranch,
  onSelectBase,
  onSelectWorktree,
  options,
  projectName,
  selectedValue,
  showMissingPath = true
}: {
  busyBranchName: string;
  canClone: boolean;
  cloneMessage: string;
  defaultBranch: string;
  localPathLabel?: string;
  onCloneBranch(branchName: string): void;
  onSelectBranch?(branchName: string, path?: string, worktree?: WorktreeBranchLocal): void;
  onSelectBase(): void;
  onSelectWorktree(worktreeId: string): void;
  options: WorktreeBranchOption[];
  projectName: string;
  selectedValue: string;
  showMissingPath?: boolean;
}) {
  return (
    <div className="space-y-1">
      {options.map((option) => {
        const worktree = option.worktree;
        const targetPath = option.target?.path ?? '';
        const targetExists = Boolean(option.target?.exists);
        const expectedPath = compactHomePath(targetPath || option.expectedPath);
        const isSelected = worktree?.id === selectedValue;
        const isBase = isDefaultBranch(option.branchName, defaultBranch);

        if (worktree) {
          return (
            <button
              key={option.branchName}
              type="button"
              onClick={() => {
                if (onSelectBranch) {
                  onSelectBranch(option.branchName, worktree.path, worktree);
                  return;
                }

                if (worktree.isBase) {
                  onSelectBase();
                } else {
                  onSelectWorktree(worktree.id);
                }
              }}
              className={cn(
                'group flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left transition',
                isSelected
                  ? 'bg-neutral-700/70 text-neutral-50'
                  : 'text-neutral-300 hover:bg-neutral-900/80 hover:text-neutral-100'
              )}
            >
              <GitBranch className="size-4 shrink-0 text-neutral-500 group-hover:text-neutral-300" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{option.branchName}</span>
                <span className="mt-0.5 block truncate text-xs text-neutral-500">
                  {localPathLabel}{' '}
                  <span className="font-semibold text-neutral-300">
                    <ColoredProjectPath
                      branchName={option.branchName}
                      path={compactHomePath(worktree.path)}
                      projectName={projectName}
                    />
                  </span>
                </span>
              </span>
              {isBase ? (
                <Chip
                  color="success"
                  size="sm"
                  variant="soft"
                  className="shrink-0 uppercase tracking-[0.16em]"
                >
                  base
                </Chip>
              ) : null}
            </button>
          );
        }

        return (
          <div
            key={option.branchName}
            className="flex min-w-0 flex-col gap-2 rounded-lg border border-neutral-900/80 px-3 py-2.5 text-neutral-500 sm:flex-row sm:items-center"
          >
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <GitBranch className="mt-0.5 size-4 shrink-0 text-neutral-700" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-neutral-500">
                  {option.branchName}
                </span>
                {showMissingPath ? (
                  <span className="mt-0.5 block truncate text-xs text-neutral-600">
                    Not cloned ·{' '}
                    <span className="font-semibold">
                      <ColoredProjectPath
                        branchName={option.branchName}
                        path={expectedPath}
                        projectName={projectName}
                      />
                    </span>
                  </span>
                ) : (
                  <span className="mt-0.5 block truncate text-xs text-neutral-600">Not cloned</span>
                )}
                {targetExists ? (
                  <span className="mt-1 block text-xs text-amber-300/80">
                    Target already exists, but it is not registered as a valid worktree.
                  </span>
                ) : null}
              </span>
            </div>
            <Button
              size="sm"
              variant={targetExists ? 'ghost' : 'secondary'}
              isDisabled={!canClone || targetExists || busyBranchName === option.branchName}
              onPress={() => onCloneBranch(option.branchName)}
              className="w-full shrink-0 justify-center sm:w-auto"
            >
              <Download className="size-3.5" />
              {targetExists
                ? 'Target exists'
                : busyBranchName === option.branchName
                  ? 'Cloning'
                  : cloneMessage}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
