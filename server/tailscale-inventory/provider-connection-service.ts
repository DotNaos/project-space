import type { TailscaleProviderConnectionResult } from '../../src/shared/tailscale-inventory-api';
import type { TailscaleOAuthCredentials } from './oauth-api-client';
import { tailscaleInventoryScope } from './oauth-api-client';
import type { TailscaleInventorySourceDescriptor, TailscaleInventorySourceResult } from './source';
import type { TailscaleInventoryReconciliation } from './store';

interface StoredConnectionStatus {
  connectionId: string;
  createdAt: string;
  state: 'active' | 'revoked';
  verifiedAt: string;
}

export interface TailscaleProviderConnectionWriter {
  readStatus(ownerUserId: string): Promise<StoredConnectionStatus | null>;
  revoke(input: { actorId: string; ownerUserId: string }): Promise<StoredConnectionStatus | null>;
  saveVerified(input: {
    actorId: string;
    credentials: TailscaleOAuthCredentials;
    ownerUserId: string;
    verifiedAt: string;
  }): Promise<StoredConnectionStatus>;
}

export class TailscaleProviderConnectionError extends Error {
  constructor(
    readonly code:
      | 'credentials-invalid'
      | 'scope-insufficient'
      | 'provider-unavailable'
      | 'provider-response-invalid',
    message: string
  ) {
    super(message);
    this.name = 'TailscaleProviderConnectionError';
  }
}

export function createTailscaleProviderConnectionService(options: {
  api: { observe(credentials: TailscaleOAuthCredentials): Promise<TailscaleInventorySourceResult> };
  connections: TailscaleProviderConnectionWriter;
  describe(ownerUserId: string): Promise<TailscaleInventorySourceDescriptor>;
  inventory: {
    reconcile(ownerUserId: string, input: TailscaleInventoryReconciliation): Promise<unknown>;
  };
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  return {
    async get(ownerUserId: string): Promise<TailscaleProviderConnectionResult> {
      const descriptor = await options.describe(ownerUserId);
      const stored = await options.connections.readStatus(ownerUserId);
      return publicResult(descriptor, stored);
    },

    async connect(actor: { actorId: string; ownerUserId: string }, credentials: TailscaleOAuthCredentials) {
      const observed = await options.api.observe(credentials);
      if (!observed.available) throw connectionError(observed.error.code);
      const verifiedAt = now().toISOString();
      const stored = await options.connections.saveVerified({ ...actor, credentials, verifiedAt });
      await options.inventory.reconcile(actor.ownerUserId, {
        complete: observed.snapshot.deviceErrors.length === 0,
        kind: 'snapshot',
        snapshot: observed.snapshot
      });
      return publicResult({
        connectionId: stored.connectionId,
        connectionState: 'connected',
        source: 'tailscale_oauth_api'
      }, stored);
    },

    async revoke(actor: { actorId: string; ownerUserId: string }) {
      const stored = await options.connections.revoke(actor);
      return publicResult(stored ? {
        connectionId: stored.connectionId,
        connectionState: 'reauthorization_required',
        source: 'tailscale_oauth_api'
      } : {
        connectionState: 'not_connected',
        source: 'not_connected'
      }, stored);
    }
  };
}

function publicResult(
  descriptor: TailscaleInventorySourceDescriptor,
  stored: StoredConnectionStatus | null
): TailscaleProviderConnectionResult {
  return {
    ...(descriptor.connectionId ? { connectionId: descriptor.connectionId } : {}),
    ...(stored?.createdAt ? { connectedAt: stored.createdAt } : {}),
    connectionState: descriptor.connectionState,
    requiredScope: tailscaleInventoryScope,
    source: descriptor.source,
    ...(stored?.verifiedAt ? { verifiedAt: stored.verifiedAt } : {})
  };
}

function connectionError(code: string) {
  if (code === 'credentials_invalid') {
    return new TailscaleProviderConnectionError(
      'credentials-invalid', 'Tailscale rejected this provider credential.'
    );
  }
  if (code === 'scope_insufficient') {
    return new TailscaleProviderConnectionError(
      'scope-insufficient', `The Tailscale provider credential requires ${tailscaleInventoryScope}.`
    );
  }
  if (code === 'invalid_api_response' || code === 'api_response_too_large') {
    return new TailscaleProviderConnectionError(
      'provider-response-invalid', 'Tailscale returned an invalid inventory response.'
    );
  }
  return new TailscaleProviderConnectionError(
    'provider-unavailable', 'Tailscale provider verification is temporarily unavailable.'
  );
}
