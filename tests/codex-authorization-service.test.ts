import { describe, expect, test } from 'bun:test';

import {
  createCodexAuthorizationService
} from '../server/codex-authorization/service';

describe('retired Codex authorization service', () => {
  test('returns a safe canonical-runtime result without inspecting or dispatching a Connector', async () => {
    let inventoryCalls = 0;
    let dispatchCalls = 0;
    const service = createCodexAuthorizationService({
      async dispatch() {
        dispatchCalls += 1;
        return {};
      },
      async inventory() {
        inventoryCalls += 1;
        return {};
      }
    });

    await expect(service.authorize({ userId: 'owner' }, {
      action: 'start',
      operationId: 'codex:login:retired',
      physicalMachineName: 'os-pc'
    })).resolves.toEqual({
      apiVersion: 1,
      message: 'Codex authorization requires the canonical Environment and Workspace Runtime.',
      operationId: 'codex:login:retired',
      state: 'unsupported'
    });
    expect(inventoryCalls).toBe(0);
    expect(dispatchCalls).toBe(0);
  });
});
