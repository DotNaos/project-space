import { describe, expect, test } from 'bun:test';
import type { DeployedEnvironmentStatus, GitHubWorkflowRunSummary } from '../src/shared/project-space-api';
import {
  deploymentRuns,
  environmentStatusLabel,
  isCurrentDeploymentRun,
  isHistoricalFailure,
  pipelineStateMessage,
  sortEnvironments,
  workflowStatusLabel,
  workflowStatusTone
} from '../src/features/project-desktop/components/deployment-status-model';

const sha = (character: string) => character.repeat(40);
const environment = (id: string, deployedSha?: string): DeployedEnvironmentStatus => ({
  deployedSha, displayName: id, id, verification: 'healthy'
});
const run = (overrides: Partial<GitHubWorkflowRunSummary> = {}): GitHubWorkflowRunSummary => ({
  id: 1, kind: 'deployment', status: 'completed', ...overrides
});

describe('deployment status UI model', () => {
  test('sorts known and future environments without dropping any', () => {
    expect(sortEnvironments([environment('canary'), environment('beta'), environment('prod'), environment('dev')]).map((item) => item.id))
      .toEqual(['prod', 'dev', 'beta', 'canary']);
  });

  test('uses exact full SHA equality for current deployed runs', () => {
    const deployed = sha('a');
    expect(isCurrentDeploymentRun(run({ headSha: deployed }), [environment('prod', deployed)])).toBe(true);
    expect(isCurrentDeploymentRun(run({ headSha: deployed.slice(0, 7) }), [environment('prod', deployed)])).toBe(false);
  });

  test('separates failed attempts from the currently deployed state', () => {
    const deployed = sha('b');
    expect(isHistoricalFailure(run({ conclusion: 'failure', headSha: sha('c') }), [environment('prod', deployed)])).toBe(true);
    expect(isHistoricalFailure(run({ conclusion: 'failure', headSha: deployed }), [environment('prod', deployed)])).toBe(false);
  });

  test('covers every terminal and active workflow presentation', () => {
    expect(workflowStatusTone('in_progress')).toBe('warning');
    expect(workflowStatusTone('completed', 'success')).toBe('success');
    expect(workflowStatusTone('completed', 'failure')).toBe('danger');
    expect(workflowStatusTone('completed', 'timed_out')).toBe('danger');
    expect(workflowStatusTone('completed', 'action_required')).toBe('danger');
    expect(workflowStatusTone('completed', 'cancelled')).toBe('warning');
    expect(workflowStatusTone('completed', 'stale')).toBe('warning');
    expect(workflowStatusTone('completed', 'skipped')).toBe('muted');
    expect(workflowStatusLabel('in_progress')).toBe('in progress');
  });

  test('excludes release, CI, and other workflows from deployment history', () => {
    expect(deploymentRuns([run(), run({ id: 2, kind: 'release' }), run({ id: 3, kind: 'ci' })]).map((item) => item.id)).toEqual([1]);
  });

  test('labels deployments outside the loaded graph and distinct API states', () => {
    const deployed = sha('d');
    expect(environmentStatusLabel(environment('prod', deployed), new Set())).toBe('healthy · outside loaded history');
    expect(pipelineStateMessage('rate-limited')).toContain('rate limited');
    expect(pipelineStateMessage('auth-required')).toContain('Sign in');
    expect(pipelineStateMessage('not-configured')).toContain('not configured');
  });
});
