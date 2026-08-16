import type {
  CodexSessionBrowserResult,
  CodexSessionInspectResult,
  CodexSessionListResult,
  CodexSessionOperationResult,
  CodexSessionReadResult
} from '../../src/shared/codex-sessions-api';
import type { CodexSessionsHttpHandler } from '../codex-sessions-http';
import { createConfiguredCodexSessionsRuntime } from './configured-runtime';
import { CodexSessionsExecutor } from './executor';
import { CodexSessionManager } from './manager';
import type { CodexSessionsTransport } from './service';
import { CodexImageStore } from '../prototype-review-codex-images';

export async function createLocalDevelopmentCodexSessionsRuntime(input: {
  machineId: string;
  machineName: string;
}) {
  const manager = new CodexSessionManager();
  const images = new CodexImageStore(
    async () => undefined,
    undefined,
    undefined,
    {
      machineId: input.machineId,
      routePrefix: '/api/codex/sessions/images'
    }
  );
  const executor = new CodexSessionsExecutor({
    expectedGeneration: 1,
    expectedMachineId: input.machineId,
    machineName: input.machineName,
    manager,
    resolveImageAttachments: (attachmentIds) => images.resolve(attachmentIds)
  });
  const execute = async <Result>(
    operation: 'approval' | 'browser' | 'continue' | 'input' | 'inspect' | 'interrupt' | 'list' | 'read' | 'settings',
    request: unknown
  ) => (await executor.executeBound(operation, request, 1)).result as Result;
  const transport: CodexSessionsTransport = {
    async browser(request) {
      requireMachine(request.machineId, input.machineId);
      return execute<CodexSessionBrowserResult>('browser', request);
    },
    async describeMachine({ machineId }) {
      requireMachine(machineId, input.machineId);
      return { id: input.machineId, name: input.machineName, online: true };
    },
    async inspect(request) {
      requireMachine(request.machineId, input.machineId);
      return execute<CodexSessionInspectResult>('inspect', request);
    },
    async list(request) {
      requireMachine(request.machineId, input.machineId);
      return execute<CodexSessionListResult>('list', request);
    },
    async mutate(request) {
      requireMachine(request.machineId, input.machineId);
      return {
        machineId: request.machineId,
        result: await execute<CodexSessionOperationResult>(request.kind, request.request),
        threadId: request.threadId
      };
    },
    async read(request) {
      requireMachine(request.machineId, input.machineId);
      return execute<CodexSessionReadResult>('read', request);
    },
    async stream(request, emit, signal) {
      requireMachine(request.machineId, input.machineId);
      const unsubscribe = executor.streamBound(request, emit);
      try {
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
        }
      } finally {
        unsubscribe();
      }
    }
  };
  try {
    const runtime = await createConfiguredCodexSessionsRuntime({ transport });
    const handleRequest: CodexSessionsHttpHandler = async (request, response, url) => {
      if (await images.handleRequest(request, response, url)) return true;
      return runtime.handleRequest(request, response, url);
    };
    return {
      async close() {
        executor.close();
        await images.close();
        await manager.close();
      },
      handleRequest
    };
  } catch (error) {
    executor.close();
    await images.close();
    await manager.close();
    throw error;
  }
}

function requireMachine(candidate: string, expected: string) {
  if (candidate !== expected) throw new Error('The local Codex machine does not match this request.');
}
