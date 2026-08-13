import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import type { CodexSessionsRuntime } from '../codex-sessions/runtime';
import type { MachineConnectionRuntime } from '../machine-connection-runtime';
import { CodexAttachLeaseStore } from './attach-lease-store';
import type { CodexMachineTasksHttpHandler } from './http';
import type { createCodexMachineTasksService } from './service';
import { retireCodexHttp } from '../codex-sessions/retirement';

export interface ConfiguredCodexMachineTasksOptions {
  attachLeases?: CodexAttachLeaseStore;
  backend: Pick<
    ProjectSpaceBackend,
    'createGitHubBranch' | 'getConnectorOverview' | 'getGitHubCatalog' |
    'getGitHubRepositoryDetails' | 'getMachineRuntime'
  >;
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
  sessionsRuntime?: Promise<CodexSessionsRuntime>;
}

export interface ConfiguredCodexMachineTasksRuntime {
  service: ReturnType<typeof createCodexMachineTasksService>;
  sessions: CodexSessionsRuntime;
}

export class CodexMachineTasksRetiredError extends Error {
  constructor() {
    super('Codex machine tasks require the canonical Environment and Workspace Runtime.');
    this.name = 'CodexMachineTasksRetiredError';
  }
}

export function createConfiguredCodexMachineTasksHandler(
  _options: ConfiguredCodexMachineTasksOptions
): CodexMachineTasksHttpHandler {
  return async (_request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (!url.pathname.startsWith('/api/codex/tasks')) return false;
    retireCodexHttp(response);
    return true;
  };
}

export async function createConfiguredCodexMachineTasksRuntime(
  _options: ConfiguredCodexMachineTasksOptions
): Promise<ConfiguredCodexMachineTasksRuntime> {
  throw new CodexMachineTasksRetiredError();
}
