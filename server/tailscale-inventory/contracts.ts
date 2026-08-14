export { tailscaleDeviceClassifications } from '../../src/shared/tailscale-inventory-api';
export type {
  TailscaleDeviceClassification
} from '../../src/shared/tailscale-inventory-api';

/**
 * Provider evidence for Tailscale-native Compute inventory.
 *
 * Device discovery intentionally ends at the provider boundary. Classification,
 * reachability probes, and SSH readiness are separate decisions made by later
 * adapters; none of them can replace fresh provider online truth.
 */
export type TailscaleOnlineState = 'online' | 'offline' | 'unknown';
export type TailscaleFreshnessState = 'fresh' | 'stale' | 'unknown';
export type TailscaleProbeState = 'reachable' | 'unreachable' | 'stale' | 'unknown';
export type TailscaleSshReadinessState =
  | 'ready'
  | 'blocked'
  | 'unavailable'
  | 'stale'
  | 'unknown';

export interface TailscaleFreshness {
  observedAt: string;
  freshUntil: string;
  state: TailscaleFreshnessState;
}

/** Fresh provider evidence only; it is not a reachability assertion. */
export interface TailscaleOnlineTruth {
  lastSeenAt?: string;
  observedAt: string;
  state: TailscaleOnlineState;
}

/** Optional bounded probe results. They never change provider online truth. */
export interface TailscaleReachabilityEvidence {
  clientPing?: TailscaleProbeState;
  serverPing?: TailscaleProbeState;
}

/**
 * SSH readiness is deliberately modelled separately from the provider status
 * and from ping. A caller must not infer either interactive or typed access.
 */
export interface TailscaleSshReadiness {
  control?: TailscaleSshReadinessState;
  interactive?: TailscaleSshReadinessState;
}

export interface TailscaleDeviceObservation {
  /** Stable Tailscale device ID. This is the sole reconciliation identity. */
  id: string;
  /** Exact numeric Tailscale addresses, never DNS names. */
  addresses: readonly string[];
  observedName?: string;
  online: boolean;
  lastSeenAt?: string;
  os?: string;
  tags: readonly string[];
}

export interface TailscaleProviderObservation {
  device: TailscaleDeviceObservation;
  freshness: TailscaleFreshness;
  onlineTruth: TailscaleOnlineTruth;
  reachability?: TailscaleReachabilityEvidence;
  ssh?: TailscaleSshReadiness;
}

export type TailscaleDeviceDecodeErrorCode =
  | 'duplicate_device_id'
  | 'invalid_device'
  | 'invalid_network_address';

/** Sanitized only: never include a raw peer key, label, tag, or payload. */
export interface TailscaleDeviceDecodeError {
  code: TailscaleDeviceDecodeErrorCode;
  source: 'peer';
}

export interface TailscaleStatusSnapshot {
  backendState: 'running';
  devices: readonly TailscaleDeviceObservation[];
  deviceErrors: readonly TailscaleDeviceDecodeError[];
  freshness: TailscaleFreshness;
  source: 'tailscale_api_devices' | 'tailscale_status_json';
}

export interface DecodeTailscaleStatusOptions {
  /** Collector timestamp, supplied outside the untrusted Tailscale payload. */
  observedAt: string;
  /** Defaults to 60 seconds. Must be a positive whole number. */
  freshnessSeconds?: number;
}
