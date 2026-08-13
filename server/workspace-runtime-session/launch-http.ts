import type { IncomingMessage, ServerResponse } from 'node:http';

import { CodexMachineTasksAuthError } from '../codex-machine-tasks/auth-context';
import { writeJson } from '../project-space-http-response';
import type { SshGatewayActor } from '../ssh-control-gateway/contracts';
import { SshGatewayError } from '../ssh-control-gateway/contracts';
import {
  WorkspaceRuntimeLaunchService,
  WorkspaceRuntimeSshStartDispatcher,
  type WorkspaceRuntimeSshGateway,
  type WorkspaceRuntimeStartAuthority
} from './launch-service';
import type { RuntimeSessionStore } from './contracts';
import { RuntimeSessionError } from './contracts';

export const workspaceRuntimeLaunchRoute = '/api/compute/control/workspace-runtime/launch';
export const workspaceRuntimeCapabilitiesRoute = '/api/compute/control/workspace-runtime/capabilities';
const maximumBodyBytes = 16 * 1024;

export function createWorkspaceRuntimeLaunchHttpApi(options: {
  authorizeMutation?(input: WorkspaceRuntimeStartAuthority): Promise<boolean>;
  endpoint(request: IncomingMessage): string;
  gateway: WorkspaceRuntimeSshGateway;
  resolveActor(request: IncomingMessage): Promise<{ callerMachineId?: string; userId: string }>;
  resolvePresentation?(input: {
    branch: string;
    commit: string;
    environmentId: string;
    ownerUserId: string;
    workspaceId: string;
    worktreeOwnerThreadId: string;
  }): Promise<NonNullable<WorkspaceRuntimeStartAuthority['presentation']> | undefined>;
  sessions: Pick<RuntimeSessionStore, 'issue' | 'revoke'>;
}) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (url.pathname !== workspaceRuntimeLaunchRoute &&
      url.pathname !== workspaceRuntimeCapabilitiesRoute) return false;
    response.setHeader('Cache-Control', 'private, no-store');
    try {
      if (url.pathname === workspaceRuntimeCapabilitiesRoute) {
        if (request.method !== 'GET' || [...url.searchParams.keys()].length > 0) {
          throw invalid('Workspace Runtime capabilities require one GET request without query parameters.');
        }
        const identity = await options.resolveActor(request);
        if (!identity.callerMachineId) {
          throw new SshGatewayError('authorization_denied', 'Machine authentication is required.');
        }
        writeJson(response, 200, {
          capabilities: ['workspace-runtime-presentation.v1'],
          schemaVersion: 1
        });
        return true;
      }
      if (request.method !== 'POST' || [...url.searchParams.keys()].length > 0) {
        throw invalid('Workspace Runtime launch requires one POST request without query parameters.');
      }
      const identity = await options.resolveActor(request);
      if (!identity.callerMachineId) {
        throw new SshGatewayError('authorization_denied', 'Machine authentication is required.');
      }
      const parsed = parseLaunch(await readBody(request));
      if (request.headers['idempotency-key'] !== parsed.operationId) {
        throw invalid('Idempotency-Key must match operationId.');
      }
      const presentation = parsed.worktreeOwnerThreadId && options.resolvePresentation
          ? await options.resolvePresentation({
            branch: parsed.branch,
            commit: parsed.commit,
            environmentId: parsed.environmentId,
            ownerUserId: identity.userId,
            workspaceId: parsed.workspaceId,
            worktreeOwnerThreadId: parsed.worktreeOwnerThreadId
          })
        : undefined;
      const input: WorkspaceRuntimeStartAuthority = {
        ...parsed,
        ownerUserId: identity.userId,
        ...(presentation ? { presentation } : {})
      };
      const actor: SshGatewayActor = {
        id: identity.callerMachineId,
        kind: 'machine',
        ownerUserId: identity.userId
      };
      const service = new WorkspaceRuntimeLaunchService({
        authorizeMutation: options.authorizeMutation,
        dispatcher: new WorkspaceRuntimeSshStartDispatcher(options.gateway, actor),
        endpoint: options.endpoint(request),
        sessions: options.sessions
      });
      writeJson(response, 200, await service.start(input));
    } catch (error) {
      if (error instanceof CodexMachineTasksAuthError) {
        writeJson(response, error.statusCode, {
          error: { code: 'authentication_failed', message: 'Project Space machine authentication failed.' }
        });
      } else if (error instanceof SshGatewayError) {
        writeJson(response, statusFor(error.code), { error: { code: error.code, message: error.message } });
      } else if (error instanceof RuntimeSessionError) {
        writeJson(response, runtimeStatusFor(error.code), { error: { code: error.code, message: error.message } });
      } else {
        writeJson(response, 503, {
          error: { code: 'workspace_runtime_launch_unavailable', message: 'Workspace Runtime launch is unavailable.' }
        });
      }
    }
    return true;
  };
}

function parseLaunch(body: Record<string, unknown>) {
  const keys = [
    'branch', 'commit', 'environmentId', 'generation', 'manifestDigest',
    'mode', 'operationId', 'profile', 'runtimeVersion', 'workspaceId',
    ...(body.worktreeOwnerThreadId === undefined ? [] : ['worktreeOwnerThreadId'])
  ];
  if (Object.keys(body).sort().join('\0') !== keys.sort().join('\0') ||
    !text(body.branch, 256) || !commit(body.commit) || !uuid(body.environmentId) ||
    !uuid(body.generation) || !digest(body.manifestDigest) ||
    body.mode !== 'process' && body.mode !== 'devcontainer' ||
    body.profile !== 'codex' && body.profile !== 'inspection' && body.profile !== 'mutation' ||
    !text(body.operationId, 256, /^[A-Za-z0-9:._-]+$/) ||
    !text(body.runtimeVersion, 64, /^[A-Za-z0-9._+-]+$/) || !uuid(body.workspaceId) ||
    (body.profile === 'mutation' && !uuid(body.worktreeOwnerThreadId)) ||
    (body.worktreeOwnerThreadId !== undefined && !uuid(body.worktreeOwnerThreadId))) {
    throw invalid('Workspace Runtime launch request is invalid.');
  }
  return body as unknown as Omit<WorkspaceRuntimeStartAuthority, 'ownerUserId' | 'presentation'>;
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maximumBodyBytes) throw invalid('Workspace Runtime launch request is too large.');
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SshGatewayError) throw error;
    throw invalid('Workspace Runtime launch body must be a JSON object.');
  }
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function commit(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function text(value: unknown, maximum: number, pattern?: RegExp): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value) && (!pattern || pattern.test(value));
}

function statusFor(code: SshGatewayError['code']) {
  if (code === 'authorization_denied') return 403;
  if (code === 'operation_conflict' || code === 'operation_in_progress') return 409;
  if (code === 'timeout') return 504;
  return 503;
}

function runtimeStatusFor(code: RuntimeSessionError['code']) {
  if (code === 'operation_in_progress' || code === 'replay_conflict' || code === 'generation_replaced') return 409;
  if (code === 'authentication_failed') return 403;
  return 503;
}

function invalid(message: string) {
  return new SshGatewayError('operation_conflict', message);
}
