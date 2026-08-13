import { CircleDot, ExternalLink, GitBranch } from 'lucide-react';
import type {
  ConnectorOverviewResult,
  GitHubPullRequestRecord,
  GitHubWorkflowRunSummary,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import type { ProjectTaskHealth } from '@/features/project-tasks/task-view-model';
import { usePullRequestPreviewStatus } from '../hooks/use-pull-request-preview-status';
import {
  canRunMachineCommand,
  getIssueMachineRows
} from './issue-development-machine-actions';
import { shouldShowPullRequestPreview } from './pull-request-preview-model';
import { PullRequestPreviewStatusView } from './pull-request-preview-status';
import { PullRequestPrototypeAction } from './pull-request-prototype-action';
import { useRuntimeBinding } from './runtime-binding-context';

function pipelineStatus({
  health,
  pipeline,
  pullRequest
}: {
  health: ProjectTaskHealth;
  pipeline?: GitHubWorkflowRunSummary;
  pullRequest?: GitHubPullRequestRecord;
}) {
  if (health === 'attention') return 'Checks failed';
  if (health === 'healthy') return 'Checks passed';
  return pipeline?.status ?? (pullRequest ? 'No status' : 'Not started');
}

export function IssueDevelopmentPipeline({
  connectorOverview,
  health,
  issueNumber,
  pipeline,
  project,
  projects,
  pullRequest,
  repositoryFullName
}: {
  connectorOverview: ConnectorOverviewResult;
  health: ProjectTaskHealth;
  issueNumber: number;
  pipeline?: GitHubWorkflowRunSummary;
  project: ProjectSpaceRecord;
  projects: ProjectSpaceRecord[];
  pullRequest?: GitHubPullRequestRecord;
  repositoryFullName?: string;
}) {
  const runtime = useRuntimeBinding();
  const preview = usePullRequestPreviewStatus({
    enabled: Boolean(repositoryFullName && pullRequest),
    pullRequestNumber: pullRequest?.number,
    repositoryFullName
  });
  const prototypeMachine = getIssueMachineRows({
    connectorOverview,
    project,
    projects,
    repoFullName: repositoryFullName
  }).find((row) => canRunMachineCommand(row.machine));
  const status = pipelineStatus({ health, pipeline, pullRequest });
  const statusTone = health === 'attention'
    ? 'text-red-300'
    : health === 'healthy'
      ? 'text-emerald-300'
      : 'text-current/40';
  const statusIconTone = health === 'attention'
    ? 'text-red-400'
    : health === 'healthy'
      ? 'text-emerald-400'
      : 'text-current/25';
  const pipelineSummary = (
    <div className="flex min-h-12 items-center gap-3 px-1 text-sm">
      <CircleDot className={`size-4 ${statusIconTone}`} />
      <span className="text-current/50">Pipeline</span>
      <span className={`ml-auto font-medium ${statusTone}`}>{status}</span>
      {runtime.apis === 'external' && pipeline?.url ? (
        <ExternalLink className="size-3.5 text-current/30" />
      ) : null}
    </div>
  );

  return (
    <div className="divide-y divide-current/[.08]">
      {runtime.apis === 'external' && pipeline?.url ? (
        <a className="block hover:bg-current/[.035]" href={pipeline.url} rel="noreferrer" target="_blank">
          {pipelineSummary}
        </a>
      ) : pipelineSummary}

      {pullRequest && shouldShowPullRequestPreview(pullRequest) ? (
        <section className="grid gap-4 py-5">
          <PullRequestPreviewStatusView
            inventory={preview.inventory}
            pullRequest={pullRequest}
            repositoryFullName={repositoryFullName}
            returnPath={`/projects/${encodeURIComponent(project.id)}/issues/${issueNumber}`}
          />
          {runtime.apis === 'external' && pullRequest.state === 'open' && !pullRequest.isDraft && repositoryFullName ? (
            <div className="grid gap-2">
              <a
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-current/[.08] px-4 text-sm font-medium text-current/75 hover:bg-current/[.12] hover:text-current"
                href={pullRequest.url}
                rel="noreferrer"
                target="_blank"
              >
                Approve PR <ExternalLink className="size-3.5" />
              </a>
              <PullRequestPrototypeAction
                connectorId={prototypeMachine?.machineId}
                issueNumber={issueNumber}
                projectId={project.id}
                pullRequest={pullRequest}
                repositoryFullName={repositoryFullName}
              />
            </div>
          ) : null}
        </section>
      ) : pullRequest ? null : (
        <p className="py-5 text-sm leading-6 text-current/35">
          Checks and previews appear here after a pull request is opened.
        </p>
      )}

      {pullRequest?.state === 'merged' ? (
        <section className="grid gap-2 py-5">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="font-semibold text-current/55">Branch cleanup</span>
            <span className="text-current/30">Merged task</span>
          </div>
          <div className="flex min-h-9 items-center gap-2 text-xs">
            <GitBranch className="size-3.5 text-current/30" />
            <span className="min-w-0 flex-1 truncate text-current/55">Remote branch</span>
            <span className={pullRequest.headRefPresent === false ? 'text-emerald-300' : 'text-amber-300'}>
              {pullRequest.headRefPresent === false ? 'Deleted on GitHub' : 'Still on GitHub'}
            </span>
          </div>
          <p className="text-[11px] leading-5 text-current/35">
            Local worktrees can be removed after their Git status is verified as clean in Repository.
          </p>
        </section>
      ) : null}
    </div>
  );
}
