import type { IncomingMessage, ServerResponse } from 'node:http';

import type {
  CodexAuthorizationRequest,
  CodexAuthorizationResult
} from '../../src/shared/codex-authorization-api';
import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import type { MachineConnectionRuntime } from '../machine-connection-runtime';
import { retireCodexHttp } from '../codex-sessions/retirement';

export interface CodexAuthorizationRuntime {
  authorize(
    actor: { userId: string },
    request: CodexAuthorizationRequest
  ): Promise<CodexAuthorizationResult>;
}

export interface ConfiguredCodexAuthorizationOptions {
  backend: Pick<ProjectSpaceBackend, 'getConnectorOverview'>;
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
}

export function createConfiguredCodexAuthorizationRuntime(
  _options: ConfiguredCodexAuthorizationOptions
): CodexAuthorizationRuntime {
  return {
    async authorize(_actor, request) {
      return {
        apiVersion: 1,
        message: 'Codex authorization requires the canonical Environment and Workspace Runtime.',
        operationId: request.operationId,
        state: 'unsupported'
      };
    }
  };
}

export function createConfiguredCodexAuthorizationHandler(
  _options: ConfiguredCodexAuthorizationOptions & {
    runtime?: CodexAuthorizationRuntime;
  }
) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (url.pathname !== '/api/codex/authorization') return false;
    retireCodexHttp(response);
    return true;
  };
}
