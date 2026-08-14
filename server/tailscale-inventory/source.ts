import type { TailscaleStatusSnapshot } from './contracts';
import type {
  TailscaleInventorySourceKind,
  TailscaleProviderConnectionState
} from '../../src/shared/tailscale-inventory-api';

export interface TailscaleInventorySourceDescriptor {
  connectionId?: string;
  connectionState: TailscaleProviderConnectionState;
  /** Internal cache fence; never returned by the public API. */
  revision?: number;
  source: TailscaleInventorySourceKind;
}

/** A read-only source of fresh, local Tailscale provider evidence. */
export interface TailscaleInventorySource {
  describe?(ownerUserId: string): Promise<TailscaleInventorySourceDescriptor>;
  observe(ownerUserId: string): Promise<TailscaleInventorySourceResult>;
}

export type TailscaleInventorySourceErrorCode =
  | 'command_unavailable'
  | 'command_timed_out'
  | 'command_failed'
  | 'proxy_unavailable'
  | 'proxy_timed_out'
  | 'proxy_response_too_large'
  | 'invalid_status'
  | 'connection_missing'
  | 'credentials_invalid'
  | 'scope_insufficient'
  | 'api_unavailable'
  | 'api_timed_out'
  | 'api_response_too_large'
  | 'invalid_api_response';

/**
 * Deliberately contains only a stable failure category. Command output and
 * operating-system error messages may contain sensitive local information.
 */
export interface TailscaleInventorySourceError {
  code: TailscaleInventorySourceErrorCode;
  source: 'api' | 'command' | 'proxy';
}

export type TailscaleInventorySourceResult =
  | { available: true; snapshot: TailscaleStatusSnapshot }
  | { available: false; error: TailscaleInventorySourceError };
