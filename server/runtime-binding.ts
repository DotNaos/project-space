import { isAbsolute } from 'node:path';

export type RuntimeApiBinding = 'simulated' | 'external';
export type RuntimeDataBinding = 'local' | 'remote';

export interface RuntimeBindingEvidence {
  accessUrl: string;
  apis: RuntimeApiBinding;
  data: RuntimeDataBinding;
  network: 'loopback-only' | 'external';
  secrets: 'none' | 'resolved';
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

  const mode = environment.PROJECT_SPACE_SERVE_MODE;
  if (mode !== 'managed' && mode !== 'local-only') {
    throw new Error('PROJECT_SPACE_SERVE_MODE must be managed or local-only.');
  }
  const accessUrl = validatedAccessUrl(
    environment.PROJECT_SPACE_RUNTIME_ACCESS_URL ?? environment.PORTLESS_URL
  );

  if (apis === 'external') {
    if (environment.PROJECT_SPACE_EXTERNAL_SECRETS !== 'resolved') {
      throw new Error('External APIs require Project-managed resolved secrets.');
    }
    return {
      accessUrl,
      apis,
      data,
      network: mode === 'managed' ? 'external' : 'loopback-only',
      secrets: 'resolved'
    };
  }

  const simulationStatePath = environment.PROJECT_SPACE_SIMULATION_STATE?.trim();
  if (!simulationStatePath || !isAbsolute(simulationStatePath)) {
    throw new Error('Simulated APIs require an absolute Project-managed simulation state path.');
  }

  return {
    accessUrl,
    apis,
    data,
    network: mode === 'managed' ? 'external' : 'loopback-only',
    secrets: 'none',
    simulationStatePath
  };
}

function validatedAccessUrl(value: string | undefined): string {
  const candidate = value?.trim();
  if (!candidate) {
    throw new Error('A Project-managed runtime access URL is required.');
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('The Project-managed runtime access URL must be absolute.');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
    throw new Error('The Project-managed runtime access URL must be an HTTP URL without credentials.');
  }
  return candidate;
}
