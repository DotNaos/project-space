import { Chip } from '@heroui/react';
import { CircleDot, ExternalLink, GitBranch, GitPullRequest } from 'lucide-react';
import type { GitHubPullRequestRecord, GitHubWorkflowRunSummary } from '@/shared/project-space-api';
import { PullRequestPreviewStatusView } from '../project-desktop/components/pull-request-preview-status';
import { shouldShowPullRequestPreview } from '../project-desktop/components/pull-request-preview-model';
import { useRuntimeBinding } from '../project-desktop/components/runtime-binding-context';
import { usePullRequestPreviewStatus } from '../project-desktop/hooks/use-pull-request-preview-status';
import type { ProjectTaskHealth } from './task-view-model';
import { projectTaskPipelinePresentation } from './project-task-runtime-model';

function workflowTitle(pipeline: GitHubWorkflowRunSummary | undefined) {
  if (!pipeline) return 'No workflow run yet';
  return pipeline.displayTitle ?? pipeline.name ?? 'GitHub Actions';
}

export function ProjectTaskPipelinePanel({
  health,
  issueNumber,
  pipeline,
  projectId,
  pullRequest,
  repositoryFullName
}: {
  health: ProjectTaskHealth;
  issueNumber: number;
  pipeline?: GitHubWorkflowRunSummary;
  projectId: string;
  pullRequest?: GitHubPullRequestRecord;
  repositoryFullName?: string;
}) {
  const runtime = useRuntimeBinding();
  const preview = usePullRequestPreviewStatus({
    enabled: Boolean(repositoryFullName && pullRequest),
    pullRequestNumber: pullRequest?.number,
    repositoryFullName
  });
  const presentation = projectTaskPipelinePresentation({ health, pipeline, pullRequest });
  const workflow = (
    <div className="grid min-h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-3">
      <CircleDot aria-hidden className="size-4 text-current/35" />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-current/80">{workflowTitle(pipeline)}</p>
        <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-current/40">
          {pipeline?.runNumber ? <span>Run #{pipeline.runNumber}</span> : null}
          {pipeline?.branch ? (
            <span className="inline-flex min-w-0 items-center gap-1">
              <GitBranch aria-hidden className="size-3 shrink-0" />
              <span className="max-w-56 truncate">{pipeline.branch}</span>
            </span>
          ) : null}
          {pipeline?.updatedAt ? <span>{new Date(pipeline.updatedAt).toLocaleString()}</span> : null}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Chip color={presentation.color} size="sm" variant="soft">{presentation.label}</Chip>
        {runtime.apis === 'external' && pipeline?.url ? <ExternalLink aria-hidden className="size-3.5 text-current/30" /> : null}
      </div>
    </div>
  );

  return (
    <section aria-label="Task pipeline" className="divide-y divide-current/[.08] py-4">
      {runtime.apis === 'external' && pipeline?.url ? (
        <a className="block hover:bg-current/[.025]" href={pipeline.url} rel="noreferrer" target="_blank">
          {workflow}
        </a>
      ) : workflow}

      {pullRequest ? (
        <div className="grid gap-4 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <GitPullRequest aria-hidden className="size-4 shrink-0 text-current/35" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-current/80">Pull request #{pullRequest.number}</p>
              <p className="mt-1 truncate text-xs text-current/40">{pullRequest.title}</p>
            </div>
            {runtime.apis === 'external' ? (
              <a className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-current/40 hover:bg-current/[.06] hover:text-current" href={pullRequest.url} rel="noreferrer" target="_blank" aria-label={`Open pull request #${pullRequest.number}`}>
                <ExternalLink aria-hidden className="size-3.5" />
              </a>
            ) : null}
          </div>
          {shouldShowPullRequestPreview(pullRequest) ? (
            <PullRequestPreviewStatusView
              inventory={preview.inventory}
              pullRequest={pullRequest}
              repositoryFullName={repositoryFullName}
              returnPath={`/projects/${encodeURIComponent(projectId)}/issues/${issueNumber}`}
            />
          ) : null}
        </div>
      ) : (
        <p className="py-5 text-sm leading-6 text-current/35">
          Workflow runs and Preview status appear here after a pull request is opened.
        </p>
      )}
    </section>
  );
}
