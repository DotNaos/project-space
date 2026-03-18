import type {
  Feature,
  Project,
  Sprint,
  Task,
  Worktree
} from '@/domain';
import type { WorkspaceTool } from '@/shared/electron-api';

import { QuickActions } from './quick-actions';

interface DetailPanelProps {
  appName: string;
  project: Project;
  sprint?: Sprint;
  feature?: Feature;
  task?: Task;
  worktree?: Worktree;
  lastAction: string;
  onOpenTool(tool: WorkspaceTool): void;
}

function checklistSummary(doneCount: number, totalCount: number) {
  return `${doneCount}/${totalCount} complete`;
}

function workflowPath(project: Project, sprint?: Sprint, feature?: Feature, task?: Task) {
  return [project.name, sprint?.name, feature?.name, task?.name].filter(Boolean).join(' / ');
}

export function DetailPanel({
  appName,
  project,
  sprint,
  feature,
  task,
  worktree,
  lastAction,
  onOpenTool
}: DetailPanelProps) {
  return (
    <section className="flex h-full flex-col bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.01))]">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-3xl">
          <p className="text-[10px] uppercase tracking-[0.28em] text-slate-500">
            {appName}
          </p>
          <h1 className="mt-3 text-3xl font-semibold text-white">{task?.name ?? project.name}</h1>
          <p className="mt-2 font-mono text-xs text-slate-500">
            {workflowPath(project, sprint, feature, task)}
          </p>

          <div className="mt-6 space-y-5">
            <div>
              <p className="text-sm font-medium text-white">
                {worktree?.name ?? 'No worktree selected'}
              </p>
              <p className="mt-2 font-mono text-sm text-teal-200">
                {worktree?.iterationBranchName ?? 'iteration/{N}'}
              </p>
              <p className="mt-1 font-mono text-sm text-white">
                {worktree?.branchName ?? 'iteration/{N}/{feature-name}'}
              </p>
            </div>

            <div>
              <QuickActions onOpen={onOpenTool} />
              <p className="mt-3 text-sm text-slate-400">{lastAction}</p>
            </div>

            {worktree?.issueDocuments[0] ? (
              <div className="border-t border-white/8 pt-5">
                <p className="text-sm font-medium text-white">{worktree.issueDocuments[0].title}</p>
                <p className="mt-1 text-sm text-slate-400">
                  {worktree.issueDocuments[0].summary}
                </p>
                <p className="mt-2 font-mono text-xs text-slate-500">
                  {worktree.issueDocuments[0].path}
                </p>
                <p className="mt-2 text-xs uppercase tracking-[0.18em] text-slate-500">
                  {checklistSummary(
                    worktree.issueDocuments[0].checklist.filter((item) => item.done).length,
                    worktree.issueDocuments[0].checklist.length
                  )}
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
