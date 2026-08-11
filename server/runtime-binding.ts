import { isAbsolute } from 'node:path';

export type RuntimeApiBinding = 'simulated' | 'external';
export type RuntimeDataBinding = 'local' | 'remote';

export interface RuntimeBindingEvidence {
  apis: RuntimeApiBinding;
  data: RuntimeDataBinding;
  network: 'loopback-only' | 'external';
  secrets: 'none' | 'unresolved';
  simulationStatePath?: string;
}

export function resolveManagedRuntimeBinding(
  environment: NodeJS.ProcessEnv = process.env
): RuntimeBindingEvidence {
  if (environment.PROJECT_SPACE_MANAGED_SERVE !== '1') {
    throw new Error('Runtime binding evidence is only accepted from a Project-managed server.');
  }

  const apis = environment.PROJECT_SPACE_APIS;
  const data = environment.PROJECT_SPACE_DATA;
  if (apis !== 'simulated' && apis !== 'external') {
    throw new Error('PROJECT_SPACE_APIS must be simulated or external.');
  }
  if (data !== 'local' && data !== 'remote') {
    throw new Error('PROJECT_SPACE_DATA must be local or remote.');
  }
  if (apis === 'simulated' && data === 'remote') {
    throw new Error('Simulated APIs cannot be bound to remote data.');
  }

  if (apis === 'external') {
    throw new Error(
      'External API startup is blocked until detached service-account token delivery is available.'
    );
  }

  const simulationStatePath = environment.PROJECT_SPACE_SIMULATION_STATE?.trim();
  if (!simulationStatePath || !isAbsolute(simulationStatePath)) {
    throw new Error('Simulated APIs require an absolute Project-managed simulation state path.');
  }

  return {
    apis,
    data,
    network: 'loopback-only',
    secrets: 'none',
    simulationStatePath
  };
}
