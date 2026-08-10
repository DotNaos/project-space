import { expect, test } from 'bun:test';

import {
  AGENT_RUNTIME_API_VERSION,
  type AgentAuthorizationResult,
  type AgentStatusResult
} from '../src/shared/agent-runtime-api';

test('agent status keeps canonical Environment identity and bounded runtime evidence', () => {
  const result = {
    agent: 'codex',
    apiVersion: AGENT_RUNTIME_API_VERSION,
    environmentId: 'environment-codespace-540',
    message: 'Codex is ready.',
    runtime: {
      authorization: {
        checkedAt: '2026-08-09T14:00:00.000Z',
        state: 'ready'
      },
      capabilities: ['codex.machine-tasks.v1'],
      checkedAt: '2026-08-09T14:00:00.000Z',
      state: 'ready',
      version: '1.2.3'
    }
  } satisfies AgentStatusResult;

  expect(result.environmentId).toBe('environment-codespace-540');
  expect(JSON.stringify(result)).not.toContain('physicalMachine');
});

test('pending authorization exposes guidance without credential fields', () => {
  const result = {
    action: 'start',
    agent: 'codex',
    apiVersion: AGENT_RUNTIME_API_VERSION,
    checkedAt: '2026-08-09T14:00:00.000Z',
    deadlineAt: '2026-08-09T14:15:00.000Z',
    environmentId: 'environment-codespace-540',
    message: 'Complete device authorization.',
    operationId: 'agent-auth:00000000-0000-4000-8000-000000000540',
    polling: {
      recommendedAfterSeconds: 5,
      tool: 'get_agent_authorization'
    },
    state: 'pending',
    userCode: 'ABCD-1234',
    verificationUrl: 'https://auth.openai.com/codex/device'
  } satisfies AgentAuthorizationResult;

  expect(result.polling.tool).toBe('get_agent_authorization');
  expect(Object.keys(result)).not.toContain('loginId');
  expect(JSON.stringify(result)).not.toContain('token');
});
