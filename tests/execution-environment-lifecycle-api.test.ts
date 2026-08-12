import { expect, test } from 'bun:test';

import {
  EXECUTION_ENVIRONMENT_LIFECYCLE_API_VERSION,
  type ExecutionEnvironmentLifecycleResult
} from '../src/shared/execution-environment-lifecycle-api';

test('execution Environment lifecycle result keeps normalized and provider evidence separate', () => {
  const result = {
    action: 'provision',
    apiVersion: EXECUTION_ENVIRONMENT_LIFECYCLE_API_VERSION,
    blocked: { reason: 'connector_approval_required' },
    lifecycle: {
      nativeState: 'Available',
      normalized: 'running',
      observedAt: '2026-08-09T12:00:00.000Z'
    },
    message: 'Approve the exact managed connector.',
    operationId: 'lifecycle:00000000-0000-4000-8000-000000000536',
    provider: {
      kind: 'github_codespaces',
      resource: {
        name: 'project-space-task-536',
        url: 'https://github.com/codespaces/project-space-task-536'
      }
    },
    readiness: {
      approvalUrl: 'https://projects.os-home.net/machines/connect?request=exact',
      state: 'connector_approval_required'
    },
    reconciliation: {
      checkedAt: '2026-08-09T12:00:00.000Z',
      state: 'confirmed'
    }
  } satisfies ExecutionEnvironmentLifecycleResult;

  expect(result).toMatchObject({
    lifecycle: { nativeState: 'Available', normalized: 'running' },
    provider: { kind: 'github_codespaces' },
    readiness: { state: 'connector_approval_required' }
  });
  expect(JSON.stringify(result)).not.toContain('token');
  expect(JSON.stringify(result)).not.toContain('deviceCode');
});
