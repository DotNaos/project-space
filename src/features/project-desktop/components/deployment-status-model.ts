import type {
  DeployedEnvironmentStatus,
  GitHubCatalogStatus,
  GitHubWorkflowRunConclusion,
  GitHubWorkflowRunStatus,
  GitHubWorkflowRunSummary
} from '@/shared/project-space-api';

export type StatusTone = 'danger' | 'muted' | 'success' | 'warning';

const environmentOrder = new Map([['prod', 0], ['dev', 1], ['beta', 2]]);
const fullSha = /^[0-9a-f]{40}$/;

export function normalizedFullSha(value?: string) {
  const normalized = value?.toLowerCase();
  return normalized && fullSha.test(normalized) ? normalized : undefined;
}

export function sortEnvironments(environments: DeployedEnvironmentStatus[]) {
  return [...environments].sort((left, right) =>
    (environmentOrder.get(left.id) ?? 10) - (environmentOrder.get(right.id) ?? 10) ||
    left.displayName.localeCompare(right.displayName)
  );
}

export function workflowStatusLabel(status: GitHubWorkflowRunStatus, conclusion?: GitHubWorkflowRunConclusion) {
  if (status !== 'completed') return status.replaceAll('_', ' ');
  return (conclusion ?? 'completed').replaceAll('_', ' ');
}

export function workflowStatusTone(status: GitHubWorkflowRunStatus, conclusion?: GitHubWorkflowRunConclusion): StatusTone {
  if (status !== 'completed') return status === 'unknown' ? 'muted' : 'warning';
  if (conclusion === 'success') return 'success';
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required') return 'danger';
  if (conclusion === 'cancelled' || conclusion === 'stale') return 'warning';
  return 'muted';
}

export function environmentTone(environment: DeployedEnvironmentStatus): StatusTone {
  if (environment.verification === 'healthy') return 'success';
  if (environment.verification === 'inconsistent') return 'warning';
  if (environment.verification === 'unhealthy') return 'danger';
  return 'muted';
}

export function environmentStatusLabel(environment: DeployedEnvironmentStatus, loadedCommitShas?: ReadonlySet<string>) {
  if (environment.deployedSha && loadedCommitShas && !loadedCommitShas.has(environment.deployedSha)) {
    return `${environment.verification} · outside loaded history`;
  }
  return environment.verification;
}

export function isRunInProgress(run: GitHubWorkflowRunSummary) {
  return run.status !== 'completed' && run.status !== 'unknown';
}

export function isCurrentDeploymentRun(run: GitHubWorkflowRunSummary, environments: DeployedEnvironmentStatus[]) {
  if (run.status !== 'completed' || run.conclusion !== 'success') return false;
  const runSha = normalizedFullSha(run.headSha);
  return Boolean(runSha && environments.some(
    (environment) => normalizedFullSha(environment.deployedSha) === runSha
  ));
}

export type DeploymentRunContext = 'active' | 'current' | 'failed' | 'superseded' | 'other';

export function deploymentRunContext(
  run: GitHubWorkflowRunSummary,
  environments: DeployedEnvironmentStatus[]
): DeploymentRunContext {
  if (isRunInProgress(run)) return 'active';
  if (workflowStatusTone(run.status, run.conclusion) === 'danger') return 'failed';
  if (isCurrentDeploymentRun(run, environments)) return 'current';
  if (run.status === 'completed' && run.conclusion === 'success') return 'superseded';
  return 'other';
}

export function deploymentRuns(runs: GitHubWorkflowRunSummary[]) {
  return runs.filter((run) => run.kind === 'deployment');
}

export function isHistoricalFailure(run: GitHubWorkflowRunSummary, environments: DeployedEnvironmentStatus[]) {
  return workflowStatusTone(run.status, run.conclusion) === 'danger' && !isCurrentDeploymentRun(run, environments);
}

export function pipelineStateMessage(status: GitHubCatalogStatus, message?: string) {
  if (message) return message;
  if (status === 'auth-required') return 'Sign in to GitHub to view deployment pipeline runs.';
  if (status === 'unauthorized') return 'This repository is not authorized to read workflow runs.';
  if (status === 'not-configured') return 'GitHub is not configured for this Project Space instance.';
  if (status === 'rate-limited') return 'GitHub rate limited this request. Previously loaded deployment information remains unchanged.';
  return 'Deployment pipeline information is temporarily unavailable.';
}

export function formatDuration(durationMs?: number) {
  if (typeof durationMs !== 'number' || durationMs < 0) return '';
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
