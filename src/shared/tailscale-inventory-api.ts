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
  | 'authentication_error'
  | 'configured'
  | 'configuration_error'
  | 'connected'
  | 'legacy'
  | 'not_configured'
  | 'scope_insufficient'
  | 'unavailable';

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
  connectionState: TailscaleProviderConnectionState;
  requiredScope: 'devices:core:read';
  source: TailscaleInventorySourceKind;
}

export interface TailscaleClassificationRequest {
  classification: TailscaleDeviceClassification;
  expectedRevision: number;
}
