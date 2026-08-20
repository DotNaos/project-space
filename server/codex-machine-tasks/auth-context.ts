import type { IncomingMessage } from 'node:http';
import { CODEX_THREAD_ID_PATTERN } from '../../src/shared/codex-sessions-api';

const machineHeader = 'x-project-machine-id';
const callerThreadHeader = 'x-codex-thread-id';
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const bearer = /^[A-Za-z0-9._~+/-]{1,4096}=*$/;

export class CodexMachineTasksAuthError extends Error {
  constructor(readonly statusCode: 401 | 403) {
    super('Codex machine-task authentication failed.');
    this.name = 'CodexMachineTasksAuthError';
  }
}

export function createCodexMachineTasksAuthResolver(options: {
  authenticateMachine(input: { machineId: string; token: string }): Promise<{
    machineId: string;
    userId: string;
  } | null>;
  authRequired(): boolean;
  readHuman(request: IncomingMessage): Promise<{ userId: string } | null>;
}) {
  return async function resolve(request: IncomingMessage) {
    const machineId = singleHeader(request, machineHeader);
    if (machineId !== undefined) {
      if (!identifier.test(machineId)) throw new CodexMachineTasksAuthError(403);
      const authorization = singleHeader(request, 'authorization');
      if (!authorization?.startsWith('Bearer ')) throw new CodexMachineTasksAuthError(401);
      const token = authorization.slice(7);
      if (!bearer.test(token)) throw new CodexMachineTasksAuthError(401);
      let authenticated: Awaited<ReturnType<typeof options.authenticateMachine>>;
      try {
        authenticated = await options.authenticateMachine({ machineId, token });
      } catch {
        throw new CodexMachineTasksAuthError(401);
      }
      if (!authenticated) throw new CodexMachineTasksAuthError(401);
      if (authenticated.machineId !== machineId) throw new CodexMachineTasksAuthError(403);
      return { callerMachineId: machineId, ...reportingTask(request), userId: authenticated.userId };
    }
    if (!options.authRequired()) return { userId: 'local-development-user' };
    const human = await options.readHuman(request).catch(() => null);
    if (!human) throw new CodexMachineTasksAuthError(401);
    return { ...human, ...reportingTask(request) };
  };
}

function reportingTask(request: IncomingMessage) {
  const threadId = singleHeader(request, callerThreadHeader);
  if (threadId === undefined) return {};
  if (!CODEX_THREAD_ID_PATTERN.test(threadId)) throw new CodexMachineTasksAuthError(403);
  // This header identifies the initiating Codex task only. The server cannot
  // infer Project Manager ownership from an arbitrary caller-supplied UUID;
  // #819's worktree-context gate must prove that role before dispatch.
  return { reportingTask: { role: 'initiator' as const, threadId } };
}

function singleHeader(request: IncomingMessage, name: string) {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      values.push(request.rawHeaders[index + 1] ?? '');
    }
  }
  if (values.length > 1) throw new CodexMachineTasksAuthError(401);
  if (values.length === 1) return values[0];
  const value = request.headers[name];
  if (Array.isArray(value)) throw new CodexMachineTasksAuthError(401);
  return value;
}
