import type { TailscaleOAuthCredentials } from './oauth-api-client';
import type {
  TailscaleInventorySource,
  TailscaleInventorySourceDescriptor,
  TailscaleInventorySourceResult
} from './source';

interface ActiveConnection {
  credentials: TailscaleOAuthCredentials;
  status: ConnectionStatus;
}

interface ConnectionStatus {
  connectionId: string;
  revision: number;
  state: 'active' | 'revoked';
}

export interface TailscaleAccountConnectionReader {
  readActive(ownerUserId: string): Promise<ActiveConnection | null>;
  readStatus(ownerUserId: string): Promise<ConnectionStatus | null>;
}

export function createAccountTailscaleInventorySource(options: {
  api: { observe(credentials: TailscaleOAuthCredentials): Promise<TailscaleInventorySourceResult> };
  connections: TailscaleAccountConnectionReader;
  isLegacyOwner(ownerUserId: string): boolean;
  legacy: TailscaleInventorySource;
}): TailscaleInventorySource {
  const resolve = async (ownerUserId: string): Promise<{
    descriptor: TailscaleInventorySourceDescriptor;
    observe(): Promise<TailscaleInventorySourceResult>;
  }> => {
    const status = await options.connections.readStatus(ownerUserId);
    if (status?.state === 'active') {
      let active: ActiveConnection | null = null;
      try {
        active = await options.connections.readActive(ownerUserId);
      } catch {
        return {
          descriptor: {
            connectionId: status.connectionId,
            connectionState: 'reauthorization_required',
            revision: status.revision,
            source: 'tailscale_oauth_api'
          },
          observe: async () => unavailable('credentials_invalid')
        };
      }
      if (!active) {
        return {
          descriptor: {
            connectionId: status.connectionId,
            connectionState: 'reauthorization_required',
            revision: status.revision,
            source: 'tailscale_oauth_api'
          },
          observe: async () => unavailable('credentials_invalid')
        };
      }
      return {
        descriptor: {
          connectionId: active.status.connectionId,
          connectionState: 'connected',
          revision: active.status.revision,
          source: 'tailscale_oauth_api'
        },
        observe: () => options.api.observe(active.credentials)
      };
    }
    if (status) {
      return {
        descriptor: {
          connectionId: status.connectionId,
          connectionState: 'reauthorization_required',
          revision: status.revision,
          source: 'tailscale_oauth_api'
        },
        observe: async () => unavailable('connection_missing')
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
      descriptor: { connectionState: 'not_connected', source: 'not_connected' },
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

function unavailable(code: 'connection_missing' | 'credentials_invalid'): TailscaleInventorySourceResult {
  return { available: false, error: { code, source: 'api' } };
}
