import type { ServerResponse } from 'node:http';

import { describe, expect, test } from 'bun:test';

import {
  createConfiguredCodexAuthorizationHandler
} from '../server/codex-authorization/configured-runtime';
import {
  createConfiguredCodexMachineTasksHandler
} from '../server/codex-machine-tasks/configured-runtime';
import { createConfiguredCodexSessionsHandler } from '../server/codex-sessions/configured-runtime';
import { createConfiguredMachineReadinessHandler } from '../server/machine-readiness/configured-runtime';
import { WorkspaceRuntimeSessionService } from '../server/workspace-runtime-session/service';
import type { WorkspaceRuntimeCodexMessage } from '../src/shared/workspace-runtime-codex-api';
import { workspaceRuntimeCodexCapability } from '../src/shared/workspace-runtime-codex-api';

function responseCapture() {
  let statusCode = 0;
  let body = '';
  const response = {
    end(value?: string) { body = value ?? ''; },
    setHeader() {},
    writeHead(code: number) { statusCode = code; }
  } as unknown as ServerResponse;
  return { response, result: () => ({ body, statusCode }) };
}

const request = { method: 'GET', headers: {} } as never;

describe('Codex runtime retirement boundary', () => {
  test('retires every configured Connector-backed HTTP entry point before dependencies run', async () => {
    const backend = new Proxy({}, {
      get() {
        throw new Error('retired Codex path touched the machine backend');
      }
    }) as never;
    const handlers = [
      [createConfiguredCodexSessionsHandler(), '/api/codex/sessions?machineId=hidden'],
      [createConfiguredCodexMachineTasksHandler({ backend }), '/api/codex/tasks/existing'],
      [createConfiguredCodexAuthorizationHandler({ backend }), '/api/codex/authorization'],
      [createConfiguredMachineReadinessHandler({ backend }), '/api/machine-readiness']
    ] as const;

    for (const [handler, path] of handlers) {
      const capture = responseCapture();
      await handler(request, capture.response, new URL(path, 'https://projects.example.test'));
      expect(capture.result().statusCode).toBe(410);
      expect(JSON.parse(capture.result().body)).toMatchObject({
        code: 'canonical_runtime_required'
      });
    }
  });

  test('keeps canonical runtime.codex.v1 messages accepted by the Workspace Runtime session', () => {
    const service = new WorkspaceRuntimeSessionService({} as never);
    const message: WorkspaceRuntimeCodexMessage = {
      acceptedCommandSequence: 1,
      actorId: 'human-owner',
      actorKind: 'human',
      actorUserId: 'owner',
      commandId: 'runtime-command-1',
      commandSequence: 1,
      environmentId: 'environment-1',
      generation: 'generation-1',
      operationId: 'runtime-operation-1',
      replayed: false,
      schemaVersion: 1,
      sessionId: 'session-1',
      type: 'runtime.codex.command-accepted',
      workspaceId: 'workspace-1'
    };

    expect(service.acceptCodex({
      scope: {
        capabilities: [workspaceRuntimeCodexCapability]
      } as never,
      sessionId: 'session-1'
    }, message)).toBe(message);
  });

});
