import type {
  Feature,
  Project,
  Sprint,
  Task,
  Worktree
} from '@/domain';
import { Card } from '@heroui/react';
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
  const issueDocument = worktree?.issueDocuments[0];

  return (
    <section className="flex h-full flex-col bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.01))]">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <Card
          variant="secondary"
          className="mx-auto max-w-3xl border border-slate-800/70 bg-slate-950/55 shadow-none">
          <Card.Header className="px-6 pt-6">
            <Card.Description className="text-[10px] uppercase tracking-[0.28em] text-slate-500">
              {appName}
            </Card.Description>
            <Card.Title className="mt-3 text-3xl font-semibold text-white">
              {task?.name ?? project.name}
            </Card.Title>
            <Card.Description className="mt-2 font-mono text-xs text-slate-500">
              {workflowPath(project, sprint, feature, task)}
            </Card.Description>
          </Card.Header>

          <Card.Content className="space-y-5 px-6 pb-6">
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

            {issueDocument ? (
              <Card
                variant="secondary"
                className="border border-slate-800/70 bg-slate-950/75 shadow-none">
                <Card.Header className="px-4 pt-4">
                  <Card.Title className="text-sm font-medium text-white">
                    {issueDocument.title}
                  </Card.Title>
                  <Card.Description className="mt-1 text-sm text-slate-400">
                    {issueDocument.summary}
                  </Card.Description>
                </Card.Header>
                <Card.Content className="px-4 pb-4">
                  <p className="font-mono text-xs text-slate-500">{issueDocument.path}</p>
                  <p className="mt-2 text-xs uppercase tracking-[0.18em] text-slate-500">
                    {checklistSummary(
                      issueDocument.checklist.filter((item) => item.done).length,
                      issueDocument.checklist.length
                    )}
                  </p>
                </Card.Content>
              </Card>
            ) : null}
          </Card.Content>
        </Card>
      </div>
    </section>
  );
}
