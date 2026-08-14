import type { TailscaleStatusSnapshot } from './contracts';

/** A read-only source of fresh, local Tailscale provider evidence. */
export interface TailscaleInventorySource {
  observe(): Promise<TailscaleInventorySourceResult>;
}

export type TailscaleInventorySourceErrorCode =
  | 'command_unavailable'
  | 'command_timed_out'
  | 'command_failed'
  | 'proxy_unavailable'
  | 'proxy_timed_out'
  | 'proxy_response_too_large'
  | 'invalid_status';

/**
 * Deliberately contains only a stable failure category. Command output and
 * operating-system error messages may contain sensitive local information.
 */
export interface TailscaleInventorySourceError {
  code: TailscaleInventorySourceErrorCode;
  source: 'command' | 'proxy';
}

export type TailscaleInventorySourceResult =
  | { available: true; snapshot: TailscaleStatusSnapshot }
  | { available: false; error: TailscaleInventorySourceError };
