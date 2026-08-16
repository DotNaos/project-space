import type { TailscaleOAuthCredentials } from './oauth-api-client';
import type {
  TailscaleInventorySource,
  TailscaleInventorySourceDescriptor,
  TailscaleInventorySourceResult
} from './source';

type DeploymentCredentialState =
  | { kind: 'configured'; credentials: TailscaleOAuthCredentials }
  | { kind: 'invalid' }
  | { kind: 'missing' };

export function createDeploymentTailscaleInventorySource(options: {
  api: { observe(credentials: TailscaleOAuthCredentials): Promise<TailscaleInventorySourceResult> };
  environment: NodeJS.ProcessEnv;
  isLegacyOwner(ownerUserId: string): boolean;
  legacy: TailscaleInventorySource;
}): TailscaleInventorySource {
  const resolve = async (ownerUserId: string): Promise<{
    descriptor: TailscaleInventorySourceDescriptor;
    observe(): Promise<TailscaleInventorySourceResult>;
  }> => {
    const configured = readTailscaleDeploymentCredentials(options.environment);
    if (configured.kind === 'configured') {
      return {
        descriptor: { connectionState: 'configured', source: 'tailscale_oauth_api' },
        observe: () => options.api.observe(configured.credentials)
      };
    }
    if (configured.kind === 'invalid') {
      return {
        descriptor: { connectionState: 'configuration_error', source: 'tailscale_oauth_api' },
        observe: async () => unavailable('credentials_invalid')
      };
    }
    if (options.isLegacyOwner(ownerUserId)) {
      return {
        descriptor: {
          connectionState: 'legacy',
          source: 'temporary_vps_local_status'
        },
        observe: () => options.legacy.observe(ownerUserId)
      };
    }
    return {
      descriptor: { connectionState: 'not_configured', source: 'not_connected' },
      observe: async () => unavailable('connection_missing')
    };
  };

  return {
    async describe(ownerUserId) {
      return (await resolve(ownerUserId)).descriptor;
    },
    async observe(ownerUserId) {
      return (await resolve(ownerUserId)).observe();
    }
  };
}

export function readTailscaleDeploymentCredentials(
  environment: NodeJS.ProcessEnv
): DeploymentCredentialState {
  const clientId = environment.TAILSCALE_OAUTH_CLIENT_ID?.trim() ?? '';
  const clientSecret = environment.TAILSCALE_OAUTH_CLIENT_SECRET ?? '';
  if (!clientId && !clientSecret) return { kind: 'missing' };
  if (!validCredentialPart(clientId, 512) || !validCredentialPart(clientSecret, 2_048)) {
    return { kind: 'invalid' };
  }
  return { credentials: { clientId, clientSecret }, kind: 'configured' };
}

function validCredentialPart(value: string, maximum: number) {
  return value === value.trim() && value.length >= 8 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function unavailable(code: 'connection_missing' | 'credentials_invalid'): TailscaleInventorySourceResult {
  return { available: false, error: { code, source: 'api' } };
}
