import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import type { MachineConnectionRuntime } from '../machine-connection-runtime';
import { retireCodexHttp } from '../codex-sessions/retirement';

export interface ConfiguredMachineReadinessOptions {
  backend: Pick<
    ProjectSpaceBackend,
    'getConnectorOverview' | 'getMachineRuntime' | 'startMachineRuntimeOperation'
  >;
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
}

export function createConfiguredMachineReadinessHandler(
  _options: ConfiguredMachineReadinessOptions
) {
  return async (_request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (url.pathname !== '/api/machine-readiness') return false;
    retireCodexHttp(response);
    return true;
  };
}
