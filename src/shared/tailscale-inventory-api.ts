export const tailscaleInventoryApiVersion = 1;

export const tailscaleDeviceClassifications = [
  'unclassified', 'environment', 'deployment_destination', 'console_endpoint', 'ignored'
] as const;
export type TailscaleDeviceClassification = typeof tailscaleDeviceClassifications[number];

export type TailscaleProviderRefreshState =
  | 'available' | 'partial' | 'unavailable' | 'not_checked';
export type TailscaleProviderNetworkState = 'online' | 'offline' | 'stale' | 'unknown';
export type TailscaleInventorySourceKind =
  | 'tailscale_oauth_api'
  | 'temporary_vps_local_status'
  | 'local_tailscale_command'
  | 'not_connected';
export type TailscaleProviderConnectionState =
  | 'connected' | 'legacy' | 'not_connected' | 'reauthorization_required';

export interface TailscaleInventoryDevice {
  addresses: string[];
  classification: TailscaleDeviceClassification;
  id: string;
  name?: string;
  network: {
    checkedAt: string;
    freshUntil: string;
    lastSeenAt?: string;
    state: TailscaleProviderNetworkState;
  };
  os?: string;
  revision: number;
  tags: string[];
}

export interface TailscaleInventoryResult {
  devices: TailscaleInventoryDevice[];
  provider: {
    connectionId?: string;
    connectionState: TailscaleProviderConnectionState;
    errorCount?: number;
    reasonCode?: string;
    refreshState: TailscaleProviderRefreshState;
    source: TailscaleInventorySourceKind;
  };
  schemaVersion: typeof tailscaleInventoryApiVersion;
}

export interface TailscaleProviderConnectionResult {
  connectionId?: string;
  connectedAt?: string;
  connectionState: TailscaleProviderConnectionState;
  requiredScope: 'devices:core:read';
  source: TailscaleInventorySourceKind;
  verifiedAt?: string;
}

/** Credentials are accepted only on connect and never returned by the server. */
export interface TailscaleProviderConnectionRequest {
  clientId: string;
  clientSecret: string;
}

export interface TailscaleClassificationRequest {
  classification: TailscaleDeviceClassification;
  expectedRevision: number;
}
