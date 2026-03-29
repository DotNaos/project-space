import { Button, Surface, Text } from '@heroui/react';
import { ArrowUpRight, FolderTree, GitBranch, Lightbulb, Sparkles } from 'lucide-react';

import type { ExplorerTarget, ProjectSpaceRecord, ProjectWorktreeRecord } from '@/shared/electron-api';
import { getIdeaStateMeta, type IdeaPresentationRecord } from '../lib/idea-utils';

interface ProjectCommandCenterProps {
  assignedIdeaIds: string[];
  launcherError: string;
  onCreateIdea(): void;
  onOpenSelectedTarget(): void;
  onSelectIdea(ideaId: string): void;
  project?: ProjectSpaceRecord;
  selectedExplorerTarget: ExplorerTarget;
  selectedTargetPath: string;
  selectedWorktree?: ProjectWorktreeRecord;
  targetIdeas: IdeaPresentationRecord[];
}

function formatIdeaTitle(idea: IdeaPresentationRecord) {
  return idea.title.trim() || 'Untitled idea';
}

function formatIdeaSummary(idea: IdeaPresentationRecord) {
  const firstBodyLine = idea.body
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);

  return firstBodyLine || idea.iteration.trim() || 'No description yet';
}

export function ProjectCommandCenter({
  assignedIdeaIds,
  launcherError,
  onCreateIdea,
  onOpenSelectedTarget,
  onSelectIdea,
  project,
  selectedExplorerTarget,
  selectedTargetPath,
  selectedWorktree,
  targetIdeas
}: ProjectCommandCenterProps) {
  if (!project) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-8">
        <Surface
          variant="secondary"
          className="w-full max-w-2xl rounded-[2rem] border border-zinc-800/80 bg-zinc-950/60 px-8 py-10"
        >
          <Text className="text-sm font-medium text-zinc-400">
            Command Center
          </Text>
          <Text className="mt-4 text-3xl font-semibold tracking-tight text-zinc-50">
            Select a project first
          </Text>
        </Surface>
      </div>
    );
  }

  const isWorktreeView = selectedExplorerTarget.kind === 'worktree';
  const targetLabel = isWorktreeView ? 'Worktree' : 'Workspace';
  const branchLabel = selectedWorktree?.branchName?.trim() || 'No branch detected';
  const readyIdeaCount = targetIdeas.filter((idea) => idea.qualityGate.isReady).length;
  const summaryLine = [branchLabel, `${targetIdeas.length} ideas here`, `${readyIdeaCount} ready`].join('  •  ');

  return (
    <div className="min-h-0 flex-1 px-6 pb-6">
      <div className="grid min-h-full grid-cols-[minmax(0,1.65fr)_minmax(18rem,0.85fr)] gap-6 pt-6">
        <div className="flex min-h-0 flex-col">
          <div className="flex items-start justify-between gap-6 border-b border-zinc-800/70 pb-5">
            <div className="min-w-0 space-y-3">
              <Text className="block text-sm font-medium text-zinc-400">
                {targetLabel}
              </Text>
              <Text className="block text-[2.6rem] font-semibold leading-none tracking-tight text-zinc-50">
                {isWorktreeView ? branchLabel : project.name}
              </Text>
              <Text className="block break-all font-mono text-sm leading-6 text-zinc-500">
                {selectedTargetPath}
              </Text>
              <Text className="block text-sm font-medium leading-6 text-zinc-400">
                {summaryLine}
              </Text>
            </div>

            <Button
              variant="secondary"
              onPress={onOpenSelectedTarget}
              className="h-11 shrink-0 rounded-2xl border border-zinc-800/80 bg-zinc-950/75 px-4 text-zinc-200"
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

          <div className="mt-5 flex items-center gap-6 border-b border-zinc-800/70 pb-5 text-sm font-medium text-zinc-400">
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-zinc-500" strokeWidth={1.9} />
              <span>{branchLabel}</span>
            </div>
            <div className="flex items-center gap-2">
              <Lightbulb className="h-4 w-4 text-zinc-500" strokeWidth={1.9} />
              <span>{targetIdeas.length} ideas here</span>
            </div>
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-zinc-500" strokeWidth={1.9} />
              <span>{readyIdeaCount} ready</span>
            </div>
          </div>

          <div className="min-h-0 flex-1 pt-6">
            <div className="flex items-center justify-between gap-4 border-b border-zinc-800/70 pb-4">
              <Text className="text-sm font-medium text-zinc-400">
                Ideas
              </Text>
              <Button
                variant="primary"
                onPress={onCreateIdea}
                className="h-10 rounded-2xl bg-zinc-100 px-3 text-zinc-950 hover:bg-zinc-200"
              >
                <Lightbulb className="h-4 w-4" strokeWidth={1.9} />
                <span>Open ideas</span>
              </Button>
            </div>

            <div className="mt-4 min-h-0 space-y-1 overflow-y-auto pr-1">
              {targetIdeas.length > 0 ? (
                targetIdeas.map((idea) => (
                  (() => {
                    const state = getIdeaStateMeta(idea, {
                      assignedToWorktree: assignedIdeaIds.includes(idea.id)
                    });

                    return (
                      <Button
                        key={idea.id}
                        variant="ghost"
                        onPress={() => {
                          onSelectIdea(idea.id);
                        }}
                        className="h-auto w-full justify-start rounded-[1.25rem] border border-transparent bg-transparent px-4 py-3 text-left text-zinc-300 transition hover:bg-zinc-950/35 hover:text-zinc-50"
                      >
                        <div className="min-w-0 space-y-1.5 overflow-hidden">
                          <div className="flex min-w-0 items-center gap-3">
                            <Text className="min-w-0 flex-1 truncate text-base font-semibold text-current">
                              {formatIdeaTitle(idea)}
                            </Text>
                            <span className="shrink-0 text-sm font-medium text-zinc-500">
                              {state.label}
                            </span>
                          </div>
                          <Text className="line-clamp-2 text-sm leading-6 text-zinc-500">
                            {formatIdeaSummary(idea)}
                          </Text>
                        </div>
                      </Button>
                    );
                  })()
                ))
              ) : (
                <div className="px-2 py-6">
                  <Text className="text-sm text-zinc-500">
                    No ideas are assigned here yet.
                  </Text>
                </div>
              )}
            </div>
          </div>
        </div>

        <aside className="flex min-h-0 flex-col border-l border-zinc-800/70 pl-6">
          <div className="pb-5">
            <div className="flex items-center gap-3 text-zinc-400">
              <FolderTree className="h-4 w-4 text-zinc-500" strokeWidth={1.9} />
              <Text className="text-sm font-medium text-current">
                {isWorktreeView ? 'Focused execution branch' : 'Project backlog'}
              </Text>
            </div>
            <Text className="mt-4 text-sm leading-7 text-zinc-500">
              {isWorktreeView
                ? 'The ideas listed here are already routed into this branch.'
                : 'This view shows ideas that still belong to the project backlog.'}
            </Text>
          </div>

          <div className="min-h-0 flex-1 border-t border-zinc-800/70 pt-5">
            <Text className="text-sm font-medium text-zinc-400">
              Ideas in scope
            </Text>
            <Text className="mt-3 block text-[2rem] font-semibold leading-tight tracking-tight text-zinc-50">
              {targetIdeas.length}
            </Text>
            <Text className="mt-2 text-sm leading-6 text-zinc-500">
              {readyIdeaCount} ready
            </Text>
          </div>
        </aside>
      </div>
    </div>
  );
}
