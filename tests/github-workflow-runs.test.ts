import { describe, expect, test } from 'bun:test';
import { mapWorkflowJob, mapWorkflowRun } from '../server/local-github-catalog';

describe('GitHub workflow run contracts', () => {
  test('classifies deployment and release workflows and normalizes unknown states', () => {
    expect(mapWorkflowRun({
      actor: { login: 'octocat' }, conclusion: 'success', head_sha: 'a'.repeat(40),
      id: 1, name: 'Deploy production', path: '.github/workflows/deploy-production.yml',
      run_attempt: 2, status: 'completed', workflow_id: 9
    })).toMatchObject({ actor: 'octocat', attempt: 2, conclusion: 'success', id: 1,
      kind: 'deployment', status: 'completed', workflowId: 9 });
    expect(mapWorkflowRun({ id: 2, name: 'Release', path: '.github/workflows/release.yml', status: 'future_state' }))
      .toMatchObject({ conclusion: undefined, kind: 'release', status: 'unknown' });
  });

  test('returns only sanitized jobs and ordered steps with durations', () => {
    const job = mapWorkflowJob({
      completed_at: '2026-01-01T00:01:00Z', conclusion: 'failure', id: 3, name: 'Deploy',
      started_at: '2026-01-01T00:00:00Z', status: 'completed',
      steps: [
        { completed_at: '2026-01-01T00:00:20Z', name: 'Second', number: 2, started_at: '2026-01-01T00:00:10Z', status: 'completed' },
        { name: 'First', number: 1, status: 'in_progress' }
      ]
    }, 1);
    expect(job).toMatchObject({ durationMs: 60_000, sequence: 1, status: 'completed' });
    expect(job.steps.map((step) => step.number)).toEqual([1, 2]);
    expect(job.steps[1]?.durationMs).toBe(10_000);
    expect(JSON.stringify(job)).not.toMatch(/runner|token|log|environment|op:\/\//i);
  });
});
