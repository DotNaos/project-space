import { Button, Input, ScrollShadow, Surface, Text } from '@heroui/react';
import {
  ArrowUpRight,
  FolderGit2,
  FolderPlus,
  GitBranch,
  GitCommitHorizontal
} from 'lucide-react';

import type {
  ExplorerTarget,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/electron-api';
import { cn } from '@/lib/utils';

interface ProjectWorktreesPanelProps {
  createWorktreeBranchName: string;
  createWorktreeError: string;
  createWorktreeFolderName: string;
  createWorktreeTargetPath: string;
  isCreatingWorktree: boolean;
  isCreatingWorktreeSubmitting: boolean;
  launcherError: string;
  onCancelCreateWorktree(): void;
  onOpenSelectedTarget(): void;
  onSubmitCreateWorktree(): void;
  onUpdateCreateWorktreeBranchName(value: string): void;
  onUpdateCreateWorktreeFolderName(value: string): void;
  project?: ProjectSpaceRecord;
  selectedExplorerTarget: ExplorerTarget;
  selectedTargetPath: string;
  selectedWorktree?: ProjectWorktreeRecord;
  worktrees: ProjectWorktreeRecord[];
}

function getWorktreeLabel(worktree: ProjectWorktreeRecord) {
  return worktree.branchName?.trim() || worktree.name;
}

function getIdeasLabel(count: number) {
  return count === 1 ? '1 idea' : `${count} ideas`;
}

export function ProjectWorktreesPanel({
  createWorktreeBranchName,
  createWorktreeError,
  createWorktreeFolderName,
  createWorktreeTargetPath,
  isCreatingWorktree,
  isCreatingWorktreeSubmitting,
  launcherError,
  onCancelCreateWorktree,
  onOpenSelectedTarget,
  onSubmitCreateWorktree,
  onUpdateCreateWorktreeBranchName,
  onUpdateCreateWorktreeFolderName,
  project,
  selectedExplorerTarget,
  selectedTargetPath,
  selectedWorktree,
  worktrees
}: ProjectWorktreesPanelProps) {
  if (!project) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-8">
        <Surface
          variant="secondary"
          className="w-full max-w-2xl rounded-[2rem] border border-zinc-800/80 bg-zinc-950/60 px-8 py-10"
        >
          <Text className="text-sm font-medium text-zinc-400">
            Worktrees
          </Text>
          <Text className="mt-4 text-3xl font-semibold tracking-tight text-zinc-50">
            Select a project first
          </Text>
        </Surface>
      </div>
    );
  }

  const baseWorktree = worktrees.find((worktree) => worktree.isBase);
  const branchWorktrees = worktrees.filter((worktree) => !worktree.isBase);
  const highlightedWorktree =
    selectedExplorerTarget.kind === 'worktree' && selectedWorktree
      ? selectedWorktree
      : branchWorktrees[0] || baseWorktree;
  const baseLabel = baseWorktree ? getWorktreeLabel(baseWorktree) : project.name;
  const graphRows = branchWorktrees.length > 0 ? branchWorktrees : baseWorktree ? [baseWorktree] : [];
  const totalIdeas = branchWorktrees.reduce((total, worktree) => total + worktree.ideaIds.length, 0);
  const summaryLine = [baseLabel, `${branchWorktrees.length} worktrees`, `${totalIdeas} routed ideas`].join('  •  ');

  return (
    <div className="flex min-h-0 flex-1 gap-8 bg-app-panel px-6 pb-6 pt-6">
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.7fr)_22rem] gap-6 pt-6">
        <div className="flex min-h-0 flex-col">
          <div className="flex items-start justify-between gap-6 border-b border-zinc-800/70 pb-5">
            <div className="min-w-0 space-y-3">
              <div className="flex items-center gap-3 text-zinc-400">
                <GitBranch className="h-4 w-4" strokeWidth={1.9} />
                <Text className="block text-sm font-medium text-current">
                  Worktree graph
                </Text>
              </div>
              <Text className="block text-[2.6rem] font-semibold leading-none tracking-tight text-zinc-50">
                {project.name}
              </Text>
              <Text className="block max-w-3xl break-all font-mono text-sm leading-6 text-zinc-500">
                {selectedTargetPath}
              </Text>
              <Text className="block text-sm font-medium leading-6 text-zinc-400">
                {summaryLine}
              </Text>
            </div>

            <Button
              variant="secondary"
              onPress={onOpenSelectedTarget}
              className="mt-1 h-11 shrink-0 rounded-2xl border border-zinc-800/80 bg-zinc-950/75 px-4 text-zinc-200"
            >
              <ArrowUpRight className="h-4 w-4" strokeWidth={1.9} />
              <span>Open target</span>
            </Button>
          </div>

          {launcherError ? (
            <div className="mt-5 rounded-2xl border border-zinc-400/20 bg-zinc-500/8 px-4 py-3 text-sm leading-6 text-zinc-300">
              {launcherError}
            </div>
          ) : null}

          <ScrollShadow className="mt-6 min-h-0 flex-1 pr-1" hideScrollBar>
            <div className="relative min-h-full rounded-[2rem] border border-zinc-800/70 bg-zinc-950/18 px-7 py-7">
              <div className="absolute top-11 bottom-10 left-11 w-px bg-zinc-800/90" />

              <div className="relative flex items-center gap-4 pb-6">
                <div className="relative flex w-8 shrink-0 justify-center">
                  <span className="h-4 w-4 rounded-full border border-zinc-500/80 bg-zinc-950 shadow-[0_0_0_6px_rgba(12,12,12,0.72)]" />
                </div>

                <div className="min-w-0 flex-1 rounded-[1.5rem] border border-zinc-800/70 bg-zinc-950/38 px-5 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <Text className="block text-sm font-medium text-zinc-400">
                        Base
                      </Text>
                      <Text className="mt-1 block truncate text-xl font-semibold text-zinc-50">
                        {baseLabel}
                      </Text>
                    </div>
                    <Text className="block text-sm font-medium text-zinc-500">
                      root
                    </Text>
                  </div>
                </div>
              </div>

              <div className="space-y-4 pb-2">
                {graphRows.length > 0 ? (
                  graphRows.map((worktree) => {
                    const isHighlighted = highlightedWorktree?.id === worktree.id;

                    return (
                      <div key={worktree.id} className="relative flex items-center gap-4">
                        <div className="relative flex w-8 shrink-0 items-center justify-center">
                          <span className="absolute left-1/2 h-px w-12 -translate-x-0 bg-zinc-800/90" />
                          <span
                            className={cn(
                              'relative h-3.5 w-3.5 rounded-full border shadow-[0_0_0_6px_rgba(10,10,10,0.7)]',
                              isHighlighted
                                ? 'border-zinc-100 bg-zinc-100'
                                : 'border-zinc-500/80 bg-zinc-900'
                            )}
                          />
                        </div>

                        <div
                          className={cn(
                            'min-w-0 flex-1 rounded-[1.5rem] border px-5 py-4 transition',
                            isHighlighted
                              ? 'border-zinc-500/70 bg-zinc-900/60 shadow-[0_12px_30px_rgba(0,0,0,0.16)]'
                              : 'border-zinc-800/70 bg-zinc-950/34'
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 space-y-2">
                              <div className="flex items-center gap-2">
                                <GitCommitHorizontal className="h-4 w-4 text-zinc-500" strokeWidth={1.9} />
                                <Text className="block truncate text-lg font-semibold text-zinc-50">
                                  {getWorktreeLabel(worktree)}
                                </Text>
                              </div>
                              <Text className="block break-all font-mono text-sm leading-6 text-zinc-500">
                                {worktree.path}
                              </Text>
                            </div>

                            <div className="shrink-0 text-right">
                              <Text className="block text-sm font-medium text-zinc-300">
                                {getIdeasLabel(worktree.ideaIds.length)}
                              </Text>
                              {worktree.status === 'broken' ? (
                                <Text className="mt-1 block text-xs font-medium text-rose-300">
                                  broken
                                </Text>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="pl-12 pt-2">
                    <Text className="text-sm text-zinc-500">
                      No additional worktrees found yet.
                    </Text>
                  </div>
                )}
              </div>
            </div>
          </ScrollShadow>
        </div>

        <aside className="flex min-h-0 flex-col border-l border-zinc-800/70 pl-6">
          {isCreatingWorktree ? (
            <Surface
              variant="secondary"
              className="mb-6 rounded-[1.6rem] border border-zinc-800/80 bg-zinc-950/45 px-5 py-5"
            >
              <div className="flex items-center gap-3 text-zinc-400">
                <FolderPlus className="h-4 w-4 text-zinc-500" strokeWidth={1.9} />
                <Text className="text-sm font-medium text-current">
                  Create worktree
                </Text>
              </div>

              <div className="mt-5 space-y-4">
                <label className="block space-y-2">
                  <Text className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
                    Branch
                  </Text>
                  <Input
                    aria-label="Branch name"
                    value={createWorktreeBranchName}
                    variant="secondary"
                    onChange={(event) => {
                      onUpdateCreateWorktreeBranchName(event.currentTarget.value);
                    }}
                  />
                </label>

                <label className="block space-y-2">
                  <Text className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
                    Folder
                  </Text>
                  <Input
                    aria-label="Worktree folder name"
                    value={createWorktreeFolderName}
                    variant="secondary"
                    onChange={(event) => {
                      onUpdateCreateWorktreeFolderName(event.currentTarget.value);
                    }}
                  />
                </label>

                {createWorktreeTargetPath ? (
                  <div className="rounded-2xl border border-zinc-800/70 bg-zinc-950/50 px-3 py-3">
                    <Text className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
                      Target path
                    </Text>
                    <Text className="mt-2 break-all font-mono text-xs leading-5 text-zinc-400">
                      {createWorktreeTargetPath}
                    </Text>
                  </div>
                ) : null}

                {createWorktreeError ? (
                  <div className="rounded-2xl border border-zinc-400/20 bg-zinc-500/8 px-3 py-3">
                    <Text className="text-sm leading-6 text-zinc-300">{createWorktreeError}</Text>
                  </div>
                ) : null}

                <div className="flex items-center gap-3 pt-1">
                  <Button
                    variant="primary"
                    isDisabled={isCreatingWorktreeSubmitting}
                    onPress={onSubmitCreateWorktree}
                    className="h-10 rounded-2xl bg-zinc-100 px-4 text-zinc-950 hover:bg-zinc-200"
                  >
                    <FolderPlus className="h-4 w-4" strokeWidth={1.9} />
                    <span>{isCreatingWorktreeSubmitting ? 'Creating…' : 'Create worktree'}</span>
                  </Button>
                  <Button
                    variant="ghost"
                    isDisabled={isCreatingWorktreeSubmitting}
                    onPress={onCancelCreateWorktree}
                    className="h-10 rounded-2xl px-4 text-zinc-400 hover:bg-zinc-900/30 hover:text-zinc-100"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </Surface>
          ) : null}

          <div className="pb-5">
            <Text className="block text-sm font-medium text-zinc-400">
              Current focus
            </Text>
            <Text className="mt-3 block break-words text-[1.75rem] font-semibold leading-tight tracking-tight text-zinc-50">
              {highlightedWorktree ? getWorktreeLabel(highlightedWorktree) : baseLabel}
            </Text>
            <Text className="mt-2 block text-sm leading-6 text-zinc-500">
              {getIdeasLabel(highlightedWorktree?.ideaIds.length ?? 0)}
            </Text>
          </div>

          <div className="min-h-0 flex-1 border-t border-zinc-800/70 pt-5">
            <div className="flex items-center gap-3 text-zinc-400">
              <FolderGit2 className="h-4 w-4" strokeWidth={1.9} />
              <Text className="block text-sm font-medium text-current">
                Branches
              </Text>
            </div>

            <ScrollShadow className="mt-5 min-h-0 h-full pr-1" hideScrollBar>
              <div className="space-y-1 pb-2">
                {[baseWorktree, ...branchWorktrees].filter(Boolean).map((worktree) => {
                  const currentWorktree = worktree as ProjectWorktreeRecord;
                  const isHighlighted = highlightedWorktree?.id === currentWorktree.id;

                  return (
                    <div
                      key={currentWorktree.id}
                      className={cn(
                        'rounded-[1.2rem] border px-4 py-3 transition',
                        isHighlighted
                          ? 'border-zinc-500/70 bg-zinc-900/55'
                          : 'border-transparent bg-transparent hover:bg-zinc-950/25'
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <Text className="block min-w-0 truncate text-base font-semibold text-zinc-100">
                            {getWorktreeLabel(currentWorktree)}
                          </Text>
                          <Text className="mt-1 block text-sm leading-6 text-zinc-500">
                            {getIdeasLabel(currentWorktree.ideaIds.length)}
                          </Text>
                        </div>
                        {currentWorktree.isBase ? (
                          <Text className="block text-sm font-medium text-zinc-500">
                            base
                          </Text>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollShadow>
          </div>
        </aside>
      </div>
    </div>
  );
}
